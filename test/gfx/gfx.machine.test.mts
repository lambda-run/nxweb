// The graphics machines (src/gfx/defs/*.json) walked through the kit's test module, so `npm run kit:test` covers every
// transition of their tables. Each test is a sequence the recorder or the lowering really produces (src/gfx/README.md);
// `npm run gfx:test` then reports which transitions the real module took while rendering the scenes.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";

function walker(name: string) {
  const d = def(name), k: Kit = fresh();
  const id = k.machines.findIndex(m => m.name === name);
  let slot = 0;
  return {
    k, d,
    start() { k.x.m_init(++slot, id, slot); return slot; },
    go(s: number, path: [string, string][], arg = 0) {
      for (const [ev, to] of path) {
        assert.equal(k.x.m_step(s, E(d, ev), arg), 1, `${name}: ${ev} refused in ${d.states[k.x.m_state(s)]}`);
        assert.equal(d.states[k.x.m_state(s)], to, `${name}: after ${ev}`);
      }
    },
    refused(s: number, ev: string) {
      const before = k.x.m_state(s), n = k.logs.length;
      assert.equal(k.x.m_step(s, E(d, ev), 0), 0);
      assert.equal(k.x.m_state(s), before);
      assert.match(k.logs[n], /^\[RED\] kit: /);
    },
    state(s: number) { return d.states[k.x.m_state(s)]; },
  };
}

test("gfx_cmdbuf: an empty recording, a recording with records, BeginRecording re-entered", () => {
  const w = walker("gfx_cmdbuf"), s = w.start();
  w.refused(s, "Record");                                   // a command outside a recording
  w.refused(s, "End");
  w.go(s, [["Begin", "Begun"], ["End", "Idle"]]);           // empty: only its END
  w.go(s, [["Begin", "Begun"], ["Record", "Recording"], ["Record", "Recording"], ["End", "Idle"]]);
  w.go(s, [["Begin", "Begun"], ["Restart", "Begun"], ["Record", "Recording"], ["Restart", "Begun"], ["End", "Idle"]]);
  w.refused(s, "Restart");
});

test("gfx_pass: clear becomes the load action, draws continue, partial clear, mid-pass clear, feedback, break, submit", () => {
  const w = walker("gfx_pass"), s = w.start();
  w.refused(s, "Draw");                                     // no render targets
  w.refused(s, "FullClear");
  w.refused(s, "PartialClear");
  w.refused(s, "Feedback");
  w.go(s, [["Break", "Unset"], ["Submit", "Unset"]]);
  // clear only: the clear lands at the submit
  w.go(s, [["SetTargets", "TargetsSet"], ["FullClear", "ClearPending"], ["FullClear", "ClearPending"], ["Submit", "TargetsSet"]]);
  // clear, draw, draw, scissored clear, full clear mid-pass, draw, submit
  w.go(s, [["FullClear", "ClearPending"], ["Draw", "Open"], ["Draw", "Open"], ["PartialClear", "Open"], ["FullClear", "ClearPending"], ["Draw", "Open"], ["Submit", "TargetsSet"]]);
  // a target change ends the pass; one with clears pending lands them first; the same again without a pass
  w.go(s, [["Draw", "Open"], ["SetTargets", "TargetsSet"], ["FullClear", "ClearPending"], ["SetTargets", "TargetsSet"], ["SetTargets", "TargetsSet"]]);
  // partial clears open the pass
  w.go(s, [["PartialClear", "Open"], ["Break", "TargetsSet"], ["FullClear", "ClearPending"], ["PartialClear", "Open"], ["Break", "TargetsSet"]]);
  // a draw that samples its own target: in a pass, with clears pending, with neither
  w.go(s, [["Draw", "Open"], ["Feedback", "TargetsSet"], ["Draw", "Open"], ["FullClear", "ClearPending"], ["Feedback", "TargetsSet"], ["Feedback", "TargetsSet"], ["Draw", "Open"]]);
  // copies and submits in each state
  w.go(s, [["Break", "TargetsSet"], ["Break", "TargetsSet"], ["FullClear", "ClearPending"], ["Break", "TargetsSet"], ["Submit", "TargetsSet"], ["Draw", "Open"], ["Submit", "TargetsSet"]]);
});

test("gfx_pipeline: built, failed, and nothing after either", () => {
  const w = walker("gfx_pipeline"), a = w.start(), b = w.start();
  w.refused(a, "Built");
  w.go(a, [["Request", "Building"], ["Built", "Ready"]]);
  w.refused(a, "Request"); w.refused(a, "Error");
  w.go(b, [["Request", "Building"], ["Error", "Failed"]]);
  w.refused(b, "Built");
});

test("gfx_image: acquire, present, on screen, retired; taken again while queued or on screen", () => {
  const w = walker("gfx_image"), a = w.start(), b = w.start();
  w.refused(a, "Present");                                  // present without acquire
  w.go(a, [["Acquire", "Acquired"], ["Present", "Submitted"], ["HostQueued", "Queued"], ["Shown", "OnScreen"]]);
  w.refused(a, "Present");
  w.go(b, [["Acquire", "Acquired"], ["Present", "Submitted"], ["HostQueued", "Queued"], ["Shown", "OnScreen"]]);
  w.go(a, [["Retire", "Free"], ["Acquire", "Acquired"]]);
  w.refused(a, "Acquire");                                  // acquired twice
  w.go(b, [["Acquire", "Acquired"], ["Present", "Submitted"], ["HostQueued", "Queued"], ["Acquire", "Acquired"]]);
});

test("gfx_sync: the pending states carry their fence number", () => {
  const w = walker("gfx_sync"), s = w.start();
  w.refused(s, "Complete");
  w.go(s, [["Fence", "PendingFence"]], 7);
  assert.equal(w.k.x.m_data(s), 7);
  w.refused(s, "Fence");                                    // fenced again only through Reset
  w.go(s, [["Reset", "Unfenced"]]);
  assert.equal(w.k.x.m_data(s), 0);
  w.go(s, [["Fence", "PendingFence"]], 9);
  w.go(s, [["Complete", "Signaled"]]);
  assert.equal(w.k.x.m_data(s), 0);
  w.go(s, [["Reset", "Unfenced"]]);
  w.go(s, [["Acquire", "PendingAcquire"]], 3);
  assert.equal(w.k.x.m_data(s), 3);
  w.go(s, [["Reset", "Unfenced"]]);
  w.go(s, [["Acquire", "PendingAcquire"]], 4);
  w.go(s, [["Complete", "Signaled"]]);
});
