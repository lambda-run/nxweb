// The prepare machine (src/prepare/defs/prepare.json) on its own, for `npm run kit:test`: every transition of the
// table is taken, every other (state, event) pair is refused and changes nothing, and Failed carries its reason.
// The prepare module driving it over real folders is `npm run prepare:test`.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";
import type { MachineDef } from "../../src/kit/host/defs.mts";

function route(M: MachineDef, state: string): string[] {
  const seen = new Map<string, string[]>([[M.initial, []]]), queue = [M.initial];
  while (queue.length) {
    const s = queue.shift()!;
    if (s === state) return seen.get(s)!;
    for (const [f, e, t] of M.transitions) if (f === s && !seen.has(t)) { seen.set(t, [...seen.get(s)!, e]); queue.push(t); }
  }
  throw new Error(`${M.name}: ${state} cannot be reached`);
}
function at(k: Kit, slot: number, M: MachineDef, state: string): void {
  k.x.m_init(slot, M.id, slot);
  for (const e of route(M, state)) assert.equal(k.x.m_step(slot, E(M, e), 1), 1);
  assert.equal(k.x.m_state(slot), S(M, state));
}

test("prepare: every transition of the table, and every other (state, event) pair refused", () => {
  const M = def("prepare"), k = fresh();
  let slot = 0, refused = 0;
  for (const s of M.states) for (const e of M.events) {
    const t = M.transitions.find(([f, ev]) => f === s && ev === e);
    at(k, slot, M, s);
    const reds = k.logs.length;
    if (t) {
      assert.equal(k.x.m_step(slot, E(M, e), 1), 1, `${s} -${e}-> ${t[2]}`);
      assert.equal(k.x.m_state(slot), S(M, t[2]));
      assert.equal(k.logs.length, reds);
    } else {
      assert.equal(k.x.m_step(slot, E(M, e), 1), 0, `${e} is refused in ${s}`);
      assert.equal(k.x.m_state(slot), S(M, s));
      assert.match(k.logs.at(-1)!, new RegExp(`^\\[RED\\] kit: prepare#${slot} refused ${e} in ${s} \\(no transition\\)$`));
      refused++;
    }
    slot++;
  }
  assert.equal(refused, M.states.length * M.events.length - M.transitions.length);
});

test("prepare: a run through the five stages, done or skipped; Failed carries one of the twelve reasons and nothing else; a finished, failed or cancelled prepare starts again", () => {
  const M = def("prepare"), k = fresh();
  const go = (e: string, to: string, arg = 0) => { assert.equal(k.x.m_step(0, E(M, e), arg), 1, e); assert.equal(k.x.m_state(0), S(M, to), `${e} leads to ${to}`); };
  assert.deepEqual(M.states, ["Idle", "Detect", "Index", "Profile", "Code", "Shaders", "Ready", "Failed", "Cancelled"]);
  assert.deepEqual(M.data!.Failed.values, ["layout", "npdm", "arch", "version", "dlc", "module", "romfs", "profile", "cut", "read", "storage", "internal"]);
  k.x.m_init(0, M.id, 0);
  go("Start", "Detect"); go("Done", "Index"); go("Skip", "Profile"); go("Done", "Code"); go("Skip", "Shaders"); go("Done", "Ready");
  assert.equal(k.x.m_data(0), 0);
  go("Start", "Detect"); go("Skip", "Index"); go("Fail", "Failed", 7);
  assert.equal(k.x.m_data(0), 7, "the reason: romfs");
  go("Start", "Detect"); assert.equal(k.x.m_data(0), 0, "the reason goes with the state");
  go("Cancel", "Cancelled"); go("Start", "Detect"); go("Done", "Index"); go("Done", "Profile"); go("Done", "Code");
  // a reason outside the list is refused: the stage stays what it was
  for (const bad of [0, 13, 200]) {
    assert.equal(k.x.m_step(0, E(M, "Fail"), bad), 0);
    assert.match(k.logs.at(-1)!, /^\[RED\] kit: prepare#0 refused Fail in Code \(bad data\)$/);
    assert.equal(k.x.m_state(0), S(M, "Code"));
  }
  go("Fail", "Failed", 9);
  assert.equal(k.x.m_data(0), 9, "cut");
});
