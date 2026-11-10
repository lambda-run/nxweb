// The guest clock and its freeze reasons, GetSystemTick, GetInfo, OutputDebugString, Break, ExitProcess and process
// teardown, GetProcessId, the session stubs, and SVCs that are not implemented.
import assert from "node:assert/strict";
import { test, Kernel, Thread, R, ACT, L, P, def, CUR_THREAD, WAITERS } from "./harness.mts";

const GC = def("guest_clock");
const info = (k: Kernel, id: number, t: Thread = k.main) => { assert.equal(k.call(t, 0x29, 0, id, 0, 0), 0); return t.x(1); };

test("guest clock: every reason and every transition; the clock runs only while no reason holds", () => {
  const k = new Kernel({ main: false });
  let now = 0n, guest = 0n, mask = 0;
  const step = (ns: bigint) => { now += ns; if (!mask) guest += ns; k.x.kernel_tick(now); };
  let seed = 7;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 10) % n; };
  const seen = new Set<string>();
  // a walk that takes each of the 48 (state, event) pairs: from every reason set, hold and release every reason
  for (let round = 0; seen.size < 48; round++) {
    assert.ok(round < 5000);
    const reason = rnd(3), on = rnd(2);
    seen.add(`${mask}/${reason}/${on}`);
    step(BigInt(1 + rnd(1000)));
    k.x.kernel_clock_freeze(reason, on);
    mask = on ? mask | (1 << reason) : mask & ~(1 << reason);
    assert.equal(k.x.kernel_clock_reasons(), mask, "the state is the reason set");
    assert.equal(GC.states[mask], ["Running", "Hold", "Background", "HoldBackground", "Keyboard", "HoldKeyboard", "BackgroundKeyboard", "HoldBackgroundKeyboard"][mask]);
    step(BigInt(rnd(500)));
    assert.equal(k.x.kernel_guest_ns(), guest, "no jump when it freezes, none when it runs again");
    assert.equal(k.x.kernel_guest_ticks(), guest * 12n / 625n);
  }
  k.x.kernel_clock_freeze(3, 1); k.x.kernel_clock_freeze(99, 0);   // no such reason: nothing
  assert.equal(k.x.kernel_clock_reasons(), mask);
  k.x.kernel_tick(now - 5n);                                        // time does not go back
  assert.equal(k.x.kernel_guest_ns(), guest);
  assert.equal(k.x.kit_refused_total(), 0);
  assert.deepEqual(k.logs, []);
});

test("guest clock: 'switch to the background and back while the keyboard is up' does not release the clock early", () => {
  const k = new Kernel({ main: false });
  k.x.kernel_tick(1000n);
  k.x.kernel_clock_freeze(2, 1); k.x.kernel_clock_freeze(1, 1);
  k.x.kernel_tick(5000n);
  k.x.kernel_clock_freeze(1, 0);
  k.x.kernel_tick(9000n);
  assert.equal(k.x.kernel_guest_ns(), 1000n, "the keyboard still holds it");
  k.x.kernel_clock_freeze(2, 0);
  k.x.kernel_tick(9500n);
  assert.equal(k.x.kernel_guest_ns(), 1500n);
});

test("GetSystemTick: 19.2 MHz (31.25 MHz with the Switch 2 flag); a read waits while the app is in the background", () => {
  const k = new Kernel(), m = k.main, t = k.thread(44, 1);
  k.tick(1_000_000_000);
  assert.equal(k.svc(m, 0x1E), ACT.CONTINUE);
  assert.equal(m.x(0), 19_200_000n);
  assert.equal(m.x(1), 19_200_000n, "nxnative puts the tick in x1");
  k.tick(625);
  k.svc(m, 0x1E); assert.equal(m.x(0), 19_200_012n);
  k.x.kernel_clock_freeze(0, 1);
  k.tick(1_000_000);
  k.svc(m, 0x1E); assert.equal(m.x(0), 19_200_012n, "a held clock reads the same tick, at once");
  k.x.kernel_clock_freeze(1, 1);
  assert.equal(k.svc(m, 0x1E), ACT.SWITCH);
  assert.equal(k.svc(t, 0x1E), ACT.SWITCH);
  assert.deepEqual([m.state, m.wait, t.wait], ["Waiting", "clock", "clock"]);
  assert.equal(k.schedule(), null);
  assert.equal(k.nextTimeout(), 0xFFFFFFFFFFFFFFFFn);
  k.x.kernel_clock_freeze(0, 0);
  assert.equal(m.state, "Waiting", "still in the background");
  k.x.kernel_clock_freeze(1, 0);
  assert.deepEqual([m.state, t.state], ["Runnable", "Runnable"]);
  k.tick(625);
  assert.equal(m.x(0), 19_200_012n, "the read returned the tick at which the clock went on");
  k.svc(m, 0x1E); assert.equal(m.x(0), 19_200_024n);
  const s2 = new Kernel({ flags: 2 });
  s2.tick(3200); s2.svc(s2.main, 0x1E);
  assert.equal(s2.main.x(0), 100n);
  k.check();
});

test("timeouts follow the guest clock: nothing times out while it stands", () => {
  const k = new Kernel(), m = k.main;
  k.tick(100);
  assert.equal(k.svc(m, 0x0B, 1000), ACT.SWITCH);
  assert.equal(k.nextTimeout(), 1100n);
  k.x.kernel_clock_freeze(2, 1);
  assert.equal(k.nextTimeout(), 0xFFFFFFFFFFFFFFFFn);
  k.tick(50_000); assert.equal(m.state, "Waiting");
  k.x.kernel_clock_freeze(2, 0);
  assert.equal(k.nextTimeout(), 51_100n, "the deadline moved with the clock");
  k.tick(999); assert.equal(m.state, "Waiting");
  k.tick(1); assert.equal(m.state, "Runnable");
});

test("GetInfo: every type nxnative answers, with its value", () => {
  const k = new Kernel({ sysResource: 0x2000000, programId: 0x010015100B514000n }), m = k.main;
  const want: [number, bigint][] = [[0, 7n], [1, 0n], [6, BigInt(L.pool)], [7, BigInt(L.used)], [8, 0n], [16, 0x2000000n], [17, 0x400000n],
    [18, 0x010015100B514000n], [20, BigInt(L.tls)], [21, BigInt(L.pool)], [22, BigInt(L.used)], [23, 1n], [24, 95n], [25, 0n], [26, 0n], [27, 0n], [28, 0n],
    [29, 0n], [30, 0n], [31, 0n], [32, 0n], [33, 0x1000n]];
  for (const [id, v] of want) assert.equal(info(k, id), v, `GetInfo type ${id}`);
  assert.deepEqual(k.red, []);
  // the user exception context is real memory (newer SDKs write to +0x1C0)
  k.w32(L.tls + 0x1C0, 0xABCD);
  // RandomEntropy: nxnative's deterministic stream (splitmix64, the same seed), one value per call
  let z = 0x5357444554524e47n; const M = (1n << 64n) - 1n;
  const next = () => { z = (z + 0x9E3779B97F4A7C15n) & M; let v = z; v = ((v ^ (v >> 30n)) * 0xBF58476D1CE4E5B9n) & M; v = ((v ^ (v >> 27n)) * 0x94D049BB133111EBn) & M; return v ^ (v >> 31n); };
  for (let i = 0; i < 4; i++) { assert.equal(k.call(m, 0x29, 0, 11, 0, i), 0); assert.equal(m.x(1), next()); }
  k.x.kernel_seed_entropy(1n); z = 1n;
  assert.equal(info(k, 11), next());
  // unknown types: 0, reported once each
  assert.equal(info(k, 9), 0n); assert.equal(info(k, 9), 0n); assert.equal(info(k, 10), 0n); assert.equal(info(k, 77), 0n);
  assert.deepEqual(k.red, ["[RED] svc GetInfo: unknown info type 9 (answered 0)", "[RED] svc GetInfo: unknown info type 10 (answered 0)", "[RED] svc GetInfo: unknown info type 77 (answered 0)"]);
  const none = new Kernel();
  assert.deepEqual([info(none, 16), info(none, 17)], [0n, 0n], "no system resource: no virtual address memory");
});

test("OutputDebugString, GetProcessId, GetCurrentProcessorNumber", () => {
  const k = new Kernel({ processId: 0x83 }), m = k.main, s = k.alloc(32);
  Buffer.from("hello, kernel\n").copy(k.u8, s);
  assert.equal(k.call(m, 0x27, s, 14), 0);
  assert.equal(k.call(m, 0x27, s, 0), 0);
  assert.deepEqual(k.out, ["hello, kernel\n", ""]);
  assert.equal(k.call(m, 0x27, 0xFFFFFFFF0000n, 4), R.BAD_MEMORY);
  assert.equal(k.call(m, 0x24, 0, 0xFFFF8001), 0); assert.equal(m.x(1), 0x83n);
  assert.equal(new Kernel().call(k.main, 0x10), 0);
  const d = new Kernel(); d.call(d.main, 0x24, 0, 0xFFFF8001); assert.equal(d.main.x(1), 0x50n);
});

test("Break: a notification goes on, a fatal one reports in red and stops the process with exit code 42", () => {
  const k = new Kernel(), m = k.main, other = k.thread(44, 1), res = k.word(0x2A2);
  assert.equal(k.svc(m, 0x26, 0x80000003n, res, 4), ACT.CONTINUE);
  assert.equal(m.x(0), 0x80000003n, "a notification leaves the registers");
  assert.deepEqual(k.logs, ["Break#1 reason=0x80000003 Result=0x2a2 lr=0xfffffff0 (notification only)"]);
  assert.equal(k.x.kernel_stop_reason(), 0);
  assert.equal(k.svc(m, 0x26, 1, res, 4), ACT.STOP);
  assert.deepEqual(k.red, ["[RED] Break#2 reason=0x1 Result=0x2a2 lr=0xfffffff0: the process stops"]);
  assert.deepEqual([k.x.kernel_stop_reason(), k.x.kernel_exit_code()], [2, 42]);
  assert.deepEqual([m.state, other.state], ["Exited", "Exited"]);
  assert.equal(k.schedule(), null);
  assert.equal(k.x.kernel_svc(0x10, m.ctx), ACT.STOP, "nothing runs after the stop");
  const k2 = new Kernel();
  assert.equal(k2.svc(k2.main, 0x26, 0, 0, 0), ACT.STOP);
  assert.deepEqual(k2.red, ["[RED] Break#1 reason=0x0 Result=0x0 lr=0xfffffff0: the process stops"]);
});

test("ExitProcess: every thread leaves, whatever it was doing; waits let their objects go", () => {
  const k = new Kernel(), m = k.main, mutex = k.word(), key = k.word(), e = k.event();
  const mk = (core: number, start = true) => k.thread(44, core, { start });
  const dormant = mk(1, false), pausedDormant = mk(1, false);
  const running = mk(1), runnable = mk(1), pausedRunnable = mk(1);
  const waiting = mk(2), pausedWaiting = mk(2), contending = mk(3), pausedContending = mk(3), syncWaiter = mk(2);
  k.run(running);
  const hs = k.alloc(8); k.w32(hs, e.r); k.w32(hs + 4, running.handle);
  assert.equal(k.svc(waiting, 0x0B, 1_000_000), ACT.SWITCH);
  assert.equal(k.svc(pausedWaiting, 0x0B, 1_000_000), ACT.SWITCH);
  assert.equal(k.svc(syncWaiter, 0x18, 0, hs, 2, -1n), ACT.SWITCH);
  for (const t of [contending, pausedContending]) {
    k.w32(mutex, t.handle);
    assert.equal(k.svc(t, 0x1C, mutex, key, t.handle, -1n), ACT.SWITCH);
  }
  k.w32(mutex, m.handle);
  assert.equal(k.call(m, 0x1D, key, 0), 0);
  for (const t of [pausedDormant, pausedRunnable, pausedWaiting, pausedContending]) assert.equal(k.call(m, 0x32, t.handle, 1), 0);
  const all = [dormant, pausedDormant, running, runnable, pausedRunnable, waiting, pausedWaiting, contending, pausedContending, syncWaiter];
  assert.deepEqual(all.map(t => t.state), ["Dormant", "PausedDormant", "Running", "Runnable", "PausedRunnable", "Waiting", "PausedWaiting", "Contending", "PausedContending", "Waiting"]);
  k.check();
  assert.equal(k.svc(m, 0x07, 3), ACT.STOP);
  assert.deepEqual([k.x.kernel_stop_reason(), k.x.kernel_exit_code()], [1, 3]);
  assert.ok(all.every(t => t.state === "Exited") && m.state === "Exited");
  assert.equal(running.info.syncRefs, 0);
  assert.equal(k.count("alive"), 0);
  assert.equal(k.schedule(), null);
  assert.equal(k.x.kernel_schedule_core(1), 0);
  k.x.kernel_tick(10_000_000n);
  assert.ok(all.every(t => t.state === "Exited"), "no timeout wakes a thread of an ended process");
  assert.equal(k.x.kit_refused_total(), 0);
  assert.deepEqual(k.red, []);
});

test("ConnectToNamedPort / SendSyncRequest: no service is implemented; success as nxnative's placeholder, in red once", () => {
  const k = new Kernel(), m = k.main, name = k.alloc(16), tlr = Number(k.dv.getBigUint64(m.ctx + 0x120, true));
  Buffer.from("sm:\0").copy(k.u8, name);
  assert.equal(k.call(m, 0x1F, 0, name), 0);
  const session = m.w(1);
  assert.equal(session, 0x1002, "a session handle of its own");
  k.w32(tlr, 0x00000004); k.w32(tlr + 4, 0x0000000A);
  assert.equal(k.call(m, 0x21, session), 0);
  assert.deepEqual([k.r32(tlr), k.r32(tlr + 4)], [4, 10], "the message buffer is untouched: there is no reply");
  assert.equal(k.call(m, 0x1F, 0, name), 0);
  assert.equal(k.call(m, 0x21, m.w(1)), 0);
  assert.deepEqual(k.red, ["[RED] svc 0x1f unimplemented: ConnectToNamedPort \"sm:\" gets a session nobody serves",
    "[RED] svc 0x21 unimplemented: SendSyncRequest on handle 0x1002 answered 0 with no reply"]);
  assert.equal(k.count("handles"), 3);
  assert.equal(k.call(m, 0x16, session), 0); assert.equal(k.call(m, 0x16, 0x1003), 0);
  assert.equal(k.count("handles"), 1);
  // a session is no synchronization object here
  assert.equal(k.call(m, 0x1F, 0, name), 0);
  const hs = k.alloc(4); k.w32(hs, m.w(1));
  assert.equal(k.call(m, 0x18, 0, hs, 1, 0), R.BAD_HANDLE);
});

test("an SVC that is not implemented: `[RED] svc 0xNN unimplemented` once, and nxnative's answer (0)", () => {
  const k = new Kernel(), m = k.main;
  for (const n of [0x13, 0x50, 0x13, 0x7F, 0x50]) {
    m.setX(1, 0x99);
    assert.equal(k.svc(m, n, 0xAA, 0x99, 0x77), ACT.CONTINUE);
    assert.deepEqual([m.x(0), m.x(1)], [0n, 0x99n], "x0 = 0, the other registers as they were");
  }
  assert.deepEqual(k.red, ["[RED] svc 0x13 unimplemented (x0=0xaa x1=0x99 x2=0x77; answered 0)", "[RED] svc 0x50 unimplemented (x0=0xaa x1=0x99 x2=0x77; answered 0)",
    "[RED] svc 0x7f unimplemented (x0=0xaa x1=0x99 x2=0x77; answered 0)"]);
});

test("the kernel's machines never refuse an event in any of the scenarios above (spot check on a busy script)", () => {
  const k = new Kernel(), m = k.main, lock = k.word(), key = k.word(), e = k.event();
  const a = k.thread(30, 0), b = k.thread(50, 1);
  k.lock(a, lock); k.svc(a, 0x1C, lock, key, a.handle, 100);
  k.lock(b, lock); k.svc(b, 0x1D, key, 1); k.call(m, 0x32, a.handle, 1); k.unlock(b, lock); k.call(m, 0x32, a.handle, 0);
  k.tick(100); k.svc(m, 0x11, e.w); k.svc(b, 0x0A); k.svc(m, 0x07, 0);
  assert.equal(k.x.kit_refused_total(), 0);
  assert.deepEqual(k.red, []);
});
