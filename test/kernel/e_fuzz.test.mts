// Scheduling determinism and the property test: random sequences of lock / unlock / condition wait / signal / address
// wait / event wait / sleep / yield / exit / pause / priority change over several threads on three cores, with the
// invariants checked after every step.
import assert from "node:assert/strict";
import { test, Kernel, Thread, R, ACT, WAITERS } from "./harness.mts";

const NLOCK = 3, NTHREAD = 7;
interface Guest { t: Thread; holding: number; relock: number; pending: { kind: string; l: number } | null; done: boolean }

// One run of the script chosen by seed. Returns everything observable: the order threads ran in with what they did
// and got, and the kit trace.
export function run(seed: number, steps: number, flags = 0): { log: string[]; trace: string[]; k: Kernel } {
  const k = new Kernel({ flags }), m = k.main, log: string[] = [];
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 9) % n; };
  const locks = Array.from({ length: NLOCK }, () => k.word()), keys = locks.map(() => k.word()), addr = [k.word(5), k.word(5)];
  const holder: (Guest | null)[] = locks.map(() => null);
  const events = [k.event(), k.event()];
  const hs = k.alloc(8); k.w32(hs, events[0].r); k.w32(hs + 4, events[1].r);
  assert.equal(k.call(m, 0x0F, 0xFFFF8000, 3, 0b1000), 0);        // the supervisor (main) lives alone on core 3
  const spawn = (): Guest => ({ t: k.thread(40 + rnd(4), rnd(3)), holding: -1, relock: -1, pending: null, done: false });
  const guests: Guest[] = Array.from({ length: NTHREAD }, spawn);
  const byIndex = (i: number) => guests.find(g => !g.done && g.t.index === i)!;
  let draining = false;

  const invariants = (what: string) => {
    const e = k.x.kernel_check();
    assert.equal(e, 0, `kernel_check after ${what}`);
    assert.equal(k.x.kit_refused_total(), 0, `a machine refused an event after ${what}`);
    locks.forEach((a, l) => {   // a lock word names a live owner or is 0, and it is the owner the guests agree on
      const tag = k.r32(a) & ~WAITERS;
      if (holder[l]) assert.equal(tag, holder[l]!.t.handle, `lock ${l} after ${what}`);
      if (tag) { const o = guests.find(g => !g.done && g.t.handle === tag); assert.ok(o && o.t.state !== "Exited", `lock ${l} names a live thread after ${what}`); }
      else assert.equal(k.r32(a), 0);
    });
    const now = k.x.kernel_guest_ns();
    for (const g of guests) {   // a wait is of one kind, and a finite timeout that has come has ended it
      const i = g.t.info;
      if (g.done) continue;
      assert.equal(i.waitKind !== 0, ["Waiting", "Contending", "PausedWaiting", "PausedContending"].includes(g.t.state));
      if (i.waitKind) assert.ok(BigInt.asUintN(64, i.deadline) > now, `a waiter is past its deadline after ${what}`);
    }
  };
  const acquired = (g: Guest, l: number) => { assert.equal(holder[l], null, `two owners of lock ${l}`); assert.equal(k.r32(locks[l]) & ~WAITERS, g.t.handle); holder[l] = g; g.holding = l; };
  const tryLock = (g: Guest, l: number) => {
    const act = k.lock(g.t, locks[l]);
    if (act === ACT.CONTINUE) { assert.equal(k.r32(locks[l]), g.t.handle); holder[l] = null; acquired(g, l); return "lock"; }
    assert.ok(g.t.wait === "lock"); g.pending = { kind: "lock", l };
    return "lock-wait";
  };
  const release = (g: Guest) => { const l = g.holding; holder[l] = null; g.holding = -1; k.unlock(g.t, locks[l]); return "unlock"; };

  // what a guest thread does when it has its core
  const act = (g: Guest): string => {
    const t = g.t;
    if (g.pending) {   // its blocking SVC returned
      const p = g.pending, r = t.result; g.pending = null;
      if (p.kind === "lock") { assert.equal(r, 0); acquired(g, p.l); }
      else if (p.kind === "cv") { if (r === 0) acquired(g, p.l); else { assert.equal(r, R.TIMEOUT); g.relock = p.l; } }
      else if (p.kind === "addr") assert.ok(r === 0 || r === R.TIMEOUT);
      else if (p.kind === "sync") assert.ok(r === 0 || r === R.TIMEOUT || r === R.CANCELLED);
    }
    if (g.relock >= 0) { const l = g.relock; g.relock = -1; return tryLock(g, l); }
    const c = rnd(100);
    if (g.holding >= 0) {
      const l = g.holding;
      if (draining || c < 40) return release(g);
      if (c < 55) {   // the SDK's condition wait: the kernel releases the lock
        holder[l] = null; g.holding = -1;
        const a = k.svc(t, 0x1C, locks[l], keys[l], t.handle, 200 + rnd(3000));
        assert.equal(a, ACT.SWITCH); g.pending = { kind: "cv", l };
        return "cv-wait";
      }
      if (c < 72) { if (k.r32(keys[l])) k.svc(t, 0x1D, keys[l], rnd(3) - 1); return "cv-signal"; }   // the fast path: no SVC when the key is 0
      if (c < 82) { k.svc(t, 0x0B, 0); return "yield"; }
      if (c < 88) { k.svc(t, 0x0B, 1 + rnd(1500)); g.pending = { kind: "sleep", l: -1 }; return "sleep"; }
      if (c < 94) { k.x.kernel_preempt(t.ctx); return "slice"; }
      k.svc(t, 0x0C, 0, 0xFFFF8000); return "prio?";
    }
    if (draining) { g.done = true; k.svc(t, 0x0A); return "exit"; }
    if (c < 35) return tryLock(g, rnd(NLOCK));
    if (c < 45) { k.svc(t, 0x0B, 1 + rnd(2500)); g.pending = { kind: "sleep", l: -1 }; return "sleep"; }
    if (c < 55) { k.svc(t, 0x0B, rnd(2) ? 0 : -1n); return "yield"; }
    if (c < 63) {
      const a = addr[rnd(2)], type = rnd(3), v = k.r32(a) + (type === 2 ? 0 : 1);
      const before = k.r32(a);
      const r = k.svc(t, 0x34, a, type, v, rnd(4) ? 300 + rnd(2000) : 0);
      if (r === ACT.SWITCH && t.wait === "address") g.pending = { kind: "addr", l: -1 };
      if (type === 1) k.w32(a, before);   // keep the word in range for the next waiter
      return "addr-wait";
    }
    if (c < 71) { const a = addr[rnd(2)], type = rnd(3); k.svc(t, 0x35, a, type, k.r32(a), rnd(4) - 1); k.w32(a, 5); return "addr-signal"; }
    if (c < 79) {
      const r = k.svc(t, 0x18, 0, hs + 4 * rnd(2), 1 + rnd(1), rnd(5) ? 200 + rnd(3000) : 0);
      if (r === ACT.SWITCH && t.wait === "sync") g.pending = { kind: "sync", l: -1 };
      return "sync-wait";
    }
    if (c < 87) { const e = events[rnd(2)]; k.svc(t, rnd(2) ? 0x11 : 0x12, e.w); return "event"; }
    if (c < 90) { g.done = true; k.svc(t, 0x0A); return "exit"; }
    if (c < 96) { k.x.kernel_preempt(t.ctx); return "slice"; }
    k.svc(t, 0x10); return "core?";
  };
  // the supervisor: replaces threads that exited, pauses and resumes, changes priorities, cancels waits
  const supervise = (): string => {
    const dead = guests.findIndex(g => g.done);
    const c = rnd(100);
    if (draining) { for (const g of guests) if (!g.done) k.call(m, 0x32, g.t.handle, 0); k.svc(m, 0x0B, 0); return "resume-all"; }
    if (dead >= 0 && c < 50) { assert.equal(k.call(m, 0x16, guests[dead].t.handle), 0); guests[dead] = spawn(); return "respawn"; }
    const g = guests[rnd(NTHREAD)];
    if (g.done || c < 40) { k.svc(m, 0x0B, 0); return "idle"; }
    if (c < 60) { assert.equal(k.call(m, 0x32, g.t.handle, 1), 0); return "pause"; }
    if (c < 85) { for (const x of guests) if (!x.done) assert.equal(k.call(m, 0x32, x.t.handle, 0), 0); return "resume-all"; }
    if (c < 93) { assert.equal(k.call(m, 0x0D, g.t.handle, 38 + rnd(8)), 0); return "set-prio"; }
    assert.equal(k.call(m, 0x19, g.t.handle), 0); return "cancel";
  };

  const step = (i: number) => {
    k.tick(rnd(4) ? rnd(400) : 0);
    invariants(`tick ${i}`);
    const t = k.schedule();
    assert.ok(t, "the supervisor never blocks, so some thread is always ready");
    // no ready thread of the core has a better priority than the one chosen
    const ti = t.info;
    for (const g of guests) {
      const gi = g.t.info;
      if (!g.done && g.t !== t && g.t.state === "Runnable" && gi.runCore === ti.runCore) assert.ok(gi.eff >= ti.eff, "a better thread was ready on that core");
    }
    const what = t === m ? supervise() : act(byIndex(t.index));
    log.push(`${i} ${t.handle.toString(16)}#${t.index} ${what} -> ${t.state} x0=${t.x(0).toString(16)}`);
    invariants(`step ${i}: ${t.handle.toString(16)} ${what}`);
  };
  for (let i = 0; i < steps; i++) step(i);
  // No lost wake-up, no starvation: once the guests only finish what they hold and exit, every one of them gets there
  draining = true;
  let i = steps;
  for (; guests.some(g => !g.done); i++) { assert.ok(i < steps + 6000, "the threads did not all finish: " + guests.filter(g => !g.done).map(g => `${g.t.handle.toString(16)} ${g.t.state}/${g.t.wait}`).join(", ")); step(i); }
  for (const g of guests) assert.equal(k.call(m, 0x16, g.t.handle), 0);
  for (const e of events) { k.call(m, 0x16, e.w); k.call(m, 0x16, e.r); }
  locks.forEach(a => assert.equal(k.r32(a), 0));
  assert.deepEqual([k.count("handles"), k.count("alive"), k.count("objects"), k.count("events")], [1, 1, 1, 0], "nothing leaked");
  assert.deepEqual(k.red, []);
  return { log, trace: k.trace(), k };
}

test("determinism: the same script twice gives the identical trace and the identical results", () => {
  const a = run(20240607, 4000), b = run(20240607, 4000);
  assert.equal(a.trace.length, 4096, "the kit trace ring is full: these are its last 4096 transitions");
  assert.ok(a.k.x.kit_trace_total() > 4096);
  assert.deepEqual(a.trace, b.trace);
  assert.deepEqual(a.log, b.log);
  assert.equal(a.k.x.kit_trace_total(), b.k.x.kit_trace_total());
  const c = run(20240608, 4000);
  assert.notDeepEqual(a.log, c.log, "another seed is another run");
});

test("determinism: a hand-written script of four threads, twice, down to the trace", () => {
  const script = () => {
    const k = new Kernel(), m = k.main, lock = k.word(), key = k.word(), e = k.event();
    const a = k.thread(30, 2), b = k.thread(44, 1), c = k.thread(44, 1);
    const order: string[] = [];
    const next = () => { const t = k.schedule(); order.push(t ? t.handle.toString(16) : "idle"); return t; };
    k.lock(a, lock); k.svc(a, 0x1C, lock, key, a.handle, 5000);
    k.lock(b, lock); next(); k.svc(b, 0x0B, 0); next();
    k.svc(c, 0x18, 0, k.word(e.r), 1, -1n); next();
    k.svc(b, 0x1D, key, 1); k.unlock(b, lock); next(); next();
    k.tick(100); k.svc(m, 0x11, e.w); next(); k.x.kernel_preempt(b.ctx); next(); next();
    k.svc(a, 0x0A); k.tick(10_000); next(); next();
    return { order, trace: k.trace(), states: [m, a, b, c].map(t => t.state) };
  };
  const x = script(), y = script();
  assert.deepEqual(x, y);
  assert.ok(x.trace.length > 20);
  assert.ok(x.trace.includes("kthread#1 Waiting -Requeue-> Contending"));
});

test("property: random lock / wait / signal / sleep / exit sequences keep every invariant (8 seeds x 2500 steps)", () => {
  for (let seed = 1; seed <= 8; seed++) run(seed * 7919, 2500);
});

test("property: the same without priority inheritance (4 seeds x 2000 steps)", () => {
  for (let seed = 1; seed <= 4; seed++) run(seed * 104729, 2000, 4);
});
