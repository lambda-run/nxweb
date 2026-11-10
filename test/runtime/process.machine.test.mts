// The process lifecycle machine (src/runtime/defs/process.json) on its own, for `npm run kit:test`: every transition
// and what each state refuses. The runtime driving it with real guests is `npm run rt:test` (cases.ts).
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";

const M = def("process");

function process_(k: Kit, slot: number) {
  k.x.m_init(slot, M.id, slot);
  return {
    go(event: string, to: string, arg = 0) {
      assert.equal(k.x.m_step(slot, E(M, event), arg), 1, `${event} accepted in ${M.states[k.x.m_state(slot)]}`);
      assert.equal(k.x.m_state(slot), S(M, to), `${event} leads to ${to}`);
    },
    no(event: string) {
      const s = k.x.m_state(slot);
      assert.equal(k.x.m_step(slot, E(M, event), 1), 0, `${event} refused in ${M.states[s]}`);
      assert.equal(k.x.m_state(slot), s);
    },
    get data() { return k.x.m_data(slot); },
  };
}

test("process: the states and events are the ones the runtime uses", () => {
  assert.deepEqual(M.states, ["Empty", "Loading", "Ready", "Running", "Paused", "Stopped"]);
  assert.deepEqual(M.events, ["Load", "LoadOk", "Start", "Pause", "Resume", "Exit", "Break", "Fault", "Kill"]);
  assert.equal(M.initial, "Empty");
  assert.deepEqual(M.final, ["Stopped"]);
});

test("process: load, start, pause and resume, exit; Stopped carries why and is final", () => {
  const k = fresh(), p = process_(k, 0);
  for (const e of M.events) if (e !== "Load") p.no(e);
  p.go("Load", "Loading"); p.no("Start"); p.no("Load");
  p.go("LoadOk", "Ready"); p.no("Pause"); p.no("Exit"); p.no("Fault");
  p.go("Start", "Running"); p.no("Resume"); p.no("Load");
  p.go("Pause", "Paused"); p.no("Exit"); p.no("Fault"); p.no("Pause");
  p.go("Resume", "Running");
  p.go("Exit", "Stopped", 42);
  assert.equal(p.data, 42);
  for (const e of M.events) p.no(e);
});

test("process: a break and a fault stop a running process; a refused file stops it from Loading", () => {
  const k = fresh();
  const a = process_(k, 0); a.go("Load", "Loading"); a.go("LoadOk", "Ready"); a.go("Start", "Running"); a.go("Break", "Stopped", 7);
  const b = process_(k, 1); b.go("Load", "Loading"); b.go("LoadOk", "Ready"); b.go("Start", "Running"); b.go("Fault", "Stopped", 3);
  const c = process_(k, 2); c.go("Load", "Loading"); c.go("Fault", "Stopped", 7);
  assert.deepEqual([a.data, b.data, c.data], [7, 3, 7]);
  assert.equal(k.logs.length, 0);
  // the embedder's stop: from Ready, Running and Paused
  const d = process_(k, 3); d.no("Kill"); d.go("Load", "Loading"); d.no("Kill"); d.go("LoadOk", "Ready"); d.go("Kill", "Stopped", 4);
  const e = process_(k, 4); e.go("Load", "Loading"); e.go("LoadOk", "Ready"); e.go("Start", "Running"); e.go("Kill", "Stopped", 4);
  const f = process_(k, 5); f.go("Load", "Loading"); f.go("LoadOk", "Ready"); f.go("Start", "Running"); f.go("Pause", "Paused"); f.go("Kill", "Stopped", 4);
  assert.equal(k.logs.length, 2, "the two refused Kills are red");
});
