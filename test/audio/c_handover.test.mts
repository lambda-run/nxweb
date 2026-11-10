// The handover between the silent sink and the device: silent -> live -> stall -> silent -> live, hide and show.
// One queue and one position serve both consumers; the stream's frames are numbered, so the test sees every frame
// the device got and counts every byte either consumer took.
import assert from "node:assert/strict";
import { test, Au, Feeder, frameNumbers, DEV, MS } from "./harness.mts";

const Q = BigInt(Math.round(128e9 / 48000));   // one device quantum of 128 frames

test("handover: silent -> live -> stall -> silent -> retry -> live -> hidden -> shown -> live: every buffer released exactly once, in order; the device gets consecutive frames, never one twice", () => {
  const a = new Au();
  a.attach(48000, 512);
  const g = a.open(), f = new Feeder(a, g);
  f.refill();
  a.c("au_Start", g);
  const played: number[] = [];
  const states: string[] = [];
  const note = () => { const s = a.state(g); if (states.at(-1) !== s) states.push(s); };
  const run = (ms: number, device: boolean) => {
    for (let t = 0n; t < BigInt(ms) * MS; t += Q) { a.tick(Q); note(); if (device) played.push(...frameNumbers(a.callback(128))); f.step(); note(); }
  };
  a.dev(DEV.STARTING); run(100, false);          // the context waits for its gesture
  a.dev(DEV.RUNNING); run(300, true);            // it runs
  run(1300, false);                              // the device stops calling back: 200 ms, then the silent sink, a retry after 1 s
  run(300, true);                                // the callbacks are back
  a.x.audio_suspend(1); run(150, false);         // the page is hidden
  a.x.audio_suspend(0); a.dev(DEV.RUNNING); run(300, true);
  assert.deepEqual(states, ["SilentStarting", "Live", "SilentRetry", "SilentStarting", "Live", "Suspended", "SilentStarting", "Live"]);

  // the game's side: every buffer back once and in order (Feeder throws otherwise), none stuck
  a.c("au_Stop", g); f.refill();
  assert.equal(f.reclaimed + f.queue.length, f.appended);
  assert.equal(a.stat(g, 3), f.appended); assert.equal(a.stat(g, 4), a.stat(g, 5));
  // 2.45 s at 5 ms a buffer, less the 200 ms the stalled device held the queue: about 450 buffers
  assert.ok(f.reclaimed > 440 && f.reclaimed < 460, `${f.reclaimed} buffers`);

  // the device's side: frame numbers only go up, by exactly 1 inside a run; a jump is what the silent sink consumed
  const heard = played.filter(n => n !== 0);
  let jumps = 0, sinkFrames = 0;
  for (let i = 1; i < heard.length; i++) {
    const d = heard[i] - heard[i - 1];
    if (d !== 1) { assert.ok(d > 1, `frame ${heard[i]} after ${heard[i - 1]}`); jumps++; sinkFrames += d - 1; }
  }
  assert.equal(jumps, 2);   // the stall, and the hidden page
  assert.equal(new Set(heard).size, heard.length);
  // every byte of every played buffer went to exactly one consumer: device frames + silent sink frames = consumed
  const consumed = a.stat(g, 9) / 4;
  const mixed = Number(a.x.audio_mixed_frames());
  assert.ok(heard.length <= mixed && mixed - heard.length <= 512, `${heard.length} heard of ${mixed} mixed`);   // the rest is still in the ring
  assert.equal(heard[0] - 1 + sinkFrames + (consumed - heard.at(-1)!) + heard.length, consumed);
  assert.equal(a.stat(g, 7), 0, "no underrun on either side of a handover");
  assert.equal(a.red.length, 1);   // the stall
  assert.equal(a.x.kit_refused_total(), 0);
});

test("handover: the stall is noticed after 200 ms of host time, not before; during it the game's buffers are held, and the silent sink starts exactly where the device stopped", () => {
  const a = new Au();
  a.attach(48000, 256);
  const g = a.open(), f = new Feeder(a, g);
  f.refill(); a.goLive(g);
  for (let i = 0; i < 100; i++) { a.tick(Q); a.callback(128); f.step(); }
  const before = a.stat(g, 9), rel = a.stat(g, 4);
  for (let i = 0; i < 75; i++) { a.tick(Q); f.step(); }           // 200 ms without a callback
  assert.equal(a.state(g), "Live"); assert.equal(a.stat(g, 9), before); assert.equal(a.stat(g, 4), rel);
  a.tick(Q); assert.equal(a.state(g), "SilentRetry");
  const at = a.g, pos = a.stat(g, 14);
  // the buffer the device was inside is finished by the silent sink: (960 - pos) bytes at 192 bytes per ms
  const d = a.host.nextDeadline();
  assert.equal(d, at + (BigInt(960 - pos) / 4n * 1_000_000_000n + 47999n) / 48000n);
  a.tick(d - a.g); f.step();
  assert.equal(a.stat(g, 4), rel + 1);
});

test("handover: a page frozen for 30 s (no ticks, then one) is no stall and no start timeout: the watchdog's clock does not run over a gap", () => {
  const a = new Au();
  a.attach(48000);
  const g = a.open(), f = new Feeder(a, g);
  f.refill(); a.goLive(g);
  for (let i = 0; i < 20; i++) { a.tick(Q); a.callback(128); f.step(); }
  a.tick(0n, 30_000n * MS);                      // host time jumps, the guest clock stood still
  assert.equal(a.state(g), "Live");
  for (let i = 0; i < 20; i++) { a.tick(Q); a.callback(128); f.step(); }
  assert.equal(a.state(g), "Live"); assert.equal(a.red.length, 0);
  // the same while a start waits for its first callback
  const h = a.open(); a.c("au_Start", h);
  a.tick(MS); a.tick(0n, 30_000n * MS); a.tick(MS);
  assert.equal(a.state(h), "SilentStarting");
  a.callback(); a.tick(MS);
  assert.equal(a.state(h), "Live");
});
