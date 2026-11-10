// The audio machines (src/audio/defs/*.json) on their own, for `npm run kit:test`: every transition of every table
// is taken, every other (state, event) pair is refused and changes nothing. The audio module driving them with
// queues, clocks and a device is `npm run audio:test`, which applies the same coverage rule to the module itself.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "../kit/harness.mts";
import type { MachineDef } from "../../src/kit/host/defs.mts";

const NAMES = ["audio_out", "audio_buf", "opus_req", "audio_ren", "audio_ren_thread", "audio_render", "audio_ren_update"];

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

test("audio_out: the guest-visible state is Stopped in Stopped and Started in the four others; the two silent states that time something carry it, Live and Suspended carry nothing", () => {
  const k = fresh(), M = def("audio_out");
  assert.deepEqual(M.states, ["Stopped", "SilentStarting", "Live", "SilentRetry", "Suspended"]);
  const go = (e: string, to: string, arg = 0) => { assert.equal(k.x.m_step(0, E(M, e), arg), 1, e); assert.equal(k.x.m_state(0), S(M, to)); };
  k.x.m_init(0, M.id, 0);
  go("Start", "SilentStarting", 0x1230); assert.equal(k.x.m_data(0), 0x1230);
  go("DeviceCallback", "Live"); assert.equal(k.x.m_data(0), 0);
  go("Stall", "SilentRetry", 0x4561); assert.equal(k.x.m_data(0), 0x4561);
  go("RetryDue", "SilentStarting", 0x7891); assert.equal(k.x.m_data(0), 0x7891);
  go("StartTimeout", "SilentRetry", 0x9992);
  go("Suspend", "Suspended"); assert.equal(k.x.m_data(0), 0);
  go("Resume", "SilentStarting", 0x10);
  go("Stop", "Stopped"); assert.equal(k.x.m_data(0), 0);
  // nothing leaves Stopped but a Start: a device event for a stopped output is a bug in a guard
  for (const e of ["DeviceCallback", "Stall", "RetryDue", "Suspend", "Resume", "Stop"]) assert.equal(k.x.m_step(0, E(M, e), 0), 0);
  assert.equal(k.x.kit_refused_total(), 6);
});

test("audio_buf: a buffer is released once: Finish and Flush leave Appended and Playing only, a released buffer can only be taken back or dropped", () => {
  const k = fresh(), M = def("audio_buf");
  k.x.m_init(0, M.id, 0);
  for (const e of ["Append", "Play", "Finish"]) assert.equal(k.x.m_step(0, E(M, e), 0), 1);
  for (const e of ["Finish", "Flush", "Play", "Append"]) assert.equal(k.x.m_step(0, E(M, e), 0), 0, e);
  assert.equal(k.x.m_state(0), S(M, "Released"));
  assert.equal(k.x.m_step(0, E(M, "Reclaim"), 0), 1);
  for (const e of ["Reclaim", "Drop", "Finish", "Flush", "Play"]) assert.equal(k.x.m_step(0, E(M, e), 0), 0, e);
});

test("opus_req: a request the decoder still holds is abandoned, not freed; its late answer frees the slot and completes nothing", () => {
  const k = fresh(), M = def("opus_req");
  k.x.m_init(0, M.id, 0);
  for (const e of ["Enqueue", "Execute"]) assert.equal(k.x.m_step(0, E(M, e), 0), 1);
  assert.equal(k.x.m_step(0, E(M, "Cancel"), 0), 0);      // not while executing
  assert.equal(k.x.m_step(0, E(M, "Abandon"), 0), 1);
  assert.equal(k.x.m_step(0, E(M, "Dequeue"), 0), 0); assert.equal(k.x.m_step(0, E(M, "Enqueue"), 0), 0);
  assert.equal(k.x.m_step(0, E(M, "Complete"), 0), 1);
  assert.equal(k.x.m_state(0), S(M, "Free"));
});

test("audio_ren: the render thread is made after the SDK's open and gone before the SDK's close; a renderer without a thread closes without the join", () => {
  const k = fresh(), M = def("audio_ren");
  const go = (slot: number, ...es: string[]) => { for (const e of es) assert.equal(k.x.m_step(slot, E(M, e), 0), 1, e); };
  k.x.m_init(0, M.id, 0);
  for (const e of ["Opened", "Close", "Started", "Closed"]) assert.equal(k.x.m_step(0, E(M, e), 0), 0, e);   // nothing but Open leaves Free
  go(0, "Open");
  assert.equal(k.x.m_step(0, E(M, "Close"), 0), 0);       // not while the SDK's open runs
  go(0, "Opened", "Allocated", "Created");
  assert.equal(k.x.m_step(0, E(M, "NoThread"), 0), 0);    // a created thread is started
  go(0, "Started");
  assert.equal(k.x.m_state(0), S(M, "Running"));
  go(0, "Close");
  for (const e of ["Closed", "Freed", "Destroyed", "Open"]) assert.equal(k.x.m_step(0, E(M, e), 0), 0, e);   // the join comes first
  go(0, "ThreadEnded", "Destroyed", "Freed", "Closed");
  assert.equal(k.x.m_state(0), S(M, "Free"));
  k.x.m_init(1, M.id, 1);
  go(1, "Open", "NoThread", "CloseNoThread", "Closed");
  assert.equal(k.x.m_state(1), S(M, "Free"));
});

test("audio_render: generation is inside the update lock and processing outside it; a render that finds another in progress waits its turn", () => {
  const k = fresh(), M = def("audio_render");
  assert.deepEqual(M.states, ["Idle", "Queued", "Locking", "Generating", "Unlocking", "Processing"]);
  k.x.m_init(0, M.id, 0);
  for (const e of ["Busy", "StillBusy", "StillBusy", "Turn", "Locked"]) assert.equal(k.x.m_step(0, E(M, e), 0), 1, e);
  for (const e of ["Processed", "Unlocked", "Locked", "Begin"]) assert.equal(k.x.m_step(0, E(M, e), 0), 0, e);   // Generating: only Generated
  for (const e of ["Generated", "Unlocked", "Processed"]) assert.equal(k.x.m_step(0, E(M, e), 0), 1, e);
  assert.equal(k.x.m_state(0), S(M, "Idle"));
});

test("audio_ren_update and audio_ren_thread: the SDK's Update runs last, after at most one catch-up render; the render thread renders or plays a queued frame only when a block is free", () => {
  const k = fresh(), U = def("audio_ren_update"), T = def("audio_ren_thread");
  k.x.m_init(0, U.id, 0);
  for (const e of ["QueueFull", "StillFull"]) assert.equal(k.x.m_step(0, E(U, e), 0), 1, e);
  for (const e of ["CatchUp", "Pass", "Done", "Space"]) assert.equal(k.x.m_step(0, E(U, e), 0), 0, e);   // Rendering: only Rendered
  for (const e of ["Rendered", "Done"]) assert.equal(k.x.m_step(0, E(U, e), 0), 1, e);
  k.x.m_init(1, T.id, 1);
  for (const e of ["Start", "NoBlock"]) assert.equal(k.x.m_step(1, E(T, e), 0), 1, e);
  for (const e of ["Render", "PlayQueued", "Stop", "Rendered"]) assert.equal(k.x.m_step(1, E(T, e), 0), 0, e);   // Waiting: only Wake
  for (const e of ["Wake", "Render"]) assert.equal(k.x.m_step(1, E(T, e), 0), 1, e);
  assert.equal(k.x.m_step(1, E(T, "Stop"), 0), 0);   // not inside the SDK's render
  for (const e of ["Rendered", "PlayQueued", "Stop"]) assert.equal(k.x.m_step(1, E(T, e), 0), 1, e);
  assert.equal(k.x.m_state(1), S(T, "Idle"));
});
