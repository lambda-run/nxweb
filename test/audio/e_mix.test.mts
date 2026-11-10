// Sample format conversion, the resampler, the mix.
import assert from "node:assert/strict";
import { test, Au, sine, fit, channel, DEV, MS, RING } from "./harness.mts";

// n frames of a stereo f32 sine at 48 kHz through audio_resample; the SNR of the result against a fitted sine
function resampled(a: Au, freq: number, outRate: number, n = 48000): { frames: number; snr: number; amp: number } {
  const src = a.alloc(n * 8), dst = a.alloc(Math.ceil(n * outRate / 48000 + 64) * 8);
  const s = new Float32Array(a.x.memory.buffer, src, n * 2);
  for (let i = 0; i < n; i++) s[2 * i] = s[2 * i + 1] = 0.5 * Math.sin(2 * Math.PI * freq * i / 48000);
  const frames = a.x.audio_resample(src, n, dst, outRate);
  const out = channel(new Float32Array(a.x.memory.buffer, dst, frames * 2), 0).subarray(256, frames - 256);   // without the filter's run-in
  return { frames, ...fit(out, freq, outRate) };
}

test("resampler: 48 kHz -> 44.1 kHz, a sine in and its signal-to-noise ratio out: above 90 dB up to 10 kHz, above 80 dB at 15 kHz, unity gain", () => {
  const rows: string[] = [];
  for (const [freq, min] of [[100, 90], [440, 90], [1000, 90], [5000, 90], [10000, 90], [15000, 80]]) {
    const a = new Au({ cover: false, guest: 16 << 20 });
    const r = resampled(a, freq, 44100);
    rows.push(`${freq} Hz ${r.snr.toFixed(1)} dB`);
    assert.ok(Math.abs(r.frames - 44100) <= 32, `${r.frames} frames`);
    assert.ok(r.snr > min, `${freq} Hz: ${r.snr.toFixed(1)} dB`);
    assert.ok(Math.abs(r.amp - 0.5) < 0.5 * 0.002, `${freq} Hz: amplitude ${r.amp}`);
  }
  console.log("     " + rows.join(", "));
});

test("resampler: other device rates (96000, 88200, 32000, 22050, 192000 Hz) keep a 1 kHz sine above 85 dB; 48000 Hz is a copy; an odd rate is resampled at the nearest ratio with a red line", () => {
  const rows: string[] = [];
  for (const rate of [96000, 88200, 32000, 22050, 192000]) {
    const a = new Au({ cover: false, guest: 32 << 20 });
    const r = resampled(a, 1000, rate, 24000);
    rows.push(`${rate} Hz ${r.snr.toFixed(1)} dB`);
    assert.ok(Math.abs(r.frames - rate / 2) <= 64 * rate / 48000, `${rate}: ${r.frames} frames`);
    assert.ok(r.snr > 85, `${rate} Hz: ${r.snr.toFixed(1)} dB`);
    assert.equal(a.red.length, 0);
  }
  console.log("     " + rows.join(", "));
  const a = new Au({ cover: false });
  const src = a.alloc(800), dst = a.alloc(800);
  const s = new Float32Array(a.x.memory.buffer, src, 200); for (let i = 0; i < 200; i++) s[i] = Math.sin(i);
  assert.equal(a.x.audio_resample(src, 100, dst, 48000), 100);
  assert.deepEqual(new Float32Array(a.x.memory.buffer, dst, 200), s);
  const b = new Au({ cover: false, guest: 16 << 20 });
  const r = resampled(b, 1000, 44056, 24000);
  assert.match(b.red[0], /device rate 44056 Hz needs 5507 filter phases, only 640 are kept/);
  assert.ok(Math.abs(r.frames - 22028) < 64);
});

test("mix: at 48 kHz the device gets the game's PCM16 bit for bit (sample / 32768), after the ring's lead of silence", () => {
  const a = new Au();
  a.attach(48000, 256);
  const g = a.open(), pcm = sine(997, 4800);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 2654435761) >> 16;   // every value, both signs
  pcm[200] = 32767; pcm[201] = -32768;
  a.append(g, a.buf(pcm)); a.goLive(g);
  const dev = a.play(60);
  let start = 0; while (dev[start] === 0 && dev[start + 1] === 0) start += 2;
  assert.ok(start >= 256 * 2 - 256 && start <= 256 * 2, `silence lead of ${start / 2} frames`);
  // the silent sink played the first 2 ms (96 frames) while the device started; the device goes on from there
  for (let i = 0; i < 1920; i++) assert.equal(dev[start + i], pcm[192 + i] / 32768, `sample ${i}`);
  assert.ok(dev.includes(32767 / 32768) && dev.includes(-1));
});

test("mix: a 440 Hz tone through a 44.1 kHz device arrives at 440 Hz with the right level and above 80 dB; at device pace: 5 s of device time take 5 s of the game's buffers", () => {
  const a = new Au({ guest: 32 << 20 });
  a.attach(44100);
  const g = a.open();
  let n = 0;
  const feed = () => { a.drain(g); while (a.stat(g, 1) < 6) { a.append(g, a.buf(sine(440, 480, 2, 0.5, n))); n += 480; } };
  feed(); a.goLive(g);
  const chunks: Float32Array[] = [];
  for (let i = 0; i < 500; i++) { feed(); chunks.push(a.play(10, 44100)); }
  const all = new Float32Array(chunks.reduce((s, c) => s + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const left = channel(all, 0), body = left.subarray(4410, left.length - 4410);
  const r = fit(body, 440, 44100);
  assert.ok(r.snr > 80, `${r.snr.toFixed(1)} dB`);
  assert.ok(Math.abs(r.amp - 0.5 * 32767 / 32768) < 0.001, `amplitude ${r.amp}`);
  // 439 or 441 Hz would not fit: the fit at the wrong frequency is far worse
  assert.ok(fit(body, 441, 44100).snr < 3);
  assert.equal(a.stat(g, 7), 0); assert.equal(a.ring[RING.UNDER], 0);
  // what the game was asked for is what the device took: device frames x 48000 / 44100 (and the 2 ms before Live)
  const consumed = a.stat(g, 9) / 4, deviceSeconds = left.length / 44100;
  assert.ok(deviceSeconds > 5);
  assert.ok(Math.abs(consumed - deviceSeconds * 48000) < 200, `${consumed} frames consumed in ${deviceSeconds} s`);
  console.log(`     ${r.snr.toFixed(1)} dB, amplitude ${r.amp.toFixed(5)}`);
});

test("mix: two stereo outputs, a mono one and a six-channel one play together; each keeps its own volume; six channels are downmixed with nxnative's coefficients", () => {
  const a = new Au({ guest: 32 << 20 });
  a.attach(48000);
  const N = 9600;
  const mk = (ch: number, pcm: Int16Array) => { const g = a.open(ch, false); a.append(g, a.buf(pcm)); return g; };
  const s1 = mk(2, sine(500, N, 2, 0.2)), s2 = mk(2, sine(1250, N, 2, 0.2));
  const mono = mk(1, sine(2000, N, 1, 0.2));
  const six = new Int16Array(N * 6), c = sine(3000, N, 1, 0.2), lfe = sine(60, N, 1, 0.2), bl = sine(4000, N, 1, 0.2), fr = sine(5000, N, 1, 0.2);
  for (let i = 0; i < N; i++) { six[6 * i + 1] = fr[i]; six[6 * i + 2] = c[i]; six[6 * i + 3] = lfe[i]; six[6 * i + 4] = bl[i]; }
  const s6 = mk(6, six);
  a.call("au_SetVol", [s2], { f0: 0.5 });
  for (const g of [s1, s2, mono, s6]) a.c("au_Start", g);
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  for (const g of [s1, s2, mono, s6]) assert.equal(a.state(g), "Live");
  assert.equal(a.ring[RING.LIVE], 4);
  const dev = a.play(180), L = channel(dev, 0).subarray(3000, 3000 + 4800), Rt = channel(dev, 1).subarray(3000, 3000 + 4800);   // 0.1 s: whole cycles of every tone
  const amp = (x: Float32Array, f: number) => fit(x, f, 48000).amp;
  const A = 0.2 * 32767 / 32768, near = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) < 0.0006, `${what}: ${got} for ${want}`);
  near(amp(L, 500), A, "first output, left"); near(amp(Rt, 500), A, "first output, right");
  near(amp(L, 1250), A / 2, "second output at volume 0.5");
  near(amp(L, 2000), A, "mono, left"); near(amp(Rt, 2000), A, "mono, right");
  near(amp(L, 3000), A * 23167 / 32768, "center, left"); near(amp(Rt, 3000), A * 23167 / 32768, "center, right");
  near(amp(L, 60), A * 8224 / 32768, "LFE"); near(amp(L, 4000), A * 23167 / 32768, "back left"); near(amp(Rt, 4000), 0, "back left in the right channel");
  near(amp(Rt, 5000), A, "front right"); near(amp(L, 5000), 0, "front right in the left channel");
  assert.equal(a.red.length, 0);
});

test("mix: eight outputs at once are summed and the sum is limited to full scale; the volume saturates PCM16 before the mix", () => {
  const a = new Au({ guest: 32 << 20 });
  a.attach(48000, 256);
  const outs = Array.from({ length: 8 }, () => { const g = a.open(2, false); a.append(g, a.buf(new Int16Array(4800).fill(8000))); a.c("au_Start", g); return g; });
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  assert.equal(a.ring[RING.LIVE], 8);
  let dev = a.play(20);
  assert.equal(Math.max(...dev), 1);   // 8 x 8000 / 32768 = 1.95 -> 1
  assert.ok(dev.includes(1));
  outs.slice(1).forEach(g => a.c("au_Stop", g));
  a.call("au_SetVol", [outs[0]], { f0: 8 });   // 64000 saturates at 32767
  a.play(10); dev = a.play(10);
  assert.equal(dev.at(-1), 32767 / 32768);
});

test("mix: an output whose game appends too late underruns alone: silence for the missing frames, counted on that output, while the other plays on and the device never starves", () => {
  // nxnative "Several outputs at once": per output numbers
  const a = new Au({ guest: 32 << 20 });
  a.attach(48000);
  const fed = a.open(), starved = a.open();
  let n = 0;
  const feed = () => { a.drain(fed); while (a.stat(fed, 1) < 6) { a.append(fed, a.buf(sine(440, 240, 2, 0.3, n))); n += 240; } };
  feed(); a.append(starved, a.buf(sine(3000, 2400, 2, 0.3)));
  a.c("au_Start", fed); a.c("au_Start", starved);
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  const chunks: Float32Array[] = [];
  for (let i = 0; i < 100; i++) { feed(); chunks.push(a.play(5)); }
  assert.equal(a.stat(fed, 7), 0);
  assert.ok(a.stat(starved, 7) > 100, `${a.stat(starved, 7)} underruns`);
  assert.equal(a.stat(starved, 8) / 4, Number(a.x.audio_mixed_frames()) + 96 - 2400);   // everything the device took beyond its 2400 frames
  assert.equal(a.ring[RING.UNDER], 0);
  const all = new Float32Array(chunks.length * chunks[0].length); chunks.forEach((c, i) => all.set(c, i * c.length));
  const tail = channel(all, 0).subarray(12000, 22000);
  assert.ok(fit(tail, 440, 48000).snr > 80);   // only the fed output is left, undisturbed
  assert.deepEqual(a.logs.filter(l => l.includes("OpenAudioOut")).map(l => l.slice(0, 8)), ["audio #0", "audio #1"]);
});
