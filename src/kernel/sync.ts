// Waiting and waking (nxnative hle_thread.c, which follows mesosphère's KConditionVariable, KAddressArbiter and
// KSynchronizationObject): locks, condition variables, the address arbiter, synchronization objects, sleeps.
// The kernel never blocks: a wait puts the thread in Waiting with its deadline and the SVC returns "switch"; the
// result is written into the thread's saved context when the wait ends.
import { KthreadS, KthreadE } from "../kit/gen/tables";
import { R_TIMEOUT, WAITERS_BIT, FOREVER, ld32, st32 } from "./base";
import { KThread, thr, MAX_THREADS, threadFree, threadOfHandle, WK_LOCK, WK_CONDVAR, WK_ADDRESS, WK_SYNC, WK_SLEEP, WK_CLOCK } from "./thread";
import { O_THREAD, O_EVENT_R, hType, hObj, evRetain, evRelease, evSignaled } from "./handle";
import { schedReady, schedLeft, schedChanged } from "./sched";
import { guestNs, guestTicks } from "./clock";

export const PENDING: u64 = u64.MAX_VALUE;   // block(): the thread now waits; its result comes later
let wseq: u64 = 0;
export function syncInit(): void { wseq = 0; }

// ---- retained synchronization objects: type << 16 | index ----
// @ts-ignore: decorator
@inline function refOf(type: u32, obj: u32): u32 { return (type << 16) | obj; }
export function refOfThread(t: KThread): u32 { return refOf(O_THREAD, <u32>t.index); }
export function refOfEvent(e: i32): u32 { return refOf(O_EVENT_R, <u32>e); }
// Resolve and retain: only a thread or a readable event, no pseudo-handles. 0 = not one
export function syncOpen(h: u32): u32 {
  const ty = hType(h);
  if (ty == O_THREAD) { thr(<i32>hObj(h)).syncRefs++; return refOf(O_THREAD, hObj(h)); }
  if (ty == O_EVENT_R) { evRetain(<i32>hObj(h)); return refOf(O_EVENT_R, hObj(h)); }
  return 0;
}
export function syncClose(ref: u32): void {
  if (ref >> 16 == O_THREAD) {
    const t = thr(<i32>(ref & 0xFFFF));
    if (--t.syncRefs == 0 && t.closed && t.exited) threadFree(t);
  } else evRelease(<i32>(ref & 0xFFFF));
}
export function syncSignaled(ref: u32): bool {
  return ref >> 16 == O_THREAD ? thr(<i32>(ref & 0xFFFF)).exited : evSignaled(<i32>(ref & 0xFFFF));
}

// ---- wait primitives ----
// Suspend t until woken or timed out (ns < 0 forever, 0 = an immediate timeout). PENDING when it now waits.
export function block(t: KThread, kind: u32, ns: i64): u64 {
  t.wseq = ++wseq;
  if (ns == 0) return R_TIMEOUT;
  const now = guestNs();
  t.deadline = ns < 0 || <u64>ns > FOREVER - now ? FOREVER : now + <u64>ns;
  t.m.step(KthreadE.Block, kind);
  schedLeft(t);
  return PENDING;
}
// End t's wait with a result. A sleep has no result; a synchronization wait also reports its index and lets its
// objects go; a wait for the clock (GetSystemTick in the background) reports the tick.
export function wake(t: KThread, res: u64): void {
  const kind = t.waitKind;
  if (kind == WK_SYNC) {
    t.setX(0, res); t.setX(1, t.widx >= 0 ? <u64>t.widx : 0);
    const n = t.wn; t.wn = 0;
    for (let i = 0; i < n; i++) syncClose(t.wobj(i));
  } else if (kind == WK_CLOCK) { t.setX(0, guestTicks()); t.setX(1, guestTicks()); }
  else if (kind != WK_SLEEP) t.setX(0, res);
  t.deadline = FOREVER; t.wowner = -1;
  t.m.step(KthreadE.Wake);
  if (t.state == KthreadS.Runnable) schedReady(t);
  else schedChanged();   // paused: it runs after its resume, but a lock it waited for has one waiter less
}
// The first waiter in kernel order: the numerically lowest priority, then the earliest registered.
// WK_LOCK matches by lock address, WK_CONDVAR by key, WK_ADDRESS by address
export function pick(kind: u32, a: u64): KThread | null {
  let b: KThread | null = null;
  for (let i = 0; i < MAX_THREADS; i++) {
    const t = thr(i);
    if (!t.used || t.waitKind != kind || (kind == WK_CONDVAR ? t.wkey : t.waddr) != a) continue;
    if (b == null || t.prio < b.prio || (t.prio == b.prio && t.wseq < b.wseq)) b = t;
  }
  return b;
}
export function waiters(kind: u32, a: u64): i32 {
  let n = 0;
  for (let i = 0; i < MAX_THREADS; i++) {
    const t = thr(i);
    if (t.used && t.waitKind == kind && (kind == WK_CONDVAR ? t.wkey : t.waddr) == a) n++;
  }
  return n;
}

// ---- locks ----
// Release the lock at addr: hand it to its first waiter (with the waiters bit while more wait), or clear it
export function lockHandoff(addr: u64): void {
  const w = pick(WK_LOCK, addr);
  if (w == null) { st32(addr, 0); return; }
  const more = waiters(WK_LOCK, addr) > 1;
  st32(addr, w.wtag | (more ? WAITERS_BIT : 0));
  for (let i = 0; i < MAX_THREADS; i++) {   // the others now wait for w
    const t = thr(i);
    if (t.used && t != w && t.waitKind == WK_LOCK && t.waddr == addr) t.wowner = w.index;
  }
  wake(w, 0);
}
// A signalled condition waiter takes its lock: at once when it is free, else it sets the waiters bit and becomes a
// lock waiter, behind those already waiting at its priority
function lockAcquireFor(t: KThread): void {
  const addr = t.waddr, v = ld32(addr);
  if (v == 0) { st32(addr, t.wtag); wake(t, 0); return; }
  st32(addr, v | WAITERS_BIT);
  const owner = threadOfHandle(v & ~WAITERS_BIT, null);
  t.wowner = owner != null ? owner.index : -1;
  t.wseq = ++wseq;
  t.m.step(KthreadE.Requeue);
  schedChanged();
}
// SignalProcessWideKey: count <= 0 wakes all. The key word goes back to 0 when nobody waits on it any more
export function condSignal(key: u64, count: i32): void {
  for (let n = 0; count <= 0 || n < count; n++) {
    const w = pick(WK_CONDVAR, key);
    if (w == null) break;
    lockAcquireFor(w);
  }
  if (waiters(WK_CONDVAR, key) == 0) st32(key, 0);
}

// ---- address arbiter ----
export function addressWaiters(addr: u64): i32 { return waiters(WK_ADDRESS, addr); }
export function addressSignal(addr: u64, count: i32): void {
  for (let n = 0; count <= 0 || n < count; n++) {
    const w = pick(WK_ADDRESS, addr);
    if (w == null) break;
    wake(w, 0);
  }
}

// ---- synchronization objects ----
// The object became signaled: complete every wait that retains it, in the order the waits began. The index is
// recorded here, so a later clear or close cannot undo a completed wait
export function wakeSyncWaiters(ref: u32): void {
  for (;;) {
    let b: KThread | null = null, bi = 0;
    for (let i = 0; i < MAX_THREADS; i++) {
      const t = thr(i);
      if (!t.used || t.waitKind != WK_SYNC || (b != null && t.wseq > b.wseq)) continue;
      for (let k = 0; k < t.wn; k++) if (t.wobj(k) == ref) { b = t; bi = k; break; }
    }
    if (b == null) return;
    b.widx = bi; wake(b, 0);
  }
}
export function wakeClockWaiters(): void {
  for (;;) {
    let b: KThread | null = null;
    for (let i = 0; i < MAX_THREADS; i++) {
      const t = thr(i);
      if (t.used && t.waitKind == WK_CLOCK && (b == null || t.wseq < b.wseq)) b = t;
    }
    if (b == null) return;
    wake(b, 0);
  }
}

// ---- timeouts ----
// The earliest deadline of a waiting thread (guest ns), FOREVER when none has one
export function nextDeadline(): u64 {
  let d = FOREVER;
  for (let i = 0; i < MAX_THREADS; i++) { const t = thr(i); if (t.used && t.waitKind && t.deadline < d) d = t.deadline; }
  return d;
}
// The guest clock moved: end the waits whose deadline has come, earliest deadline first, then in wait order.
// A timed-out condition wait does not take its lock back (user mode does); a lock waiter that began as a timed
// condition wait leaves the lock's queue the same way, as in nxnative.
export function expire(): void {
  const now = guestNs();
  for (;;) {
    let b: KThread | null = null;
    for (let i = 0; i < MAX_THREADS; i++) {
      const t = thr(i);
      if (!t.used || !t.waitKind || t.deadline > now) continue;
      if (b == null || t.deadline < b.deadline || (t.deadline == b.deadline && t.wseq < b.wseq)) b = t;
    }
    if (b == null) return;
    wake(b, R_TIMEOUT);
  }
}
