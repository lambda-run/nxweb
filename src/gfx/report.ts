// Counter reports (nvnCommandBufferReportCounter) and conditional rendering (SetRenderEnable, SetRenderEnableConditional).
//
// A report is a 16-byte record the GPU writes into a buffer when it reaches the command: { u64 counter, u64 timestamp }.
// The timestamp is in ticks of 614.4 MHz (384 ticks per 625 ns) on the guest clock (nxnative nvn_timestamp.h). The
// counter of a timestamp report (TIMESTAMP, TIMESTAMP_TOP) is 0 on the hardware; nxnative writes the time there too
// unless the game's profile has render_cond, and so does this port. Reports of counters that are not counted here
// land with counter 0 (nxnative's placeholder); SAMPLES_PASSED (occlusion queries) is not written at all (red once).
//
// The recorder cannot write a report when it lowers the command: the GPU has not run it. Each report gets an id and
// goes into the host stream (H_REPORT); the replayer times the GPU work around it and calls reportLand when the
// submission the report belongs to is done. Fences issued after a report wait for it, like read-backs. An embedder
// with no device lands them itself (gfx_reports_flush).
//
// Which time a report takes (nxnative nvn_mtl.m rep_ticks, profile key gpu_timestamps):
//   submission (the default)  one time for every report of a submission: when its last segment was done
//   segment                   the GPU start (TIMESTAMP_TOP) or end (any other type) of the segment the report lies in.
//                             A segment is what the replayer hands to the GPU in one piece; in this mode the lowering
//                             cuts a submission at a render target change once 64 draws were made (nxnative sub_cut)
//
// Conditional rendering (profile key render_cond; nxnative nvn_mtl.m OP_RENDER_COND, rc_value). The condition compares
// the 64-bit counters at addr and addr + 16 when the command is lowered, on the CPU, from guest memory. A report that
// is still on its way is not in memory yet: a timestamp report counts with the 0 it will write (whatever the CPU put
// there meanwhile, as the GPU would overwrite it); a counter that is not counted here is unknown for good, and a
// condition on an unknown value draws (skipping is only right for a condition that was evaluated).
// Buffer writes made in stream order (UpdateUniformBuffer, CopyBufferToBuffer) over a record that is still on its way
// are the later writer: the report then lands only the fields the write left alone.
import * as L from "./log";
import * as H from "./hostops";
import { Inst } from "../kit/machine";
import { GFX_RENDER_ENABLE, GfxRenderEnableE, GfxRenderEnableS } from "../kit/gen/tables";
import { profileHas, P_RENDER_COND, P_TS_SEGMENT } from "./profile";

export const COUNTER_TIMESTAMP: u32 = 0, COUNTER_SAMPLES_PASSED: u32 = 1, COUNTER_TIMESTAMP_TOP: u32 = 0x10;
// @ts-ignore: decorator
@inline function isTime(type: u32): bool { return type == COUNTER_TIMESTAMP || type == COUNTER_TIMESTAMP_TOP; }
export function ticksFromNs(ns: u64): u64 { return ns / 625 * 384 + ns % 625 * 384 / 625; }
export function nsFromTicks(t: u64): u64 { return t / 384 * 625 + t % 384 * 625 / 384; }

// ---- reports on their way: a ring by id ----
const CAP: u32 = 4096;                      // a power of two
const R_addr: usize = 0, R_type: usize = 8, R_mask: usize = 12;   // mask: 1 the counter field is still to land, 2 the timestamp field; 0 landed
const RING: usize = memory.data(65536);     // CAP * 16
let nextId: u32 = 1, oldest: u32 = 1;       // ids oldest .. nextId - 1 may be on their way
let lastNs: u64 = 0;                        // the latest time a report took (a ring that overflows lands its oldest with it)
let nReports: u32 = 0, nLanded: u32 = 0, nCondFalse: u32 = 0, nCondTrue: u32 = 0, nCondUnknown: u32 = 0, nSkippedDraws: u32 = 0, nSkippedClears: u32 = 0, nCuts: u32 = 0;
// 0 reports issued, 1 landed, 2 conditions evaluated false, 3 true, 4 unknown (drawn), 5 draws skipped by a false condition, 6 clears skipped, 7 segment cuts
export function reportStat(i: i32): u32 { return i == 0 ? nReports : i == 1 ? nLanded : i == 2 ? nCondFalse : i == 3 ? nCondTrue : i == 4 ? nCondUnknown : i == 5 ? nSkippedDraws : i == 6 ? nSkippedClears : i == 7 ? nCuts : 0; }
// @ts-ignore: decorator
@inline function slot(id: u32): usize { return RING + (<usize>(id & (CAP - 1)) << 4); }
let redOnce: u32 = 0;
function once(bit: u32): bool { if (redOnce & (1 << bit)) return false; redOnce |= 1 << bit; return true; }
// @ts-ignore: decorator
@inline function inMemory(addr: u64, n: u64): bool { return addr > 1 && addr + n <= <u64>memory.size() << 16; }

// Records written by counters this port does not count: a condition on one of them is never evaluated. Open
// addressing; an address that a timestamp report takes over is replaced by 1, which no record has
const CONS_N: u32 = 4096;
const CONS: usize = memory.data(32768);
let consCount: u32 = 0, consAll = false;
// @ts-ignore: decorator
@inline function consHash(addr: u64): u32 { return <u32>((addr * 0x9E3779B97F4A7C15) >> 52); }
function consSlot(addr: u64): usize {     // where addr is, 0 when it is not there
  for (let i = consHash(addr), k: u32 = 0; k < CONS_N; k++, i = (i + 1) & (CONS_N - 1)) { const p = CONS + (<usize>i << 3), v = load<u64>(p); if (v == addr) return p; if (!v) return 0; }
  return 0;
}
function consAdd(addr: u64): void {
  if (consAll || consSlot(addr)) return;
  if (consCount >= CONS_N - CONS_N / 4) { consAll = true; L.redLine("conditional rendering: counters that are not counted wrote more records than the table holds: every condition is drawn from now on"); return; }
  let i = consHash(addr); while (load<u64>(CONS + (<usize>i << 3))) i = (i + 1) & (CONS_N - 1);
  store<u64>(CONS + (<usize>i << 3), addr); consCount++;
}

function write(e: usize, counter: u64, ticks: u64): void {
  const addr = load<u64>(e, R_addr), mask = load<u32>(e, R_mask);
  if (inMemory(addr, 16)) { if (mask & 1) store<u64>(<usize>addr, counter); if (mask & 2) store<u64>(<usize>addr, ticks, 8); }
  store<u32>(e, 0, R_mask); nLanded++;
}
// What a report writes into its counter field: the time for a timestamp report (0 under render_cond, as the GPU), 0 as
// the placeholder of a counter that is not counted
// @ts-ignore: decorator
@inline function counterOf(type: u32, ticks: u64): u64 { return isTime(type) && !profileHas(P_RENDER_COND) ? ticks : 0; }

// nvnCommandBufferReportCounter reached in a submission
export function reportIssue(type: u32, addr: u64): void {
  if (type == COUNTER_SAMPLES_PASSED) {
    if (inMemory(addr, 16)) consAdd(addr);
    if (once(0)) L.redLine("ReportCounter(SAMPLES_PASSED): occlusion queries are not counted, the record is not written (a render condition on it draws)");
    return;
  }
  if (!inMemory(addr, 16)) { if (once(1)) { L.red("ReportCounter: the record at 0x"); L.hex(addr); L.str(" is outside guest memory: not written"); L.end(); } return; }
  if (isTime(type)) { const p = consCount ? consSlot(addr) : 0; if (p) store<u64>(p, 1); } else consAdd(addr);
  if (nextId - oldest == CAP) {       // the GPU has not finished 4096 reports: the oldest takes the latest time known
    if (once(2)) L.redLine("more than 4096 counter reports are on their way: the oldest lands now with the latest time known");
    const e = slot(oldest), t = ticksFromNs(lastNs);
    if (load<u32>(e, R_mask)) write(e, counterOf(load<u32>(e, R_type), t), t);
    oldest++;
  }
  const id = nextId++, e = slot(id);
  store<u64>(e, addr, R_addr); store<u32>(e, type, R_type); store<u32>(e, 3, R_mask);
  store<u32>(H.hostRec(H.H_REPORT, 16), id, 8);
  nReports++;
}
// The submission that holds the reports issued since the last commit is complete in the stream: they land together
// when the GPU has finished it
let committed: u32 = 1;
export function reportCommit(): void { if (nextId != committed) { committed = nextId; H.hostRec(H.H_REPORT_COMMIT, 8); } }
// The replayer: report `id` is done. Times on the guest clock in nanoseconds: the GPU start and end of the segment the
// report lies in, and when the submission's last segment was done
export function reportLand(id: u32, startNs: u64, endNs: u64, doneNs: u64): void {
  if (id - oldest >= nextId - oldest) return;        // landed already (the ring overflowed), or never issued
  const e = slot(id), type = load<u32>(e, R_type);
  if (load<u32>(e, R_mask)) {
    const ns = profileHas(P_TS_SEGMENT) ? (type == COUNTER_TIMESTAMP_TOP ? startNs : endNs) : doneNs, ticks = ticksFromNs(ns);
    if (ns > lastNs) lastNs = ns;
    write(e, counterOf(type, ticks), ticks);
  }
  while (oldest != nextId && !load<u32>(slot(oldest), R_mask)) oldest++;
}
// An embedder with no GPU: everything issued is done now
export function reportsFlush(nowNs: u64): void { for (let id = oldest, end = nextId; id != end; id++) reportLand(id, nowNs, nowNs, nowNs); }
export function reportsPending(): u32 { let n: u32 = 0; for (let id = oldest; id != nextId; id++) if (load<u32>(slot(id), R_mask)) n++; return n; }

// A write of n bytes at dst made in stream order (lower.ts memWrite), before it is made: for a record still on its
// way it is the later writer of the bytes it covers
export function reportOverwrite(dst: u64, n: u64): void {
  if (oldest == nextId || !n) return;
  for (let id = oldest; id != nextId; id++) {
    const e = slot(id), mask = load<u32>(e, R_mask), addr = load<u64>(e, R_addr);
    if (!mask || dst >= addr + 16 || dst + n <= addr) continue;
    let m = mask;
    if ((m & 1) && dst < addr + 8) {
      // what the write leaves of the counter field must be the report's bytes: they are known only when the counter is
      if (counterOf(load<u32>(e, R_type), 1) == 0) store<u64>(<usize>addr, 0);
      m &= ~1;
    }
    if ((m & 2) && dst + n > addr + 8) m &= ~2;
    store<u32>(e, m, R_mask);
    if (!m) nLanded++;
  }
  while (oldest != nextId && !load<u32>(slot(oldest), R_mask)) oldest++;
}

// ---- conditional rendering ----
// The 64-bit counter at addr as the GPU would read it at this point of the stream; false: not known
let rcV: u64 = 0;
function rcValue(addr: u64): bool {
  if (consAll || !inMemory(addr, 8) || (consCount && consSlot(addr))) return false;
  for (let id = nextId; id != oldest;) {
    const e = slot(--id);
    if (load<u64>(e, R_addr) != addr || !(load<u32>(e, R_mask) & 1)) continue;
    rcV = 0; return true;              // a timestamp report on its way: the 0 it will write
  }
  rcV = load<u64>(<usize>addr); return true;
}
const ENABLE: usize = memory.data(16);
// @ts-ignore: decorator
@inline function enable(): Inst { return Inst.at(ENABLE); }
export function reportInit(): void { enable().init(GFX_RENDER_ENABLE, 0); }
// An OP_RENDER_COND record: mode 0 / 1 = SetRenderEnableConditional (render if the counters at addr and addr + 16 are
// equal / not equal), 2 / 3 = SetRenderEnable(true / false). Queue state: it lasts until the next such command
export function renderCond(mode: i32, addr: u64): void {
  const m = enable();
  if (mode >= 2) { m.step(mode == 3 ? GfxRenderEnableE.Disable : GfxRenderEnableE.Enable); return; }
  if (!rcValue(addr)) { nCondUnknown++; m.step(GfxRenderEnableE.Unknown); return; }
  const x = rcV;
  if (!rcValue(addr + 16)) { nCondUnknown++; m.step(GfxRenderEnableE.Unknown); return; }
  const draw = mode ? x != rcV : x == rcV;
  if (draw) nCondTrue++; else nCondFalse++;
  m.step(draw ? GfxRenderEnableE.Pass : GfxRenderEnableE.Fail);
}
// Whether draws and clears are dropped at this point of the stream (what: 0 a draw, 1 a clear: counted)
export function renderSkip(what: i32): bool {
  if (enable().state != GfxRenderEnableS.Skipping) return false;
  if (what) nSkippedClears++; else nSkippedDraws++;
  return true;
}
export function renderEnableState(): i32 { return enable().state; }

// ---- segments (gpu_timestamps segment) ----
// nxnative hands a submission to the GPU every 64 draws, between two passes (sub_cut, at a render target change).
// Here that is done only for a game whose reports take their segment's times
const CUT_DRAWS: u32 = 64;
let drawsSinceCut: u32 = 0;
export function segDraw(): void { drawsSinceCut++; }
export function segSubmitBegin(): void { drawsSinceCut = 0; }
// At a render target change, the pass before it ended: true when the stream is to be cut here
export function segCut(): bool {
  if (!profileHas(P_TS_SEGMENT) || drawsSinceCut < CUT_DRAWS) return false;
  drawsSinceCut = 0; nCuts++;
  return true;
}
