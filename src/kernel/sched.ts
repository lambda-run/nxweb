// The scheduler: four virtual cores, or eight (kernel flag 8; MAX_CORES sizes the tables), each running its highest-priority ready thread, first come first served among
// equals. The rest of the kernel talks to it only through the functions exported here, and all state is per core, so
// a later phase can run each core on its own Worker (scheduleCore(c) per Worker) without changing the callers.
//
// Green threads today: one host thread calls scheduleNext(), which gives the cores turns in rotation. A thread that
// is Running is its core's current thread; it stays Running while other cores have their turn.
import { KthreadS, KthreadE } from "../kit/gen/tables";
import { KThread, thr, MAX_THREADS, MAX_CORES, threadTop, coreCount, setCoreCount, runCoreOf, WK_LOCK } from "./thread";

const CUR: usize = memory.data(32);      // MAX_CORES * 4. per core: the index of its current thread, -1 none
const RESCHED: usize = memory.data(8);   // MAX_CORES. per core: its ready set or a priority changed since it last chose
// The wake hand-off (eight cores only). A thread whose SVC made a better thread ready on another core stands back until
// that thread has blocked, yielded or exited (or used HOLD_SLICES slices): what the woken thread does first is done
// before the waker goes on, as when both queue on one core. On hardware the woken thread's core runs it at once, beside
// the waker; with green threads the waker would otherwise finish its slice first. Ocarina of Time's movie player
// (core 5, priority 45) registers its video frames, which wakes the movie library's event thread (priority 44, cores
// 0..2) to give them to the decoder, and then calls VideoDecoder::Start: started first, the library drops both frames
// (subsdk0+0x44bc, +0x450c) and no picture ever comes. nxnative has the same rule for threads of one core
// (hle_thread.c dm_yield_to_core_peers); its threads of different cores do run side by side.
const HOLD: usize = memory.data(1024);   // MAX_THREADS * 4. per thread: 1 + the index of the thread it stands back for, 0 none
const HOLDN: usize = memory.data(256);   // MAX_THREADS. ... and the slices that thread may still use before the hold ends
const WOKE: usize = memory.data(32);     // the threads the current SVC made ready
const HOLD_SLICES: u8 = 4;
let nwoke: i32 = 0, holds: i32 = 0, handoff: bool = false, ncores: i32 = 4;
let seq: u64 = 0;
let cursor: i32 = 0;
let effDirty: bool = true;
let inherit: bool = true;
let anyPending: bool = false;   // some thread has yieldAny set

// @ts-ignore: decorator
@inline function cur(c: i32): i32 { return load<i32>(CUR + (<usize>c << 2)); }
// @ts-ignore: decorator
@inline function setCur(c: i32, i: i32): void { store<i32>(CUR + (<usize>c << 2), i); }
// @ts-ignore: decorator
@inline function flag(c: i32): void { store<u8>(RESCHED + <usize>c, 1); }

export function schedInit(priorityInheritance: bool, eightCores: bool, wakeHandoff: bool): void {
  for (let c = 0; c < MAX_CORES; c++) { setCur(c, -1); store<u8>(RESCHED + <usize>c, 0); }
  memory.fill(HOLD, 0, <usize>MAX_THREADS * 4); memory.fill(HOLDN, 0, <usize>MAX_THREADS);
  seq = 0; cursor = 0; effDirty = true; inherit = priorityInheritance; anyPending = false;
  ncores = eightCores ? 8 : 4; setCoreCount(ncores); handoff = wakeHandoff; nwoke = 0; holds = 0; outMask = 0;
}
// @ts-ignore: decorator
@inline function holdOf(i: i32): i32 { return load<i32>(HOLD + (<usize>i << 2)); }
function unhold(i: i32): void {
  if (!holdOf(i)) return;
  store<i32>(HOLD + (<usize>i << 2), 0); holds--;
  flag(thr(i).runCore);
}
// t stands back for a thread that is still ready
function held(t: KThread): bool {
  const h = holdOf(t.index);
  if (!h) return false;
  const u = thr(h - 1);
  if (u.used && u.ready && load<u8>(HOLDN + <usize>t.index)) return true;
  unhold(t.index);
  return false;
}
// u blocked, yielded or exited: those that stood back for it go on
function holdersGo(u: KThread): void {
  for (let i = 0; i < threadTop && holds > 0; i++) if (holdOf(i) == u.index + 1) unhold(i);
}
// An SVC begins: the threads it makes ready are noted for the hand-off
export function schedSvcBegin(): void { nwoke = 0; }
// Something the choice depends on changed (a priority, a lock wait, a core mask)
export function schedChanged(): void { effDirty = true; for (let c = 0; c < ncores; c++) flag(c); }

// t became Runnable (started, woken, resumed): to the back of its priority on its core
export function schedReady(t: KThread): void {
  t.rqSeq = ++seq; t.runCore = runCoreOf(t); t.yieldAny = false;
  effDirty = true; flag(t.runCore);
  if (handoff && nwoke < 8) { store<i32>(WOKE + (<usize>nwoke << 2), t.index); nwoke++; }
}
// t yielded: behind the threads of its priority. any = YieldToAnyThread: lower-priority threads of the core get a turn
export function schedYield(t: KThread, any: bool): void {
  t.rqSeq = ++seq; t.yieldAny = any;
  if (any) anyPending = true;
  flag(t.runCore);
  if (holds) holdersGo(t);
}
// t stopped being ready (it blocked, exited or was paused)
export function schedLeft(t: KThread): void {
  if (cur(t.runCore) == t.index) setCur(t.runCore, -1);
  effDirty = true; flag(t.runCore);
  if (holds) { unhold(t.index); holdersGo(t); }
}

// Effective priorities. A thread waiting for a lock lends its priority to the lock's owner (and through it to the
// owner's owner), as Horizon's kernel does; the guest never sees the lent priority (GetThreadPriority reports prio).
function computeEff(): void {
  if (!effDirty) return;
  effDirty = false;
  for (let i = 0; i < threadTop; i++) { const t = thr(i); if (t.used) t.eff = t.prio; }
  if (!inherit) return;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < threadTop; i++) {
      const w = thr(i);
      if (!w.used || w.wowner < 0 || w.waitKind != WK_LOCK) continue;
      const o = thr(w.wowner);
      if (o.used && o.eff > w.eff) { o.eff = w.eff; changed = true; }
    }
    if (!changed) break;
  }
}
// @ts-ignore: decorator
@inline function better(a: KThread, b: KThread | null): bool {
  return b == null || a.eff < b.eff || (a.eff == b.eff && a.rqSeq < b.rqSeq);
}
// The thread core c should run among those queued on it. A thread that yielded to any thread stands back once.
function pickLocal(c: i32): KThread | null {
  let best: KThread | null = null, stoodBack: KThread | null = null;
  for (let i = 0; i < threadTop; i++) {
    const t = thr(i);
    if (!t.used || !t.ready || t.runCore != c) continue;
    if (holds && held(t)) continue;
    if (t.yieldAny) { if (better(t, stoodBack)) stoodBack = t; }
    else if (better(t, best)) best = t;
  }
  return best != null ? best : stoodBack;
}
// An idle core takes a ready thread that its own core keeps waiting, if the thread's mask allows this core
function steal(c: i32): KThread | null {
  let best: KThread | null = null;
  for (let i = 0; i < threadTop; i++) {
    const t = thr(i);
    if (!t.used || t.state != KthreadS.Runnable || t.runCore == c || !((t.mask >> c) & 1)) continue;
    if (pickLocal(t.runCore) == t) continue;   // its core is about to run it
    if (holds && held(t)) continue;
    if (better(t, best)) best = t;
  }
  if (best != null) { flag(best.runCore); best.runCore = c; }
  return best;
}

// Core c's scheduling point: choose its thread and make it Running. null = the core is idle.
export function scheduleCore(c: i32): KThread | null {
  computeEff();
  store<u8>(RESCHED + <usize>c, 0);
  let t = pickLocal(c);
  if (t == null) t = steal(c);
  const old = cur(c);
  if (old >= 0 && (t == null || old != t.index) && thr(old).used && thr(old).state == KthreadS.Running && thr(old).runCore == c) thr(old).m.step(KthreadE.Preempt);
  if (t == null) { setCur(c, -1); return null; }
  if (t.state == KthreadS.Runnable) t.m.step(KthreadE.Schedule);
  setCur(c, t.index);
  // those that stood back for this turn compete again at the core's next scheduling point
  if (anyPending) {
    anyPending = false;
    for (let i = 0; i < threadTop; i++) {
      const u = thr(i);
      if (!u.used || !u.yieldAny) continue;
      if (u.runCore == c) { u.yieldAny = false; flag(c); } else anyPending = true;
    }
  }
  return t;
}
// Green threads: the next core in rotation that has a thread to run
export function scheduleNext(): KThread | null {
  // One scan says which cores have a ready thread queued or could take one that waits for another core (steal's
  // test): a core with neither has nothing to choose from, and its scheduling point is only "idle" (what
  // scheduleCore does when it finds nothing), without its two scans. Not while threads stand back: their holds end
  // inside the scans.
  let busy: u32 = 0xFFFFFFFF;
  computeEff();
  if (!holds) {
    busy = 0;
    for (let i = 0; i < threadTop; i++) {
      const t = thr(i);
      if (!t.used) continue;
      const s = t.state;
      if (s == KthreadS.Runnable) busy |= <u32>t.mask | (<u32>1 << t.runCore);
      else if (s == KthreadS.Running) busy |= <u32>1 << t.runCore;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < ncores; i++) {
      const c = (cursor + i) % ncores;
      if ((outMask >> c) & 1) continue;   // its thread is out on a helper
      if (!((busy >> c) & 1)) { store<u8>(RESCHED + <usize>c, 0); setCur(c, -1); continue; }
      const t = scheduleCore(c);
      if (t != null) { cursor = (c + 1) % ncores; return t; }
    }
    // nothing to run but threads that stand back (the one they stand back for cannot run either): they go on
    if (!holds || outMask) break;   // (a thread out on a helper still runs: those that stand back for it wait)
    for (let i = 0; i < threadTop; i++) unhold(i);
  }
  return null;
}
// After an SVC of t: must it give up its core now? (it stopped running, or a better thread is ready on its core)
// Depth of guest callbacks run inside host functions (kernel_preempt_hold): such a thread cannot give up its core, so
// a better thread made ready meanwhile waits for the callback's first SVC after it returns (RESCHED stays set)
let preemptHold: i32 = 0;
// Cores whose current thread is out on a helper Worker (bit c; RuntimeOptions.helpers, src/glue/rt_helpers.ts): the
// embedder gave the thread's context block away, so the core is not scheduled until it has it back
// (kernel_core_out). 0 unless the embedder uses helpers: nothing below changes then.
let outMask: u32 = 0;
export function schedCoreOut(c: i32, on: bool): void { if (c < 0 || c >= ncores) return; if (on) outMask |= <u32>1 << c; else outMask &= ~(<u32>1 << c); }
// Would core c's current thread give way at its next scheduling point (a slice end)? A ready thread of its core that
// is at least as good waits, or a hand-off is counting slices. The embedder then asks the helper for the thread.
export function schedContended(c: i32): bool {
  const i = c >= 0 && c < ncores ? cur(c) : -1;
  if (i < 0) return true;
  const t = thr(i);
  if (!t.used || t.state != KthreadS.Running || holds) return true;
  computeEff();
  for (let k = 0; k < threadTop; k++) {
    const u = thr(k);
    if (u.used && u != t && u.state == KthreadS.Runnable && u.runCore == c && u.eff <= t.eff) return true;
  }
  return false;
}
export function schedHolding(): bool { return preemptHold != 0; }
// Is a thread ready on a core other than t's, here (not out on a helper Worker)? On hardware it would run beside t;
// the poll back-off (backoff.ts) asks before it lets t spin on.
export function schedOthersReady(t: KThread): bool {
  const c = t.runCore;
  for (let i = 0; i < threadTop; i++) {
    const u = thr(i);
    if (!u.used || !u.ready || u.runCore == c) continue;
    if (((outMask >> u.runCore) & 1) && cur(u.runCore) == i) continue;
    return true;
  }
  return false;
}
export function schedPreemptHold(on: bool): void { preemptHold += on ? 1 : (preemptHold > 0 ? -1 : 0); }
export function schedMustSwitch(t: KThread): bool {
  if (t.state != KthreadS.Running) return true;
  if (preemptHold) return false;
  const c = t.runCore;
  if (load<u8>(RESCHED + <usize>c)) {
    computeEff();
    if (pickLocal(c) != t) return true;
    store<u8>(RESCHED + <usize>c, 0);
  }
  if (nwoke) {
    // the hand-off: the best of the better threads this SVC made ready elsewhere acts before t goes on
    computeEff();
    let best: KThread | null = null;
    for (let k = 0; k < nwoke; k++) {
      const u = thr(load<i32>(WOKE + (<usize>k << 2)));
      if (u.used && u.ready && u != t && u.eff < t.eff && (best == null || u.eff < best.eff)) best = u;
    }
    nwoke = 0;
    if (best != null) {
      if (!holdOf(t.index)) holds++;
      store<i32>(HOLD + (<usize>t.index << 2), best.index + 1); store<u8>(HOLDN + <usize>t.index, HOLD_SLICES);
      flag(c);
      return true;
    }
  }
  return false;
}
// t's time slice ran out: threads of its priority on its core take turns
export function schedSliceEnded(t: KThread): void {
  if (t.state != KthreadS.Running) return;
  if (holds) for (let i = 0; i < threadTop; i++) if (holdOf(i) == t.index + 1) {   // a slice of the thread they stand back for is used
    const n = load<u8>(HOLDN + <usize>i);
    if (n <= 1) unhold(i); else store<u8>(HOLDN + <usize>i, n - 1);
  }
  computeEff();
  for (let i = 0; i < threadTop; i++) {
    const u = thr(i);
    if (u.used && u != t && u.state == KthreadS.Runnable && u.runCore == t.runCore && u.eff == t.eff && !(holds && held(u))) {
      t.m.step(KthreadE.Preempt); t.rqSeq = ++seq; flag(t.runCore);
      return;
    }
  }
}
export function schedCurrent(c: i32): i32 { return c >= 0 && c < ncores ? cur(c) : -1; }
// Any thread ready on any core
export function schedAnyReady(): bool {
  for (let i = 0; i < threadTop; i++) if (thr(i).used && thr(i).ready) return true;
  return false;
}
// t's ideal core or mask changed: a ready thread moves to the core it now belongs on
export function schedMoved(t: KThread): void {
  const nc = runCoreOf(t), old = t.runCore;
  if (nc == old || !t.ready) return;
  if (t.state == KthreadS.Running) t.m.step(KthreadE.Preempt);
  if (cur(old) == t.index) setCur(old, -1);
  t.runCore = nc;
  flag(old); flag(nc);
}
