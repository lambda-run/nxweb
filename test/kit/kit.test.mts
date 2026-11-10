// The kit itself: tables, step, the three refusal classes, the trace ring, the trace switch, coverage, the generator.
import assert from "node:assert/strict";
import { test, fresh, defs, def, S, E } from "./harness.mts";
import { tableOf, dataMax, validate, NONE, type MachineDef } from "../../src/kit/host/defs.mts";
import { readTrace, formatRecord, unexercised } from "../../src/kit/host/reader.mts";
import { check, diagramSource, tablesSource } from "../../src/kit/host/gen.mts";

// The example machine of these tests is the kernel's thread machine (src/kernel/defs/kthread.json)
const TH = def("kthread");
const th = { id: TH.id, s: (n: string) => S(TH, n), e: (n: string) => E(TH, n) };

// A thread in slot 0 taken to Running
function running(k = fresh(), id = 7) {
  k.x.m_init(0, th.id, id);
  for (const e of ["Create", "Start", "Schedule"]) assert.equal(k.x.m_step(0, th.e(e), 0), 1);
  return k;
}

test("kit: the tables in the wasm are the definitions", () => {
  const ms = fresh().machines;
  assert.equal(ms.length, defs.length);
  ms.forEach((m, i) => {
    const d = defs[i];
    assert.equal(m.name, d.name);
    assert.deepEqual(m.states, d.states);
    assert.deepEqual(m.events, d.events);
    assert.equal(m.initial, d.states.indexOf(d.initial));
    assert.deepEqual([...m.table], [...tableOf(d)]);
    assert.deepEqual([...m.dataMax], d.states.map(s => dataMax(d, s)));
  });
});

test("kit: init puts an instance in the initial state; an unknown machine id is red and traps", () => {
  const k = fresh();
  for (const d of defs) {
    k.x.m_init(d.id, d.id, 1);
    assert.equal(k.x.m_state(d.id), d.states.indexOf(d.initial));
    assert.equal(k.x.m_data(d.id), 0);
  }
  assert.throws(() => k.x.m_init(0, defs.length, 1), WebAssembly.RuntimeError);
  assert.deepEqual(k.logs, [`[RED] kit: no machine with id ${defs.length}`]);
});

test("kit: an accepted step changes the state and is traced", () => {
  const k = fresh();
  k.x.m_init(0, th.id, 41);
  assert.equal(k.x.m_step(0, th.e("Create"), 0), 1);
  assert.equal(k.x.m_state(0), th.s("Dormant"));
  assert.equal(k.x.kit_trace_total(), 1);
  assert.deepEqual(readTrace(k.x), [{ seq: 0, machine: th.id, instance: 41, from: th.s("Created"), to: th.s("Dormant"), event: th.e("Create"), refused: false, reason: 0 }]);
  assert.equal(formatRecord(readTrace(k.x)[0], k.machines), "kthread#41 Created -Create-> Dormant");
  assert.deepEqual(k.logs, []);
  assert.equal(k.x.kit_refused_total(), 0);
});

test("kit: refusal, no transition: state unchanged, false, a red line, counted, traced with the flag", () => {
  const k = running();
  const before = k.x.kit_trace_total();
  assert.equal(k.x.m_step(0, th.e("Start"), 0), 0);
  assert.equal(k.x.m_state(0), th.s("Running"));
  assert.deepEqual(k.logs, ["[RED] kit: kthread#7 refused Start in Running (no transition)"]);
  assert.equal(k.x.kit_refused_total(), 1);
  assert.equal(k.x.kit_trace_total(), before + 1);
  const r = readTrace(k.x).at(-1)!;
  assert.deepEqual(r, { seq: before, machine: th.id, instance: 7, from: th.s("Running"), to: th.s("Running"), event: th.e("Start"), refused: true, reason: 1 });
  assert.equal(formatRecord(r, k.machines), "kthread#7 Running x Start (refused: no transition)");
});

test("kit: refusal, unknown event id", () => {
  const k = running();
  for (const ev of [TH.events.length, 200, 255]) {
    assert.equal(k.x.m_step(0, ev, 0), 0);
    assert.equal(k.x.m_can(0, ev), 0);
    assert.equal(k.x.m_state(0), th.s("Running"));
    assert.equal(k.logs.at(-1), `[RED] kit: kthread#7 refused event ${ev} in Running (unknown event)`);
    const r = readTrace(k.x).at(-1)!;
    assert.equal(r.refused, true); assert.equal(r.reason, 2); assert.equal(r.event, ev); assert.equal(r.to, r.from);
  }
  assert.equal(k.x.kit_refused_total(), 3);
});

test("kit: refusal, a value the target state does not carry", () => {
  const k = running();
  for (const kind of [0, 7, 0xffffffff]) {
    assert.equal(k.x.m_step(0, th.e("Block"), kind), 0);
    assert.equal(k.x.m_state(0), th.s("Running"));
    assert.equal(k.x.m_data(0), 0);
    assert.equal(k.logs.at(-1), "[RED] kit: kthread#7 refused Block in Running (bad data)");
    assert.equal(readTrace(k.x).at(-1)!.reason, 3);
  }
  assert.equal(k.x.kit_refused_total(), 3);
  assert.equal(k.x.m_step(0, th.e("Block"), 5), 1);
  assert.equal(k.x.m_data(0), 5);
});

test("kit: every (state, event) pair without a table entry is refused, in every machine", () => {
  for (const d of defs) {
    // the shortest way to each state
    const path = new Map<string, [string, string][]>([[d.initial, []]]), queue = [d.initial];
    while (queue.length) {
      const s = queue.shift()!;
      for (const [f, e, to] of d.transitions) if (f === s && !path.has(to)) { path.set(to, [...path.get(s)!, [e, to]]); queue.push(to); }
    }
    assert.equal(path.size, d.states.length, `${d.name}: every state can be reached`);
    const table = tableOf(d);
    let refusals = 0;
    for (const s of d.states) for (const e of d.events) {
      const k = fresh();
      k.x.m_init(3, d.id, 9);
      for (const [pe] of path.get(s)!) assert.equal(k.x.m_step(3, E(d, pe), 1), 1);
      assert.equal(k.x.m_state(3), S(d, s));
      const to = table[S(d, s) * d.events.length + E(d, e)], data = k.x.m_data(3);
      assert.equal(k.x.m_can(3, E(d, e)), to === NONE ? 0 : 1);
      assert.deepEqual(k.logs, [], "can() reports nothing");
      if (to !== NONE) continue;
      refusals++;
      assert.equal(k.x.m_step(3, E(d, e), 1), 0, `${d.name}: ${e} in ${s} must be refused`);
      assert.equal(k.x.m_state(3), S(d, s));
      assert.equal(k.x.m_data(3), data);
      assert.deepEqual(k.logs, [`[RED] kit: ${d.name}#9 refused ${e} in ${s} (no transition)`]);
      assert.equal(k.x.kit_refused_total(), 1);
    }
    assert.equal(refusals, d.states.length * d.events.length - d.transitions.length);
  }
});

test("kit: a final state refuses every event", () => {
  const k = running();
  assert.equal(k.x.m_step(0, th.e("Exit"), 0), 1);
  TH.events.forEach((_, ev) => assert.equal(k.x.m_step(0, ev, 1), 0));
  assert.equal(k.x.m_state(0), th.s("Exited"));
  assert.equal(k.x.kit_refused_total(), TH.events.length);
});

test("kit: can() is a pure query: no trace, no count, no log", () => {
  const k = running();
  const total = k.x.kit_trace_total();
  assert.equal(k.x.m_can(0, th.e("Yield")), 1);
  assert.equal(k.x.m_can(0, th.e("Start")), 0);
  assert.equal(k.x.m_state(0), th.s("Running"));
  assert.equal(k.x.kit_trace_total(), total);
  assert.equal(k.x.kit_refused_total(), 0);
  assert.deepEqual(k.logs, []);
});

test("kit: tracing switched off at runtime: nothing is recorded, refusals are still counted and red", () => {
  const k = running();
  assert.equal(k.x.kit_trace_enabled(), 1, "on by default");
  const total = k.x.kit_trace_total();
  k.x.kit_trace_enable(0);
  assert.equal(k.x.kit_trace_enabled(), 0);
  assert.equal(k.x.m_step(0, th.e("Yield"), 0), 1);
  assert.equal(k.x.m_step(0, th.e("Yield"), 0), 0);
  assert.equal(k.x.m_state(0), th.s("Runnable"));
  assert.equal(k.x.kit_trace_total(), total);
  assert.equal(k.x.kit_refused_total(), 1);
  assert.equal(k.logs.length, 1);
  k.x.kit_trace_enable(1);
  assert.equal(k.x.m_step(0, th.e("Schedule"), 0), 1);
  assert.equal(k.x.kit_trace_total(), total + 1);
  k.x.kit_trace_clear();
  assert.equal(k.x.kit_trace_total(), 0);
  assert.deepEqual(readTrace(k.x), []);
});

test("kit: the trace is a ring: the newest records stay, in order", () => {
  const k = running();
  const cap = k.x.kit_trace_cap(), steps = cap + 1000;
  assert.equal(k.x.kit_trace_rec(), 16);
  for (let i = 0; i < steps; i++) assert.equal(k.x.m_step(0, i % 2 ? th.e("Schedule") : th.e("Yield"), 0), 1);
  const total = 3 + steps;
  assert.equal(k.x.kit_trace_total(), total);
  const t = readTrace(k.x);
  assert.equal(t.length, cap);
  t.forEach((r, i) => {
    assert.equal(r.seq, total - cap + i);
    const yielded = (r.seq - 3) % 2 === 0;
    assert.equal(r.event, yielded ? th.e("Yield") : th.e("Schedule"));
    assert.equal(r.to, yielded ? th.s("Runnable") : th.s("Running"));
    assert.equal(r.instance, 7);
  });
});

test("kit: thousands of instances of one definition are independent", () => {
  const k = fresh(), n = 8192;
  for (let i = 0; i < n; i++) k.x.m_init(i, th.id, 100000 + i);
  for (let i = 0; i < n; i += 2) assert.equal(k.x.m_step(i, th.e("Create"), 0), 1);
  for (let i = 0; i < n; i += 4) assert.equal(k.x.m_step(i, th.e("Start"), 0), 1);
  for (let i = 0; i < n; i++) assert.equal(k.x.m_state(i), i % 4 === 0 ? th.s("Runnable") : i % 2 === 0 ? th.s("Dormant") : th.s("Created"));
  assert.equal(readTrace(k.x).at(-1)!.instance, 100000 + n - 4);
  assert.equal(k.x.kit_refused_total(), 0);
});

test("kit: the hot path, tracing on and off (times are printed, not judged)", () => {
  const n = 4096, rounds = 500, time = (trace: number) => {
    const k = fresh(false);   // coverage off, as in a release
    k.x.kit_trace_enable(trace);
    k.x.m_bench(n, 20);
    const t0 = performance.now(), ok = k.x.m_bench(n, rounds), ms = performance.now() - t0;
    assert.equal(ok, n * rounds * 2);
    assert.equal(k.x.kit_trace_total(), trace ? (n * 2 + n * 20 * 2) + (n * 2 + n * rounds * 2) : 0);
    assert.equal(k.x.kit_refused_total(), 0);
    return ms * 1e6 / (n * rounds * 2);
  };
  const on = time(1), off = time(0);
  console.log(`     ${(n * rounds * 2 / 1e6).toFixed(1)} M steps: ${off.toFixed(2)} ns/step with tracing off, ${on.toFixed(2)} ns/step with tracing on`);
});

test("kit: the coverage rule sees a transition no test exercised", () => {
  const k = fresh(false);
  const all = defs.reduce((n, d) => n + d.transitions.length, 0);
  assert.equal(unexercised(k.machines, k.machines.map(m => m.hits)).length, all, "nothing exercised: every transition is reported");
  k.x.m_init(0, th.id, 1);
  k.x.m_step(0, th.e("Create"), 0);
  assert.equal(unexercised(k.machines, k.machines.map(m => m.hits)).length, all, "coverage off: no hits");
  k.x.kit_cover_enable(1);
  k.x.m_step(0, th.e("Start"), 0);
  k.x.m_step(0, th.e("Start"), 0);   // refused: not a hit
  const missing = unexercised(k.machines, k.machines.map(m => m.hits));
  assert.equal(missing.length, all - 1);
  assert.ok(missing.includes("kthread: Created -Create-> Dormant"));
  assert.ok(!missing.includes("kthread: Dormant -Start-> Runnable"));
  assert.equal(k.machines[th.id].hits.reduce((a, b) => a + b, 0), 1);
});

test("generator: the check passes on the committed files and sees a changed definition", () => {
  assert.deepEqual(check(), []);
  const changed: MachineDef[] = defs.map(d => d.name !== "kthread" ? d : { ...d, transitions: [...d.transitions, ["Waiting", "Exit", "Exited"]] });
  assert.deepEqual(check(changed), ["src/kit/gen/tables.ts: out of date", "docs/machines/kthread.md: out of date"]);
  const extra: MachineDef[] = [...defs, { ...defs[0], id: defs.length, name: "extra" }];
  assert.deepEqual(check(extra), ["src/kit/gen/tables.ts: out of date", "docs/machines/extra.md: missing"]);
  const gone = defs.slice(2).map(d => `docs/machines/${d.name}.md: no machine of this name is defined any more`).sort();
  assert.deepEqual(check(defs.slice(0, 2)), ["src/kit/gen/tables.ts: out of date", ...gone]);
});

test("generator: the diagram and the constants come from the table", () => {
  const md = diagramSource(TH);
  assert.ok(md.includes("```mermaid\nstateDiagram-v2\n    [*] --> Created\n"));
  for (const [f, e, to] of TH.transitions) assert.ok(md.includes(`    ${f} --> ${to}: ${e}\n`));
  assert.equal(md.split("\n").filter(l => / --> /.test(l)).length, TH.transitions.length + 2, "initial, each transition, final");
  assert.ok(md.includes("    Exited --> [*]\n"));
  assert.ok(md.includes("    note right of Waiting: carries waitKind (lock, condvar, address, sync, sleep, clock)\n"));
  const src = tablesSource(defs);
  assert.ok(src.includes(`export const KTHREAD: u8 = ${TH.id};`));
  assert.ok(src.includes("export namespace KthreadS {\n  export const Created: u8 = 0;"));
  assert.ok(src.includes("export namespace KthreadWaitKind {\n  export const lock: u64 = 1;"));
});

test("generator: a definition that is not sound is rejected", () => {
  const base = () => JSON.parse(JSON.stringify({ id: 0, name: "m", doc: "d", states: ["A", "B"], initial: "A", events: ["Go"], transitions: [["A", "Go", "B"]] }));
  const bad = (change: (d: any) => void, re: RegExp) => { const d = base(); change(d); assert.throws(() => validate(d, "m.json"), re); };
  validate(base(), "m.json");
  bad(d => d.transitions.push(["A", "Go", "A"]), /two transitions for \(A, Go\)/);
  bad(d => d.transitions.push(["C", "Go", "A"]), /from "C": not a state/);
  bad(d => d.transitions.push(["B", "Stop", "A"]), /on "Stop": not an event/);
  bad(d => d.transitions.push(["B", "Go", "C"]), /to "C": not a state/);
  bad(d => d.states.push("C"), /state "C" is never entered/);
  bad(d => d.events.push("Stop"), /event "Stop" is in no transition/);
  bad(d => { d.final = ["A"]; }, /out of final state "A"/);
  bad(d => { d.initial = "C"; }, /initial "C" is not a state/);
  bad(d => { d.states = ["A", "B", "A"]; }, /duplicate/);
  bad(d => { d.data = { C: { name: "x", type: "u64" } }; }, /data: "C" is not a state/);
  bad(d => { d.data = { B: { name: "x" } }; }, /give "values"/);
  bad(d => { d.name = "Bad Name"; }, /lower_snake_case/);
  bad(d => { d.guard = 1; }, /unknown key "guard"/);
});
