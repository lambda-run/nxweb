// The scheduler: NCORES virtual cores, each running its highest-priority ready thread, first come first served among
// equals. The rest of the kernel talks to it only through the functions exported here, and all state is per core, so
// a later phase can run each core on its own Worker (scheduleCore(c) per Worker) without changing the callers.
//
// Green threads today: one host thread calls scheduleNext(), which gives the cores turns in rotation. A thread that
// is Running is its core's current thread; it stays Running while other cores have their turn.
import { KthreadS, KthreadE } from "../kit/gen/tables";
import { KThread, thr, MAX_THREADS, NCORES, runCoreOf, WK_LOCK } from "./thread";
import { kick, mtWorkers } from "./base";

const CUR: usize = memory.data(16);      // per core: the index of its current thread, -1 none
const RESCHED: usize = memory.data(4);   // per core: its ready set or a priority changed since it last chose
let seq: u64 = 0;
let cursor: i32 = 0;
let effDirty: bool = true;
let inherit: bool = true;

// @ts-ignore: decorator
@inline function cur(c: i32): i32 { return load<i32>(CUR + (<usize>c << 2)); }
// @ts-ignore: decorator
@inline function setCur(c: i32, i: i32): void { store<i32>(CUR + (<usize>c << 2), i); }
// @ts-ignore: decorator
@inline function flag(c: i32): void { store<u8>(RESCHED + <usize>c, 1); kick(c); }

export function schedInit(priorityInheritance: bool): void {
  for (let c = 0; c < NCORES; c++) { setCur(c, -1); store<u8>(RESCHED + <usize>c, 0); }
  seq = 0; cursor = 0; effDirty = true; inherit = priorityInheritance;
}
// Something the choice depends on changed (a priority, a lock wait, a core mask)
export function schedChanged(): void { effDirty = true; for (let c = 0; c < NCORES; c++) flag(c); }

// t became Runnable (started, woken, resumed): to the back of its priority on its core
export function schedReady(t: KThread): void {
  t.rqSeq = ++seq; t.runCore = runCoreOf(t); t.yieldAny = false;
  effDirty = true; flag(t.runCore);
  // SPIKE, Workers: an idle core of another Worker may take it (steal), so those Workers look too
  if (mtWorkers()) for (let c = 0; c < NCORES; c++) if (c != t.runCore && ((t.mask >> c) & 1)) kick(c);
}
// t yielded: behind the threads of its priority. any = YieldToAnyThread: lower-priority threads of the core get a turn
export function schedYield(t: KThread, any: bool): void {
  t.rqSeq = ++seq; t.yieldAny = any;
  flag(t.runCore);
}
// t stopped being ready (it blocked, exited or was paused)
export function schedLeft(t: KThread): void {
  if (cur(t.runCore) == t.index) setCur(t.runCore, -1);
  effDirty = true; flag(t.runCore);
}

// Effective priorities. A thread waiting for a lock lends its priority to the lock's owner (and through it to the
// owner's owner), as Horizon's kernel does; the guest never sees the lent priority (GetThreadPriority reports prio).
function computeEff(): void {
  if (!effDirty) return;
  effDirty = false;
  for (let i = 0; i < MAX_THREADS; i++) { const t = thr(i); if (t.used) t.eff = t.prio; }
  if (!inherit) return;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < MAX_THREADS; i++) {
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
  for (let i = 0; i < MAX_THREADS; i++) {
    const t = thr(i);
    if (!t.used || !t.ready || t.runCore != c) continue;
    if (t.yieldAny) { if (better(t, stoodBack)) stoodBack = t; }
    else if (better(t, best)) best = t;
  }
  return best != null ? best : stoodBack;
}
// An idle core takes a ready thread that its own core keeps waiting, if the thread's mask allows this core
function steal(c: i32): KThread | null {
  let best: KThread | null = null;
  for (let i = 0; i < MAX_THREADS; i++) {
    const t = thr(i);
    if (!t.used || t.state != KthreadS.Runnable || t.runCore == c || !((t.mask >> c) & 1)) continue;
    if (pickLocal(t.runCore) == t) continue;   // its core is about to run it
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
  for (let i = 0; i < MAX_THREADS; i++) {
    const u = thr(i);
    if (u.used && u.yieldAny && u.runCore == c) { u.yieldAny = false; flag(c); }
  }
  return t;
}
// Green threads: the next core in rotation that has a thread to run
export function scheduleNext(): KThread | null {
  for (let i = 0; i < NCORES; i++) {
    const c = (cursor + i) % NCORES;
    const t = scheduleCore(c);
    if (t != null) { cursor = (c + 1) % NCORES; return t; }
  }
  return null;
}
// After an SVC of t: must it give up its core now? (it stopped running, or a better thread is ready on its core)
export function schedMustSwitch(t: KThread): bool {
  if (t.state != KthreadS.Running) return true;
  const c = t.runCore;
  if (!load<u8>(RESCHED + <usize>c)) return false;
  computeEff();
  if (pickLocal(c) != t) return true;
  store<u8>(RESCHED + <usize>c, 0);
  return false;
}
// t's time slice ran out: threads of its priority on its core take turns
export function schedSliceEnded(t: KThread): void {
  if (t.state != KthreadS.Running) return;
  computeEff();
  for (let i = 0; i < MAX_THREADS; i++) {
    const u = thr(i);
    if (u.used && u != t && u.state == KthreadS.Runnable && u.runCore == t.runCore && u.eff == t.eff) {
      t.m.step(KthreadE.Preempt); t.rqSeq = ++seq; flag(t.runCore);
      return;
    }
  }
}
export function schedCurrent(c: i32): i32 { return c >= 0 && c < NCORES ? cur(c) : -1; }
// Any thread ready on any core
export function schedAnyReady(): bool {
  for (let i = 0; i < MAX_THREADS; i++) if (thr(i).used && thr(i).ready) return true;
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
