// The hle machines (src/hle/defs/*.json) on their own, for `npm run kit:test`: every transition of every table is
// taken, every other (state, event) pair is refused and changes nothing, and the shapes the take-overs rely on.
// The module driving them through hle_call is `npm run hle:test`, which applies the same coverage rule to itself.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";
import type { MachineDef } from "../../src/kit/host/defs.mts";

const NAMES = ["oe_focus", "oe_msg", "oe_notify_event", "hle_exit", "nifm_request", "swkbd_request", "swkbd_inline", "web_session"];

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

test("oe_focus: the state's number + 1 is the SDK's FocusState; any state reaches any other in one step", () => {
  const M = def("oe_focus");
  assert.deepEqual(M.states, ["InFocus", "OutOfFocus", "Background"]);
  assert.deepEqual(M.events, ["ToInFocus", "ToOutOfFocus", "ToBackground"]);
  for (const a of M.states) for (const b of M.states) assert.equal(M.transitions.some(([f, , t]) => f === a && t === b), a !== b, `${a} -> ${b}`);
});

test("oe_msg and oe_notify_event: a second Post while queued keeps the state; the event is bound once", () => {
  const k = fresh(), Q = def("oe_msg"), N = def("oe_notify_event");
  k.x.m_init(0, Q.id, 15);
  assert.equal(k.x.m_step(0, E(Q, "Pop"), 0), 0, "nothing to pop");
  assert.equal(k.x.m_step(0, E(Q, "Post"), 0), 1); assert.equal(k.x.m_step(0, E(Q, "Post"), 0), 1); assert.equal(k.x.m_state(0), S(Q, "Queued"));
  assert.equal(k.x.m_step(0, E(Q, "Pop"), 0), 1); assert.equal(k.x.m_state(0), S(Q, "Idle"));
  k.x.m_init(1, N.id, 0);
  assert.equal(k.x.m_step(1, E(N, "QueueHolds"), 0), 0, "nothing is signalled before the event is bound");
  assert.equal(k.x.m_step(1, E(N, "Bind"), 0), 1); assert.equal(k.x.m_step(1, E(N, "Bind"), 0), 0, "bound once");
  assert.equal(k.x.m_step(1, E(N, "QueueEmpty"), 0), 1); assert.equal(k.x.m_state(1), S(N, "Clear"));
  assert.equal(k.logs.length, 3);
});

test("hle_exit: the first request carries its reason to the end; Exited is final", () => {
  const k = fresh(), M = def("hle_exit");
  assert.deepEqual(M.final, ["Exited"]);
  assert.deepEqual(M.data.Exiting.values, ["hostShutdown", "executeProgram", "abort"]);
  k.x.m_init(0, M.id, 0);
  assert.equal(k.x.m_step(0, E(M, "Request"), 0), 0, "a reason is required"); assert.equal(k.x.m_step(0, E(M, "Request"), 4), 0);
  assert.equal(k.x.m_step(0, E(M, "Request"), 3), 1); assert.equal(k.x.m_data(0), 3);
  assert.equal(k.x.m_step(0, E(M, "Request"), 1), 0, "a second request changes nothing"); assert.equal(k.x.m_data(0), 3);
  assert.equal(k.x.m_step(0, E(M, "Done"), 3), 1); assert.equal(k.x.m_state(0), S(M, "Exited")); assert.equal(k.x.m_data(0), 3);
  for (const e of M.events) assert.equal(k.x.m_step(0, E(M, e), 1), 0);
});

test("swkbd_request and swkbd_inline: one request at a time; an answer carries its result", () => {
  const k = fresh(), R = def("swkbd_request"), I = def("swkbd_inline");
  k.x.m_init(0, R.id, 0);
  assert.equal(k.x.m_step(0, E(R, "Answer"), 1), 0, "no request waiting");
  assert.equal(k.x.m_step(0, E(R, "Ask"), 0), 1); assert.equal(k.x.m_step(0, E(R, "Ask"), 0), 0, "one at a time");
  assert.equal(k.x.m_step(0, E(R, "Answer"), 0), 0, "a result is required");
  assert.equal(k.x.m_step(0, E(R, "Answer"), 2), 1); assert.equal(k.x.m_data(0), 2);
  assert.equal(k.x.m_step(0, E(R, "Take"), 0), 1); assert.equal(k.x.m_data(0), 0);
  k.x.m_init(1, I.id, 0);
  assert.equal(k.x.m_can(1, E(I, "Disappear")), 0, "Disappear before anything is shown is not this machine's business");
  for (const [e, to] of [["Appear", "Shown"], ["Ask", "Asking"]]) { assert.equal(k.x.m_step(1, E(I, e), 0), 1); assert.equal(k.x.m_state(1), S(I, to)); }
  assert.equal(k.x.m_can(1, E(I, "Appear")), 0, "an Appear while the text is asked for does not arm a second request");
  assert.equal(k.x.m_step(1, E(I, "Decided"), 0), 1); assert.equal(k.x.m_state(1), S(I, "Hidden"));
});

test("nifm_request and web_session: the numbers the C code used", () => {
  const N = def("nifm_request"), W = def("web_session");
  assert.deepEqual(N.states, ["Idle", "OnHold"]);
  assert.deepEqual(W.states, ["None", "Started", "Shown", "Ended"], "g_web_state 0, 1, 2, 3");
  for (const s of W.states) assert.ok(W.transitions.some(([f, e, t]) => f === s && e === "Start" && t === "Started"), `Start replaces a page in ${s}`);
});
