// The kernel's machines (src/kernel/defs: kthread, guest_clock, alias_page) on the kit's own test module, for
// `npm run kit:test`: every transition of each table, and what the tables leave out on purpose. How the kernel itself
// drives them is tested by `npm run kernel:test`, which applies the same coverage rule to the kernel's instances.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";
import { readTrace, formatRecord } from "../../src/kit/host/reader.mts";
import type { MachineDef } from "../../src/kit/host/defs.mts";

// The events that lead from the initial state to `to` (breadth first over the table)
function pathTo(d: MachineDef, to: string): [string, string][] {
  const prev = new Map<string, [string, string] | null>([[d.initial, null]]), queue = [d.initial];
  while (queue.length) {
    const s = queue.shift()!;
    for (const [f, e, t] of d.transitions) if (f === s && !prev.has(t)) { prev.set(t, [f, e]); queue.push(t); }
  }
  const out: [string, string][] = [];
  for (let s = to; prev.get(s); s = prev.get(s)![0]) out.unshift([prev.get(s)![1], s]);
  return out;
}
function everyTransition(k: Kit, d: MachineDef): void {
  d.transitions.forEach(([from, ev, to], n) => {
    k.x.m_init(n, d.id, n);
    for (const [e, s] of pathTo(d, from)) { assert.equal(k.x.m_step(n, E(d, e), 1), 1); assert.equal(k.x.m_state(n), S(d, s)); }
    assert.equal(k.x.m_state(n), S(d, from), `${from} is reachable`);
    assert.equal(k.x.m_can(n, E(d, ev)), 1);
    assert.equal(k.x.m_step(n, E(d, ev), 1), 1, `${from} -${ev}->`);
    assert.equal(k.x.m_state(n), S(d, to), `${from} -${ev}-> ${to}`);
  });
  assert.deepEqual(k.logs, []);
}

const KT = def("kthread"), GC = def("guest_clock"), AP = def("alias_page");

test("kthread: every transition of the table", () => everyTransition(fresh(), KT));
test("guest_clock: every transition of the table", () => everyTransition(fresh(), GC));
test("alias_page: every transition of the table", () => everyTransition(fresh(), AP));

function thread(k: Kit, slot: number, id = slot) {
  k.x.m_init(slot, KT.id, id);
  return {
    go(event: string, to: string, arg = 0) { assert.equal(k.x.m_step(slot, E(KT, event), arg), 1, `${event} accepted`); assert.equal(k.x.m_state(slot), S(KT, to), `${event} leads to ${to}`); },
    no(event: string, arg = 0) { const s = k.x.m_state(slot); assert.equal(k.x.m_step(slot, E(KT, event), arg), 0, `${event} refused`); assert.equal(k.x.m_state(slot), s); },
    get kind() { return k.x.m_data(slot); },
  };
}

test("kthread: the states, events and wait kinds the kernel is written against", () => {
  assert.deepEqual(KT.states, ["Created", "Dormant", "Runnable", "Running", "Waiting", "Contending", "PausedDormant", "PausedRunnable", "PausedWaiting", "PausedContending", "Exited"]);
  assert.deepEqual(KT.events, ["Create", "Start", "Schedule", "Preempt", "Yield", "Block", "Requeue", "Wake", "PauseRequest", "Resume", "Exit", "Terminate"]);
  assert.deepEqual(KT.data.Waiting.values, ["lock", "condvar", "address", "sync", "sleep", "clock"]);
  assert.deepEqual(KT.data.PausedWaiting.values, KT.data.Waiting.values, "a paused wait is of the same kinds");
  assert.deepEqual(KT.final, ["Exited"]);
});

test("kthread: a pause keeps the wait kind, through wake, requeue and resume", () => {
  const k = fresh(), kinds = KT.data.Waiting.values!;
  kinds.forEach((name, i) => {
    const t = thread(k, i, 100 + i), kind = i + 1;
    t.go("Create", "Dormant"); t.go("Start", "Runnable"); t.go("Schedule", "Running");
    t.go("Block", "Waiting", kind); assert.equal(t.kind, kind, name);
    t.go("PauseRequest", "PausedWaiting", kind); assert.equal(t.kind, kind, `${name} under the pause`);
    t.go("Resume", "Waiting", kind); assert.equal(t.kind, kind, `${name} after the resume`);
    t.go("PauseRequest", "PausedWaiting", kind);
    t.go("Wake", "PausedRunnable"); assert.equal(t.kind, 0, "the kind goes with the wait");
    t.go("Resume", "Runnable");
  });
  const t = thread(k, 20, 7);
  t.go("Create", "Dormant"); t.go("Start", "Runnable"); t.go("Schedule", "Running"); t.go("Block", "Waiting", 2);
  t.go("Requeue", "Contending"); t.go("PauseRequest", "PausedContending"); t.go("Resume", "Contending"); t.go("Wake", "Runnable");
  assert.deepEqual(readTrace(k.x).slice(-8).map(r => formatRecord(r, k.machines)), [
    "kthread#7 Created -Create-> Dormant", "kthread#7 Dormant -Start-> Runnable", "kthread#7 Runnable -Schedule-> Running", "kthread#7 Running -Block-> Waiting",
    "kthread#7 Waiting -Requeue-> Contending", "kthread#7 Contending -PauseRequest-> PausedContending", "kthread#7 PausedContending -Resume-> Contending",
    "kthread#7 Contending -Wake-> Runnable"]);
  assert.deepEqual(k.logs, []);
});

test("kthread: what the table leaves out on purpose is refused", () => {
  const k = fresh(), t = thread(k, 0, 5);
  t.no("Start"); t.no("Terminate");          // the slot is not a thread yet
  t.go("Create", "Dormant");
  t.no("Create"); t.no("Schedule"); t.no("Exit"); t.no("Block", 1);
  t.go("PauseRequest", "PausedDormant");
  t.no("PauseRequest");                      // twice: the kernel asks can() first
  t.no("Schedule");
  t.go("Start", "PausedRunnable");
  t.no("Schedule"); t.no("Start"); t.no("Wake");
  t.go("Resume", "Runnable");
  t.no("Resume"); t.no("Block", 1); t.no("Exit"); t.no("Yield"); t.no("Requeue");
  t.go("Schedule", "Running");
  t.no("Schedule"); t.no("Wake"); t.no("Start"); t.no("Requeue");
  t.no("Block", 0); t.no("Block", 7);        // a wait has a kind
  t.go("Block", "Waiting", 4);
  t.no("Block", 4); t.no("Schedule"); t.no("Exit"); t.no("Yield"); t.no("Preempt");
  t.no("PauseRequest", 0);                   // PausedWaiting needs the kind too
  t.go("Requeue", "Contending");
  t.no("Requeue"); t.no("Schedule");
  t.go("Wake", "Runnable"); t.go("Schedule", "Running"); t.go("Exit", "Exited");
  for (const e of KT.events) t.no(e, 1);     // final
  assert.equal(k.logs.length, k.x.kit_refused_total());
  assert.ok(k.logs.every(l => l.startsWith("[RED] kit: kthread#5 refused ")));
  assert.ok(k.logs.includes("[RED] kit: kthread#5 refused Block in Running (bad data)"));
  assert.ok(k.logs.includes("[RED] kit: kthread#5 refused Terminate in Exited (no transition)"));
});

test("guest_clock: the state number is the reason set, and every state carries the clock's value", () => {
  const names = ["Running", "Hold", "Background", "HoldBackground", "Keyboard", "HoldKeyboard", "BackgroundKeyboard", "HoldBackgroundKeyboard"];
  assert.deepEqual(GC.states, names);
  assert.deepEqual(GC.events, ["FreezeHold", "ThawHold", "FreezeBackground", "ThawBackground", "FreezeKeyboard", "ThawKeyboard"]);
  assert.equal(GC.transitions.length, 48, "total: no event is ever refused");
  for (const [from, ev, to] of GC.transitions) {
    const bit = 1 << ["Hold", "Background", "Keyboard"].indexOf(ev.replace(/^(Freeze|Thaw)/, "")), m = names.indexOf(from);
    assert.equal(names.indexOf(to), ev.startsWith("Freeze") ? m | bit : m & ~bit);
  }
  assert.deepEqual(Object.keys(GC.data), names);
  const k = fresh();
  k.x.m_init(0, GC.id, 0);
  assert.equal(k.x.m_step(0, E(GC, "FreezeKeyboard"), 1234), 1); assert.equal(k.x.m_data(0), 1234);
  assert.equal(k.x.m_step(0, E(GC, "FreezeKeyboard"), 99), 1); assert.equal(k.x.m_data(0), 1234, "holding a held reason keeps where the clock stands");
  assert.equal(k.x.m_step(0, E(GC, "FreezeHold"), 1234), 1); assert.equal(k.x.m_state(0), 5);
  assert.equal(k.x.m_step(0, E(GC, "ThawKeyboard"), 1234), 1); assert.equal(k.x.m_step(0, E(GC, "ThawHold"), 77), 1);
  assert.deepEqual([k.x.m_state(0), k.x.m_data(0)], [0, 77]);
});

test("alias_page: three states, total over Map and Unmap", () => {
  assert.deepEqual(AP.states, ["Fresh", "Mapped", "Stale"]);
  assert.equal(AP.transitions.length, 6);
  assert.ok(!AP.transitions.some(([f, , t]) => f !== "Fresh" && t === "Fresh"), "a page that was mapped is never Fresh again");
});
