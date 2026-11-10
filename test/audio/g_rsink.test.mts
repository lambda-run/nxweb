// The audio renderer's sink and timing (src/audio/rsink.ts) with a stand-in for the SDK's renderer: the test plays
// the render loop and "renders" frames whose samples number them. Also the work buffer budget and the two
// take-overs that only need an SDK function behind them.
import assert from "node:assert/strict";
import { test, Au, fit, DEV, R, MS, MANGLED, FN } from "./harness.mts";

const Q = BigInt(Math.round(128e9 / 48000));

// A fake renderer: mix buffers of `samples` int32 samples, `nbuf` of them, in guest memory
class Renderer {
  mix: number; idx: number; n = 0;
  a: Au; sink: number; samples: number; rate: number;
  constructor(a: Au, sink: number, samples = 240, rate = 48000) {
    this.a = a; this.sink = sink; this.samples = samples; this.rate = rate;
    this.mix = a.alloc(8 * 1024 * 4); this.idx = a.alloc(16);
    new Int16Array(a.x.memory.buffer, this.idx, 2).set([3, 5]);   // the sink's inputs are mix buffers 3 and 5
  }
  // One render: every frame of the block carries the stream's frame number (left: low 15 bits, right: the next 15)
  render(dest: number): number {
    const m = new Int32Array(this.a.x.memory.buffer, this.mix, 8 * this.samples);
    for (let i = 0; i < this.samples; i++) { const n = ++this.n; m[3 * this.samples + i] = n & 0x7FFF; m[5 * this.samples + i] = (n >> 15) & 0x7FFF; }
    this.a.x.audio_rs_count_render(this.sink);
    return this.a.x.audio_rs_capture(this.sink, dest, this.mix, this.samples, this.rate, this.idx, 2, 2);
  }
  // nxnative's render_main, one round: true when it did something, false when it has to wait for a block
  round(): boolean {
    const x = this.a.x;
    if (!x.audio_rs_ready(this.sink)) return false;
    if (x.audio_rs_next(this.sink)) { this.render(0); x.audio_rs_rendered(this.sink); }
    return true;
  }
}
const stat = (a: Au, s: number, w: number) => Number(a.x.audio_rs_stat(s, w));   // 0 frames 1 nonsilent 2 updates 3 renders 4 catchups 5 played 6 queued 7 free 8 discarded

test("render sink: paced by its output: four blocks in flight, then one render for each 5 ms block the output hands back, on the silent sink at exactly 5 ms of guest time each", () => {
  const a = new Au();
  const s = a.x.audio_rs_open();
  assert.equal(s, 0);
  const o = a.x.audio_rs_out(s);
  assert.equal(a.x.audio_out_state(o), 1);   // started at once: SilentStarting
  const rel = a.events[a.x.audio_rs_event(s) - 1], cq = a.events[a.x.audio_rs_cq_event(s) - 1];
  assert.deepEqual([rel.ptr, rel.autoClear, cq.ptr], [0, true, 0]);   // bare kernel events of the host's own
  const r = new Renderer(a, s);
  const t0 = a.g;
  while (r.round()) { /* fills the four blocks */ }
  assert.deepEqual([stat(a, s, 3), stat(a, s, 5), stat(a, s, 7)], [4, 4, 0]);
  for (let k = 1; k <= 400; k++) {
    assert.equal(a.host.nextDeadline(), t0 + BigInt(k) * 5n * MS);
    rel.flag = false;
    a.toDeadline();
    assert.equal(rel.flag, true, "the release wakes the render loop");
    assert.equal(r.round(), true); assert.equal(r.round(), false);   // one block came back: one render
  }
  assert.deepEqual([stat(a, s, 3), stat(a, s, 0), stat(a, s, 1)], [404, 404, 404]);
  assert.match(a.logs.find(l => l.includes("rendered 200 frames"))!, /^audren: renderer 0 rendered 200 frames, 200 of them not silent$/);
  a.x.audio_rs_close(s);
  assert.equal(a.x.audio_out_state(o), -1);
  assert.ok(rel.released && cq.released);
  assert.equal(a.red.length, 0); assert.equal(a.x.kit_refused_total(), 0);
});

test("render sink: on a device the frames arrive in order, each once; a frame that rendered nothing is 5 ms of silence so the pace holds", () => {
  const a = new Au();
  a.attach(48000, 256);
  const s = a.x.audio_rs_open(), r = new Renderer(a, s);
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  assert.equal(a.x.audio_out_state(a.x.audio_rs_out(s)), 2);   // Live
  const heard: number[] = [];
  let silentRounds = 0;
  while (r.round()) { /* the first four blocks */ }
  const u0 = Number(a.x.audio_out_stat(a.x.audio_rs_out(s), 7));   // the device ran before the first block existed
  for (let i = 0; i < 2000; i++) {
    a.tick(Q);
    const d = a.callback(128);
    for (let k = 0; k < d.length; k += 2) heard.push(Math.round(d[k] * 32768) + Math.round(d[k + 1] * 32768) * 32768);
    if (i >= 1000 && i < 1100) {   // the SDK renders nothing for a while (a list that walks in no layout): silence, same pace
      if (a.x.audio_rs_ready(s) && a.x.audio_rs_next(s)) { a.x.audio_rs_rendered(s); silentRounds++; }
    } else while (r.round()) { /* as many as blocks are free */ }
  }
  const nums = heard.filter(n => n !== 0);
  for (let i = 1; i < nums.length; i++) assert.equal(nums[i], nums[i - 1] + 1, `frame ${nums[i]} after ${nums[i - 1]}`);
  assert.ok(nums.length > 2000 * 128 - 240 * (silentRounds + 8) - 512);
  assert.ok(silentRounds >= 50 && silentRounds <= 56, `${silentRounds} silent blocks in 267 ms`);
  assert.ok(heard.length - nums.length >= silentRounds * 240);
  assert.equal(Number(a.x.audio_out_stat(a.x.audio_rs_out(s), 7)), u0);
});

test("render sink: at least one rendered frame between two updates: an update with none since the last renders a catch-up frame, which is played in place of the next render without waking the game; a full queue makes the update wait, then discard", () => {
  const a = new Au();
  const s = a.x.audio_rs_open(), r = new Renderer(a, s), x = a.x;
  const cq = a.events[x.audio_rs_cq_event(s) - 1];
  const update = (waited = 0) => x.audio_rs_update_begin(s, waited);
  // the first update, and an update after a render: nothing to do
  assert.equal(update(), 0); x.audio_rs_update_end(s);
  // the game updates twice in a row at start-up (0.04 ms apart): the second one renders first
  assert.equal(update(), 1);
  assert.equal(r.render(1), 240); x.audio_rs_update_end(s);
  assert.deepEqual([stat(a, s, 4), stat(a, s, 6)], [1, 1]);
  assert.match(a.logs.at(-1)!, /^audren: renderer 0: no frame rendered before update 2, rendering a catch-up frame first \(1 so far\)$/);
  // the render loop plays the queued frame instead of rendering, and says so on the catch-up event only
  const renders = stat(a, s, 3);
  assert.equal(x.audio_rs_ready(s), 1); assert.equal(x.audio_rs_next(s), 0);
  assert.deepEqual([stat(a, s, 3), stat(a, s, 5), stat(a, s, 6), cq.signals], [renders, 1, 0, 1]);
  // a render in between: the next update goes straight on
  assert.equal(r.round(), true);
  assert.equal(update(), 0); x.audio_rs_update_end(s);
  // a sound driver that never waits (DRAGON QUEST XI S): update after update with the output's blocks all in flight
  while (r.round()) { /* fill the blocks */ }
  assert.equal(update(), 0); x.audio_rs_update_end(s);
  for (let i = 0; i < 4; i++) { assert.equal(update(), 1); r.render(1); x.audio_rs_update_end(s); }
  assert.equal(stat(a, s, 6), 4);
  assert.equal(update(), 2);                    // full: wait for the catch-up event, at most 50 ms
  // ... the output plays a block (5 ms), the render loop takes a queued frame: room again
  a.toDeadline(); assert.equal(x.audio_rs_ready(s), 1); assert.equal(x.audio_rs_next(s), 0);
  assert.equal(cq.signals, 2);
  assert.equal(update(1), 1); r.render(1); x.audio_rs_update_end(s);
  // ... or the output has stopped and nothing leaves the queue: after the wait, render anyway and discard
  assert.equal(update(), 2); assert.equal(update(1), 3);
  assert.equal(r.render(2), 240); x.audio_rs_update_end(s);
  assert.deepEqual([stat(a, s, 6), stat(a, s, 8), stat(a, s, 4)], [4, 1, 7]);
  // catch-up frames are played in the order they were rendered, in place of renders: the numbers on a device say so
  assert.equal(a.x.kit_refused_total(), 0);
});

test("render sink: the DeviceSink's mix buffers become stereo PCM16: clamped to 16 bits, six inputs downmixed with the system's coefficients, a single input on both sides, SDK 4's byte indices", () => {
  const a = new Au();
  a.attach(48000, 256);
  const s = a.x.audio_rs_open(), x = a.x;
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  const mix = a.alloc(8 * 240 * 4), idx16 = a.alloc(16), idx8 = a.alloc(8), m = new Int32Array(x.memory.buffer, mix, 8 * 240);
  new Int16Array(x.memory.buffer, idx16, 6).set([0, 1, 2, 3, 4, 5]); new Int8Array(x.memory.buffer, idx8, 6).set([1, 0, 2, 3, 4, 5]);
  const fill = (v: number[]) => v.forEach((val, c) => m.fill(val, c * 240, (c + 1) * 240));
  const play = () => { assert.equal(x.audio_rs_ready(s), 1); assert.equal(x.audio_rs_next(s), 1); };
  const heard: [number, number][] = [];
  const cases: [number[], number, number, number][] = [   // mix values, inputs, index pointer, index size
    [[1000, -2000, 0, 0, 0, 0], 2, idx16, 2],
    [[40000, -40000, 0, 0, 0, 0], 2, idx16, 2],            // beyond 16 bits: clamped
    [[1000, 2000, 3000, 4000, 5000, 6000], 6, idx16, 2],
    [[1234, 0, 0, 0, 0, 0], 1, idx16, 2],                  // one input: both sides
    [[1000, -2000, 0, 0, 0, 0], 2, idx8, 1],               // SDK 4: s8 indices, here swapped
  ];
  const listen = (ms: number) => { const dev = a.play(ms); for (let i = 0; i < dev.length; i += 2) { const p: [number, number] = [Math.round(dev[i] * 32768), Math.round(dev[i + 1] * 32768)]; if ((p[0] || p[1]) && (heard.length === 0 || heard.at(-1)![0] !== p[0] || heard.at(-1)![1] !== p[1])) heard.push(p); } };
  cases.forEach(([v, n, idx, size], i) => {
    if (i === 4) listen(30);   // four blocks are in flight: the fifth render waits for one to come back
    fill(v); play(); assert.equal(x.audio_rs_capture(s, 0, mix, 240, 48000, idx, n, size), 240); x.audio_rs_rendered(s);
  });
  listen(40);
  const c = 3000 * 23167 + 4000 * 8224;
  assert.deepEqual(heard, [[1000, -2000], [32767, -32768], [(1000 * 32768 + c + 5000 * 23167) >> 15, (2000 * 32768 + c + 6000 * 23167) >> 15], [1234, 1234], [-2000, 1000]]);
  // what is not a sink the host plays: a red line and silence
  assert.equal(x.audio_rs_capture(s, 0, mix, 0, 48000, idx16, 2, 2), 0);
  assert.equal(x.audio_rs_capture(s, 0, mix, 240, 44100, idx16, 2, 2), 0);
  assert.equal(a.red.length, 2);
  assert.match(a.red[1], /a DeviceSink of 240 samples at 44100 Hz with 2 inputs is not played/);
});

test("render sink: a renderer at 32 kHz is upsampled 3:2 (160 samples in, 240 out, history kept across frames): a 1 kHz sine stays a 1 kHz sine", () => {
  const a = new Au({ guest: 32 << 20 });
  a.attach(48000, 256);
  const s = a.x.audio_rs_open(), x = a.x;
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  const mix = a.alloc(2 * 160 * 4), idx = a.alloc(8), m = new Int32Array(x.memory.buffer, mix, 320);
  new Int16Array(x.memory.buffer, idx, 2).set([0, 1]);
  let n = 0;
  const chunks: Float32Array[] = [];
  for (let i = 0; i < 1500; i++) {
    a.tick(Q); chunks.push(a.callback(128));
    while (x.audio_rs_ready(s) && x.audio_rs_next(s)) {
      for (let k = 0; k < 160; k++, n++) { m[k] = Math.round(12000 * Math.sin(2 * Math.PI * 1000 * n / 32000)); m[160 + k] = -m[k]; }
      assert.equal(x.audio_rs_capture(s, 0, mix, 160, 32000, idx, 2, 2), 240);
      x.audio_rs_rendered(s);
    }
  }
  const left = new Float32Array(chunks.length * 128); chunks.forEach((c, i) => { for (let k = 0; k < 128; k++) left[i * 128 + k] = c[2 * k]; });
  const r = fit(left.subarray(48000, 48000 + 96000), 1000, 48000);
  assert.ok(r.snr > 60, `${r.snr.toFixed(1)} dB`);
  assert.ok(Math.abs(r.amp - 12000 / 32768) < 0.001, `amplitude ${r.amp}`);
  console.log(`     ${r.snr.toFixed(1)} dB (16 taps, Blackman, as nxnative's up_3_2), amplitude ${(r.amp * 32768).toFixed(1)} of 12000`);
});

test("render sink: four renderers at once, each with its own blocks and queue (two renderers used to overwrite each other's queued blocks); a fifth is refused with a red line", () => {
  const a = new Au();
  a.attach(48000, 256);
  const sinks = [0, 1, 2, 3].map(() => a.x.audio_rs_open());
  assert.deepEqual(sinks, [0, 1, 2, 3]);
  assert.equal(a.x.audio_rs_open(), -1);
  assert.match(a.red[0], /more than 4 renderers: this one is not rendered/);
  // queue every block of renderer 0, then render the others: renderer 0's samples are untouched
  const rs = sinks.map(s => new Renderer(a, s));
  rs[1].n = 100000; rs[2].n = 200000; rs[3].n = 300000;
  while (rs[0].round()) { /* 4 blocks */ }
  for (const r of rs.slice(1)) while (r.round()) { /* 4 blocks each */ }
  a.x.audio_rs_close(1); a.x.audio_rs_close(2); a.x.audio_rs_close(3);
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  const dev = a.play(30), nums: number[] = [];
  for (let k = 0; k < dev.length; k += 2) { const n = Math.round(dev[k] * 32768) + Math.round(dev[k + 1] * 32768) * 32768; if (n) nums.push(n); }
  assert.ok(nums.length > 800);
  for (let i = 1; i < nums.length; i++) assert.equal(nums[i], nums[i - 1] + 1);
  assert.ok(nums.at(-1)! <= 960);
  assert.equal(a.x.audio_rs_open(), 1);   // a closed renderer's slot is free again
});

test("audio renderer: GetAudioRendererWorkBufferSize answers the DSP service's budget (nxnative's fixtures from Horizon's own sizing routine, revisions 4 to 15, SDK 8's longer parameter); what the model does not cover goes to the SDK's function with a CPU / manual copy of the parameter", () => {
  const SDK_WORK = 0x760000n, SERVICE_WORK = 0x61d000n;
  const name = MANGLED[FN.ar_WorkSize - 1];
  const seen: number[][] = [];
  const a = new Au({ sdk: { [name]: (x, au) => { const p = Number(x[0]); seen.push([au.dv.getInt32(p + 0x2c, true), au.dv.getInt32(p + 0x30, true), au.dv.getUint32(p + 0x34, true)]); return SDK_WORK; } } });
  const words = [48000, 240, 132, 19, 138, 1, 16, 0, 0, 85, 1800, 0, 0, 0x38564552];
  const param = a.alloc(0x40);
  const set = () => { a.u8.fill(0, param, param + 0x40); words.forEach((w, i) => a.dv.setUint32(param + 4 * i, w, true)); };
  const cases: [number, number, number, bigint][] = [
    [8, 4, 138, 0x61d000n], [8, 4, 137, 0x61b000n], [8, 3, 18, 0x5f7000n], [8, 10, 1799, 0x61c000n], [8, 7, 2, 0x622000n], [9, 4, 138, 0x61e000n],
    [12, 4, 138, 0x5f7000n], [14, 4, 138, 0x621000n], [15, 4, 138, 0x6a4000n],
  ];
  for (const [rev, word, value, want] of cases) {
    set(); a.dv.setUint32(param + 0x34, 0x30564552 + rev * 0x1000000, true); a.dv.setUint32(param + 4 * word, value, true);
    assert.equal(a.c("ar_WorkSize", param), want, `revision ${rev}, word ${word} = ${value}`);
  }
  set(); a.dv.setUint32(param + 0x34, 0x34564552, true); a.dv.setUint32(param + 0x24, 0, true); a.dv.setUint32(param + 0x28, 0, true);
  assert.equal(a.c("ar_WorkSize", param), 0x308000n);   // fixed command buffer and performance format 1
  // the longer SDK 8 layout (revision one word later), uninitialized padding after the voice-drop byte
  set(); a.dv.setUint32(param + 0x34, 0, true); a.dv.setUint32(param + 0x38, 0x38564552, true); a.u8.fill(0xFF, param + 0x21, param + 0x24);
  assert.equal(a.c("ar_WorkSize", param), SERVICE_WORK);
  assert.equal(seen.length, 0);                          // none of these needed the SDK
  // an unknown future revision, and a game that asks for a CPU renderer itself: the SDK's own answer
  set(); a.dv.setUint32(param + 0x34, 0x40564552, true);
  assert.equal(a.c("ar_WorkSize", param), SDK_WORK);
  set(); a.dv.setInt32(param + 0x2c, 1, true);
  assert.equal(a.c("ar_WorkSize", param), SDK_WORK);
  assert.deepEqual(seen, [[1, 1, 0x40564552], [1, 1, 0x38564552]]);   // device = CPU, mode = manual in the copy
  assert.equal(a.dv.getInt32(param + 0x30, true), 0);                  // the game's parameter is not touched
  assert.equal(a.red.length, 0);
  // without an SDK behind it: a red line once, 0
  const b = new Au();
  const p2 = b.alloc(0x40); words.forEach((w, i) => b.dv.setUint32(p2 + 4 * i, w, true)); b.dv.setUint32(p2 + 0x34, 0x40564552, true);
  assert.equal(b.c("ar_WorkSize", p2), 0n); assert.equal(b.c("ar_WorkSize", p2), 0n);
  assert.equal(b.red.length, 1);
});

test("audio renderer: UpsamplerManager::Allocate on a null manager answers 'no upsampler' (CPU rendering has none; the sink resamples), on a real one it is the SDK's own", () => {
  const name = MANGLED[FN.up_Allocate - 1];
  const a = new Au({ sdk: { [name]: x => x[0] + 0x40n } });
  assert.equal(a.c("up_Allocate", 0), 0n);
  assert.equal(a.sdkCalls.length, 0);
  assert.equal(a.c("up_Allocate", 0x5000), 0x5040n);
  assert.deepEqual(a.sdkCalls, [name]);
});
