// The poll back-off (src/kernel/backoff.ts, kernel_poll_backoff) and the per-thread counters (kernel_stats_ptr).
import assert from "node:assert/strict";
import { test, Kernel, Thread, R, ACT } from "./harness.mts";

const US = 1000, YIELD = 0x0B, CORE = 0x10, WAIT = 0x18;
const guest = (k: Kernel) => BigInt.asUintN(64, k.x.kernel_guest_ns());
const left = (k: Kernel, t: Thread) => Number(BigInt.asUintN(64, t.info.deadline) - guest(k));   // ns of its wait still to go
const stat = (k: Kernel, t: Thread, slot: number) => k.dv.getUint32(k.x.kernel_stats_ptr() + t.index * k.x.kernel_stats_stride() + 4 * slot, true);
const wait = (k: Kernel, t: Thread, w: number, cls: number) => [0, 1, 2].map(r => stat(k, t, 128 + (w * 5 + cls) * 3 + r));

// A poller (the main thread, core 0) yields in a loop while a worker of core 1 computes in slices of 100 us; a
// yield costs the poller 3 us. Returns each thread's turns, the longest time the poller was kept from its next
// turn, and what happened in order.
function pollerAndWorker(on: boolean, ms: number): { poller: number; worker: number; longest: number; log: string } {
  const k = new Kernel(), m = k.main, w = k.thread(44, 1);
  k.x.kernel_poll_backoff(on ? 1 : 0);
  let poller = 0, worker = 0, longest = 0, since = 0n, log = "";
  while (guest(k) < BigInt(ms) * 1000000n) {
    const t = k.schedule();
    if (t === m) {
      if (poller) longest = Math.max(longest, Number(guest(k) - since));
      poller++; log += "p";
      k.tick(3 * US);
      assert.equal(k.svc(m, YIELD, 0), ACT.SWITCH);
      if (m.wait === "sleep") { assert.ok(left(k, m) >= 10 * US && left(k, m) <= 250 * US, `a sleep of ${left(k, m)} ns`); log += "s"; }
      since = guest(k);
    } else if (t === w) { worker++; log += "w"; k.tick(100 * US); k.x.kernel_preempt(w.ctx); }
    else assert.fail("nothing to run while the worker computes");
    k.check();
  }
  assert.deepEqual(k.red, []);
  return { poller, worker, longest, log };
}

test("back-off: a poller beside a worker: off, they take turns; on, the worker gets the turns and the poller is at most 250 us and a slice late", () => {
  const off = pollerAndWorker(false, 50), on = pollerAndWorker(true, 50);
  assert.ok(!off.log.includes("s") && Math.abs(off.poller - off.worker) <= 1, "off: one turn each, no sleep");
  assert.ok(on.log.startsWith("wpwpwp") && on.log.indexOf("s") > 30, "on: plain yields for the first 2 ms");
  assert.ok(on.worker > off.worker && on.poller * 2.5 < on.worker, `on: ${on.poller} poller turns, ${on.worker} worker turns (off: ${off.poller}, ${off.worker})`);
  assert.ok(on.longest <= 350 * US, `the poller waited ${on.longest} ns for a turn`);
  assert.deepEqual(pollerAndWorker(true, 50), on, "the same script twice");
});

test("back-off: off unless asked for; a lone thread's run of yields sleeps from its second yield, 10 us growing to 250 us", () => {
  const k = new Kernel(), m = k.main;
  for (let i = 0; i < 50; i++) { assert.equal(k.svc(m, YIELD, 0), ACT.SWITCH); assert.equal(m.state, "Runnable"); k.tick(100 * US); }
  assert.deepEqual(wait(k, m, 0, 0), [0, 0, 50]);   // 50 yields that went on
  k.x.kernel_poll_backoff(1);
  k.call(m, CORE);                                   // another SVC: a new run
  k.svc(m, YIELD, 0); assert.equal(m.state, "Runnable");
  const slept: number[] = [];
  for (let i = 0; i < 40; i++) {
    k.tick(3 * US);
    k.svc(m, YIELD, 0);
    assert.equal(m.wait, "sleep");
    assert.equal(k.schedule(), null);                // nothing runs meanwhile
    slept.push(left(k, m));
    k.tick(left(k, m)); assert.equal(m.state, "Runnable");
  }
  assert.equal(slept[0], 10 * US);
  assert.ok(slept.every((v, i) => !i || v >= slept[i - 1]) && slept[39] === 250 * US, slept.join(" "));
  assert.equal(stat(k, m, 188), 40);
  assert.deepEqual(wait(k, m, 0, 0), [0, 40, 51]);
  assert.equal(stat(k, m, YIELD), 91); assert.equal(stat(k, m, CORE), 1);
  k.check(); assert.deepEqual(k.red, []);
});

test("back-off: a loop that moves its callee-saved registers, or makes another SVC between its yields, never sleeps; one that reads the clock sleeps at once", () => {
  const k = new Kernel(), m = k.main, w = k.thread(44, 1);
  k.x.kernel_poll_backoff(1);
  for (let i = 0; i < 2000; i++) { m.setX(21, i); k.svc(m, YIELD, 0); assert.equal(m.state, "Runnable"); k.tick(5 * US); }
  for (let i = 0; i < 2000; i++) { k.call(m, CORE); k.svc(m, YIELD, 0); assert.equal(m.state, "Runnable"); k.tick(5 * US); }
  // two yields a pass (the registers of the yield before last come back): a wait
  for (let i = 0; i < 500; i++) { m.setX(23, i & 1 ? 2000 : 0); k.svc(m, YIELD, 0); k.tick(5 * US); if (m.wait === "sleep") k.tick(left(k, m)); }
  assert.ok(stat(k, m, 188) > 10, "a two-yield wait backs off after its first 2 ms");
  // beside a ready worker a run of yields is let through for 2 ms, unless its passes read the system counter
  const before = stat(k, m, 188);
  k.call(m, CORE); m.setX(23, 7);
  k.svc(m, YIELD, 0); assert.equal(m.state, "Runnable");
  k.svc(m, YIELD, 0); assert.equal(m.state, "Runnable");
  k.x.kernel_guest_ticks();
  k.svc(m, YIELD, 0); assert.equal(m.wait, "sleep");
  assert.equal(stat(k, m, 188), before + 1);
  assert.equal(w.state === "Running" || w.state === "Runnable", true);
  k.check(); assert.deepEqual(k.red, []);
});

test("back-off: timed waits under 20 us in a run wait longer, a signal still ends them at once; longer timeouts and loops that work between waits are left alone", () => {
  const k = new Kernel(), m = k.main, ev = k.event(), hs = k.alloc(4);
  k.w32(hs, ev.r);
  const poll = (ns: number) => { assert.equal(k.svc(m, WAIT, 0, hs, 1, ns), ACT.SWITCH); assert.equal(m.wait, "sync"); return left(k, m); };
  const out = () => { k.tick(left(k, m)); assert.equal(m.result, R.TIMEOUT); };
  assert.equal(poll(1 * US), 1 * US); out();                       // off
  k.x.kernel_poll_backoff(1);
  k.call(m, CORE);
  const got: number[] = [];
  for (let i = 0; i < 60; i++) { got.push(poll(1 * US)); out(); k.tick(2 * US); }
  assert.deepEqual(got.slice(0, 2), [1 * US, 10 * US]); assert.equal(got[59], 250 * US);
  assert.ok(stat(k, m, 189) === 59 && k.dv.getBigUint64(k.x.kernel_stats_ptr() + m.index * k.x.kernel_stats_stride() + 760, true) > 0n);
  // signalled while it waits longer than it asked: it ends now, with success, and the next wait starts a new run
  assert.equal(poll(1 * US), 250 * US);
  k.x.kernel_event_signal(ev.w); assert.equal(m.state, "Runnable"); assert.equal(m.result, 0);
  k.x.kernel_event_clear(ev.w);
  assert.equal(poll(1 * US), 1 * US); out();                       // a new run
  k.call(m, CORE);
  for (let i = 0; i < 100; i++) { assert.equal(poll(50 * US), 50 * US); out(); }                    // 50 us is not a poll
  for (let i = 0; i < 100; i++) { assert.equal(poll(5 * US), 5 * US); out(); k.schedule(); k.tick(60 * US); }   // 60 us of work between two
  // a short SleepThread is such a wait too
  k.call(m, CORE);
  k.svc(m, YIELD, 500); assert.equal(left(k, m), 500); k.tick(left(k, m));
  k.svc(m, YIELD, 500); assert.equal(left(k, m), 10 * US); k.tick(left(k, m));
  assert.deepEqual(wait(k, m, 1, 1).slice(0, 2), [1, 262]);        // WaitSynchronization under 1 ms: 1 woke, 262 timed out
  k.check(); assert.deepEqual(k.red, []);
});
