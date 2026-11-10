// The AudioOut and device entries of nxnative docs/reference/audio.md, each as a test (the entry's title is in the
// test's name). Entries that other files cover are named there: Stop's releases, the stall watchdog and volume in
// b_out, several outputs in e_mix, the handover in c_handover.
import assert from "node:assert/strict";
import { test, Au, Feeder, frameNumbers, sine, DEV, R, MS, RING } from "./harness.mts";

const Q = BigInt(Math.round(128e9 / 48000));

test("reference 'A blocked audio device start freezes the game': a start the device never answers: Start returns, the queued buffers come back in real time, Stop, hide, show and Close all run meanwhile, a second output starts on its own", () => {
  const a = new Au();
  a.attach(48000);
  const g = a.open(), f = new Feeder(a, g);
  f.refill();
  assert.equal(a.c("au_Start", g), R.OK);        // returns; nothing waits for the device
  a.dev(DEV.STARTING);                           // resume() is pending and stays pending
  for (let i = 0; i < 2000; i++) { a.tick(MS); f.step(); }
  assert.equal(a.state(g), "SilentStarting");
  assert.equal(f.reclaimed, 400 - 0, "2 s of 5 ms buffers");   // the game never stalled
  assert.equal(a.ring[RING.WR], 0);              // the device got nothing while it had not called back
  // Stop / hide / show while the start is still blocked
  a.c("au_Stop", g); f.refill(); assert.equal(a.state(g), "Stopped");
  a.c("au_Start", g); assert.equal(a.state(g), "SilentStarting");
  a.x.audio_suspend(1); assert.equal(a.state(g), "Suspended");
  for (let i = 0; i < 100; i++) { a.tick(MS); f.step(); }
  a.x.audio_suspend(0); assert.equal(a.state(g), "SilentStarting");
  // each output starts independently
  const g2 = a.open(), f2 = new Feeder(a, g2);
  f2.refill(); a.c("au_Start", g2);
  const before = [f.reclaimed, f2.reclaimed];
  for (let i = 0; i < 100; i++) { a.tick(MS); f.step(); f2.step(); }
  assert.deepEqual([f.reclaimed - before[0], f2.reclaimed - before[1]], [20, 20]);
  // Close during the blocked start returns at once and frees the slot
  a.c("au_Close", g);
  assert.equal(a.state(g), "closed"); assert.equal(a.state(g2), "SilentStarting");
  // the device finally answers: the remaining output goes Live
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  assert.equal(a.state(g2), "Live");
  assert.equal(a.red.length, 0); assert.equal(a.x.kit_refused_total(), 0);
});

test("reference 'A blocked audio device start freezes the game': a device that reports success and never calls back is given up after 1 s and retried; until the first callback the device plays silence", () => {
  const a = new Au();
  a.attach(48000);
  const g = a.open(), f = new Feeder(a, g);
  f.refill(); a.c("au_Start", g); a.dev(DEV.RUNNING);
  for (let i = 0; i < 999; i++) { a.tick(MS); f.step(); }
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.ring[RING.WR], 0);
  a.tick(MS);
  assert.equal(a.state(g), "SilentRetry");
  assert.match(a.red[0], /no device callback within 1 s of its start: the silent sink stands in, retrying the device in 1 s/);
  assert.equal(f.reclaimed, 199);
});

test("reference 'AudioOut release notification can sleep with pending work': 100,000 event-driven buffers reclaimed one by one by a game that only acts when woken: no release without its wake-up, on the silent sink (one buffer in flight) and on the device (two)", () => {
  // nxnative's notifier thread and its two flags (pending, armed) do not exist here: a release signals the kernel
  // event inside the same call (see README). The fixture is the same: a game that appends only when woken.
  {
    const a = new Au();
    const g = a.open(), f = new Feeder(a, g, 240, 1);
    f.refill(); a.c("au_Start", g);
    for (let i = 0; i < 100000; i++) { if (!a.toDeadline()) assert.fail(`no release pending after ${i} buffers: the game sleeps for good`); f.step(); }
    assert.deepEqual([f.reclaimed, f.wakes, a.ev(g).signals], [100000, 100000, 100000]);
    assert.equal(a.g, 100000n * 5n * MS);
  }
  {
    const a = new Au();
    a.attach(48000, 256);
    const g = a.open(), f = new Feeder(a, g, 128, 2);   // one buffer per device callback, one ahead
    f.refill(); a.goLive(g); f.step();
    const s0 = a.ev(g).signals, w0 = f.wakes, r0 = f.reclaimed, u0 = a.stat(g, 7);
    for (let i = 0; i < 100000; i++) { a.tick(Q); a.callback(128); f.step(); }
    // every signal woke the game, every buffer came back; the first two releases shared one wake-up
    assert.equal(f.reclaimed - r0, 100000); assert.ok(f.wakes - w0 >= 99999);
    assert.equal(a.ev(g).signals - s0, f.wakes - w0 + (a.ev(g).flag ? 1 : 0));   // a signal not yet acted on is still set
    assert.ok(a.stat(g, 7) - u0 <= 1, "at most the one underrun while the two-buffer game finds its phase"); assert.equal(a.state(g), "Live");
  }
});

test("reference 'Interruptions that stop RemoteIO callbacks': a game that only polls for its buffers (no event) gets them back again once the watchdog has put the silent sink in the device's place", () => {
  const a = new Au();
  a.attach(48000, 256);
  const g = a.open(2, false), f = new Feeder(a, g);
  f.refill(); a.goLive(g);
  for (let i = 0; i < 200; i++) { a.tick(Q); a.callback(128); f.step(); }
  const n = f.reclaimed;
  for (let i = 0; i < 76; i++) { a.tick(Q); f.step(); }      // the callbacks stop: 200 ms nothing comes back
  assert.equal(f.reclaimed, n); assert.equal(a.state(g), "SilentRetry");
  for (let i = 0; i < 100; i++) { a.tick(MS); f.step(); }
  assert.equal(f.reclaimed, n + 20);
  assert.equal(a.evOf.size, 0);
});

test("reference 'Audio across a background round trip': hidden, the silent sink keeps the pace; a process frozen for 10 s on a wall clock is not made up: no burst of releases, no underruns", () => {
  const a = new Au();
  a.attach(48000);
  a.x.audio_set_catchup_limit(100n * MS);          // the embedder's guest clock is a wall clock
  const g = a.open(), f = new Feeder(a, g);
  f.refill(); a.goLive(g);
  for (let i = 0; i < 100; i++) { a.tick(Q); a.callback(128); f.step(); }
  a.x.audio_suspend(1);
  for (let i = 0; i < 60; i++) { a.tick(MS); f.step(); }
  const n = f.reclaimed, sig = a.ev(g).signals;
  a.tick(10_000n * MS);                             // SIGSTOP ... SIGCONT
  f.step();
  assert.ok(f.reclaimed - n <= 1 && a.ev(g).signals - sig <= 1);
  assert.equal(a.stat(g, 7), 0);
  for (let i = 0; i < 100; i++) { a.tick(MS); f.step(); }
  assert.equal(f.reclaimed - n, 20);
  a.x.audio_suspend(0); a.dev(DEV.RUNNING);
  a.tick(MS); a.callback(); a.tick(MS);
  assert.equal(a.state(g), "Live");
  assert.deepEqual(a.logs.filter(l => l.startsWith("audio suspended") || l.startsWith("audio resumed")), ["audio suspended (the page is hidden)", "audio resumed (the page is visible)"]);
});

test("reference 'AudioOut buffer count from the host queue': after every release event the count is what is appended and not yet played to the end, 0 when the sink has starved", () => {
  const a = new Au();
  const g = a.open(), b = [0, 1, 2].map(() => a.buf(240 * 4));
  a.c("au_Start", g);
  b.forEach(x => a.append(g, x));
  for (const want of [2n, 1n, 0n]) { a.toDeadline(); assert.equal(a.ev(g).flag, true); a.ev(g).flag = false; assert.equal(a.c("au_BufCount", g), want); }
});

test("reference 'Audio device output volume and names', the notification names of SDK 7, 12 and 21, 'No audio input devices', 'No virtual audio input devices (SDK 22)'", () => {
  const a = new Au();
  const names = a.alloc(0x300); a.u8.fill(0xCC, names, names + 0x300);
  for (const fn of ["ad_List", "ad_List12"]) {
    assert.equal(a.c(fn, names, 0), 0n); assert.equal(a.c(fn, 0, 4), 0n);
    assert.equal(a.c(fn, names, 4), 1n); assert.equal(a.str(names), "AudioBuiltInSpeakerOutput");
    assert.ok(a.u8.subarray(names + 25, names + 0x100).every(v => v === 0) && a.u8[names + 0x100] === 0xCC);
  }
  for (const fn of ["ad_Active", "ad_Active12"]) { a.u8.fill(1, names, names + 0x100); a.c(fn, names); assert.equal(a.str(names), "AudioBuiltInSpeakerOutput"); }
  assert.equal(a.c("ad_Channels"), 2n); assert.equal(a.c("ad_Channels7"), 2n);
  assert.equal(a.call("ad_GetVol", [names]).f, 1);
  a.call("ad_SetVol", [names], { f0: 0.375 }); assert.equal(a.call("ad_GetVol", [names]).f, 0.375);
  assert.equal(a.c("ad_AutoTune"), 0n); a.c("ad_SetAutoTune", 0xFF01); assert.equal(a.c("ad_AutoTune"), 1n);
  // the output notification: bound (not auto-clear), never signalled; a second acquire answers 0x499 under either name
  const ev = a.alloc(64), ev2 = a.alloc(64);
  assert.equal(a.c("ad_Notify21", ev), R.OK);
  assert.deepEqual([a.events.at(-1)!.ptr, a.events.at(-1)!.autoClear], [ev, false]);
  assert.equal(a.c("ad_Notify", ev2), R.TWICE); assert.equal(a.c("ad_Notify21", ev2), R.TWICE);
  assert.equal(a.c("ad_NotifyIn", ev2), R.OK); assert.equal(a.c("ad_NotifyIn", ev2), R.TWICE);
  assert.equal(a.call("ad_Notify7", [a.alloc(64)]).kind, 0);
  assert.equal(a.events.length, 3); assert.ok(a.events.every(e => e.signals === 0));
  // no microphone: nothing listed, every open fails, the rest answers without touching the game's object
  const o = a.alloc(64); a.u8.fill(0x77, o, o + 64);
  assert.equal(a.c("ai_List", names, 4), 0n);
  for (const fn of ["ai_Open", "ai_OpenNoEv", "ai_OpenDef", "ai_Start"]) assert.equal(a.c(fn, o, 0, 0, 0), R.FAIL);
  a.c("ai_Stop", o); a.c("ai_Close", o);
  assert.deepEqual([a.c("ai_Append", o, o), a.c("ai_Released", o), a.c("ai_Rate", o), a.c("ai_Ch", o), a.c("ai_Fmt", o)], [0n, 0n, 48000n, 2n, 2n]);
  assert.equal(a.c("is_List", names, 4), 0n);
  for (const fn of ["is_Props", "is_Open", "is_Start"]) assert.equal(a.c(fn, o, 0, 0, 0), R.FAIL);
  for (const fn of ["is_Close", "is_Stop", "is_Purge"]) assert.equal(a.call(fn, [o]).kind, 0);
  assert.deepEqual(["is_Read", "is_Filled", "is_State", "is_Free", "is_Capacity"].map(fn => a.c(fn, o, 0, 0)), [0n, 0n, 0n, 0n, 0n]);
  const fmt = a.call("is_Format", [o]);
  assert.deepEqual([fmt.kind, fmt.x0, fmt.x1], [3, 2n | (1n << 32n), 48000n]);   // { PCM16, 1 channel, 48000 } in x0, x1
  assert.equal(a.call("is_GetGain", [o]).f, 1); assert.equal(a.call("is_SetGain", [o], { f0: 2 }).kind, 0);
  const st = a.alloc(64); a.u8.fill(0x55, st, st + 64);
  assert.equal(a.call("is_Stats", [o, 1], { x8: st }).kind, 0);
  assert.ok(a.u8.subarray(st, st + 24).every(v => v === 0) && a.u8[st + 24] === 0x55);
  assert.ok(a.u8.subarray(o, o + 64).every(v => v === 0x77));
  assert.equal(a.red.length, 0);
});

test("reference 'OpenAudioOut without a release event (SDK 22)': the overload without an event binds none; the game polls its released buffers", () => {
  const a = new Au();
  const g = a.alloc(64);
  assert.equal(a.c("au_Open4", g, a.cstr("DeviceOut"), a.param(2, 48000)), R.OK);
  assert.equal(a.events.length, 0);
  assert.match(a.logs[0], /no release event \(the game polls\)/);
  const b = a.buf(240 * 4);
  a.append(g, b); a.c("au_Start", g); a.tick(5n * MS);
  assert.equal(a.released(g), b);
});

// ---- SDK 21's OutputStream ----
function streamOpen(a: Au, fmt: number, ch: number, cap: number, withEvent = true): { s: number; ev: number } {
  const s = a.alloc(0x400), ev = withEvent ? a.alloc(64) : 0, f = a.alloc(16), dev = a.alloc(0x100);
  a.c("os_DefaultDev", dev);
  if (a.str(dev) !== "AudioVirtualOutput") throw new Error("default virtual device " + a.str(dev));
  a.dv.setInt32(f, fmt, true); a.dv.setInt32(f + 4, ch, true); a.dv.setInt32(f + 8, 48000, true);
  const r = withEvent ? a.c("os_Open", s, ev, 0, 0, dev, f, cap, cap / 4) : a.c("os_OpenNoEv", s, 0, 0, dev, f, cap);
  if (r !== 0n) throw new Error("OpenOutputStream failed " + r.toString(16));
  return { s, ev };
}

test("reference 'SDK 21's OutputStream on a virtual output device' (nxnative t_output_stream): interleaved float frames become one PCM16 block in order, scaled and clamped; the free count is the capacity less what is queued; played blocks come back and the event fires; a purge drops what is queued; states 0, 1, 2", () => {
  const a = new Au();
  a.attach(48000, 256);
  const CAP = 4800, FRAMES = 960;
  const none = a.alloc(64);
  assert.equal(a.c("os_State", none), 0n);                       // never opened: 0, and no red line
  const { s } = streamOpen(a, 5, 2, CAP);
  const ev = a.events.at(-1)!;
  assert.equal(ev.autoClear, true);
  assert.equal(a.c("os_State", s), 1n);
  assert.equal(a.c("os_Free", s), BigInt(CAP)); assert.equal(a.c("os_Filled", s), 0n);
  // L, R, L, R: left counts up, right is a constant; two values beyond full scale and a NaN
  const data = a.alloc(FRAMES * 8), fl = new Float32Array(a.x.memory.buffer, data, FRAMES * 2);
  for (let i = 0; i < FRAMES; i++) { fl[2 * i] = (i + 1) / 2000; fl[2 * i + 1] = -0.25; }
  fl[2 * 900] = 1.5; fl[2 * 901] = -1.5; fl[2 * 902] = NaN;
  for (let k = 0; k < 5; k++) { assert.equal(a.c("os_Write", s, data, FRAMES), BigInt(FRAMES)); assert.equal(a.c("os_Free", s), BigInt(CAP - (k + 1) * FRAMES)); }
  assert.equal(a.c("os_Write", s, data, FRAMES), 0n);            // full: nothing is taken
  assert.equal(a.c("os_Write", s, data, 0), 0n); assert.equal(a.c("os_Write", s, 0, 10), 0n);
  assert.equal(a.c("os_Filled", s), BigInt(CAP));
  // started on a running device: what the device plays is the block, in the order written
  assert.equal(a.c("os_Start", s), R.OK); assert.equal(a.c("os_State", s), 2n);
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  const dev = a.play(110);
  let st = 0; while (dev[st] === 0 && dev[st + 1] === 0) st += 2;
  const first = Math.round(dev[st] * 32768);                      // the silent sink played the first 2 ms
  assert.ok(first >= Math.trunc(97 / 2000 * 32767) - 1 && first <= Math.trunc(98 / 2000 * 32767));
  for (let i = 0; i < 700; i++) {
    assert.equal(dev[st + 2 * i], Math.trunc((97 + i) / 2000 * 32767) / 32768, `left of frame ${i}`);
    assert.equal(dev[st + 2 * i + 1], Math.trunc(-0.25 * 32767) / 32768, `right of frame ${i}`);
  }
  const at = (frame: number) => dev[st + 2 * (frame - 96)];
  assert.deepEqual([at(900), at(901), at(902)], [32767 / 32768, -1, 0]);   // clamped; NaN is silence
  // the 100 ms were played: the frames are free again and the event fired
  assert.equal(a.c("os_Free", s), BigInt(CAP)); assert.equal(a.c("os_Filled", s), 0n);
  assert.ok(ev.signals >= 5);
  // stopped with frames queued: a purge drops them
  a.c("os_Stop", s); assert.equal(a.c("os_State", s), 1n);
  assert.equal(a.c("os_Write", s, data, FRAMES), BigInt(FRAMES)); assert.equal(a.c("os_Write", s, data, FRAMES), BigInt(FRAMES));
  assert.equal(a.c("os_Free", s), BigInt(CAP - 2 * FRAMES));
  a.c("os_Purge", s);
  assert.equal(a.c("os_Free", s), BigInt(CAP)); assert.equal(a.c("os_Filled", s), 0n);
  a.c("os_Close", s);
  assert.equal(a.c("os_State", s), 0n);
  assert.equal(ev.released, true);
  assert.equal(a.x.audio_arena_used(), 0);
  assert.equal(a.red.length, 0); assert.equal(a.x.kit_refused_total(), 0);
});

test("reference OutputStream: PCM16 frames are copied; the gain is the output's volume; StartOutputStreams starts several; the statistics are 24 zero bytes through x8 and not one more; unsupported formats and rates fail the open with a red line", () => {
  const a = new Au();
  a.attach(48000, 256);
  const { s: s1 } = streamOpen(a, 2, 2, 1920, false), { s: s2 } = streamOpen(a, 5, 1, 1920);
  const list = a.alloc(16); a.dv.setBigUint64(list, BigInt(s1), true); a.dv.setBigUint64(list + 8, BigInt(s2), true);
  assert.equal(a.c("os_StartN", list, 2), R.OK);
  assert.deepEqual([a.c("os_State", s1), a.c("os_State", s2)], [2n, 2n]);
  a.call("os_Gain", [s1, 1_000_000], { f0: 0.5 });
  const pcm = sine(1000, 480, 2, 0.5), data = a.alloc(1920);
  new Int16Array(a.x.memory.buffer, data, 960).set(pcm);
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  assert.equal(a.c("os_Write", s1, data, 480), 480n);
  const dev = a.play(30);
  let st = 0; while (dev[st] === 0 && dev[st + 1] === 0) st += 2;
  for (let i = 0; i < 400; i++) assert.equal(dev[st + i], Math.trunc(pcm[2 + i] * 0.5) / 32768);   // pcm[0], pcm[1] are 0
  const stats = a.alloc(64); a.u8.fill(0xAB, stats, stats + 64);
  const r = a.call("os_Stats", [s1, 0], { x8: stats });
  assert.equal(r.kind, 0);
  assert.ok(a.u8.subarray(stats, stats + 24).every(v => v === 0)); assert.equal(a.u8[stats + 24], 0xAB);   // Star Fox's stack canary sits here
  // opens that fail
  const f = a.alloc(16), bad = a.alloc(64);
  const open = (fmt: number, ch: number, rate: number, frames: number) => { a.dv.setInt32(f, fmt, true); a.dv.setInt32(f + 4, ch, true); a.dv.setInt32(f + 8, rate, true); return a.c("os_OpenNoEv", bad, 0, 0, 0, f, frames); };
  assert.equal(open(3, 2, 48000, 480), R.FAIL); assert.match(a.red.at(-1)!, /OutputStream sample format 3: not supported/);
  assert.equal(open(5, 2, 44100, 480), R.FAIL); assert.match(a.red.at(-1)!, /OutputStream sample rate 44100: not supported/);
  assert.equal(open(5, 0, 48000, 480), R.FAIL); assert.equal(open(5, 2, 48000, 0), R.FAIL);
  assert.equal(a.red.length, 2);
  assert.equal(a.c("os_State", bad), 0n);
  // calls on a stream that is not open: red once per function, harmless answers
  assert.equal(a.c("os_Start", bad), R.FAIL); assert.equal(a.c("os_Write", bad, data, 10), 0n); assert.equal(a.c("os_Free", bad), 0n);
  assert.equal(a.red.length, 5);
});

test("reference OutputStream 'Focus': a game that closes its stream and opens a new one 14 times (Star Fox) leaves no output slot and no arena memory behind; writes of every size wrap the block store", () => {
  const a = new Au();
  for (let round = 0; round < 14; round++) {
    const { s } = streamOpen(a, 5, 2, 1920);
    a.c("os_Start", s);
    const data = a.alloc(1920 * 8);
    let written = 0, next = 1;
    const sizes = [480, 37, 1000, 1, 480, 959, 13, 480, 480, 200];
    for (let i = 0; i < 60; i++) {
      const n = sizes[(i + round) % sizes.length], free = Number(a.c("os_Free", s));
      if (free >= n) {
        const fl = new Float32Array(a.x.memory.buffer, data, n * 2);
        for (let k = 0; k < n; k++) { fl[2 * k] = ((next + k) & 0x3FFF) / 32767; fl[2 * k + 1] = 0; }
        assert.equal(a.c("os_Write", s, data, n), BigInt(n), `write ${i} of ${n} frames with ${free} free`);
        written += n; next += n;
      }
      a.tick(7n * MS);
      assert.equal(Number(a.c("os_Free", s)) + Number(a.c("os_Filled", s)), 1920);
    }
    assert.ok(written > 15000);
    if (round % 2) a.c("os_Stop", s);
    a.c("os_Close", s);
    assert.equal(a.x.audio_arena_used(), 0);
    assert.equal(a.host.outs().length, 0);
  }
  assert.equal(a.red.length, 0); assert.equal(a.x.kit_refused_total(), 0);
});
