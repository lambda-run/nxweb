// Threads and the scheduler: every thread SVC with its result codes, priorities, the eight virtual cores, yields,
// preemption, sleeping, pausing (SetThreadActivity / GetThreadContext3) and thread-local memory.
import assert from "node:assert/strict";
import { test, Kernel, Thread, R, ACT, L, P, CUR_THREAD } from "./harness.mts";

const SVC = { Create: 0x08, Start: 0x09, Exit: 0x0A, Sleep: 0x0B, GetPrio: 0x0C, SetPrio: 0x0D, GetMask: 0x0E, SetMask: 0x0F, Core: 0x10,
  Close: 0x16, Wait: 0x18, GetId: 0x25, GetInfo: 0x29, Activity: 0x32, Context: 0x33 };

test("threads: the main thread is nxnative's (handle 0x1001, id 0x51, priority 44, core 0)", () => {
  const k = new Kernel(), m = k.main;
  assert.equal(m.handle, 0x1001);
  assert.deepEqual([m.info.id, m.info.prio, m.info.core, m.info.mask], [0x51n, 44, 0, 1n]);
  assert.equal(m.state, "Runnable");
  assert.equal(k.schedule(), m);
  assert.equal(m.state, "Running");
  assert.equal(m.x(1), 0x1001n);                                  // x1 = its own handle
  assert.equal(k.dv.getBigUint64(m.ctx + 0x100, true), BigInt(L.code));   // pc
  assert.equal(k.dv.getBigUint64(m.ctx + 0xF8, true), BigInt(L.stack + 0x10000));   // sp
  assert.equal(m.x(30), 0xFFFFFFF0n);
  assert.equal(k.call(m, SVC.GetId, 0, CUR_THREAD), 0); assert.equal(m.x(1), 0x51n);
  assert.equal(k.call(m, SVC.GetPrio, 0, 0x1001), 0); assert.equal(m.w(1), 44);
  assert.equal(k.call(m, SVC.Core), 0);
  assert.deepEqual(k.red, []);
});

test("threads: the kernel's fields of the ThreadLocalRegion (thread object at +0x1F8, thread id at +0x110)", () => {
  const k = new Kernel(), t = k.thread(40, 1);
  for (const th of [k.main, t]) {
    const tlr = Number(k.dv.getBigUint64(th.ctx + 0x120, true)), tls = Number(k.dv.getBigUint64(th.ctx + 0x118, true));
    assert.ok(tlr >= L.tls + P && tlr < L.tls + L.tlsSize);
    assert.equal(k.r32(tlr + 0x110), Number(th.info.id));
    assert.equal(Number(k.r64(tlr + 0x1F8)), tlr + 0x200);
    assert.equal(tls, tlr + 0x1000);
  }
  const a = Number(k.dv.getBigUint64(k.main.ctx + 0x120, true)), b = Number(k.dv.getBigUint64(t.ctx + 0x120, true));
  assert.equal(Math.abs(a - b), 0x3000);
});

test("CreateThread / StartThread: handle, id, first context, core -2 = core 0, held until started", () => {
  const k = new Kernel(), m = k.main;
  assert.equal(k.call(m, SVC.Create, 0, L.code + 0x4000, 0x1234, L.stack + 0x2000F, 30, 2), 0);
  const h = m.w(1), t = new Thread(k, k.x.kernel_thread_index(h), h);
  assert.equal(h, 0x1002);
  assert.deepEqual([t.info.id, t.info.prio, t.info.core, t.info.mask], [0x52n, 30, 2, 4n]);
  assert.equal(t.state, "Dormant");
  for (let i = 0; i < 6; i++) assert.equal(k.schedule(), m, "a thread that was not started never runs");
  assert.equal(k.call(m, SVC.Start, h), 0);
  assert.equal(t.state, "Runnable");
  assert.equal(k.call(m, SVC.Start, h), 0, "starting it again changes nothing");
  k.run(t);
  assert.equal(t.x(0), 0x1234n);
  assert.equal(k.dv.getBigUint64(t.ctx + 0x100, true), BigInt(L.code + 0x4000));
  assert.equal(k.dv.getBigUint64(t.ctx + 0xF8, true), BigInt(L.stack + 0x20000), "the stack top is aligned down to 16");
  assert.equal(t.x(30), 0xFFFFFFF0n);
  assert.equal(k.call(t, SVC.Core), 2);
  assert.equal(k.call(m, SVC.Start, 0x1F00), R.BAD_HANDLE);
  assert.equal(k.call(m, SVC.Start, 0), R.BAD_HANDLE);
  const u = k.thread(30, -2, { start: false });
  assert.deepEqual([u.info.core, u.info.mask], [0, 1n]);
  assert.deepEqual(k.red, []);
});

test("thread SVCs: priorities, ids and core masks, with their invalid-handle results", () => {
  const k = new Kernel(), m = k.main, t = k.thread(50, 1);
  assert.equal(k.call(m, SVC.GetPrio, 0, t.handle), 0); assert.equal(m.w(1), 50);
  assert.equal(k.call(m, SVC.SetPrio, t.handle, 20), 0);
  assert.equal(k.call(m, SVC.GetPrio, 0, t.handle), 0); assert.equal(m.w(1), 20);
  assert.equal(k.call(m, SVC.SetPrio, CUR_THREAD, 43), 0); assert.equal(m.info.prio, 43);
  assert.equal(k.call(m, SVC.GetId, 0, t.handle), 0); assert.equal(m.x(1), 0x52n);
  for (const [n, args] of [[SVC.GetPrio, [0, 0x1777]], [SVC.SetPrio, [0x1777, 1]], [SVC.GetId, [0, 0x1777]], [SVC.GetMask, [0, 0, 0x1777]], [SVC.SetMask, [0x1777, 0, 1]]] as [number, number[]][]) {
    assert.equal(k.call(m, n, ...args), R.BAD_HANDLE, `svc ${n.toString(16)}`);
  }
  assert.equal(m.x(1), 0n, "the outputs of a failed query are 0");
  // GetThreadCoreMask(w2 handle) -> w1 ideal core, x2 mask
  assert.equal(k.call(m, SVC.GetMask, 0, 0, t.handle), 0); assert.deepEqual([m.w(1), m.x(2)], [1, 2n]);
  // -3 keeps the ideal core, but the new mask excludes it: the ideal core moves to the mask's lowest core
  assert.equal(k.call(m, SVC.SetMask, t.handle, 0xFFFFFFFD, 0b1100), 0);
  assert.deepEqual([t.info.core, t.info.mask], [2, 0b1100n]);
  assert.equal(k.call(t, SVC.Core), 2);
  // an ideal core inside the mask stays
  assert.equal(k.call(m, SVC.SetMask, t.handle, 3, 0b1100), 0); assert.equal(t.info.core, 3);
  // -2: the process default, core 0 alone
  assert.equal(k.call(m, SVC.SetMask, t.handle, 0xFFFFFFFE, 0b0110), 0);
  assert.deepEqual([t.info.core, t.info.mask], [0, 1n]);
  // -1 (no ideal core) with mask 0 leaves the mask
  assert.equal(k.call(m, SVC.SetMask, t.handle, 0xFFFFFFFF, 0), 0); assert.deepEqual([t.info.core, t.info.mask], [0, 1n]);
  assert.deepEqual(k.red, []);
  k.check();
});

test("scheduler: on one core the highest priority runs, equals in the order they became ready", () => {
  const k = new Kernel(), m = k.main;                    // main: priority 44 on core 0
  const lo = k.thread(50, 0), a = k.thread(44, 0), b = k.thread(44, 0);
  assert.equal(k.schedule(), m, "main was ready first among the priority-44 threads");
  assert.equal(k.svc(m, SVC.Sleep, 0), ACT.SWITCH);      // yield: behind a and b
  assert.equal(k.schedule(), a);
  assert.equal(k.svc(a, SVC.Sleep, 0), ACT.SWITCH);
  assert.equal(k.schedule(), b);
  assert.equal(k.svc(b, SVC.Sleep, 0xFFFFFFFFFFFFFFFFn), ACT.SWITCH);   // -1: yield with core migration
  assert.equal(k.schedule(), m);
  assert.equal(lo.state, "Runnable", "the priority-50 thread waits while priority 44 is ready");
  // the three block; now the lower one runs
  for (const t of [m, a, b]) assert.equal(k.svc(t, SVC.Sleep, 1000), ACT.SWITCH);
  assert.equal(k.schedule(), lo);
  // they wake: the running lower-priority thread must give up its core at its next SVC
  k.tick(1000);
  assert.deepEqual([m.state, a.state, b.state], ["Runnable", "Runnable", "Runnable"]);
  assert.equal(k.x.kernel_svc(SVC.Core, lo.ctx), ACT.SWITCH);
  assert.equal(k.schedule(), m);
  assert.equal(lo.state, "Runnable");
  k.check();
});

test("scheduler: starting or waking a higher-priority thread on the caller's core preempts the caller", () => {
  const k = new Kernel(), m = k.main;
  assert.equal(k.call(m, SVC.Create, 0, L.code, 0, L.stack + 0x40000, 30, 0), 0);
  const h = m.w(1);
  assert.equal(k.svc(m, SVC.Start, h), ACT.SWITCH, "StartThread returns only after the child gave the core back");
  assert.equal(m.result, 0);
  const child = k.schedule()!;
  assert.equal(child.handle, h);
  assert.equal(m.state, "Runnable");
  // an equal-priority or other-core child does not hold the caller up
  assert.equal(k.svc(child, SVC.Sleep, 5000), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Create, 0, L.code, 0, L.stack + 0x50000, 44, 0), 0);
  assert.equal(k.svc(m, SVC.Start, m.w(1)), ACT.CONTINUE);
  assert.equal(k.call(m, SVC.Create, 0, L.code, 0, L.stack + 0x60000, 10, 1), 0);
  assert.equal(k.svc(m, SVC.Start, m.w(1)), ACT.CONTINUE);
  k.check();
});

test("scheduler: under kernel_preempt_hold (guest code run by a host function) a better thread waits for the hold's end", () => {
  const k = new Kernel(), m = k.main;
  k.x.kernel_preempt_hold(1);
  assert.equal(k.call(m, SVC.Create, 0, L.code, 0, L.stack + 0x40000, 30, 0), 0);
  assert.equal(k.svc(m, SVC.Start, m.w(1)), ACT.CONTINUE, "the caller keeps its core while held");
  const h = m.w(1);
  assert.equal(k.call(m, SVC.GetId, 0, CUR_THREAD), 0);
  assert.equal(m.state, "Running");
  k.x.kernel_preempt_hold(0);
  assert.equal(k.svc(m, SVC.GetId, CUR_THREAD), ACT.SWITCH, "the first SVC after the hold gives the core to the better thread");
  assert.equal(k.schedule()!.handle, h);
  assert.equal(m.state, "Runnable");
  k.check();
});

test("scheduler: the virtual cores take turns, and a thread keeps running across SVCs that do not block", () => {
  const k = new Kernel(), m = k.main;
  const t1 = k.thread(44, 1), t2 = k.thread(20, 2), t3 = k.thread(60, 3);
  const order: Thread[] = [];
  for (let i = 0; i < 8; i++) order.push(k.schedule()!);
  const next = (t: Thread) => [m, t1, t2, t3][([m, t1, t2, t3].indexOf(t) + 1) % 4];
  for (let i = 1; i < 8; i++) assert.equal(order[i], next(order[i - 1]));
  assert.deepEqual([m, t1, t2, t3].map(t => t.state), ["Running", "Running", "Running", "Running"]);
  assert.deepEqual([0, 1, 2, 3].map(c => k.x.kernel_core_current(c)), [m.index, t1.index, t2.index, t3.index]);
  assert.equal(k.x.kernel_schedule_core(2), t2.ctx);
  assert.equal(k.svc(t2, SVC.Core), ACT.CONTINUE);
  k.check();
});

test("scheduler: when the budget runs out, threads of one priority on a core take turns", () => {
  const k = new Kernel(), m = k.main, a = k.thread(44, 0), lo = k.thread(45, 0);
  k.run(m);
  k.x.kernel_preempt(m.ctx);
  assert.equal(m.state, "Runnable");
  assert.equal(k.schedule(), a);
  k.x.kernel_preempt(a.ctx);
  assert.equal(k.schedule(), m);
  assert.equal(lo.state, "Runnable", "a lower priority does not get the slice");
  // alone at its priority, a thread keeps its core
  k.x.kernel_preempt(m.ctx);
  assert.equal(k.svc(a, SVC.Exit), ACT.SWITCH);
  k.run(m); k.x.kernel_preempt(m.ctx);
  assert.equal(m.state, "Running");
  assert.equal(k.schedule(), m);
  k.check();
});

test("SleepThread(-2), YieldToAnyThread: a lower-priority thread of the core gets a turn", () => {
  const k = new Kernel(), m = k.main, lo = k.thread(50, 0);
  assert.equal(k.svc(m, SVC.Sleep, 0), ACT.SWITCH);
  assert.equal(k.schedule(), m, "a plain yield passes the core only to its own priority");
  assert.equal(k.svc(m, SVC.Sleep, 0xFFFFFFFFFFFFFFFEn), ACT.SWITCH);
  assert.equal(k.schedule(), lo);
  assert.equal(k.x.kernel_svc(SVC.Core, lo.ctx), ACT.SWITCH, "and the yielder is back at the next scheduling point");
  assert.equal(k.schedule(), m);
  // with nothing else to run, the yielder goes on
  assert.equal(k.svc(m, SVC.Sleep, 0xFFFFFFFFFFFFFFFEn), ACT.SWITCH);
  assert.equal(k.svc(lo, SVC.Exit), ACT.SWITCH);
  assert.equal(k.schedule(), m);
  assert.equal(k.svc(m, SVC.Sleep, 0xFFFFFFFFFFFFFFFEn), ACT.SWITCH);
  assert.equal(k.schedule(), m);
});

// Ocarina of Time (Switch 2) pins its movie player's thread with nn::os::SetThreadCoreMask(thread, -1, 0x20): core 5,
// one priority below the main thread. With four virtual cores it queued on core 0 and ran only while the main thread waited
test("scheduler: a thread pinned to core 5 of eight (kernel flag 8) runs beside a better thread on core 0; of four, behind it", () => {
  const k4 = new Kernel(), p4 = k4.thread(45, 0);
  assert.equal(k4.call(k4.main, SVC.SetMask, p4.handle, 0xFFFFFFFF, 0x20), 0);
  assert.deepEqual([p4.info.runCore, k4.schedule(), k4.schedule(), p4.state], [0, k4.main, k4.main, "Runnable"]);
  assert.equal(k4.red.length, 1);
  const k = new Kernel({ flags: 8 }), m = k.main;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(c => k.x.kernel_core_current(c)), [-1, -1, -1, -1, -1, -1, -1, -1, -1]);
  const player = k.thread(45, 0, { start: false });
  assert.equal(k.call(m, SVC.SetMask, player.handle, 0xFFFFFFFF, 0x20), 0);
  assert.deepEqual([player.info.core, player.info.mask], [5, 0x20n]);
  k.svc(m, SVC.Start, player.handle);
  assert.equal(player.info.runCore, 5);
  const seen: Thread[] = [];
  for (let i = 0; i < 4; i++) seen.push(k.schedule()!);
  assert.deepEqual(seen.map(t => t === m ? "main" : t === player ? "player" : "?").sort(), ["main", "main", "player", "player"], "the cores take turns: the main thread never blocked");
  assert.notEqual(seen[0], seen[1]);
  assert.deepEqual([m.state, player.state], ["Running", "Running"]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(c => k.x.kernel_core_current(c)), [m.index, -1, -1, -1, -1, player.index, -1, -1], "the per-core tables hold eight cores");
  assert.equal(k.call(player, SVC.Core), 5);
  // a mask that names no core of the eight still queues on core 0
  const far = k.thread(45, 0);
  assert.equal(k.call(m, SVC.SetMask, far.handle, 0xFFFFFFFF, 0x100), 0);
  assert.deepEqual([far.info.runCore, far.state], [0, "Runnable"]);
  assert.deepEqual(k.red, ["[RED] svc SetThreadCoreMask: mask 0x100 names none of the 8 virtual cores: the thread queues on core 0, behind every better thread there"]);
  k.check();
});

test("scheduler: an idle core takes a waiting thread whose mask allows it; a pinned one is left", () => {
  const k = new Kernel(), m = k.main;
  const pinned = k.thread(50, 0), free = k.thread(51, 0);
  assert.equal(k.call(m, SVC.SetMask, free.handle, 0xFFFFFFFD, 0b0011), 0);   // cores 0 and 1, ideal core kept
  assert.equal(free.info.core, 0);
  const seen = new Set<Thread>();
  for (let i = 0; i < 4; i++) seen.add(k.schedule()!);
  assert.deepEqual([m.state, pinned.state, free.state], ["Running", "Runnable", "Running"]);
  assert.equal(free.info.runCore, 1);
  assert.ok(seen.has(m) && seen.has(free) && !seen.has(pinned));
  assert.equal(k.call(free, SVC.Core), 0, "GetCurrentProcessorNumber reports the ideal core, as nxnative");
  k.check();
});

test("SleepThread: wakes at its deadline on the guest clock; kernel_next_timeout says when", () => {
  const k = new Kernel(), m = k.main;
  k.tick(500);
  assert.equal(k.nextTimeout(), 0xFFFFFFFFFFFFFFFFn);
  m.setX(0, 0x77);
  assert.equal(k.svc(m, SVC.Sleep, 1000), ACT.SWITCH);
  assert.deepEqual([m.state, m.wait], ["Waiting", "sleep"]);
  assert.equal(k.schedule(), null, "every thread waits");
  assert.equal(k.nextTimeout(), 1500n);
  k.tick(999); assert.equal(m.state, "Waiting");
  k.tick(1); assert.equal(m.state, "Runnable");
  assert.equal(m.x(0), 1000n, "SleepThread returns nothing: x0 is as the guest left it");
  assert.equal(k.schedule(), m);
  // a sleep of any positive length is a sleep on the guest clock
  assert.equal(k.svc(m, SVC.Sleep, 1), ACT.SWITCH); assert.equal(m.state, "Waiting");
  k.tick(1); assert.equal(m.state, "Runnable");
  k.check();
});

test("ExitThread: waits on the thread complete, and its record goes after the last handle and wait reference", () => {
  const k = new Kernel(), m = k.main, t = k.thread(44, 1), w = k.thread(44, 2);
  const free0 = (k.call(m, SVC.GetInfo, 0, 24, 0, 0), Number(m.x(1)));
  assert.equal(free0, 96 - 3);
  const hs = k.alloc(8); k.w32(hs, t.handle);
  assert.equal(k.svc(w, SVC.Wait, 0, hs, 1, -1n), ACT.SWITCH);
  assert.equal(t.info.syncRefs, 1);
  assert.equal(k.svc(t, SVC.Exit), ACT.SWITCH);
  assert.equal(t.state, "Exited");
  assert.deepEqual([w.state, w.result, w.w(1)], ["Runnable", 0, 0]);
  assert.equal(t.info.syncRefs, 0);
  assert.equal((k.call(m, SVC.GetInfo, 0, 24, 0, 0), Number(m.x(1))), 96 - 2, "an exited thread gives its slot of the limit back");
  // an exited thread stays signaled, and its handle works until closed
  assert.equal(k.call(m, SVC.Wait, 0, hs, 1, 0), 0);
  assert.equal(k.call(m, SVC.GetPrio, 0, t.handle), 0);
  assert.equal(k.count("objects"), 3);
  assert.equal(k.call(m, SVC.Close, t.handle), 0);
  assert.equal(k.count("objects"), 2);
  assert.equal(k.call(m, SVC.GetPrio, 0, t.handle), R.BAD_HANDLE);
  // closing first, exiting later frees it too; the handle number is reused at once
  assert.equal(k.call(m, SVC.Close, w.handle), 0);
  assert.equal(w.state, "Runnable", "a thread runs on without its handle");
  assert.equal(k.svc(w, SVC.Exit), ACT.SWITCH);
  assert.equal(k.count("objects"), 1);
  assert.deepEqual([k.count("handles"), k.count("alive")], [1, 1]);
  assert.equal(k.thread(44, 1).handle, 0x1002);
  k.check();
});

test("CreateThread: no free thread slot is ResultOutOfResource, in red", () => {
  const k = new Kernel(), m = k.main;
  let n = 1;
  for (; n < 200; n++) { if (k.call(m, SVC.Create, 0, L.code, 0, L.stack + 0x1000, 44, 1)) break; }
  assert.equal(n, 85, "the test layout's thread-local region has room for 85 threads");
  assert.equal(m.result, R.OUT_OF_RES);
  assert.deepEqual(k.red, ["[RED] kernel: CreateThread: no free thread slot"]);
  assert.equal((k.call(m, SVC.GetInfo, 0, 24, 0, 0), Number(m.x(1))), 96 - 85);
});

test("SetThreadActivity: a pause is a state; a waiting thread keeps its wait under it", () => {
  const k = new Kernel(), m = k.main;
  const running = k.thread(44, 1), runnable = k.thread(50, 1), waiting = k.thread(44, 2), dormant = k.thread(44, 3, { start: false });
  k.run(running);
  assert.equal(k.svc(waiting, SVC.Sleep, 1000), ACT.SWITCH);
  assert.deepEqual([running.state, runnable.state, waiting.state, dormant.state], ["Running", "Runnable", "Waiting", "Dormant"]);
  assert.equal(k.call(m, SVC.Context, k.alloc(0x320), running.handle), R.BAD_STATE, "the context of a thread that is not paused");
  for (const t of [running, runnable, waiting, dormant]) assert.equal(k.call(m, SVC.Activity, t.handle, 1), 0);
  assert.deepEqual([running.state, runnable.state, waiting.state, dormant.state], ["PausedRunnable", "PausedRunnable", "PausedWaiting", "PausedDormant"]);
  assert.equal(waiting.wait, "sleep");
  assert.equal(k.call(m, SVC.Activity, running.handle, 1), 0, "pausing twice changes nothing");
  assert.equal(k.call(m, SVC.Activity, m.handle, 1), R.BAD_STATE, "a thread cannot pause itself");
  assert.equal(k.call(m, SVC.Activity, CUR_THREAD, 0), R.BAD_STATE);
  assert.equal(k.call(m, SVC.Activity, 0x1444, 1), R.BAD_HANDLE);
  assert.equal(k.call(m, SVC.Context, 0, 0x1444), R.BAD_HANDLE);
  for (let i = 0; i < 8; i++) assert.equal(k.schedule(), m, "no paused thread runs");
  // the wait goes on under the pause: its timeout ends it, and the thread is then paused and runnable
  k.tick(1000);
  assert.equal(waiting.state, "PausedRunnable");
  // a paused thread that is started stays paused
  assert.equal(k.call(m, SVC.Start, dormant.handle), 0);
  assert.equal(dormant.state, "PausedRunnable");
  for (const t of [running, runnable, waiting, dormant]) assert.equal(k.call(m, SVC.Activity, t.handle, 0), 0);
  assert.deepEqual([running.state, runnable.state, waiting.state, dormant.state], ["Runnable", "Runnable", "Runnable", "Runnable"]);
  assert.equal(k.call(m, SVC.Activity, running.handle, 0), 0, "resuming a thread that is not paused changes nothing");
  k.run(running); k.run(waiting); k.run(dormant);
  // paused and resumed while still waiting: the same wait
  assert.equal(k.svc(waiting, SVC.Sleep, 500), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Activity, waiting.handle, 1), 0);
  assert.equal(k.call(m, SVC.Activity, waiting.handle, 0), 0);
  assert.deepEqual([waiting.state, waiting.wait], ["Waiting", "sleep"]);
  k.tick(500); assert.equal(waiting.state, "Runnable");
  // a thread that was never started
  const d2 = k.thread(44, 3, { start: false });
  assert.equal(k.call(m, SVC.Activity, d2.handle, 1), 0);
  assert.equal(k.call(m, SVC.Activity, d2.handle, 0), 0);
  assert.equal(d2.state, "Dormant");
  // an exited thread
  assert.equal(k.svc(dormant, SVC.Exit), ACT.SWITCH);
  assert.equal(k.call(m, SVC.Activity, dormant.handle, 1), 0);
  assert.equal(k.call(m, SVC.Context, k.alloc(0x320), dormant.handle), R.BAD_STATE);
  assert.deepEqual(k.red, []);
  k.check();
});

test("GetThreadContext3: Horizon's ThreadContext of a paused thread (the garbage collector's stop-the-world)", () => {
  const k = new Kernel(), m = k.main, t = k.thread(44, 1);
  k.run(t);
  const c = t.ctx, dv = k.dv;
  for (let i = 0; i < 31; i++) dv.setBigUint64(c + 8 * i, 0x1000n + BigInt(i), true);
  dv.setBigUint64(c + 0xF8, 0x5000n, true); dv.setBigUint64(c + 0x100, 0x6000n, true);
  dv.setUint32(c + 0x108, 0b1010, true); dv.setUint32(c + 0x10C, 0x03000000, true); dv.setUint32(c + 0x110, 0x1F, true);
  dv.setBigUint64(c + 0x118, 0x7000n, true);
  for (let i = 0; i < 0x200; i++) dv.setUint8(c + 0x130 + i, i & 0xFF);
  assert.equal(k.call(m, SVC.Activity, t.handle, 1), 0);
  const out = k.alloc(0x340);
  k.u8.fill(0xA7, out, out + 0x340);
  assert.equal(k.call(m, SVC.Context, out + 16, t.handle), 0);
  const o = out + 16;
  for (let i = 0; i < 29; i++) assert.equal(dv.getBigUint64(o + 8 * i, true), 0x1000n + BigInt(i));
  assert.deepEqual([dv.getBigUint64(o + 0xE8, true), dv.getBigUint64(o + 0xF0, true), dv.getBigUint64(o + 0xF8, true), dv.getBigUint64(o + 0x100, true)],
    [0x1000n + 29n, 0x1000n + 30n, 0x5000n, 0x6000n], "fp, lr, sp, pc");
  assert.equal(dv.getUint32(o + 0x108, true), 0xA0000000, "pstate: NZCV in bits 31..28");
  assert.equal(dv.getUint32(o + 0x10C, true), 0);
  for (let i = 0; i < 0x200; i++) assert.equal(dv.getUint8(o + 0x110 + i), i & 0xFF);
  assert.deepEqual([dv.getUint32(o + 0x310, true), dv.getUint32(o + 0x314, true), dv.getBigUint64(o + 0x318, true)], [0x03000000, 0x1F, 0x7000n]);
  assert.equal(dv.getUint8(o - 1), 0xA7); assert.equal(dv.getUint8(o + 0x320), 0xA7);
  assert.equal(k.call(m, SVC.Context, 0xFFFFFFFF0000n, t.handle), R.BAD_MEMORY);
  assert.equal(k.call(m, SVC.Activity, t.handle, 0), 0);
  assert.equal(k.call(m, SVC.Context, out, t.handle), R.BAD_STATE);
});

test("a thread that returns from its entry function: the main thread ends the process, another one exits in red", () => {
  const k = new Kernel(), m = k.main, t = k.thread(44, 1);
  k.run(t);
  assert.equal(k.x.kernel_thread_returned(t.ctx), ACT.SWITCH);
  assert.equal(t.state, "Exited");
  assert.deepEqual(k.red, ["[RED] kernel: thread 0x1002 returned from its entry function (Horizon requires ExitThread): exited"]);
  k.run(m); m.setX(0, 7);
  assert.equal(k.x.kernel_thread_returned(m.ctx), ACT.STOP);
  assert.deepEqual([k.x.kernel_stop_reason(), k.x.kernel_exit_code()], [1, 7]);
});

test("kernel_svc from a context that is not a running thread is refused in red", () => {
  const k = new Kernel(), t = k.thread(44, 1, { start: false });
  assert.equal(k.x.kernel_svc(0x10, t.ctx), ACT.SWITCH);
  assert.equal(k.x.kernel_svc(0x10, 12345), ACT.SWITCH);
  assert.equal(k.red.length, 2);
  assert.ok(k.red[0].startsWith("[RED] kernel: svc 0x10 from a context that is not a running thread"));
});
