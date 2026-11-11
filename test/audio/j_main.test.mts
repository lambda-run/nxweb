// The AudioContext half (src/glue/audio_device_main.ts) under Node, with a fake AudioContext: what it reports
import assert from "node:assert/strict";
import { test } from "./harness.mts";
import { AudioDeviceMain } from "../../src/glue/audio_device_main.ts";

const tick = () => new Promise(r => setTimeout(r, 5));
function fake(o: { refuse?: boolean }) {
  const made: { state: string; closed: boolean }[] = [];
  class Ctx {
    state = "suspended"; sampleRate = 48000; baseLatency = 0; onstatechange: (() => void) | null = null; closed = false;
    destination = {};
    audioWorklet = { addModule: async () => { if (o.refuse) throw new Error("the worklet was refused"); } };
    constructor() { made.push(this); }
    async resume() { this.state = "running"; this.onstatechange?.(); }
    async suspend() { this.state = "suspended"; }
    async close() { this.closed = true; this.state = "closed"; }
  }
  const g = globalThis as any, saved = { ctx: g.AudioContext, node: g.AudioWorkletNode, url: g.URL.createObjectURL, rev: g.URL.revokeObjectURL };
  g.AudioContext = Ctx;
  g.AudioWorkletNode = class { port = { onmessage: null, postMessage() {} }; connect() {} disconnect() {} };
  g.URL.createObjectURL = () => "blob:worklet"; g.URL.revokeObjectURL = () => {};
  return { made, restore: () => { g.AudioContext = saved.ctx; g.AudioWorkletNode = saved.node; g.URL.createObjectURL = saved.url; g.URL.revokeObjectURL = saved.rev; } };
}
// a resume reports when it resolves and again at its statechange: the same state twice in a row is one report
const states = (sent: any[]) => sent.filter(m => m.audio?.ev === "state").map(m => m.audio.state).filter((s, i, a) => i === 0 || a[i - 1] !== s);

test("page side: a context whose worklet is refused is closed, and a start after it never reports a running device", async () => {
  const f = fake({ refuse: true });
  try {
    const sent: any[] = [], m = new AudioDeviceMain(x => sent.push(x), { watchVisibility: false });
    m.handle({ audio: { cmd: "open" } }); await tick();
    m.handle({ audio: { cmd: "start" } }); await tick();
    assert.equal(sent[0].audio.ev, "open"); assert.equal(sent[0].audio.rate, 0); assert.match(sent[0].audio.error, /refused/);
    assert.deepEqual(states(sent), [], "no state after a failed open: the runtime side already has the open's error");
    assert.deepEqual(f.made.map(c => c.closed), [true]);
  } finally { f.restore(); }
});

test("page side: an open that works, then start: STARTING then RUNNING; stop: NONE", async () => {
  const f = fake({});
  try {
    const sent: any[] = [], m = new AudioDeviceMain(x => sent.push(x), { watchVisibility: false });
    m.handle({ audio: { cmd: "open" } }); await tick();
    assert.equal(sent[0].audio.rate, 48000);
    m.handle({ audio: { cmd: "start" } }); await tick();
    m.handle({ audio: { cmd: "stop" } }); await tick();
    assert.deepEqual(states(sent), [1, 2, 0]);
    m.handle({ audio: { cmd: "close" } });
    assert.deepEqual(f.made.map(c => c.closed), [true]);
  } finally { f.restore(); }
});
