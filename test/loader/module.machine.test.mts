// The module lifecycle machine (src/loader/defs/module.json) on its own, for `npm run kit:test`: every transition, the
// reason Refused carries, and the property the machine is there for: no path maps a module that has let go of its file.
// The loader driving the machine with real modules is `npm run loader:test` (d_lifecycle.test.mts).
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";

const M = def("module");
const REASONS = M.data.Refused.values!;

function module_(k: Kit, slot: number) {
  k.x.m_init(slot, M.id, slot);
  return {
    go(event: string, to: string, arg = 0) {
      assert.equal(k.x.m_step(slot, E(M, event), arg), 1, `${event} accepted in ${M.states[k.x.m_state(slot)]}`);
      assert.equal(k.x.m_state(slot), S(M, to), `${event} leads to ${to}`);
    },
    no(event: string, arg = 0) {
      const s = k.x.m_state(slot);
      assert.equal(k.x.m_step(slot, E(M, event), arg), 0, `${event} refused in ${M.states[s]}`);
      assert.equal(k.x.m_state(slot), s);
    },
    get reason() { return k.x.m_data(slot); },
  };
}

test("module: the states, events and refusal reasons are the ones the loader uses", () => {
  assert.deepEqual(M.states, ["New", "Parsed", "Mapped", "Relocated", "Active", "Pinned", "Unloaded", "Refused"]);
  assert.deepEqual(M.events, ["ParseOk", "Map", "Relocate", "Activate", "Pin", "Unload", "Refuse"]);
  assert.deepEqual(REASONS, ["header", "layout", "decompress", "hash", "mod0", "dynamic", "symbols", "relocs", "arena"]);
  assert.equal(M.initial, "New");
  assert.deepEqual(M.final, ["Pinned", "Refused"]);
});

test("module: a module of the start set: parsed, mapped, relocated, active, pinned for good", () => {
  const k = fresh(), m = module_(k, 0);
  m.go("ParseOk", "Parsed"); m.go("Map", "Mapped"); m.go("Relocate", "Relocated"); m.go("Activate", "Active"); m.go("Pin", "Pinned");
  for (const e of M.events) m.no(e, 1);
});

test("module: an NRO is unloaded from Mapped, Relocated or Active and mapped again", () => {
  const k = fresh(), m = module_(k, 0);
  m.go("ParseOk", "Parsed"); m.go("Map", "Mapped");
  m.go("Unload", "Unloaded");
  m.go("Map", "Mapped"); m.go("Relocate", "Relocated");
  m.go("Unload", "Unloaded");
  m.go("Map", "Mapped"); m.go("Relocate", "Relocated"); m.go("Activate", "Active");
  m.go("Unload", "Unloaded");
  m.no("Relocate"); m.no("Activate"); m.no("Pin"); m.no("Unload"); m.no("ParseOk");
  m.go("Map", "Mapped");
});

test("module: refusal from New, Parsed and Unloaded, with its reason; never from a mapped state", () => {
  const k = fresh();
  const a = module_(k, 0);
  a.go("Refuse", "Refused", 1);
  assert.equal(REASONS[a.reason - 1], "header");
  const b = module_(k, 1);
  b.go("ParseOk", "Parsed"); b.go("Refuse", "Refused", 4);
  assert.equal(REASONS[b.reason - 1], "hash");
  const c = module_(k, 2);
  c.go("ParseOk", "Parsed"); c.go("Map", "Mapped"); c.no("Refuse", 8);
  c.go("Relocate", "Relocated"); c.no("Refuse", 8);
  c.go("Activate", "Active"); c.no("Refuse", 8);
  c.go("Unload", "Unloaded"); c.go("Refuse", "Refused", 3);
  assert.equal(REASONS[c.reason - 1], "decompress");
  for (const m of [a, b, c]) for (const e of M.events) m.no(e, 1);
  // a refusal needs one of the reasons
  const d = module_(k, 3);
  d.no("Refuse", 0); d.no("Refuse", REASONS.length + 1);
  d.go("Refuse", "Refused", REASONS.length);
});

test("module: Map is accepted in Parsed and Unloaded only, and no state after Pin or Refuse accepts anything", () => {
  // The record refers to its file from New until Pin or Refuse (src/loader/module.ts). So "a reload finds no pristine
  // copy" would need Map after one of those two: the table has no such path.
  const mapFrom = M.transitions.filter(([, e]) => e === "Map").map(([f]) => f).sort();
  assert.deepEqual(mapFrom, ["Parsed", "Unloaded"]);
  for (const f of M.final) assert.equal(M.transitions.filter(([from]) => from === f).length, 0, `${f} is final`);
  const into = (s: string) => M.transitions.filter(([, , to]) => to === s).map(([f, e]) => `${f}/${e}`).sort();
  assert.deepEqual(into("Unloaded"), ["Active/Unload", "Mapped/Unload", "Relocated/Unload"]);
  assert.deepEqual(into("Pinned"), ["Active/Pin", "Relocated/Pin"]);
});

test("module: a module of the start set is pinned as soon as it is relocated; Pin is refused before the relocation", () => {
  const k = fresh(), m = module_(k, 0);
  m.no("Pin");
  m.go("ParseOk", "Parsed"); m.no("Pin");
  m.go("Map", "Mapped"); m.no("Pin");
  m.go("Relocate", "Relocated"); m.go("Pin", "Pinned");
  for (const e of M.events) m.no(e, 1);
});
