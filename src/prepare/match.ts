// Function-matched cuts: a cut placed by the function it lies in, for a build no registered cut names.
//
// This is nxnative's dm/tools/nso_match.py (MIT, Copyright (c) 2026 seedds) read as a specification: a rule names a
// complete function of the module's unwind table by its size and a fingerprint, and holds cuts at offsets from that
// function's start. The fingerprint is SHA-256 over the function's instruction words with only what a relocation
// changes masked out (the targets of branches that leave the function, addresses taken by ADRP / ADR / literal
// loads outside it, the low part of an ADRP address), and over what each branch that leaves it leads to: an imported
// name (through the PLT), a system call number (`svc #n; ret`), or another function's size and masked body. Nothing
// is fuzzy: exactly one function of the module must have the size and one of the rule's fingerprints, its original
// bytes are compared, and a rule of several functions applies whole or not at all. Rules of one name are one
// patch's reviewed implementations: exactly one of them must match.
//
// A fingerprint computed here has to be the number nxnative computed, or nothing matches. Two things in
// nso_match.py come from Capstone and are replaced:
//   - "which register does this instruction write" (the walk after an ADRP stops there): the table in
//     gen/match_writes.ts, measured from Capstone by tools/prepare/gen_match_writes.py. A word the table does not
//     know counts as writing every register, which can only make a fingerprint differ, never agree by mistake.
//   - "every word of the function decodes": not checked. Decoding depends on no bit a fingerprint masks, so a
//     function that equals a reference function in every unmasked bit decodes exactly when the reference does.
// An imported name with a byte outside printable ASCII, a quote or a backslash is not taken (nso_match.py would
// escape it in JSON): such a callee has no identity here and its callers do not match.
import { sha256 } from "../loader/sha256";
import { alloc, arenaMark, arenaRelease } from "./base";
import { WRITES_CLASS, WRITES_CLASSES, WRITES_RUNS } from "./gen/match_writes";

const TRAP_WORD: u32 = 0xE7FFDEFE;   // left after a call that does not return; nso_match.py reads it as brk #0
const ALL_REGS: u32 = 0x7FFFFFFF;

// The registers x0..x30 (bit n) the instruction counts as writing, by the measured table
export function writesMask(u: u32): u32 {
  if (u == TRAP_WORD) return 0;
  for (let i: i32 = 0; i < WRITES_CLASSES; i++) {
    const c = WRITES_CLASS + <usize>i * 56;
    if ((u & load<u32>(c)) != load<u32>(c, 4)) continue;
    const first = load<u32>(c, 8), n = load<u32>(c, 12), nr = load<u32>(c, 16), fl = load<u32>(c, 20);
    let key: u32 = 0;
    for (let r: u32 = 0; r < nr; r++) {
      const lo = load<u32>(c + (<usize>r << 3), 24), w = load<u32>(c + (<usize>r << 3), 28);
      key = (key << w) | ((u >> lo) & ((<u32>1 << w) - 1));
    }
    if (fl & 1) key = (key << 1) | <u32>((u & 31) == 31);
    if (fl & 2) key = (key << 1) | <u32>(((u >> 5) & 31) == 31);
    if (fl & 4) key = (key << 1) | <u32>(((u >> 10) & 31) == 31);
    if (fl & 8) key = (key << 1) | <u32>(((u >> 16) & 31) == 31);
    // the last run that starts at or before the key
    let lo: u32 = 0, hi: u32 = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((load<u32>(WRITES_RUNS + (<usize>(first + mid) << 2)) >> 8) <= key) lo = mid; else hi = mid; }
    if (!n) return ALL_REGS;
    const code = load<u32>(WRITES_RUNS + (<usize>(first + lo) << 2)) & 0xFF;
    if (code == 0xFF) return ALL_REGS;
    let m: u32 = 0;
    if (code & 1) { const r = u & 31; if (r != 31) m |= <u32>1 << r; }
    if (code & 2) { const r = (u >> 5) & 31; if (r != 31) m |= <u32>1 << r; }
    if (code & 4) { const r = (u >> 10) & 31; if (r != 31) m |= <u32>1 << r; }
    if (code & 8) { const r = (u >> 16) & 31; if (r != 31) m |= <u32>1 << r; }
    if (code & 16) m |= 1 << 16;
    if (code & 32) m |= 1 << 17;
    if (code & 64) m |= 1 << 30;
    return m;
  }
  return ALL_REGS;
}

// ---- the image ----
let IMG: usize = 0;
let LEN: u32 = 0;
let LIMIT: u32 = 0;            // min(text end, image length): functions and call targets lie below
let FN: usize = 0;             // sorted u64: start << 32 | end
let NFN: u32 = 0;
let MAXFN: u32 = 0;
let SCRATCH_A: usize = 0;      // masked words of the function being fingerprinted
let SCRATCH_B: usize = 0;      // and of one of its callees
let imageErr: i32 = 0;
let imageErrAt: u32 = 0;
export const IMG_OK: i32 = 0;
export const IMG_NO_MOD0: i32 = 1;       // 'no MOD0'
export const IMG_UNWIND: i32 = 2;        // 'cannot read function boundaries'
export const IMG_CONFLICT: i32 = 3;      // 'conflicting function boundaries at ...'
export const IMG_NOMEM: i32 = 4;

let bad: bool = false;         // a read left the image
// @ts-ignore: decorator
@inline function ok(o: i64, n: i64): bool { return o >= 0 && o + n <= <i64>LEN; }
function r8(o: i64): u32 { if (!ok(o, 1)) { bad = true; return 0; } return load<u8>(IMG + <usize>o); }
function r32(o: i64): u32 { if (!ok(o, 4)) { bad = true; return 0; } return load<u32>(IMG + <usize>o); }
function r64(o: i64): u64 { if (!ok(o, 8)) { bad = true; return 0; } return load<u64>(IMG + <usize>o); }
// @ts-ignore: decorator
@inline function word(o: u32): u32 { return load<u32>(IMG + <usize>o); }

// nso_code.py _read: a pointer in a DWARF encoding (value in the return, its size in readSize)
let readSize: i64 = 0;
let EHS: i64 = 0;
function readEnc(o: i64, enc: u32): i64 {
  const fmt = enc & 0xF, app = enc & 0x70;
  let v: i64 = 0;
  if (fmt == 0x3) { v = <i64>r32(o); readSize = 4; }
  else if (fmt == 0xB) { v = <i64><i32>r32(o); readSize = 4; }
  else if (fmt == 0x0 || fmt == 0x4 || fmt == 0xC) { v = <i64>r64(o); readSize = 8; }
  else { bad = true; readSize = 4; return 0; }
  if (app == 0x10) v += o; else if (app == 0x30) v += EHS;
  return v;
}
function uleb(o: i64): i64 {   // the position after it
  for (let i = 0; i < 10; i++) { const b = r8(o); o++; if (!(b & 0x80) || bad) return o; }
  bad = true; return o;
}
// nso_code.py fde_ranges cie_encoding: the pointer encoding a CIE gives its FDEs
let lastCie: i64 = -1;
let lastEnc: u32 = 0;
function cieEncoding(cie: i64): u32 {
  if (cie == lastCie) return lastEnc;
  let p = cie + 8;
  const ver = r8(p); p++;
  const aug = p;
  let augLen: i64 = 0;
  while (!bad && r8(aug + augLen)) { augLen++; if (augLen > 64) bad = true; }
  p += augLen + 1;
  p = uleb(p);                                   // code alignment
  while (!bad && (r8(p) & 0x80)) p++;            // data alignment
  p++;
  p = ver == 1 ? p + 1 : uleb(p);                // return address register
  let enc: u32 = 0;
  if (augLen && r8(aug) == 0x7A) {               // 'z'
    p = uleb(p);
    for (let i: i64 = 1; i < augLen && !bad; i++) {
      const ch = r8(aug + i);
      if (ch == 0x52) { enc = r8(p); p++; }                                   // 'R'
      else if (ch == 0x50) { const pe = r8(p); p++; readEnc(p, pe); p += readSize; }   // 'P'
      else if (ch == 0x4C) p++;                                               // 'L'
    }
  }
  if (!bad) { lastCie = cie; lastEnc = enc; }
  return enc;
}
function siftDown(a: usize, i: u32, n: u32): void {
  const v = load<u64>(a + (<usize>i << 3));
  for (;;) {
    let c: u32 = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && load<u64>(a + (<usize>(c + 1) << 3)) > load<u64>(a + (<usize>c << 3))) c++;
    const cv = load<u64>(a + (<usize>c << 3));
    if (cv <= v) break;
    store<u64>(a + (<usize>i << 3), cv); i = c;
  }
  store<u64>(a + (<usize>i << 3), v);
}
function sort64(a: usize, n: u32): void {
  if (n < 2) return;
  for (let i: i32 = <i32>(n / 2) - 1; i >= 0; i--) siftDown(a, <u32>i, n);
  for (let e: u32 = n - 1; e > 0; e--) {
    const t = load<u64>(a); store<u64>(a, load<u64>(a + (<usize>e << 3))); store<u64>(a + (<usize>e << 3), t);
    siftDown(a, 0, e);
  }
}

// The functions of an unpacked module image [image, image + len) whose text ends at textEnd: nso_match.py Image.
// IMG_OK, or why the image has no function table (then no rule can match)
export function imageInit(image: usize, len: u32, textEnd: u32): i32 {
  IMG = image; LEN = len; LIMIT = textEnd < len ? textEnd : len; FN = 0; NFN = 0; MAXFN = 0; SCRATCH_A = 0; SCRATCH_B = 0;
  imageErr = IMG_OK; imageErrAt = 0; bad = false; lastCie = -1; importsState = 0;
  const m0 = <i64>r32(4);
  if (bad || !ok(m0, 24) || r32(m0) != 0x30444F4D) { imageErr = IMG_NO_MOD0; return imageErr; }
  const ehs = m0 + <i64><i32>r32(m0 + 16), ehe = m0 + <i64><i32>r32(m0 + 20);
  EHS = ehs;
  // nso_code.py fde_table: no valid .eh_frame_hdr is an empty table, not an error
  if (ehe - ehs < 12) return IMG_OK;
  if (!ok(ehs, 4)) { imageErr = IMG_UNWIND; return imageErr; }
  if (r8(ehs) != 1 || r8(ehs + 3) == 0xFF || r8(ehs + 3) == 0) return IMG_OK;
  const penc = r8(ehs + 1), cenc = r8(ehs + 2), tenc = r8(ehs + 3);
  let o = ehs + 4;
  readEnc(o, penc); o += readSize;
  const n = readEnc(o, cenc); o += readSize;
  if (bad || n < 0 || n > <i64>(LEN >> 3)) { imageErr = IMG_UNWIND; return imageErr; }
  FN = alloc((<usize>n << 3) + 8);
  if (!FN) { imageErr = IMG_NOMEM; return imageErr; }
  let k: u32 = 0;
  for (let i: i64 = 0; i < n; i++) {
    readEnc(o, tenc); o += readSize;
    const f = readEnc(o, tenc); o += readSize;
    const cptr = f + 4;
    const enc = cieEncoding(cptr - <i64>r32(cptr));
    const st = readEnc(f + 8, enc);
    const ln = readEnc(f + 8 + readSize, enc & 0xF);
    if (bad) { imageErr = IMG_UNWIND; return imageErr; }
    const end = st + ln;
    if (st >= 0 && st < end && end <= <i64>LIMIT && !(st & 3) && !(end & 3)) { store<u64>(FN + (<usize>k << 3), (<u64>st << 32) | <u64>end); k++; }
  }
  sort64(FN, k);
  // one end for a start; the same range twice is one function
  let w: u32 = 0;
  for (let i: u32 = 0; i < k; i++) {
    const v = load<u64>(FN + (<usize>i << 3));
    if (w) {
      const p = load<u64>(FN + (<usize>(w - 1) << 3));
      if (p == v) continue;
      if ((p >> 32) == (v >> 32)) { imageErr = IMG_CONFLICT; imageErrAt = <u32>(v >> 32); NFN = 0; return imageErr; }
    }
    store<u64>(FN + (<usize>w << 3), v); w++;
    const sz = <u32>v - <u32>(v >> 32);
    if (sz > MAXFN) MAXFN = sz;
  }
  NFN = w;
  SCRATCH_A = alloc(<usize>MAXFN + 16); SCRATCH_B = alloc(<usize>MAXFN + 16);
  if (!SCRATCH_A || !SCRATCH_B) { imageErr = IMG_NOMEM; NFN = 0; return imageErr; }
  return IMG_OK;
}
export function imageError(): i32 { return imageErr; }
export function imageErrorAt(): u32 { return imageErrAt; }
export function fnCount(): u32 { return NFN; }
export function fnStart(i: u32): u32 { return i < NFN ? <u32>(load<u64>(FN + (<usize>i << 3)) >> 32) : 0; }
export function fnEndAt(i: u32): u32 { return i < NFN ? <u32>load<u64>(FN + (<usize>i << 3)) : 0; }
// The end of the function that starts at `start`, or 0
function fnEnd(start: i64): u32 {
  if (start < 0 || start > 0xFFFFFFFF || !NFN) return 0;
  let lo: u32 = 0, hi: u32 = NFN;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (<i64>(load<u64>(FN + (<usize>mid << 3)) >> 32) <= start) lo = mid; else hi = mid; }
  const v = load<u64>(FN + (<usize>lo << 3));
  return <i64>(v >> 32) == start ? <u32>v : 0;
}

// ---- nso_match.py _relative: a direct branch's immediate mask (0: not one) and its displacement in relDelta ----
let relDelta: i64 = 0;
function relative(w: u32): u32 {
  if ((w & 0x7C000000) == 0x14000000) { relDelta = <i64>((<i32>(w << 6)) >> 6) * 4; return 0x03FFFFFF; }
  if ((w & 0xFF000010) == 0x54000000 || (w & 0x7E000000) == 0x34000000) { relDelta = <i64>((<i32>(w << 8)) >> 13) * 4; return 0x00FFFFE0; }
  if ((w & 0x7E000000) == 0x36000000) { relDelta = <i64>((<i32>(w << 13)) >> 18) * 4; return 0x0007FFE0; }
  return 0;
}
// @ts-ignore: decorator
@inline function adrDelta(w: u32): i64 { return <i64>((<i32>((((w >> 5) & 0x7FFFF) << 2 | ((w >> 29) & 3)) << 11)) >> 11); }

// nso_match.py Image._body: the masked words of [start, end) into `scratch`, their SHA-256 into out (32 bytes)
function body(start: u32, end: u32, scratch: usize, out: usize): void {
  const n = (end - start) >> 2;
  memory.copy(scratch, IMG + <usize>start, <usize>n << 2);
  for (let i: u32 = 0; i < n; i++) {
    const w = word(start + (i << 2)), addr = <i64>start + (<i64>i << 2);
    const mask = relative(w);
    if (mask) {
      const target = addr + relDelta;
      if (!(target >= <i64>start && target < <i64>end)) store<u32>(scratch + (<usize>i << 2), load<u32>(scratch + (<usize>i << 2)) & ~mask);
    } else if ((w & 0x1F000000) == 0x10000000) {            // ADR / ADRP
      const t = addr + adrDelta(w);
      if ((w & 0x80000000) || !(t >= <i64>start && t < <i64>end)) store<u32>(scratch + (<usize>i << 2), load<u32>(scratch + (<usize>i << 2)) & 0x9F00001F);
    } else if ((w & 0x3B000000) == 0x18000000) {            // literal load
      const t = addr + <i64>((<i32>(w << 8)) >> 13) * 4;
      if (!(t >= <i64>start && t < <i64>end)) store<u32>(scratch + (<usize>i << 2), load<u32>(scratch + (<usize>i << 2)) & 0xFF00001F);
    }
    if ((w & 0x9F000000) != 0x90000000) continue;
    // the low part of the ADRP's address: the add, load or store on its register within the next eight instructions,
    // unless a branch or a write to the register comes first
    const rd = w & 31, stop = i + 9 < n ? i + 9 : n;
    for (let j = i + 1; j < stop; j++) {
      const u = word(start + (j << 2));
      if (((u & 0xFFC00000) == 0x91000000 || (u & 0x3B000000) == 0x39000000) && ((u >> 5) & 31) == rd) {
        store<u32>(scratch + (<usize>j << 2), load<u32>(scratch + (<usize>j << 2)) & ~<u32>0x3FFC00);
        break;
      }
      if (relative(u)) break;
      const k = u & 0xFFFFFC1F;
      if (k == 0xD61F0000 || k == 0xD63F0000 || k == 0xD65F0000) break;       // br, blr, ret
      if (rd != 31 && ((writesMask(u) >> rd) & 1)) break;
    }
  }
  sha256(scratch, n << 2, out);
}

// ---- imported names: GOT slot -> symbol, from DT_JMPREL (nso_match.py _import_slots) ----
let importsState: i32 = 0;     // 0 not read, 1 read, 2 none
let jmprel: i64 = 0, jmprelSize: i64 = 0, symtab: i64 = 0, strtab: i64 = 0;
function importsInit(): void {
  importsState = 2;
  const save = bad; bad = false;
  const mod = <i64>r32(4), dyn = mod + <i64><i32>r32(mod + 4);
  let pltrel: i64 = -1, haveJ = false, haveSz = false, haveSym = false, haveStr = false;
  const stop = dyn + 4096 * 16 < <i64>LEN - 15 ? dyn + 4096 * 16 : <i64>LEN - 15;
  if (!bad && dyn >= 0) for (let pos = dyn; pos < stop; pos += 16) {
    const tag = <i64>r64(pos), value = <i64>r64(pos + 8);
    if (tag == 0) break;
    if (tag == 20) pltrel = value; else if (tag == 23) { jmprel = value; haveJ = true; } else if (tag == 2) { jmprelSize = value; haveSz = true; }
    else if (tag == 6) { symtab = value; haveSym = true; } else if (tag == 5) { strtab = value; haveStr = true; }
  }
  if (!bad && pltrel == 7 && haveJ && haveSz && haveSym && haveStr && jmprel >= 0 && jmprelSize >= 0 && jmprel + jmprelSize <= <i64>LEN && symtab >= 0 && strtab >= 0) importsState = 1;
  bad = save;
}
// The name bound to the GOT slot at `slot`: its bytes at importPtr, importLen of them; false when there is none
// (or its name is not plain ASCII)
let importPtr: usize = 0, importLen: u32 = 0;
function importName(slot: i64): bool {
  if (!importsState) importsInit();
  if (importsState != 1) return false;
  const save = bad; bad = false;
  let found = false;
  // the last entry for a slot is the one a dictionary keeps
  for (let pos = jmprel + (jmprelSize + 23) / 24 * 24 - 24; pos >= jmprel; pos -= 24) {
    if (<i64>r64(pos) != slot) continue;
    const inf = r64(pos + 8);
    if (<u32>inf != 1026) continue;                                  // R_AARCH64_JUMP_SLOT
    const name = <i64>r32(symtab + <i64>(inf >> 32) * 24) + strtab;
    if (bad || name < 0 || name >= <i64>LEN) break;
    let n: u32 = 0, plain = true;
    for (;;) {
      if (name + n >= <i64>LEN) { plain = false; break; }
      const ch = load<u8>(IMG + <usize>name + n);
      if (!ch) break;
      if (ch < 0x20 || ch > 0x7E || ch == 0x22 || ch == 0x5C) plain = false;
      n++;
    }
    if (plain && n) { importPtr = IMG + <usize>name; importLen = n; found = true; }
    break;
  }
  bad = save;
  return found;
}

// ---- nso_match.py _callee: what a branch that leaves its function leads to ----
const CALLEE_NONE: u32 = 0, CALLEE_IMPORT: u32 = 1, CALLEE_SVC: u32 = 2, CALLEE_FUNCTION: u32 = 3;
// a record: +0 kind, +4 offset of the branch in its function, +8 a (name pointer / svc number / size), +12 b (name length), +16 digest (32)
const REF: usize = 48;
function callee(target: i64, rec: usize): u32 {
  if (target >= 0 && LIMIT >= 16 && target <= <i64>(LIMIT - 16)) {
    const t = <u32>target, a = word(t), b = word(t + 4), c = word(t + 8), d = word(t + 12);
    // the PLT: adrp x16, page; ldr x17, [x16, #lo]; add x16, x16, #lo; br x17
    if ((a & 0x9F00001F) == 0x90000010 && (b & 0xFFC003FF) == 0xF9400211 && (c & 0xFFC003FF) == 0x91000210 && d == 0xD61F0220) {
      const page = (target & ~<i64>0xFFF) + (adrDelta(a) << 12), lo = <i64>((b >> 10) & 0xFFF) * 8;
      if (<i64>((c >> 10) & 0xFFF) == lo && importName(page + lo)) {
        store<u32>(rec, CALLEE_IMPORT); store<u32>(rec, <u32>importPtr, 8); store<u32>(rec, importLen, 12);
        return CALLEE_IMPORT;
      }
    }
    // the SDK's system call wrappers have no unwind entry: `svc #n; ret` is the call n
    if ((a & 0xFFE0001F) == 0xD4000001 && b == 0xD65F03C0 && !fnEnd(target)) {
      store<u32>(rec, CALLEE_SVC); store<u32>(rec, (a >> 5) & 0xFFFF, 8);
      return CALLEE_SVC;
    }
  }
  const end = fnEnd(target);
  if (!end) return CALLEE_NONE;
  store<u32>(rec, CALLEE_FUNCTION); store<u32>(rec, end - <u32>target, 8);
  body(<u32>target, end, SCRATCH_B, rec + 16);
  return CALLEE_FUNCTION;
}

const HEX: usize = memory.data<u8>([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102]);
let W: usize = 0;
// @ts-ignore: decorator
@inline function wc(c: u8): void { store<u8>(W, c); W++; }
function ws(s: string): void { for (let i = 0, n = s.length; i < n; i++) wc(<u8>s.charCodeAt(i)); }
function wu(v: u32): void { if (v >= 10) wu(v / 10); wc(<u8>(48 + v % 10)); }
function wdigest(p: usize): void { wc(34); for (let i: usize = 0; i < 32; i++) { const b = load<u8>(p + i); wc(load<u8>(HEX + (b >> 4))); wc(load<u8>(HEX + (b & 15))); } wc(34); }
const DIGEST: usize = memory.data(32);

// nso_match.py Image.fingerprint: SHA-256 of the JSON text [body, [[offset, callee], ...]] into out. False when a
// branch leaves the function for a place with no identity (the function cannot match anything)
export function fingerprint(start: u32, out: usize): bool {
  const end = fnEnd(<i64>start);
  if (!end) return false;
  const mark = arenaMark();
  body(start, end, SCRATCH_A, DIGEST);
  const n = (end - start) >> 2;
  let refs: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    if (!relative(word(start + (i << 2)))) continue;
    const t = <i64>start + (<i64>i << 2) + relDelta;
    if (!(t >= <i64>start && t < <i64>end)) refs++;
  }
  const recs = alloc(<usize>refs * REF + 16);
  if (!recs) { arenaRelease(mark); return false; }
  let k: u32 = 0, text: usize = 80;
  for (let i: u32 = 0; i < n; i++) {
    if (!relative(word(start + (i << 2)))) continue;
    const t = <i64>start + (<i64>i << 2) + relDelta;
    if (t >= <i64>start && t < <i64>end) continue;
    const rec = recs + <usize>k * REF;
    const kind = callee(t, rec);
    if (kind == CALLEE_NONE) { arenaRelease(mark); return false; }
    store<u32>(rec, i << 2, 4);
    text += 112 + (kind == CALLEE_IMPORT ? <usize>load<u32>(rec, 12) : 0);
    k++;
  }
  const buf = alloc(text);
  if (!buf) { arenaRelease(mark); return false; }
  W = buf;
  wc(91); wdigest(DIGEST); wc(44); wc(91);
  for (let i: u32 = 0; i < k; i++) {
    const rec = recs + <usize>i * REF, kind = load<u32>(rec);
    if (i) wc(44);
    wc(91); wu(load<u32>(rec, 4)); wc(44); wc(91);
    if (kind == CALLEE_IMPORT) {
      ws("\"import\",\""); const p = <usize>load<u32>(rec, 8), l = load<u32>(rec, 12);
      memory.copy(W, p, l); W += l; wc(34);
    } else if (kind == CALLEE_SVC) { ws("\"svc\","); wu(load<u32>(rec, 8)); }
    else { ws("\"function\","); wu(load<u32>(rec, 8)); wc(44); wdigest(rec + 16); }
    wc(93); wc(93);
  }
  wc(93); wc(93);
  sha256(buf, <u32>(W - buf), out);
  arenaRelease(mark);
  return true;
}

// nso_match.py Image.locate: the start of the one function of this size with one of these fingerprints (nfp digests
// of 32 bytes at fps); locCount is how many matched, and only 1 gives a start
let locCount: u32 = 0;
const FP: usize = memory.data(32);
function locate(size: u32, fps: usize, nfp: u32): u32 {
  locCount = 0;
  let at: u32 = 0;
  for (let i: u32 = 0; i < NFN; i++) {
    const v = load<u64>(FN + (<usize>i << 3)), s = <u32>(v >> 32);
    if (<u32>v - s != size) continue;
    if (!fingerprint(s, FP)) continue;
    for (let f: u32 = 0; f < nfp; f++) if (memory.compare(FP, fps + (<usize>f << 5), 32) == 0) { locCount++; at = s; break; }
  }
  return locCount == 1 ? at : 0;
}

// ---- nso_match.py resolve over a rule list ----
// The list (little endian, unaligned):
//   u32 rules; per rule: u32 set, u32 group, u32 functions; per function: u32 size, u32 fingerprints, 32 bytes each,
//   u32 cuts; per cut: u32 offset from the function's start, u32 length, <length> original bytes, <length> new bytes
// A group is the rules of one name (one patch's reviewed implementations, consecutive numbers from 0 in the order
// the names first appear): exactly one of a group's rules must match. A set is one resolve() of nxnative (the game's
// rules, the rules for every game): cuts of one set must not overlap.
// The status, 12 bytes a rule then 12 a function, in the list's order:
//   rule:     u32 state (0 every function matched, 1 not), u32 chosen (1: its cuts are in the result), u32 functions
//   function: u32 state (FN_*), u32 detail, u32 start
export const FN_OK: u32 = 0;
export const FN_COUNT: u32 = 1;          // detail functions match (need exactly one): 0 or several
export const FN_BYTES: u32 = 2;          // original bytes differ at detail
export const FN_SAME: u32 = 3;           // matched a function another one of the rule did
export const MATCH_OK: i32 = 0;
export const MATCH_BAD_LIST: i32 = -2;
export const MATCH_NOMEM: i32 = -5;
export const MATCH_OVERLAP: i32 = -6;    // 'function patches overlap'

let statusPtr: usize = 0, statusLen: u32 = 0, cutsPtr: usize = 0, cutsLen: u32 = 0, cutCount: u32 = 0, srcPtr: usize = 0;
let overlapAt: u32 = 0;
export function matchStatusPtr(): usize { return statusPtr; }
export function matchStatusLen(): u32 { return statusLen; }
export function matchCutsPtr(): usize { return cutsPtr; }       // the list cutApply takes
export function matchCutsLen(): u32 { return cutsLen; }
export function matchCutCount(): u32 { return cutCount; }
export function matchSrcPtr(): usize { return srcPtr; }         // per cut: u32 rule, u32 function, u32 cut (where its reason is)
export function matchOverlapAt(): u32 { return overlapAt; }

// One pass over the list. apply = false: check its shape, count; true: match and fill the status
let pRules: u32 = 0, pFns: u32 = 0, pCuts: u32 = 0, pBytes: u64 = 0, pGroups: u32 = 0;
function shape(list: usize, listLen: u32): bool {
  pRules = 0; pFns = 0; pCuts = 0; pBytes = 0; pGroups = 0;
  const end: u64 = <u64>list + listLen;
  if (listLen < 4) return false;
  const n = load<u32>(list);
  let p: u64 = <u64>list + 4;
  for (let r: u32 = 0; r < n; r++) {
    if (p + 12 > end) return false;
    const group = load<u32>(<usize>p, 4), nf = load<u32>(<usize>p, 8);
    if (group > pGroups || !nf) return false;       // groups are numbered as they first appear
    if (group == pGroups) pGroups++;
    p += 12; pRules++;
    for (let f: u32 = 0; f < nf; f++) {
      if (p + 8 > end) return false;
      const size = load<u32>(<usize>p), nfp = load<u32>(<usize>p, 4);
      if (!size || (size & 3) || !nfp || p + 8 + (<u64>nfp << 5) + 4 > end) return false;
      p += 8 + (<u64>nfp << 5);
      const nc = load<u32>(<usize>p); p += 4;
      if (!nc) return false;
      for (let c: u32 = 0; c < nc; c++) {
        if (p + 8 > end) return false;
        const off = load<u32>(<usize>p), cl = load<u32>(<usize>p, 4);
        if (!cl || (cl & 3) || (off & 3) || <u64>off + cl > <u64>size || p + 8 + 2 * <u64>cl > end) return false;
        p += 8 + 2 * <u64>cl; pCuts++; pBytes += 8 + 2 * <u64>cl;
      }
      pFns++;
    }
  }
  return p == end;
}

export function matchResolve(list: usize, listLen: u32): i32 {
  statusPtr = 0; statusLen = 0; cutsPtr = 0; cutsLen = 0; cutCount = 0; srcPtr = 0; overlapAt = 0;
  if (!shape(list, listLen)) return MATCH_BAD_LIST;
  statusLen = 12 * (pRules + pFns);
  statusPtr = alloc(<usize>statusLen + 16);
  cutsPtr = alloc(<usize>(4 + pBytes) + 16);
  srcPtr = alloc(<usize>pCuts * 12 + 16);
  const found = alloc((<usize>pGroups << 2) + 16);        // per group: how many of its rules matched
  const ruleAt = alloc((<usize>pRules << 3) + 16);        // per rule: where it is in the list, where its status is
  if (!statusPtr || !cutsPtr || !srcPtr || !found || !ruleAt) return MATCH_NOMEM;
  // (1) every rule against the image
  let p: usize = list + 4, st: usize = statusPtr;
  for (let r: u32 = 0; r < pRules; r++) {
    store<u32>(ruleAt + (<usize>r << 3), <u32>(p - list)); store<u32>(ruleAt + (<usize>r << 3), <u32>(st - statusPtr), 4);
    const group = load<u32>(p, 4), nf = load<u32>(p, 8);
    p += 12;
    const rst = st; st += 12;
    const fst0 = st;
    let missed: u32 = 0;
    for (let f: u32 = 0; f < nf; f++) {
      const size = load<u32>(p), nfp = load<u32>(p, 4), fps = p + 8;
      p += 8 + (<usize>nfp << 5);
      const nc = load<u32>(p); p += 4;
      let state = FN_OK, detail: u32 = 0;
      const start = imageErr == IMG_OK ? locate(size, fps, nfp) : 0;
      if (imageErr != IMG_OK) { state = FN_COUNT; detail = 0; }
      else if (locCount != 1) { state = FN_COUNT; detail = locCount; }
      for (let c: u32 = 0; c < nc; c++) {
        const off = load<u32>(p), cl = load<u32>(p, 4);
        if (state == FN_OK && memory.compare(IMG + <usize>start + off, p + 8, cl) != 0) { state = FN_BYTES; detail = start + off; }
        p += 8 + 2 * <usize>cl;
      }
      if (state == FN_OK) for (let g: u32 = 0; g < f; g++) {
        const o = fst0 + <usize>g * 12;
        if ((load<u32>(o) == FN_OK || load<u32>(o) == FN_SAME) && load<u32>(o, 8) == start) { state = FN_SAME; break; }
      }
      store<u32>(st, state); store<u32>(st, detail, 4); store<u32>(st, start, 8);
      if (state != FN_OK) missed++;
      st += 12;
    }
    store<u32>(rst, missed ? 1 : 0); store<u32>(rst, 0, 4); store<u32>(rst, nf, 8);
    if (!missed) store<u32>(found + (<usize>group << 2), load<u32>(found + (<usize>group << 2)) + 1);
  }
  // (2) the cuts of each group's one matching rule, groups in order
  let out: usize = cutsPtr + 4, src: usize = srcPtr;
  for (let g: u32 = 0; g < pGroups; g++) {
    if (load<u32>(found + (<usize>g << 2)) != 1) continue;
    for (let r: u32 = 0; r < pRules; r++) {
      let q: usize = list + load<u32>(ruleAt + (<usize>r << 3));
      const rst = statusPtr + load<u32>(ruleAt + (<usize>r << 3), 4);
      if (load<u32>(q, 4) != g || load<u32>(rst) != 0) continue;
      store<u32>(rst, 1, 4);
      const nf = load<u32>(q, 8);
      q += 12;
      for (let f: u32 = 0; f < nf; f++) {
        const start = load<u32>(rst + 12 + <usize>f * 12, 8);
        q += 8 + (<usize>load<u32>(q, 4) << 5);
        const nc = load<u32>(q); q += 4;
        for (let c: u32 = 0; c < nc; c++) {
          const off = load<u32>(q), cl = load<u32>(q, 4);
          store<u32>(out, start + off); store<u32>(out, cl, 4); memory.copy(out + 8, q + 8, 2 * <usize>cl);
          store<u32>(src, r); store<u32>(src, f, 4); store<u32>(src, c, 8);
          out += 8 + 2 * <usize>cl; src += 12; q += 8 + 2 * <usize>cl; cutCount++;
        }
      }
    }
  }
  store<u32>(cutsPtr, cutCount);
  cutsLen = <u32>(out - cutsPtr);
  // (3) cuts of one set must not overlap
  let a: usize = cutsPtr + 4;
  for (let i: u32 = 0; i < cutCount; i++) {
    const ao = load<u32>(a), al = load<u32>(a, 4);
    const aset = load<u32>(list + load<u32>(ruleAt + (<usize>load<u32>(srcPtr + <usize>i * 12) << 3)));
    let b: usize = a + 8 + 2 * <usize>al;
    for (let j: u32 = i + 1; j < cutCount; j++) {
      const bo = load<u32>(b), bl = load<u32>(b, 4);
      const bset = load<u32>(list + load<u32>(ruleAt + (<usize>load<u32>(srcPtr + <usize>j * 12) << 3)));
      if (aset == bset && ao < bo + bl && bo < ao + al) { overlapAt = ao > bo ? ao : bo; return MATCH_OVERLAP; }
      b += 8 + 2 * <usize>bl;
    }
    a += 8 + 2 * <usize>al;
  }
  return MATCH_OK;
}
