// The fs machines (src/fs/defs/*.json) on their own, for `npm run kit:test`: every transition of every table is
// taken, every other (state, event) pair is refused and changes nothing. The fs module driving them with real
// storage is `npm run fs:test`, which applies the same coverage rule to the module itself.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";
import type { MachineDef } from "../../src/kit/host/defs.mts";

const NAMES = ["fs_save", "fs_file", "fs_dir", "fs_image", "fs_mount", "fs_pend"];

// The events that lead from the initial state to `state` (breadth first over the table)
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

for (const name of NAMES) {
  const M = def(name);
  test(`${name}: every transition of the table, and every other (state, event) pair refused`, () => {
    const k = fresh();
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
        assert.match(k.logs.at(-1)!, new RegExp(`^\\[RED\\] kit: ${name}#${slot} refused ${e} in ${s} \\(no transition\\)$`));
        refused++;
      }
      slot++;
    }
    assert.equal(refused, M.states.length * M.events.length - M.transitions.length);
  });
}

test("fs_save: a transaction from mount to a sealed commit; a poisoned one is discarded; Poisoned keeps the first error", () => {
  const k = fresh(), M = def("fs_save");
  const go = (slot: number, e: string, to: string, arg = 0) => { assert.equal(k.x.m_step(slot, E(M, e), arg), 1, e); assert.equal(k.x.m_state(slot), S(M, to), `${e} leads to ${to}`); };
  assert.deepEqual(M.states, ["Unmounted", "Recovering", "Clean", "Dirty", "Committing", "Sealing", "Poisoned", "ReadOnly"]);
  k.x.m_init(0, M.id, 0);
  go(0, "Mount", "Recovering"); go(0, "Recovered", "Clean"); go(0, "Commit", "Clean"); go(0, "Write", "Dirty"); go(0, "Write", "Dirty");
  go(0, "Commit", "Committing"); go(0, "CommitFailed", "Dirty"); go(0, "Commit", "Committing"); go(0, "DataDurable", "Sealing"); go(0, "Sealed", "Clean");
  go(0, "Write", "Dirty"); go(0, "WriteFailed", "Poisoned", 28);
  assert.equal(k.x.m_data(0), 28);
  go(0, "WriteFailed", "Poisoned", 5); go(0, "Write", "Poisoned");
  assert.equal(k.x.m_data(0), 28, "the errno of the first failure stays");
  go(0, "Discard", "Recovering");
  assert.equal(k.x.m_data(0), 0);
  go(0, "StillPoisoned", "Poisoned", 28); go(0, "Discard", "Recovering"); go(0, "Recovered", "Clean");
  go(0, "Write", "Dirty"); go(0, "Commit", "Committing"); go(0, "DataDurable", "Sealing"); go(0, "SealUncertain", "Recovering"); go(0, "Unusable", "ReadOnly");
  for (const e of M.events) assert.equal(k.x.m_step(0, E(M, e), 1), 0, `ReadOnly refuses ${e}`);
  // what must not happen: a write while a commit is in flight, a commit before the mount, a second seal
  k.x.m_init(1, M.id, 1);
  assert.equal(k.x.m_step(1, E(M, "Commit"), 0), 0); assert.equal(k.x.m_step(1, E(M, "Write"), 0), 0);
  at(k, 2, M, "Committing"); assert.equal(k.x.m_step(2, E(M, "Write"), 0), 0); assert.equal(k.x.m_step(2, E(M, "Sealed"), 0), 0);
  at(k, 3, M, "Sealing"); assert.equal(k.x.m_step(3, E(M, "Write"), 0), 0); assert.equal(k.x.m_step(3, E(M, "CommitFailed"), 0), 0);
});

test("fs_pend: Waiting carries what the call waits for; fs_image: Bad is final", () => {
  const k = fresh(), P = def("fs_pend"), I = def("fs_image");
  k.x.m_init(0, P.id, 0);
  assert.equal(k.x.m_step(0, E(P, "Begin"), 0), 1);
  assert.equal(k.x.m_step(0, E(P, "Park"), 0), 0, "Park needs one of open, read, flush, remove");
  assert.equal(k.x.m_step(0, E(P, "Park"), 5), 0);
  assert.equal(k.x.m_step(0, E(P, "Park"), 3), 1); assert.equal(k.x.m_data(0), 3);
  assert.equal(k.x.m_step(0, E(P, "Resume"), 0), 1); assert.equal(k.x.m_data(0), 0);
  assert.equal(k.x.m_step(0, E(P, "Finish"), 0), 1); assert.equal(k.x.m_state(0), S(P, "Free"));
  at(k, 1, I, "Bad");
  for (const e of I.events) assert.equal(k.x.m_step(1, E(I, e), 0), 0);
  assert.deepEqual(I.final, ["Bad"]);
});
