// The last SVCs of each thread, for a fault report: a ring of RING_N records per thread record. A record is written
// when the SVC enters and completed when it returns, or when the thread runs again after its wait (the wake writes
// the results into the context). Nothing reads it but the embedder (kernel_svc_ring).
import { KThread, MAX_THREADS } from "./thread";
import * as mem from "./mem";

export const RING_N: u32 = 16;
export const RING_REC: usize = 112;
// +0 seq u32 (the thread's SVC count, from 1), +4 svc number u16, +6 flags u16, +8 pc u64 (the instruction after the
// svc), +16 x0..x5 as it entered (6 u64), +64 x0 and +72 x1 as it returned, +80 what a QueryMemory wrote to its
// MemoryInfo: base u64, +88 size u64, +96 state u32, +100 attribute u32, +104 permission u32 (zero for other SVCs)
export const RF_WAITING: u32 = 1;   // the thread waits in it: no results yet
export const RF_WAITED: u32 = 2;    // it waited; the results are those its wake wrote
export const RF_ENDED: u32 = 4;     // it did not return: the thread exited or the process stopped
const BLOCK: usize = 16 + <usize>RING_N * RING_REC;
const RING: usize = memory.data(462848);   // MAX_THREADS * BLOCK

// @ts-ignore: decorator
@inline function block(i: i32): usize { return RING + <usize>i * BLOCK; }
// @ts-ignore: decorator
@inline function newest(i: i32): usize { const n = load<u32>(block(i)); return block(i) + 16 + <usize>((n - 1) % RING_N) * RING_REC; }

export function ringInit(): void { assert(<usize>MAX_THREADS * BLOCK == 462848); memory.fill(RING, 0, 462848); }
export function ringClear(t: KThread): void { memory.fill(block(t.index), 0, BLOCK); }
export function ringEnter(t: KThread, n: i32): void {
  const total = load<u32>(block(t.index)) + 1;
  store<u32>(block(t.index), total);
  const r = newest(t.index);
  store<u32>(r, total); store<u16>(r, <u16>n, 4); store<u16>(r, 0, 6); store<u64>(r, load<u64>(t.ctx, 0x100), 8);
  for (let i = 0; i < 6; i++) store<u64>(r + 16 + (<usize>i << 3), t.x(i));
  memory.fill(r + 64, 0, RING_REC - 64);
}
// After svc(): waiting, ended (exited: the context is gone or the process is over) or returned
export function ringLeave(t: KThread, waiting: bool, ended: bool): void {
  if (!load<u32>(block(t.index))) return;
  const r = newest(t.index);
  if (ended) { store<u16>(r, <u16>RF_ENDED, 6); return; }
  if (waiting) { store<u16>(r, <u16>RF_WAITING, 6); return; }
  store<u64>(r, t.x(0), 64); store<u64>(r, t.x(1), 72);
  if (load<u16>(r, 4) == 0x06 && !t.x(0)) {
    store<u64>(r, mem.qBase, 80); store<u64>(r, mem.qSize, 88);
    store<u32>(r, mem.qState, 96); store<u32>(r, mem.qAttr, 100); store<u32>(r, mem.qPerm, 104);
  }
}
// The thread is scheduled again: a wait it made in an SVC has ended and its results are in the context
export function ringResume(t: KThread): void {
  if (!load<u32>(block(t.index))) return;
  const r = newest(t.index);
  if (load<u16>(r, 6) != <u16>RF_WAITING) return;
  store<u16>(r, <u16>RF_WAITED, 6); store<u64>(r, t.x(0), 64); store<u64>(r, t.x(1), 72);
}
export function ringTotal(i: i32): u32 { return i >= 0 && i < MAX_THREADS ? load<u32>(block(i)) : 0; }
// The newest min(cap, RING_N, total) records of thread record i to out, oldest first; their count
export function ringCopy(i: i32, out: usize, cap: u32): u32 {
  if (i < 0 || i >= MAX_THREADS) return 0;
  const total = load<u32>(block(i));
  let n = total < RING_N ? total : RING_N;
  if (n > cap) n = cap;
  for (let k: u32 = 0; k < n; k++) {
    const seq = total - n + 1 + k;
    memory.copy(out + <usize>k * RING_REC, block(i) + 16 + <usize>((seq - 1) % RING_N) * RING_REC, RING_REC);
  }
  return n;
}
