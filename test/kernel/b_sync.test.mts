// Synchronization: ArbitrateLock / ArbitrateUnlock, WaitProcessWideKeyAtomic / SignalProcessWideKey, WaitForAddress /
// SignalToAddress, events, WaitSynchronization, CancelSynchronization, timeouts, priority inheritance.
// Ported scenarios (nxnative dm/host/tests, C tests against the Apple host, re-expressed with the scripted guest):
//   t_condvar.c    -> "condition variable: the key is set before the lock is released" (and its old-order control)
//   t_sync_wait.c  -> the seven "t_sync_wait:" tests (framing, endpoints, signal-clear, close-reuse, snapshot,
//                     cancel-release, thread-close), each ending with its leak check
//   t_preempt.c    -> "t_preempt:" tests: condition_order, wake-to-run ordering through event, mutex and condition
//                     variable SVCs, and the handoff scope cases that have a meaning with a real per-core scheduler
// and from docs/reference/threads.md: SignalToAddress type 2 with count <= 0, WaitForAddress type 3, synchronization
// waits retain objects and completed notifications, one auto-clear event shared by a pool's workers (wake order).
import assert from "node:assert/strict";
import { test, Kernel, Thread, R, ACT, L, WAITERS, CUR_THREAD } from "./harness.mts";

const SVC = { Start: 0x09, Exit: 0x0A, Sleep: 0x0B, GetPrio: 0x0C, SetPrio: 0x0D, Core: 0x10, Signal: 0x11, Clear: 0x12, Close: 0x16, Reset: 0x17, Wait: 0x18, Cancel: 0x19,
  Lock: 0x1A, Unlock: 0x1B, CvWait: 0x1C, CvSignal: 0x1D, Activity: 0x32, WaitAddr: 0x34, SignalAddr: 0x35, CreateEvent: 0x45 };
const FOREVER = -1n;
const handles = (k: Kernel, ...hs: number[]) => { const a = k.alloc(4 * Math.max(hs.length, 1)); hs.forEach((h, i) => k.w32(a + 4 * i, h)); return a; };
const wait = (k: Kernel, t: Thread, hs: number[], timeout: number | bigint) => k.svc(t, SVC.Wait, 0, handles(k, ...hs), hs.length, timeout);
const waitNow = (k: Kernel, t: Thread, hs: number[], timeout: number | bigint = 0) => { wait(k, t, hs, timeout); return t.result; };
const leakFree = (k: Kernel) => { assert.deepEqual([k.count("handles"), k.count("alive"), k.count("objects"), k.count("events")], [1, 1, 1, 0]); k.check(); };
// End a helper thread and close its handle
const finish = (k: Kernel, t: Thread) => { if (t.state !== "Exited") k.svc(t, SVC.Exit); k.call(k.main, SVC.Close, t.handle); };

// ---------- locks ----------
test("ArbitrateLock / ArbitrateUnlock: the owner tag, the waiters bit, handoff by priority then arrival", () => {
  const k = new Kernel(), m = k.main, lock = k.word();
  const a = k.thread(44, 1), b = k.thread(44, 2), c = k.thread(30, 3);
  // the lock word changed between the user-mode test and the SVC: no wait
  k.w32(lock, 0);
  assert.equal(k.svc(a, SVC.Lock, m.handle, lock, a.handle), ACT.CONTINUE); assert.equal(a.result, 0);
  k.w32(lock, m.handle);   // held, but the waiters bit is not set: the caller's fast path will try again
  assert.equal(k.svc(a, SVC.Lock, m.handle, lock, a.handle), ACT.CONTINUE);
  // main holds it; a, b, then c (higher priority) wait
  k.w32(lock, 0);
  assert.equal(k.lock(m, lock), ACT.CONTINUE);
  for (const t of [a, b, c]) { assert.equal(k.lock(t, lock), ACT.SWITCH); assert.deepEqual([t.state, t.wait], ["Waiting", "lock"]); }
  assert.equal(k.r32(lock), m.handle | WAITERS);
  assert.deepEqual([a.info.owner, c.info.owner], [m.index, m.index]);
  k.check();
  k.unlock(m, lock);
  assert.equal(k.r32(lock), c.handle | WAITERS, "the highest priority first, the bit stays while others wait");
  assert.deepEqual([c.state, c.result, a.state], ["Runnable", 0, "Waiting"]);
  assert.equal(a.info.owner, c.index);
  k.unlock(c, lock);
  assert.equal(k.r32(lock), a.handle | WAITERS, "at equal priority the one that came first");
  k.unlock(a, lock);
  assert.equal(k.r32(lock), b.handle, "the last waiter gets the plain tag");
  k.unlock(b, lock);
  assert.equal(k.r32(lock), 0);
  // an unlock SVC with no waiter clears the word
  k.w32(lock, m.handle | WAITERS);
  assert.equal(k.call(m, SVC.Unlock, lock), 0); assert.equal(k.r32(lock), 0);
  assert.equal(k.call(m, SVC.Lock, m.handle, 0x1F0000000000n, m.handle), R.BAD_MEMORY);
  assert.equal(k.call(m, SVC.Unlock, 0x1F0000000000n), R.BAD_MEMORY);
  k.check();
});

test("priority inheritance: a lock's owner runs at its best waiter's priority; the guest still reads its own", () => {
  for (const inherit of [true, false]) {
    const k = new Kernel({ flags: inherit ? 0 : 4 }), m = k.main, lock = k.word();
    assert.equal(k.call(m, SVC.SetPrio, CUR_THREAD, 20), 0);
    const low = k.thread(50, 0), mid = k.thread(45, 0), high = k.thread(30, 0);
    assert.equal(k.svc(m, SVC.Sleep, 1_000_000), ACT.SWITCH);
    assert.equal(k.schedule(), high);
    // low takes the lock in user mode before the others ran (as if it had run earlier)
    k.w32(lock, low.handle);
    assert.equal(k.lock(high, lock), ACT.SWITCH);
    const next = k.schedule();
    if (inherit) {
      assert.equal(next, low, "the owner runs ahead of the priority-45 thread");
      assert.deepEqual([low.info.eff, low.info.prio], [30, 50]);
      assert.equal(k.call(low, SVC.GetPrio, 0, CUR_THREAD), 0); assert.equal(low.w(1), 50);
      k.unlock(low, lock);
      assert.equal(k.schedule(), high);
      assert.equal(low.info.eff, 50, "and falls back when the lock is handed over");
    } else assert.equal(next, mid, "without inheritance the middle thread runs: priority inversion");
    k.check();
  }
  // through a chain: high waits for a lock of mid, which waits for a lock of low
  const k = new Kernel(), m = k.main, l1 = k.word(), l2 = k.word();
  const low = k.thread(50, 1), mid = k.thread(45, 1), high = k.thread(30, 1), other = k.thread(47, 1);
  k.w32(l1, low.handle); k.w32(l2, mid.handle);
  assert.equal(k.lock(high, l2), ACT.SWITCH);
  assert.equal(k.lock(mid, l1), ACT.SWITCH);
  assert.equal(k.x.kernel_schedule_core(1), low.ctx);
  assert.equal(low.info.eff, 30);
  assert.equal(other.state, "Runnable");
});

// ---------- condition variables ----------
test("condition variable: the key is set before the lock is released (t_condvar.c)", () => {
  // W holds the mutex and waits; R then does what the SDK's user-mode code does: take the lock, read the key and
  // signal only if it is not 0, release the lock.
  const k = new Kernel(), w = k.main, r = k.thread(44, 1), mutex = k.word(), key = k.word();
  assert.equal(k.lock(w, mutex), ACT.CONTINUE);
  assert.equal(k.svc(w, SVC.CvWait, mutex, key, w.handle, FOREVER), ACT.SWITCH);
  assert.deepEqual([w.state, w.wait], ["Waiting", "condvar"]);
  assert.deepEqual([k.r32(key), k.r32(mutex)], [1, 0], "a thread that can take the lock sees that somebody waits");
  assert.equal(k.lock(r, mutex), ACT.CONTINUE);
  assert.notEqual(k.r32(key), 0);
  assert.equal(k.call(r, SVC.CvSignal, key, 1), 0);
  assert.equal(k.r32(key), 0, "no waiter is left on the key");
  assert.deepEqual([w.state, w.wait], ["Contending", "lock"], "the mutex is held: the woken waiter queues on it");
  assert.equal(k.r32(mutex), r.handle | WAITERS);
  assert.equal(w.info.owner, r.index);
  k.check();
  k.unlock(r, mutex);
  assert.deepEqual([w.state, w.result, k.r32(mutex)], ["Runnable", 0, w.handle], "W returns 0 holding the lock");
  // The control: what the old order (release, then set the key) let happen. A thread that looked at the key between
  // the two steps saw 0 and sent no signal; the kernel's order leaves no such moment, which the asserts above pin.
  k.check();
});

test("SignalProcessWideKey: count, order by priority then arrival, the key word, a free lock is taken at once (t_preempt condition_order)", () => {
  const k = new Kernel(), m = k.main, mutex = k.word(), key = k.word();
  const a = k.thread(44, 1), b = k.thread(44, 2), c = k.thread(30, 3), d = k.thread(44, 3);
  for (const t of [a, b, c, d]) {
    assert.equal(k.lock(t, mutex), ACT.CONTINUE);
    assert.equal(k.svc(t, SVC.CvWait, mutex, key, t.handle, FOREVER), ACT.SWITCH);
    assert.equal(k.r32(mutex), 0);
  }
  assert.equal(k.call(m, SVC.CvSignal, key, 1), 0);
  assert.deepEqual([a, b, c, d].map(t => t.state), ["Waiting", "Waiting", "Runnable", "Waiting"], "the priority-30 waiter first");
  assert.deepEqual([k.r32(mutex), k.r32(key), c.result], [c.handle, 1, 0], "it holds the free lock; the key stays while others wait");
  assert.equal(k.call(m, SVC.CvSignal, key, 1), 0);
  assert.deepEqual([a, b, d].map(t => t.state), ["Contending", "Waiting", "Waiting"], "then the earliest of the equals, which queues on the held lock");
  assert.equal(k.r32(mutex), c.handle | WAITERS);
  assert.equal(k.call(m, SVC.CvSignal, key, 0), 0);   // 0 or less: all
  assert.deepEqual([a, b, d].map(t => t.state), ["Contending", "Contending", "Contending"]);
  assert.equal(k.r32(key), 0);
  k.unlock(c, mutex); assert.equal(k.r32(mutex), a.handle | WAITERS);
  k.unlock(a, mutex); assert.equal(k.r32(mutex), b.handle | WAITERS);
  k.unlock(b, mutex); assert.equal(k.r32(mutex), d.handle);
  assert.equal(k.call(m, SVC.CvSignal, key, -1), 0, "a signal with no waiter");
  assert.equal(k.r32(key), 0);
  assert.equal(k.call(m, SVC.CvSignal, 0x1F0000000000n, 1), R.BAD_MEMORY);
  assert.equal(k.call(m, SVC.CvWait, 0x1F0000000000n, key, 1, 0), R.BAD_MEMORY);
  k.check();
});

test("WaitProcessWideKeyAtomic: releasing the lock hands it to a lock waiter; timeouts do not take the lock back", () => {
  const k = new Kernel(), m = k.main, mutex = k.word(), key = k.word();
  const a = k.thread(44, 1), b = k.thread(44, 2);
  assert.equal(k.lock(a, mutex), ACT.CONTINUE);
  assert.equal(k.lock(b, mutex), ACT.SWITCH);
  k.tick(100);
  assert.equal(k.svc(a, SVC.CvWait, mutex, key, a.handle, 5000), ACT.SWITCH);
  assert.deepEqual([b.state, b.result, k.r32(mutex)], ["Runnable", 0, b.handle]);
  assert.equal(k.nextTimeout(), 5100n);
  k.tick(4999); assert.equal(a.state, "Waiting");
  k.tick(1);
  assert.deepEqual([a.state, a.result], ["Runnable", R.TIMEOUT]);
  assert.deepEqual([k.r32(mutex), k.r32(key)], [b.handle, 1], "the lock is b's still; the key word is left as nxnative leaves it");
  // timeout 0: the key is set and the lock released, then an immediate timeout
  k.unlock(b, mutex);
  assert.equal(k.lock(a, mutex), ACT.CONTINUE);
  k.w32(key, 0);
  assert.equal(k.svc(a, SVC.CvWait, mutex, key, a.handle, 0), ACT.CONTINUE);
  assert.deepEqual([a.result, k.r32(mutex), k.r32(key), a.state], [R.TIMEOUT, 0, 1, "Running"]);
  // a signalled waiter queued on its mutex still times out at its own deadline, and leaves the queue
  assert.equal(k.lock(b, mutex), ACT.CONTINUE);
  assert.equal(k.lock(a, mutex), ACT.SWITCH);   // a waits for the lock...
  k.unlock(b, mutex);                            // ...and gets it
  assert.equal(k.svc(a, SVC.CvWait, mutex, key, a.handle, 300), ACT.SWITCH);
  assert.equal(k.lock(b, mutex), ACT.CONTINUE);
  assert.equal(k.call(b, SVC.CvSignal, key, 1), 0);
  assert.equal(a.state, "Contending");
  k.tick(300);
  assert.deepEqual([a.state, a.result], ["Runnable", R.TIMEOUT]);
  k.unlock(b, mutex);
  assert.equal(k.r32(mutex), 0, "the stale waiters bit only costs the owner one unlock SVC");
  k.check();
});

test("a paused thread keeps its place in a condition wait and in the lock queue behind it", () => {
  const k = new Kernel(), m = k.main, mutex = k.word(), key = k.word();
  const a = k.thread(44, 1), b = k.thread(44, 2);
  assert.equal(k.lock(a, mutex), ACT.CONTINUE);
  assert.equal(k.svc(a, SVC.CvWait, mutex, key, a.handle, FOREVER), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Activity, a.handle, 1), 0);
  assert.deepEqual([a.state, a.wait], ["PausedWaiting", "condvar"]);
  assert.equal(k.lock(b, mutex), ACT.CONTINUE);
  assert.equal(k.call(b, SVC.CvSignal, key, 1), 0);
  assert.deepEqual([a.state, a.wait], ["PausedContending", "lock"]);
  assert.equal(k.call(m, SVC.Activity, a.handle, 0), 0);
  assert.equal(a.state, "Contending");
  assert.equal(k.call(m, SVC.Activity, a.handle, 1), 0);
  assert.equal(a.state, "PausedContending");
  k.unlock(b, mutex);
  assert.deepEqual([a.state, k.r32(mutex), a.result], ["PausedRunnable", a.handle, 0], "it owns the lock while paused, as on Horizon");
  for (let i = 0; i < 4; i++) assert.notEqual(k.schedule(), a);
  assert.equal(k.call(m, SVC.Activity, a.handle, 0), 0);
  k.run(a);
  k.check();
});

// ---------- address arbiter ----------
test("WaitForAddress: the four arbitration types, their refusals and timeouts", () => {
  const k = new Kernel(), m = k.main, a = k.word(), q = k.alloc(8);
  const w = k.thread(44, 1);
  const waits = (type: number, mem: number, value: number | bigint, timeout: number | bigint = FOREVER) => { k.w32(a, mem); return k.svc(w, SVC.WaitAddr, a, type, value, timeout); };
  const release = () => { assert.equal(w.state, "Waiting"); assert.equal(w.wait, "address"); assert.equal(k.call(m, SVC.SignalAddr, a, 0, 0, 1), 0); assert.equal(w.result, 0); };
  // 0 WaitIfLessThan (signed)
  assert.equal(waits(0, 5, 6), ACT.SWITCH); release();
  assert.equal(waits(0, 6, 6), ACT.CONTINUE); assert.equal(w.result, R.BAD_STATE);
  assert.equal(waits(0, 0xFFFFFFFF, 0), ACT.SWITCH, "-1 < 0"); release();
  // 1 DecrementAndWaitIfLessThan
  assert.equal(waits(1, 5, 6), ACT.SWITCH); assert.equal(k.r32(a), 4); release();
  assert.equal(waits(1, 7, 6), ACT.CONTINUE); assert.deepEqual([w.result, k.r32(a)], [R.BAD_STATE, 7]);
  // 2 WaitIfEqual
  assert.equal(waits(2, 9, 9), ACT.SWITCH); release();
  assert.equal(waits(2, 9, 8), ACT.CONTINUE); assert.equal(w.result, R.BAD_STATE);
  // 3 WaitIfEqual64 (Horizon 18): the whole 64-bit value
  k.w64(q, 0x1_0000_0002n);
  assert.equal(k.svc(w, SVC.WaitAddr, q, 3, 0x1_0000_0002n, FOREVER), ACT.SWITCH);
  assert.equal(k.call(m, SVC.SignalAddr, q, 0, 0, 1), 0); assert.equal(w.result, 0);
  assert.equal(k.svc(w, SVC.WaitAddr, q, 3, 2, FOREVER), ACT.CONTINUE); assert.equal(w.result, R.BAD_STATE, "the low words alone are equal");
  // timeouts: a poll, and a deadline
  assert.equal(waits(2, 1, 1, 0), ACT.CONTINUE); assert.equal(w.result, R.TIMEOUT);
  k.tick(10);
  assert.equal(waits(2, 1, 1, 250), ACT.SWITCH);
  assert.equal(k.nextTimeout(), 260n);
  k.tick(250); assert.deepEqual([w.state, w.result], ["Runnable", R.TIMEOUT]);
  assert.equal(k.call(w, SVC.WaitAddr, 0x1F0000000000n, 2, 0, 0), R.BAD_MEMORY);
  k.check();
});

test("SignalToAddress: Signal, SignalAndIncrementIfEqual, SignalAndModifyByWaitingCountIfEqual", () => {
  const k = new Kernel(), m = k.main, a = k.word(7);
  const ts = [k.thread(44, 1), k.thread(44, 2), k.thread(30, 3), k.thread(44, 3)];
  const park = (n: number) => { for (const t of ts.slice(0, n)) { if (t.state !== "Waiting") assert.equal(k.svc(t, SVC.WaitAddr, a, 2, k.r32(a), FOREVER), ACT.SWITCH); } };
  const waiting = () => ts.filter(t => t.state === "Waiting").length;
  // type 0: count, in priority then arrival order
  park(4);
  assert.equal(k.call(m, SVC.SignalAddr, a, 0, 0, 1), 0);
  assert.deepEqual(ts.map(t => t.state), ["Waiting", "Waiting", "Runnable", "Waiting"]);
  assert.equal(k.call(m, SVC.SignalAddr, a, 0, 0, 1), 0);
  assert.deepEqual(ts.map(t => t.state), ["Runnable", "Waiting", "Runnable", "Waiting"]);
  assert.equal(k.call(m, SVC.SignalAddr, a, 0, 0, 0), 0); assert.equal(waiting(), 0);
  // type 1: only if the value is the expected one
  park(2);
  assert.equal(k.call(m, SVC.SignalAddr, a, 1, 8, 1), R.BAD_STATE); assert.deepEqual([k.r32(a), waiting()], [7, 2]);
  assert.equal(k.call(m, SVC.SignalAddr, a, 1, 7, 1), 0); assert.deepEqual([k.r32(a), waiting()], [8, 1]);
  assert.equal(k.call(m, SVC.SignalAddr, a, 0, 0, -1), 0);
  // type 2, count > 0: no waiter +1; waiters <= count -1; more waiters than count: unchanged
  k.w32(a, 10);
  assert.equal(k.call(m, SVC.SignalAddr, a, 2, 10, 1), 0); assert.equal(k.r32(a), 11);
  park(1);
  assert.equal(k.call(m, SVC.SignalAddr, a, 2, 11, 1), 0); assert.deepEqual([k.r32(a), waiting()], [10, 0]);
  park(3);
  assert.equal(k.call(m, SVC.SignalAddr, a, 2, 10, 2), 0); assert.deepEqual([k.r32(a), waiting()], [10, 1]);
  assert.equal(k.call(m, SVC.SignalAddr, a, 2, 11, 2), R.BAD_STATE); assert.equal(waiting(), 1);
  // type 2, count <= 0 (all): with waiters -2 (mesosphère; it was -1 once, and Unity's job fences let waiters through early), without +1
  assert.equal(k.call(m, SVC.SignalAddr, a, 2, 10, 0), 0); assert.deepEqual([k.r32(a), waiting()], [8, 0]);
  assert.equal(k.call(m, SVC.SignalAddr, a, 2, 8, -1), 0); assert.equal(k.r32(a), 9);
  assert.equal(k.call(m, SVC.SignalAddr, 0x1F0000000000n, 0, 0, 1), R.BAD_MEMORY);
  k.check();
});

// ---------- events and WaitSynchronization: t_sync_wait.c ----------
test("t_sync_wait: framing (handle validation before readiness, 64 objects, poll and ready before a pending cancel)", () => {
  const k = new Kernel(), m = k.main, e = k.event();
  assert.deepEqual([e.w, e.r], [0x1002, 0x1003]);
  assert.equal(k.call(m, SVC.Signal, e.w), 0);
  assert.equal(waitNow(k, m, [e.r, 0]), R.BAD_HANDLE, "a signaled first entry does not hide an invalid later handle");
  assert.equal(waitNow(k, m, [e.r, e.w]), R.BAD_HANDLE, "an event's writable end");
  assert.equal(waitNow(k, m, [e.r, CUR_THREAD]), R.BAD_HANDLE, "the pseudo-handle");
  assert.equal(k.call(m, SVC.Wait, 0, handles(k), -1, 0), R.OUT_OF_RANGE);
  assert.equal(k.call(m, SVC.Wait, 0, handles(k), 65, 0), R.OUT_OF_RANGE);
  assert.equal(k.call(m, SVC.Wait, 0, 0, 0, 0), R.TIMEOUT, "no handles, a poll");
  assert.equal(waitNow(k, m, [e.r, e.r]), 0); assert.equal(m.w(1), 0);
  assert.equal(waitNow(k, m, new Array(64).fill(e.r)), 0); assert.equal(m.w(1), 0);
  assert.equal(k.call(m, SVC.Wait, 0, 0x1F0000000000n, 2, 0), R.BAD_MEMORY);
  // an already signaled object and a poll both come before a pending cancellation
  assert.equal(k.call(m, SVC.Cancel, CUR_THREAD), 0);
  assert.equal(waitNow(k, m, [e.r], FOREVER), 0);
  assert.equal(k.call(m, SVC.Clear, e.r), 0);
  assert.equal(waitNow(k, m, [e.r], 0), R.TIMEOUT);
  assert.equal(waitNow(k, m, [e.r], FOREVER), R.CANCELLED);
  assert.equal(waitNow(k, m, [e.r], 0), R.TIMEOUT);
  assert.equal(wait(k, m, [e.r], 100000), ACT.SWITCH);
  k.tick(100000); assert.equal(m.result, R.TIMEOUT);
  k.check();   // the event has its two handles and no wait reference
  k.call(m, SVC.Close, e.w); k.call(m, SVC.Close, e.r);
  leakFree(k);
});

test("t_sync_wait: endpoints (which end each event SVC takes; waiting does not clear a kernel event)", () => {
  const k = new Kernel(), m = k.main, e = k.event();
  assert.equal(waitNow(k, m, [e.r]), R.TIMEOUT);
  assert.equal(k.call(m, SVC.Signal, e.r), R.BAD_HANDLE);
  assert.equal(k.call(m, SVC.Reset, e.w), R.BAD_HANDLE);
  assert.equal(k.call(m, SVC.Reset, m.handle), R.BAD_HANDLE, "ResetSignal on a thread: invalid handle, not invalid state");
  assert.equal(k.call(m, SVC.Reset, CUR_THREAD), R.BAD_HANDLE);
  assert.equal(k.call(m, SVC.Reset, e.r), R.BAD_STATE);
  assert.equal(k.call(m, SVC.Clear, e.w), 0);
  assert.equal(k.call(m, SVC.Clear, m.handle), R.BAD_HANDLE);
  assert.equal(k.call(m, SVC.Signal, e.w), 0);
  assert.equal(waitNow(k, m, [e.r]), 0);
  assert.equal(waitNow(k, m, [e.r]), 0);
  assert.equal(k.call(m, SVC.Clear, e.r), 0);
  assert.equal(waitNow(k, m, [e.r]), R.TIMEOUT);
  assert.equal(k.call(m, SVC.Signal, e.w), 0);
  assert.equal(k.call(m, SVC.Reset, e.r), 0);
  assert.equal(k.call(m, SVC.Reset, e.r), R.BAD_STATE);
  // an allocator's final release signals, then closes the producer's end
  assert.equal(k.call(m, SVC.Signal, e.w), 0); assert.equal(k.call(m, SVC.Close, e.w), 0);
  assert.equal(waitNow(k, m, [e.r]), 0); assert.equal(k.call(m, SVC.Close, e.r), 0);
  assert.equal(k.call(m, SVC.Close, e.r), 0, "CloseHandle answers 0 for a handle that is none, as nxnative");
  assert.equal(k.call(m, SVC.Close, 0), 0);
  leakFree(k);
});

test("t_sync_wait: signal-clear (a signal completes every wait and records its index; a clear cannot undo it)", () => {
  const k = new Kernel(), m = k.main, a = k.event(), b = k.event();
  const first = k.thread(44, 1), second = k.thread(44, 2);
  assert.equal(wait(k, first, [a.r, b.r, b.r], 500_000_000), ACT.SWITCH);
  assert.equal(wait(k, second, [b.r], 500_000_000), ACT.SWITCH);
  assert.deepEqual([first.wait, first.info.wn], ["sync", 3]);
  assert.equal(k.call(m, SVC.Signal, b.w), 0);
  assert.equal(k.call(m, SVC.Clear, b.w), 0);   // before either waiter runs again
  assert.deepEqual([first.state, first.result, first.w(1)], ["Runnable", 0, 1]);
  assert.deepEqual([second.state, second.result, second.w(1)], ["Runnable", 0, 0]);
  assert.equal(waitNow(k, m, [b.r]), R.TIMEOUT);
  for (const h of [a.w, a.r, b.w, b.r]) k.call(m, SVC.Close, h);
  finish(k, first); finish(k, second);
  leakFree(k);
});

test("t_sync_wait: close-reuse (a wait keeps its object when the handle is closed and its number reused)", () => {
  const k = new Kernel(), m = k.main, old = k.event(), w = k.thread(44, 1);
  assert.equal(wait(k, w, [old.r], 500_000_000), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Close, old.r), 0);
  const replacement = k.event();
  assert.equal(replacement.w, old.r, "the closed handle's number is handed out again");
  assert.equal(k.call(m, SVC.Signal, replacement.w), 0);
  assert.equal(w.state, "Waiting", "the unrelated event does not end the wait");
  assert.equal(k.call(m, SVC.Signal, old.w), 0);
  assert.deepEqual([w.state, w.result, w.w(1)], ["Runnable", 0, 0]);
  for (const h of [old.w, replacement.w, replacement.r]) k.call(m, SVC.Close, h);
  finish(k, w);
  leakFree(k);
});

test("t_sync_wait: snapshot (the handle array is read once; rewriting it during the wait changes nothing)", () => {
  const k = new Kernel(), m = k.main, old = k.event(), replacement = k.event(), w = k.thread(44, 1);
  const arr = handles(k, old.r);
  assert.equal(k.svc(w, SVC.Wait, 0, arr, 1, 500_000_000), ACT.SWITCH);
  k.w32(arr, replacement.r);
  assert.equal(k.call(m, SVC.Signal, replacement.w), 0); assert.equal(w.state, "Waiting");
  assert.equal(k.call(m, SVC.Signal, old.w), 0);
  assert.deepEqual([w.state, w.result, w.w(1)], ["Runnable", 0, 0]);
  for (const h of [old.w, old.r, replacement.w, replacement.r]) k.call(m, SVC.Close, h);
  finish(k, w);
  leakFree(k);
});

test("t_sync_wait: cancel-release (CancelSynchronization ends a blocked wait at once and lets its objects go)", () => {
  const k = new Kernel(), m = k.main, e = k.event(), w = k.thread(44, 1);
  assert.equal(wait(k, w, [e.r, e.r], 500_000_000), ACT.SWITCH);
  k.call(m, SVC.Close, e.w); k.call(m, SVC.Close, e.r);
  assert.equal(k.count("events"), 1, "the wait alone keeps the event alive");
  assert.equal(k.call(m, SVC.Cancel, w.handle), 0);
  assert.deepEqual([w.state, w.result, w.w(1)], ["Runnable", R.CANCELLED, 0]);
  assert.equal(k.count("events"), 0);
  // a wait on nothing can only be cancelled (or time out)
  assert.equal(wait(k, w, [], 500_000_000), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Cancel, w.handle), 0);
  assert.equal(w.result, R.CANCELLED);
  // not waiting: the cancel is sticky and ends the next wait that would block, once
  const e2 = k.event();
  assert.equal(k.call(m, SVC.Cancel, w.handle), 0);
  assert.equal(w.info.cancel, 1);
  assert.equal(waitNow(k, w, [e2.r], FOREVER), R.CANCELLED);
  assert.equal(wait(k, w, [e2.r], 1000), ACT.SWITCH);
  k.tick(1000); assert.equal(w.result, R.TIMEOUT);
  assert.equal(k.call(m, SVC.Cancel, 0x1999), R.BAD_HANDLE);
  k.call(m, SVC.Close, e2.w); k.call(m, SVC.Close, e2.r);
  finish(k, w);
  leakFree(k);
});

test("t_sync_wait: thread-close (a wait on a thread whose handle was closed and reused completes when it exits)", () => {
  const k = new Kernel(), m = k.main, target = k.thread(44, 1), w = k.thread(44, 2);
  assert.equal(wait(k, w, [target.handle, target.handle], 500_000_000), ACT.SWITCH);
  const oldHandle = target.handle;
  assert.equal(k.call(m, SVC.Close, oldHandle), 0);
  const replacement = k.event();
  assert.equal(replacement.w, oldHandle);
  assert.equal(k.x.kernel_svc(SVC.Exit, target.ctx), ACT.SWITCH);
  assert.deepEqual([w.state, w.result, w.w(1)], ["Runnable", 0, 0]);
  assert.equal(k.count("objects"), 2, "the exited thread's record went with its last wait reference");
  k.call(m, SVC.Close, replacement.w); k.call(m, SVC.Close, replacement.r);
  finish(k, w);
  leakFree(k);
});

test("WaitSynchronization: several objects, the first signaled index, a timeout releases what it retained", () => {
  const k = new Kernel(), m = k.main, a = k.event(), b = k.event(), t = k.thread(44, 1), w = k.thread(44, 2);
  assert.equal(k.call(m, SVC.Signal, b.w), 0);
  assert.equal(waitNow(k, m, [a.r, t.handle, b.r]), 0); assert.equal(m.w(1), 2);
  assert.equal(k.call(m, SVC.Signal, a.w), 0);
  assert.equal(waitNow(k, m, [a.r, t.handle, b.r]), 0); assert.equal(m.w(1), 0);
  k.call(m, SVC.Clear, a.r); k.call(m, SVC.Clear, b.r);
  k.tick(7);
  assert.equal(wait(k, w, [a.r, t.handle, b.r], 1000), ACT.SWITCH);
  assert.deepEqual([t.info.syncRefs, k.nextTimeout()], [1, 1007n]);
  k.check();
  k.tick(1000);
  assert.deepEqual([w.state, w.result, w.w(1), t.info.syncRefs, w.info.wn], ["Runnable", R.TIMEOUT, 0, 0, 0]);
  // a wait that is paused completes under the pause
  assert.equal(wait(k, w, [a.r], FOREVER), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Activity, w.handle, 1), 0);
  assert.equal(k.call(m, SVC.Signal, a.w), 0);
  assert.deepEqual([w.state, w.result], ["PausedRunnable", 0]);
  assert.equal(k.call(m, SVC.Activity, w.handle, 0), 0);
  k.check();
});

test("events for the embedder's services: new, duplicate readable end, signal, clear", () => {
  const k = new Kernel(), m = k.main, out = k.alloc(4);
  const r = k.x.kernel_event_new(out), w = k.r32(out);
  assert.deepEqual([r, w], [0x1002, 0x1003]);
  const r2 = k.x.kernel_event_dup_readable(r);
  assert.equal(r2, 0x1004);
  assert.equal(k.x.kernel_event_dup_readable(w), 0);
  const t = k.thread(44, 1);
  assert.equal(wait(k, t, [r2], FOREVER), ACT.SWITCH);
  assert.equal(k.x.kernel_event_signal(r), 0, "signal takes the writable end");
  assert.equal(k.x.kernel_event_signal(w), 1);
  assert.deepEqual([t.state, t.result], ["Runnable", 0]);
  assert.equal(k.x.kernel_event_clear(r2), 1);
  assert.equal(waitNow(k, m, [r]), R.TIMEOUT);
  assert.equal(k.x.kernel_event_clear(0x1F00), 0);
  const lone = k.x.kernel_event_new(0);   // never signaled: no writable end
  assert.equal(waitNow(k, m, [lone]), R.TIMEOUT);
  for (const h of [r, w, r2, lone]) k.call(m, SVC.Close, h);
  assert.equal(k.count("events"), 0);
  k.check();
});

// ---------- t_preempt.c ----------
test("t_preempt: a woken higher-priority thread on the signaller's core runs before the signaller returns (event, mutex, condition variable)", () => {
  for (const kind of ["event", "mutex", "condvar"]) {
    const k = new Kernel(), m = k.main;                         // the signaller: priority 44, core 0
    const e = k.event(), mutex = k.word(), key = k.word();
    assert.equal(k.call(m, 0x08, 0, L.code, 0, L.stack + 0x40000, 30, 0), 0);   // the worker: priority 30, core 0
    const worker = k.byIndex(k.x.kernel_thread_index(m.w(1)));
    if (kind === "mutex") assert.equal(k.lock(m, mutex), ACT.CONTINUE);
    assert.equal(k.svc(m, SVC.Start, worker.handle), ACT.SWITCH);
    assert.equal(k.schedule(), worker);
    const blocked = kind === "event" ? wait(k, worker, [e.r], FOREVER)
      : kind === "mutex" ? k.lock(worker, mutex)
      : (k.lock(worker, mutex), k.svc(worker, SVC.CvWait, mutex, key, worker.handle, FOREVER));
    assert.equal(blocked, ACT.SWITCH);
    assert.equal(k.schedule(), m);
    const act = kind === "event" ? k.svc(m, SVC.Signal, e.w) : kind === "mutex" ? k.svc(m, SVC.Unlock, mutex) : k.svc(m, SVC.CvSignal, key, 1);
    assert.equal(act, ACT.SWITCH, `${kind}: the signaller gives its core up`);
    assert.equal(k.schedule(), worker);
    assert.equal(worker.result, 0);
    assert.equal(k.svc(worker, SVC.Exit), ACT.SWITCH);           // its payload and exit...
    assert.equal(k.schedule(), m);                               // ...come before the signaller goes on
    assert.equal(m.result, 0);
    k.check();
  }
});

test("t_preempt: equal-priority, other-core, migratable and paused peers do not hold the signaller", () => {
  const k = new Kernel(), m = k.main, e = k.event();
  const equal = k.thread(44, 0), other = k.thread(30, 1), paused = k.thread(30, 0, { start: false });
  assert.equal(k.call(m, SVC.Activity, paused.handle, 1), 0);
  assert.equal(k.call(m, SVC.Start, paused.handle), 0);
  assert.equal(k.svc(m, SVC.Sleep, 0), ACT.SWITCH);              // let the equal one reach its wait
  assert.equal(wait(k, equal, [e.r], FOREVER), ACT.SWITCH);
  assert.equal(wait(k, other, [e.r], FOREVER), ACT.SWITCH);
  assert.equal(k.svc(m, SVC.Signal, e.w), ACT.CONTINUE);
  assert.deepEqual([equal.state, other.state, paused.state], ["Runnable", "Runnable", "PausedRunnable"]);
  // a busy higher-priority peer on another core that nobody woke is no reason to wait either
  assert.equal(k.svc(m, SVC.Core), ACT.CONTINUE);
  k.check();
});

test("t_preempt: a worker woken by the woken dispatcher runs before the signaller; one that yields to any thread releases it", () => {
  const k = new Kernel(), m = k.main, e1 = k.event(), e2 = k.event();
  const dispatcher = k.thread(30, 0, { start: false }), worker = k.thread(30, 0, { start: false });
  assert.equal(k.svc(m, SVC.Start, dispatcher.handle), ACT.SWITCH);
  assert.equal(wait(k, dispatcher, [e1.r], FOREVER), ACT.SWITCH);
  assert.equal(k.svc(m, SVC.Start, worker.handle), ACT.SWITCH);
  assert.equal(wait(k, worker, [e2.r], FOREVER), ACT.SWITCH);
  assert.equal(k.svc(m, SVC.Signal, e1.w), ACT.SWITCH);
  assert.equal(k.schedule(), dispatcher);
  assert.equal(k.svc(dispatcher, SVC.Signal, e2.w), ACT.CONTINUE, "equal priority: the dispatcher goes on");
  assert.equal(wait(k, dispatcher, [e2.r], 0), ACT.CONTINUE);
  k.call(dispatcher, SVC.Clear, e1.r);
  assert.equal(wait(k, dispatcher, [e1.r], FOREVER), ACT.SWITCH);
  assert.equal(k.schedule(), worker, "the worker the dispatcher woke, not the signaller");
  // YieldToAnyThread takes the worker off the core for a turn: the priority-44 signaller runs
  assert.equal(k.svc(worker, SVC.Sleep, 0xFFFFFFFFFFFFFFFEn), ACT.SWITCH);
  assert.equal(k.schedule(), m);
  assert.equal(m.result, 0);
  k.check();
});

test("one event, several waiters: a kernel event notifies them all (the SDK's auto-clear event wakes one condition waiter)", () => {
  const k = new Kernel(), m = k.main, e = k.event();
  const ws = [k.thread(44, 1), k.thread(40, 2), k.thread(44, 3)];
  for (const w of ws) assert.equal(wait(k, w, [e.r], FOREVER), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Signal, e.w), 0);
  assert.deepEqual(ws.map(w => [w.state, w.result]), [["Runnable", 0], ["Runnable", 0], ["Runnable", 0]]);
  k.check();
});
