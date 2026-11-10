// BNSH shader containers: the one container format of nxnative's shader_split.py ported so far (a proof for the
// optional pre-warm; the Shaders stage itself translates on demand). As shader_split.py reads it (bnsh_shaders,
// check, ctl_len, skey):
//   'BNSH\0\0\0\0' at the start; +0x60 a 'grsc' block; +0x7C variation count (u32); +0x80 variation table pointer
//   (u64; pointers are relative to the BNSH start). A variation is 0x40 bytes with the binary program's pointer at
//   +0x10. The program has six stage pointers from +0x08: vertex, hull, domain, geometry, pixel, compute. A stage's
//   descriptor has +0x08 control section pointer, +0x10 code area pointer, +0x18 code area length (u32), +0x1C
//   control section length (u32).
//   A stage is taken when its control section starts with 0x98761234, is at least its key length long, the code
//   area's magic fits the stage (0x12345678, or 0x12345679 for compute; a compute area may have no header) and
//   control +0x704 is the code area's length.
//   The key: sha256(control[0 .. n) + code area), first 8 bytes, n = control +0x20 when 0x760 <= it < 0x880, else
//   0x880 (the same key src/gfx/shader.ts computes when the game hands the stage to NVN).
// Not read here: NVN2 (Switch 2) control sections (version 0xC9: Ampere code, another key), the task and mesh
// stages, the profile's shader_key_skip mask. Such stages are reported with their status, not dropped silently.
import { sha256 } from "../loader/sha256";
import { alloc } from "./base";

export const BN_OK: u32 = 0;
export const BN_NO_GRSC: u32 = 1;        // the container has no grsc block (the whole container is one record)
export const BN_OUTSIDE: u32 = 2;        // a pointer or length leads outside the bytes given
export const BN_BAD_CTL: u32 = 3;        // 'bad control section'
export const BN_BAD_MAGIC: u32 = 4;      // 'code area header magic does not match the stage'
export const BN_BAD_LEN: u32 = 5;        // 'control +0x704 does not match the code area length'
export const BN_NVN2: u32 = 6;           // an NVN2 control section: not read

// one record per stage found: 48 bytes
//   +0 u32 container offset, +4 u32 variation, +8 u32 stage (0 vs 1 hs 2 ds 3 gs 4 ps 5 cs), +12 u32 status,
//   +16 u32 control offset, +20 u32 control length, +24 u32 code offset, +28 u32 code length, +32 key (8 bytes), +40 pad
const REC: usize = 48;
let recs: usize = 0, nrec: u32 = 0, cap: u32 = 0, containers: u32 = 0, dropped: u32 = 0;
const DIGEST: usize = memory.data(32);

function add(base: u32, v: u32, stage: u32, status: u32, ctl: u32, nctl: u32, code: u32, ncode: u32): usize {
  if (nrec >= cap) { dropped++; return 0; }
  const r = recs + <usize>nrec * REC; nrec++;
  store<u32>(r, base, 0); store<u32>(r, v, 4); store<u32>(r, stage, 8); store<u32>(r, status, 12);
  store<u32>(r, ctl, 16); store<u32>(r, nctl, 20); store<u32>(r, code, 24); store<u32>(r, ncode, 28);
  return r;
}
// @ts-ignore: decorator
@inline function inside(len: u32, at: u64, n: u64): bool { return at <= <u64>len && n <= <u64>len - at; }

function container(d: usize, len: u32, base: u32): void {
  containers++;
  if (!inside(len, <u64>base + 0x60, 0x28) || load<u32>(d + base, 0x60) != 0x63737267) { add(base, 0, 0, BN_NO_GRSC, 0, 0, 0, 0); return; }   // 'grsc'
  const nvar = load<u32>(d + base, 0x7C), pvar = load<u64>(d + base, 0x80);
  for (let v: u32 = 0; v < nvar; v++) {
    const pv: u64 = <u64>base + pvar + 0x40 * <u64>v + 0x10;
    if (pvar > <u64>len || !inside(len, pv, 8)) { add(base, v, 0, BN_OUTSIDE, 0, 0, 0, 0); return; }
    const prog = load<u64>(d + <usize>pv);
    if (!prog) continue;
    for (let si: u32 = 0; si < 6; si++) {
      const ps: u64 = <u64>base + prog + 8 + 8 * <u64>si;
      if (prog > <u64>len || !inside(len, ps, 8)) { add(base, v, si, BN_OUTSIDE, 0, 0, 0, 0); break; }
      const sc = load<u64>(d + <usize>ps);
      if (!sc) continue;
      const pd: u64 = <u64>base + sc + 8;
      if (sc > <u64>len || !inside(len, pd, 24)) { add(base, v, si, BN_OUTSIDE, 0, 0, 0, 0); continue; }
      const pctl = load<u64>(d + <usize>pd), pcode = load<u64>(d + <usize>pd, 8), ncode = load<u32>(d + <usize>pd, 16), nctl = load<u32>(d + <usize>pd, 20);
      const ca: u64 = <u64>base + pctl, co: u64 = <u64>base + pcode;
      if (pctl > <u64>len || pcode > <u64>len || !inside(len, ca, nctl) || !inside(len, co, ncode)) { add(base, v, si, BN_OUTSIDE, 0, 0, 0, 0); continue; }
      const ctl = d + <usize>ca, code = d + <usize>co;
      let status = BN_OK, keyLen: u32 = 0x880;
      if (nctl < 0x24 || load<u32>(ctl) != 0x98761234) status = BN_BAD_CTL;
      else if (nctl >= 0x48 && load<u32>(ctl, 4) == 0xC9) status = BN_NVN2;
      else {
        const own = load<u32>(ctl, 0x20);
        if (own >= 0x760 && own < 0x880) keyLen = own;
        if (nctl < keyLen || nctl < 0x708) status = BN_BAD_CTL;
        else {
          const magic: u32 = ncode >= 4 ? load<u32>(code) : 0;
          const gfx = magic == 0x12345678, cs = magic == 0x12345679;
          if (si == 5 ? gfx : !gfx) status = BN_BAD_MAGIC;                 // compute: 0x12345679 or no header at all
          else if (load<u32>(ctl, 0x704) != ncode) status = BN_BAD_LEN;
          if (si != 5 && cs) status = BN_BAD_MAGIC;
        }
      }
      const r = add(base, v, si, status, <u32>ca, nctl, <u32>co, ncode);
      if (r && status == BN_OK) {
        const tmp = alloc(<usize>keyLen + ncode);
        if (tmp) {
          memory.copy(tmp, ctl, keyLen); memory.copy(tmp + keyLen, code, ncode);
          sha256(tmp, keyLen + ncode, DIGEST);
          memory.copy(r + 32, DIGEST, 8);
        }
      }
    }
  }
}

// Every BNSH container in [d, d + len) (a file's bytes, or an archive member's). Returns the number of stage
// records (bnshRecPtr / REC bytes each); maxRecords bounds them (bnshDropped() counts the rest).
export function bnshScan(d: usize, len: u32, maxRecords: u32): u32 {
  nrec = 0; containers = 0; dropped = 0; cap = maxRecords;
  recs = alloc(<usize>maxRecords * REC);
  if (!recs) { cap = 0; return 0; }
  if (len < 8) return 0;
  for (let i: u32 = 0; i <= len - 8; i++) {
    if (load<u64>(d + i) == 0x0000000048534E42) container(d, len, i);   // 'BNSH\0\0\0\0'
  }
  return nrec;
}
export function bnshRecPtr(): usize { return recs; }
export function bnshContainers(): u32 { return containers; }
export function bnshDropped(): u32 { return dropped; }
