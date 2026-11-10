// The guest thread's lifecycle machine (src/kit/defs/thread.json): every transition, and the wait kind Waiting carries.
// The refusals of every (state, event) pair outside the table are in kit.test.mts.
import assert from "node:assert/strict";
import { test, fresh, def, S, E, type Kit } from "./harness.mts";
import { readTrace, formatRecord } from "../../src/kit/host/reader.mts";

const TH = def("thread");
const KINDS = TH.data.Waiting.values!;

function thread(k: Kit, slot: number, id = slot) {
  k.x.m_init(slot, TH.id, id);
  return {
    go(event: string, to: string, arg = 0) {
      assert.equal(k.x.m_step(slot, E(TH, event), arg), 1, `${event} accepted`);
      assert.equal(k.x.m_state(slot), S(TH, to), `${event} leads to ${to}`);
    },
    no(event: string, arg = 0) {
      const s = k.x.m_state(slot);
      assert.equal(k.x.m_step(slot, E(TH, event), arg), 0, `${event} refused`);
      assert.equal(k.x.m_state(slot), s);
    },
    get state() { return TH.states[k.x.m_state(slot)]; },
    get waitKind() { return k.x.m_data(slot); },
  };
}

test("thread: the states and events are the ones agreed", () => {
  assert.deepEqual(TH.states, ["Created", "HeldBeforeStart", "Runnable", "Running", "Waiting", "Paused", "Exited"]);
  assert.deepEqual(TH.events, ["CreateThread", "Start", "PauseRequest", "Resume", "Schedule", "Yield", "Block", "Wake", "Exit"]);
  assert.deepEqual(KINDS, ["lock", "condvar", "address", "sync", "sleep"]);
});

test("thread: a life from creation to exit, with its trace", () => {
  const k = fresh(), t = thread(k, 0, 12);
  assert.equal(t.state, "Created");
  t.go("CreateThread", "HeldBeforeStart");
  t.go("Start", "Runnable");
  t.go("Schedule", "Running");
  t.go("Yield", "Runnable");
  t.go("Schedule", "Running");
  t.go("Block", "Waiting", 2);
  t.go("Wake", "Runnable");
  t.go("PauseRequest", "Paused");
  t.go("Resume", "Runnable");
  t.go("Schedule", "Running");
  t.go("PauseRequest", "Paused");
  t.go("Resume", "Runnable");
  t.go("Schedule", "Running");
  t.go("Exit", "Exited");
  assert.deepEqual(readTrace(k.x).map(r => formatRecord(r, k.machines)), [
    "thread#12 Created -CreateThread-> HeldBeforeStart",
    "thread#12 HeldBeforeStart -Start-> Runnable",
    "thread#12 Runnable -Schedule-> Running",
    "thread#12 Running -Yield-> Runnable",
    "thread#12 Runnable -Schedule-> Running",
    "thread#12 Running -Block-> Waiting",
    "thread#12 Waiting -Wake-> Runnable",
    "thread#12 Runnable -PauseRequest-> Paused",
    "thread#12 Paused -Resume-> Runnable",
    "thread#12 Runnable -Schedule-> Running",
    "thread#12 Running -PauseRequest-> Paused",
    "thread#12 Paused -Resume-> Runnable",
    "thread#12 Runnable -Schedule-> Running",
    "thread#12 Running -Exit-> Exited",
  ]);
  assert.deepEqual(k.logs, []);
});

test("thread: Waiting carries its wait kind, and only Waiting does", () => {
  const k = fresh(), t = thread(k, 0);
  t.go("CreateThread", "HeldBeforeStart"); t.go("Start", "Runnable");
  KINDS.forEach((name, i) => {
    t.go("Schedule", "Running");
    assert.equal(t.waitKind, 0, "Running carries nothing");
    t.go("Block", "Waiting", i + 1);
    assert.equal(t.waitKind, i + 1, `waiting on ${name}`);
    t.no("Block", i + 1);
    assert.equal(t.waitKind, i + 1, "a refused event leaves the kind");
    t.go("Wake", "Runnable");
    assert.equal(t.waitKind, 0, "the kind goes with the wait");
  });
});

test("thread: Block needs a wait kind", () => {
  const k = fresh(), t = thread(k, 0, 3);
  t.go("CreateThread", "HeldBeforeStart"); t.go("Start", "Runnable"); t.go("Schedule", "Running");
  t.no("Block", 0);
  t.no("Block", KINDS.length + 1);
  assert.equal(t.state, "Running");
  assert.deepEqual(k.logs, ["[RED] kit: thread#3 refused Block in Running (bad data)", "[RED] kit: thread#3 refused Block in Running (bad data)"]);
});

test("thread: what the table leaves out on purpose is refused", () => {
  const k = fresh(), t = thread(k, 0, 5);
  t.no("Start");                 // not created yet
  t.go("CreateThread", "HeldBeforeStart");
  t.no("CreateThread");          // twice
  t.no("Schedule");              // held until Start
  t.no("PauseRequest");          // not started
  t.go("Start", "Runnable");
  t.no("Start");                 // twice
  t.no("Exit");                  // only a running thread exits
  t.no("Resume");                // not paused
  t.go("Schedule", "Running");
  t.go("Block", "Waiting", 1);
  t.no("PauseRequest");          // a waiting thread: see README, open question
  t.no("Schedule");              // not before Wake
  t.go("Wake", "Runnable");
  t.go("PauseRequest", "Paused");
  t.no("Schedule");              // paused threads do not run
  t.no("PauseRequest");          // twice
  t.go("Resume", "Runnable");
  t.go("Schedule", "Running");
  t.go("Exit", "Exited");
  t.no("Start");                 // no way back
  assert.equal(k.x.kit_refused_total(), 12);
  assert.equal(k.logs.length, 12);
  assert.ok(k.logs.every(l => l.startsWith("[RED] kit: thread#5 refused ")));
});
