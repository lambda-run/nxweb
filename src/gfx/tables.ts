// Host-side tables of the recorder: what must outlive the guest's objects (games copy NVN objects by value, finalize
// and reuse them while recorded commands still name them), keyed by serial as in nxnative.
// A serial is (generation << 16 | slot) + 1 style: the low 16 bits are the table slot, so a lookup is one compare.
import * as L from "./log";
import { VIEW_SIZE, SP_SIZE } from "./obj";
import { arenaAlloc } from "./arena";

let generation: u64 = 0;
export function tablesInit(): void {
  TEXTAB = arenaAlloc(<usize>TEX_SLOTS * TE_SIZE); PROGTAB = arenaAlloc(<usize>PROG_SLOTS * PE_SIZE);
  TEXDESC = arenaAlloc(<usize>TEXDESC_N * TDE_SIZE); SAMPDESC = arenaAlloc(<usize>SAMPDESC_N * SDE_SIZE);
}

// ---- textures: serial -> flags ----
export const TEX_SLOTS: u32 = 65536;
// Entry: u64 serial, the content machine (texcontent.ts), where the storage is, a copy of the description (the game's
// object may be gone or reused when a recorded command needs the texture), and the content hashes
export const TE_inst: usize = 8, TE_mem: usize = 24, TE_size: usize = 32, TE_desc: usize = 40, TE_full: usize = 80, TE_last_full: usize = 88, TE_checked: usize = 92, TE_SIZE: usize = 96;
let TEXTAB: usize = 0;
let texNext: u32 = 1;
export function texNew(): u64 {
  for (let k: u32 = 0; k < TEX_SLOTS; k++) {
    const s = texNext; texNext = texNext + 1 == TEX_SLOTS ? 1 : texNext + 1;
    const e = TEXTAB + <usize>s * TE_SIZE;
    if (!load<u64>(e)) { const ser = (++generation << 16) | s; memory.fill(e, 0, TE_SIZE); store<u64>(e, ser); return ser; }
  }
  L.redLine("texture table full (65535 live textures): the texture gets no host texture");
  return 0;
}
// The table entry of a live serial, 0 when it is not (or no longer) one
export function texEntry(serial: u64): usize {
  const e = TEXTAB + <usize>(serial & 0xffff) * TE_SIZE;
  return serial && load<u64>(e) == serial ? e : 0;
}
export function texSlot(s: u32): usize { return TEXTAB + <usize>s * TE_SIZE; }
export function texFree(serial: u64): void { const e = texEntry(serial); if (e) store<u64>(e, 0); }

// ---- programs: serial -> per-stage shader keys and library ids ----
export const PROG_SLOTS: u32 = 8192;
export const PE_serial: usize = 0, PE_ok: usize = 8, PE_key: usize = 16, PE_shader: usize = 64, PE_SIZE: usize = 80;   // key: 6 x u64, shader: 6 x i16 (library id + 1, 0 = not looked up)
let PROGTAB: usize = 0;
let progNext: u32 = 1;
export function progNew(): usize {
  for (let k: u32 = 0; k < PROG_SLOTS; k++) {
    const s = progNext; progNext = progNext + 1 == PROG_SLOTS ? 1 : progNext + 1;
    const e = PROGTAB + <usize>s * PE_SIZE;
    if (!load<u64>(e)) { memory.fill(e, 0, PE_SIZE); store<u64>(e, (++generation << 16) | s); return e; }
  }
  L.redLine("program table full (8191 live programs)");
  return 0;
}
export function progEntry(serial: u64): usize {
  const e = PROGTAB + <usize>(serial & 0xffff) * PE_SIZE;
  return serial && (serial & 0xffff) < PROG_SLOTS && load<u64>(e) == serial ? e : 0;
}
export function progFree(serial: u64): void { const e = progEntry(serial); if (e) store<u64>(e, 0); }

// ---- descriptor pools: texture ID / sampler ID -> what was registered (nxnative mtl_reg_tex / mtl_reg_samp) ----
// Each pool of a kind gets a numbering base at its first Initialize, so the IDs of two pools do not collide (dpool_add).
export const TEXDESC_N: u32 = 65536;
export const TDE_serial: usize = 0, TDE_view: usize = 8, TDE_has_view: usize = 24, TDE_SIZE: usize = 32;
let TEXDESC: usize = 0;
export const SAMPDESC_N: u32 = 8192;
export const SDE_SIZE: usize = 48;                   // samp_par (40), +40 u8 registered
let SAMPDESC: usize = 0;
export function sampTablePtr(): usize { return SAMPDESC; }
export function texDesc(id: u32): usize { return id < TEXDESC_N ? TEXDESC + <usize>id * TDE_SIZE : 0; }
export function sampDesc(id: u32): usize { return id < SAMPDESC_N ? SAMPDESC + <usize>id * SDE_SIZE : 0; }
export function regTex(id: u32, serial: u64, view: usize): void {
  const e = texDesc(id);
  if (!e) { L.red("texture ID "); L.u(id); L.str(" is beyond the host's descriptor table ("); L.u(TEXDESC_N); L.str(")"); L.end(); return; }
  store<u64>(e, serial); store<u8>(e, view ? 1 : 0, TDE_has_view);
  if (view) memory.copy(e + TDE_view, view, VIEW_SIZE); else memory.fill(e + TDE_view, 0, VIEW_SIZE);
}
export function regSamp(id: u32, par: usize): void {
  const e = sampDesc(id);
  if (!e) { L.red("sampler ID "); L.u(id); L.str(" is beyond the host's descriptor table ("); L.u(SAMPDESC_N); L.str(")"); L.end(); return; }
  memory.copy(e, par, SP_SIZE); store<u8>(e, 1, 40);
}

const NDPOOL: i32 = 16;
const TPB: usize = memory.data(256), SPB: usize = memory.data(256);   // { u64 pool, i32 base } x 16
let ntpb: i32 = 0, nspb: i32 = 0, tnext: i32 = 0, snext: i32 = 0;
function dpoolAddIn(t: usize, n: i32, pool: u64, count: i32, tex: bool): i32 {
  let i = 0; while (i < n && load<u64>(t + (<usize>i << 4)) != pool) i++;
  if (i == n) {
    if (n == NDPOOL) { L.red(tex ? "texture" : "sampler"); L.str(" pools exceed 16: later ones share the first pool's numbering"); L.end(); return 0; }
    const base = tex ? tnext : snext;
    store<u64>(t + (<usize>i << 4), pool); store<i32>(t + (<usize>i << 4), base, 8);
    if (tex) { ntpb++; tnext += (count + 255) & ~255; } else { nspb++; snext += (count + 255) & ~255; }
  }
  return load<i32>(t + (<usize>i << 4), 8);
}
export function dpoolAdd(pool: u64, count: i32, tex: bool): i32 { return dpoolAddIn(tex ? TPB : SPB, tex ? ntpb : nspb, pool, count, tex); }
export function dpoolBase(pool: u64, tex: bool): i32 {
  const t = tex ? TPB : SPB, n = tex ? ntpb : nspb;
  for (let i = 0; i < n; i++) if (load<u64>(t + (<usize>i << 4)) == pool) return load<i32>(t + (<usize>i << 4), 8);
  return 0;
}

// ---- fences: a submission-ordered counter; the replayer reports completion (gfx_fence_signal) ----
let fenceIssued: u64 = 0;
const FENCE_DONE: usize = memory.data(8);            // the fence word: the highest fence whose GPU work is done
export function fenceNew(): u64 { return ++fenceIssued; }
export function fenceLast(): u64 { return fenceIssued; }
export function fenceDonePtr(): usize { return FENCE_DONE; }
export function fenceDone(n: u64): bool { return load<u64>(FENCE_DONE) >= n; }
export function fenceSignal(n: u64): void { if (n > load<u64>(FENCE_DONE)) store<u64>(FENCE_DONE, n); }

// ---- device modes (nxnative mtl_set_origin_lower_left / mtl_set_depth_zero: process-wide there too) ----
export let originLowerLeft: bool = true;
export let depthZeroToOne: bool = false;
export function setOrigin(ll: bool): void { originLowerLeft = ll; }
export function setDepthMode(zero: bool): void { depthZeroToOne = zero; }
