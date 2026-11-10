// Timeouts against a model: many threads in timed sleeps, address waits and synchronization waits, some ended early
// (signal, cancel), some under a pause, with the guest clock held now and then. After every kernel_tick the waits that
// ended are exactly those whose deadline has come, earliest deadline first, then in the order the waits began; nothing
// else moved. The model keeps its own deadlines (guest ns at the wait + the timeout), so expire() may skip its scan
// only when that changes nothing.
import assert from "node:assert/strict";
import { test, Kernel, Thread, R, ACT } from "./harness.mts";

const FOREVER = 0xFFFF_FFFF_FFFF_FFFFn;
interface Wait { t: Thread; kind: string; deadline: bigint; seq: number }

// One run. Returns what timed out at which tick, in order ("step@guest ns: thread/kind ...").
export function timeouts(seed: number, nthreads: number, steps: number): { fired: string[]; total: number } {
  const k = new Kernel(), m = k.main;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 9) % n; };
  const addr = k.word(7), ev = k.event(), hs = k.alloc(4); k.w32(hs, ev.r);
  const threads = [m, ...Array.from({ length: nthreads }, () => k.thread(40 + rnd(4), rnd(3)))];
  const waits = new Map<number, Wait>();   // by thread index
  const paused = new Set<Thread>();
  const fired: string[] = [];
  let seq = 0, total = 0, held = false;
  const guest = () => BigInt.asUintN(64, k.x.kernel_guest_ns());
  // the waits that ended without a timeout leave the model
  const sweep = () => { for (const [i, w] of waits) if (!w.t.info.waitKind) waits.delete(i); };
  const began = (t: Thread, kind: string, ns: number) => {
    assert.equal(t.wait, kind);
    const w = { t, kind, deadline: ns < 0 ? FOREVER : guest() + BigInt(ns), seq: ++seq };
    assert.equal(BigInt.asUintN(64, t.info.deadline), w.deadline);
    waits.set(t.index, w);
  };
  const timeout = () => rnd(8) ? 1 + rnd(rnd(4) ? 3000 : 60000) : -1;
  const act = (t: Thread) => {
    const c = rnd(100);
    if (c < 45) { const ns = 1 + rnd(rnd(4) ? 3000 : 60000); assert.equal(k.svc(t, 0x0B, ns), ACT.SWITCH); began(t, "sleep", ns); }
    else if (c < 65) { const ns = timeout(); assert.equal(k.svc(t, 0x34, addr, 2, 7, ns), ACT.SWITCH); began(t, "address", ns); }
    else if (c < 80) { const ns = timeout(); assert.equal(k.svc(t, 0x18, 0, hs, 1, ns), ACT.SWITCH); began(t, "sync", ns); }
    else if (c < 86) { k.svc(t, 0x35, addr, 0, 7, rnd(4) - 1); sweep(); }                      // wakes some or all address waiters
    else if (c < 91) { k.svc(t, 0x11, ev.w); sweep(); k.svc(t, 0x12, ev.w); }                   // wakes every synchronization waiter
    else if (c < 95) { const o = threads[rnd(threads.length)]; if (o !== t && o.wait === "sync") { k.svc(t, 0x19, o.handle); sweep(); } }
    else if (c < 98) { const o = threads[rnd(threads.length)]; if (o !== t && !paused.has(o)) { assert.equal(k.call(t, 0x32, o.handle, 1), 0); paused.add(o); } }
    else { for (const o of [...paused]) if (o !== t) { assert.equal(k.call(t, 0x32, o.handle, 0), 0); paused.delete(o); } }
  };
  const wakes = () => k.trace().filter(l => l.includes(" -Wake-> ")).map(l => Number(/#(\d+) /.exec(l)![1]));
  for (let i = 0; i < steps; i++) {
    for (let n = rnd(6); n > 0; n--) { const t = k.schedule(); if (t) act(t); }
    if (!rnd(40)) { held = !held; k.x.kernel_clock_freeze(0, held ? 1 : 0); }
    sweep();
    const before = new Map(threads.map(t => [t.index, t.state]));
    k.x.kit_trace_clear();
    k.tick(rnd(5) ? rnd(700) : rnd(3) ? 0 : rnd(40000));
    const now = guest();
    const due = [...waits.values()].filter(w => w.deadline <= now).sort((a, b) => a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.seq - b.seq);
    assert.deepEqual(wakes(), due.map(w => w.t.index), `tick ${i}: the waits that timed out, in order`);
    assert.equal(k.trace().length, due.length, `tick ${i}: nothing but the timeouts moved`);
    for (const w of due) {
      waits.delete(w.t.index);
      assert.equal(w.t.info.waitKind, 0);
      assert.equal(w.t.state, paused.has(w.t) ? "PausedRunnable" : "Runnable");
      if (w.kind !== "sleep") assert.equal(w.t.result, R.TIMEOUT);
      before.delete(w.t.index);
    }
    for (const [idx, s] of before) assert.equal(k.byIndex(idx).state, s);
    for (const w of waits.values()) assert.ok(w.t.info.waitKind && w.deadline > now, "a waiter is past its deadline");
    const next = [...waits.values()].reduce((d, w) => w.deadline < d ? w.deadline : d, FOREVER);
    assert.equal(k.nextTimeout() === FOREVER, next === FOREVER || held);
    if (due.length) { fired.push(`${i}@${now}: ${due.map(w => `${w.t.index}/${w.kind}`).join(" ")}`); total += due.length; }
    k.check();
  }
  assert.equal(k.x.kit_refused_total(), 0);
  assert.deepEqual(k.red, []);
  return { fired, total };
}

test("timeouts: 80 threads in timed waits fire at their ticks, earliest deadline first, then in wait order", () => {
  const a = timeouts(7001, 80, 3000);
  assert.ok(a.total > 1500, `only ${a.total} timeouts`);
  assert.ok(a.fired.some(l => l.split(" ").length > 3), "several waits ended in one tick");
  assert.deepEqual(timeouts(7001, 80, 3000).fired, a.fired, "the same script twice");
  for (const seed of [1, 2, 3, 4]) timeouts(seed, 12, 1500);   // few threads: most ticks have nothing due
});

test("timeouts: a wait that ended early does not hide or delay a later deadline", () => {
  const k = new Kernel(), m = k.main, addr = k.word(7);
  const a = k.thread(44, 1), b = k.thread(44, 2), c = k.thread(44, 3);
  assert.equal(k.svc(a, 0x34, addr, 2, 7, 100), ACT.SWITCH);        // the earliest deadline: 100
  assert.equal(k.svc(b, 0x0B, 500), ACT.SWITCH);
  k.tick(50);
  k.svc(m, 0x35, addr, 0, 7, 1);                                    // a's wait ends before its timeout
  assert.deepEqual([a.state, a.result], ["Runnable", 0]);
  k.tick(100); assert.equal(b.state, "Waiting");                    // 150: past a's old deadline, nothing is due
  assert.equal(k.svc(c, 0x0B, 100), ACT.SWITCH);                    // a new earliest deadline (250) after that tick
  k.tick(99); assert.deepEqual([b.state, c.state], ["Waiting", "Waiting"]);
  k.tick(1); assert.deepEqual([b.state, c.state], ["Waiting", "Runnable"]);
  assert.equal(k.svc(a, 0x0B, 10), ACT.SWITCH);                     // 260, earlier than b's 500
  k.tick(10); assert.deepEqual([a.state, b.state], ["Runnable", "Waiting"]);
  k.tick(239); assert.equal(b.state, "Waiting");
  k.tick(1); assert.equal(b.state, "Runnable");
  // a deadline does not come while the guest clock stands, and comes when the clock has run that long
  assert.equal(k.svc(b, 0x0B, 30), ACT.SWITCH);
  k.x.kernel_clock_freeze(0, 1); k.tick(1000); assert.equal(b.state, "Waiting");
  k.x.kernel_clock_freeze(0, 0); k.tick(29); assert.equal(b.state, "Waiting");
  k.tick(1); assert.equal(b.state, "Runnable");
  // a fresh kernel starts with no deadline remembered
  const k2 = new Kernel();
  k2.tick(5000); assert.equal(k2.svc(k2.main, 0x0B, 5), ACT.SWITCH);
  k2.tick(4); assert.equal(k2.main.state, "Waiting"); k2.tick(1); assert.equal(k2.main.state, "Runnable");
  assert.deepEqual([...k.red, ...k2.red], []);
});
