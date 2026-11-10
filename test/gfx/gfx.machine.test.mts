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

test("gfx_texture: uploaded with its sampled hash, stale and uploaded again, then the GPU's for good", () => {
  const w = walker("gfx_texture"), a = w.start(), b = w.start();
  w.refused(a, "Stale");
  w.go(a, [["Upload", "Uploaded"]], 1234);
  assert.equal(w.k.x.m_data(a), 1234);
  w.refused(a, "Upload");                                   // a new hash only through Stale
  w.go(a, [["Stale", "Unknown"]]); w.go(a, [["Upload", "Uploaded"]], 99); assert.equal(w.k.x.m_data(a), 99);
  w.go(a, [["GpuWrite", "GpuOwned"], ["GpuWrite", "GpuOwned"]]);
  assert.equal(w.k.x.m_data(a), 0);
  w.refused(a, "Upload"); w.refused(a, "Stale");
  w.go(b, [["GpuWrite", "GpuOwned"]]);
});

test("gfx_pass: compute dispatches open a compute pass, with and without render targets, and every way out of it", () => {
  const w = walker("gfx_pass"), s = w.start();
  // before any render targets: dispatches share a pass; a copy, a submit and the first targets end it
  w.go(s, [["Dispatch", "ComputeUnset"], ["Dispatch", "ComputeUnset"], ["Break", "Unset"], ["Dispatch", "ComputeUnset"], ["Submit", "Unset"], ["Dispatch", "ComputeUnset"], ["SetTargets", "TargetsSet"]]);
  // with targets: from no pass, with clears pending (they land first), from an open render pass
  w.go(s, [["Dispatch", "Compute"], ["Dispatch", "Compute"], ["Draw", "Open"], ["Dispatch", "Compute"], ["FullClear", "ClearPending"], ["Dispatch", "Compute"]]);
  w.go(s, [["PartialClear", "Open"], ["Dispatch", "Compute"], ["Feedback", "TargetsSet"], ["Dispatch", "Compute"], ["Break", "TargetsSet"], ["Dispatch", "Compute"], ["Submit", "TargetsSet"]]);
  w.go(s, [["Dispatch", "Compute"], ["SetTargets", "TargetsSet"]]);
  const u = w.start();
  w.go(u, [["Dispatch", "ComputeUnset"]]);
  w.refused(u, "Draw"); w.refused(u, "FullClear"); w.refused(u, "PartialClear"); w.refused(u, "Feedback");     // still no render targets
});

test("gfx_pipeline: a device loss asks for every pipeline again", () => {
  const w = walker("gfx_pipeline"), a = w.start(), b = w.start(), c = w.start();
  w.refused(a, "Reset");                                    // never requested
  w.go(a, [["Request", "Building"], ["Reset", "Building"], ["Built", "Ready"], ["Reset", "Building"], ["Built", "Ready"]]);
  w.go(b, [["Request", "Building"], ["Error", "Failed"], ["Reset", "Building"], ["Built", "Ready"]]);
  w.go(c, [["Request", "Building"], ["Error", "Failed"]]);
  w.refused(c, "Built");
});

test("gfx_sync: a wait with a timeout parks; woken by the fence, expired by the embedder's timer, or fenced again", () => {
  const w = walker("gfx_sync"), s = w.start();
  w.refused(s, "Park"); w.refused(s, "Wake"); w.refused(s, "Expire");
  w.go(s, [["Fence", "PendingFence"]], 5);
  w.go(s, [["Park", "Parked"]], 5); assert.equal(w.k.x.m_data(s), 5);
  w.go(s, [["Park", "Parked"]], 5); assert.equal(w.k.x.m_data(s), 5);      // the wait is made again and the fence is still not done
  w.refused(s, "Complete");                                 // a parked wait ends as CONDITION_SATISFIED (Wake), not ALREADY_SIGNALED
  w.go(s, [["Wake", "Signaled"]]);
  w.go(s, [["Reset", "Unfenced"], ["Acquire", "PendingAcquire"]], 6);
  w.go(s, [["Park", "Parked"]], 6);
  w.go(s, [["Expire", "PendingFence"]], 6); assert.equal(w.k.x.m_data(s), 6);   // the timeout ran out: pending again
  w.go(s, [["Park", "Parked"]], 6);
  w.go(s, [["Reset", "Unfenced"]]);                         // fenced again while a wait is parked
});

test("gfx_texture: texels staged in the storage by a copy; the device lost under each state", () => {
  const w = walker("gfx_texture"), a = w.start(), b = w.start(), c = w.start();
  w.go(a, [["Stage", "Staged"], ["Stage", "Staged"], ["Upload", "Uploaded"]], 77);
  assert.equal(w.k.x.m_data(a), 77);
  w.go(a, [["Stage", "Staged"]]); assert.equal(w.k.x.m_data(a), 0);
  w.refused(a, "Stale");
  w.go(a, [["Lost", "Staged"], ["GpuWrite", "GpuOwned"], ["Lost", "GpuOwned"]]);
  w.refused(a, "Stage");                                    // the GPU owns it: a copy goes to the GPU
  w.go(b, [["Lost", "Unknown"], ["Upload", "Uploaded"]], 5);
  w.go(b, [["Lost", "Unknown"]]); assert.equal(w.k.x.m_data(b), 0);
  w.go(c, [["Upload", "Uploaded"]], 9);
});

test("gfx_device: lost, lost again before a new device came, restored", () => {
  const w = walker("gfx_device"), s = w.start();
  w.refused(s, "Restore");
  w.go(s, [["Lose", "Lost"], ["Lose", "Lost"], ["Restore", "Live"]]);
  w.refused(s, "Restore");
  w.go(s, [["Lose", "Lost"], ["Restore", "Live"]]);
});
