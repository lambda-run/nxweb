// Per-thread SVC counters for the embedder's report, and the poll back-off (kernel_poll_backoff; README "Poll
// back-off"). The counters are always kept (two stores an SVC); the back-off changes nothing while it is off.
import { KThread } from "./thread";
import { ringTotal } from "./ring";
import { guestNs } from "./clock";

// ---- counters ----
// Per thread record, STAT_STRIDE bytes of u32 (kernel_stats_ptr): [0..127] SVCs by number; [128..187] the waits:
// 4 SVCs (0 SleepThread, 1 WaitSynchronization, 2 WaitProcessWideKeyAtomic, 3 WaitForAddress) x 5 timeout classes
// (0 zero, and for SleepThread the yields; 1 under 1 ms; 2 under 5 ms; 3 longer; 4 none) x 3 results (0 woke,
// 1 timed out, 2 returned at once; of a yield: 1 the back-off made it a sleep, 2 a plain yield); [188] yields the back-off made sleeps; [189] short timed waits it made longer; [190..191] u64: the
// ns it added. A record that goes to a new thread keeps counting.
export const STAT_STRIDE: usize = 768;
const STATS: usize = memory.data(196608);   // MAX_THREADS * STAT_STRIDE
const PEND: usize = memory.data(256);       // per thread: 1 + (the u32 index of its wait's counters - 128), 0 none
// @ts-ignore: decorator
@inline function bump(i: i32, slot: i32): void { const p = STATS + <usize>i * STAT_STRIDE + (<usize>slot << 2); store<u32>(p, load<u32>(p) + 1); }
export function statsPtr(): usize { return STATS; }
// @ts-ignore: decorator
@inline export function statSvc(i: i32, n: i32): void { bump(i, n & 127); }
// @ts-ignore: decorator
@inline export function waitSvcOf(n: i32): i32 { return n == 0x0B ? 0 : n == 0x18 ? 1 : n == 0x1C ? 2 : n == 0x34 ? 3 : -1; }
export function waitClass(ns: i64, sleep: bool): i32 {
  if (ns == 0 || (sleep && ns < 0)) return 0;
  if (ns < 0) return 4;
  return ns < 1000000 ? 1 : ns < 5000000 ? 2 : 3;
}
// After wait SVC `w` of t with timeout class `cls`: it waits now (its result is counted when the wait ends), or not
export function statWait(t: KThread, w: i32, cls: i32, waiting: bool): void {
  const slot = 128 + (w * 5 + cls) * 3;
  if (waiting) store<u8>(PEND + <usize>t.index, <u8>(slot - 127));
  else bump(t.index, slot + 2);
}
export function statWake(t: KThread, timedOut: bool): void {
  const p = load<u8>(PEND + <usize>t.index);
  if (!p) return;
  store<u8>(PEND + <usize>t.index, 0);
  bump(t.index, <i32>p + 127 + (timedOut ? 1 : 0));
}

// ---- the poll back-off ----
// nxnative's rules (dm/host/hle_thread.c yield_backoff_ns, thr_yield, poll_wait_begin) for a scheduler where all
// guest threads share one host thread. A run is a thread's yields, or its sleeps and timed waits under POLL_NS that
// time out, with no other SVC between them. A run of yields also starts again when the callee-saved registers
// x19..x28 differ from those of the last two yields (a loop that yields between steps of work); a run of short waits
// when the thread ran longer than GAP_NS between two, or a wait was signalled.
//   yield in a run:      becomes a sleep of an eighth of the run so far, MIN_NS..MAX_NS, once the run has lasted
//                        START_NS. No START_NS when nothing is ready on another core (a spin would only keep the
//                        embedder from its event loop, where what the thread waits for comes from) or when the pass
//                        read the system counter (it waits for a time, not for a thread).
//   short wait in a run: its timeout becomes that sleep when it is longer; a signal still ends it at once.
// The thread cannot tell: a yield and a timeout may take any time. The sleep is at most MAX_NS, so a poller is late
// by at most that (and the embedder's timer).
const START_NS: u64 = 2000000, MIN_NS: u64 = 10000, MAX_NS: u64 = 250000, GAP_NS: u64 = 20000;
export const POLL_NS: i64 = 20000;
const BO_REC: usize = 48;                  // +0 run start (guest ns), +8 / +16 the registers' hash at the last two yields,
const BO: usize = memory.data(12288);      // +24 when the last step ended, +32 when the thread last got its core,
let on: bool = false;                      // +40 its SVC count at the last step, +44 the counter reads then
let clockReads: u32 = 0;
// @ts-ignore: decorator
@inline function rec(i: i32): usize { return BO + <usize>i * BO_REC; }
export function boInit(): void { on = false; clockReads = 0; memory.fill(STATS, 0, 196608); memory.fill(PEND, 0, 256); memory.fill(BO, 0, 12288); }
export function boSet(enable: bool): void { on = enable; }
// @ts-ignore: decorator
@inline export function boOn(): bool { return on; }
// @ts-ignore: decorator
@inline export function boClockRead(): void { clockReads++; }
export function boThreadNew(i: i32): void { memory.fill(rec(i), 0, BO_REC); store<u8>(PEND + <usize>i, 0); }
// @ts-ignore: decorator
@inline function sleepFor(run: u64): u64 { const s = run >> 3; return s < MIN_NS ? MIN_NS : s < MAX_NS ? s : MAX_NS; }
function added(t: KThread, slot: i32, ns: u64): void {
  bump(t.index, slot);
  const p = STATS + <usize>t.index * STAT_STRIDE + 760;
  store<u64>(p, load<u64>(p) + ns);
}
// A yield of t (its SVC is counted already). others: a thread is ready on another core. Returns the ns to sleep
// instead, 0 for a plain yield.
export function boYield(t: KThread, others: bool): u64 {
  const r = rec(t.index), total = ringTotal(t.index), now = guestNs();
  let sig: u64 = 0xcbf29ce484222325;
  for (let i = 19; i <= 28; i++) sig = (sig ^ t.x(i)) * 0x100000001b3;
  const s1 = load<u64>(r, 8);
  const same = load<u32>(r, 40) + 1 == total;
  const fresh = !same || (sig != s1 && sig != load<u64>(r, 16));
  const clock = !fresh && load<u32>(r, 44) != clockReads;
  if (fresh) store<u64>(r, now, 0);
  store<u64>(r, s1, 16); store<u64>(r, sig, 8); store<u64>(r, now, 24); store<u32>(r, total, 40); store<u32>(r, clockReads, 44);
  if (fresh) return 0;
  const run = now - load<u64>(r, 0);
  if (!clock && others && run < START_NS) return 0;
  const s = sleepFor(run);
  added(t, 188, s);
  return s;
}
// A sleep or timed wait of t with 0 < ns < POLL_NS that is about to begin: the timeout to wait with
export function boPoll(t: KThread, ns: i64, others: bool): i64 {
  const r = rec(t.index), total = ringTotal(t.index), now = guestNs();
  const a = load<u64>(r, 24), b = load<u64>(r, 32), last = a > b ? a : b;
  const fresh = load<u32>(r, 40) + 1 != total || now - last > GAP_NS;
  store<u32>(r, total, 40);
  if (fresh) { store<u64>(r, now, 0); return ns; }
  const run = now - load<u64>(r, 0);
  if (others && run < START_NS) return ns;
  const s = sleepFor(run);
  if (s <= <u64>ns) return ns;
  added(t, 189, s - <u64>ns);
  return <i64>s;
}
// t's wait ended: a timeout is a step of its run, anything else ends the run
export function boWake(t: KThread, timedOut: bool): void {
  const r = rec(t.index);
  if (timedOut) store<u64>(r, guestNs(), 24); else store<u32>(r, 0x80000000, 40);
}
// t got its core
// @ts-ignore: decorator
@inline export function boScheduled(t: KThread): void { store<u64>(rec(t.index), guestNs(), 32); }
// t used a whole time slice: it works
// @ts-ignore: decorator
@inline export function boWorked(t: KThread): void { store<u32>(rec(t.index), 0x80000000, 40); }
