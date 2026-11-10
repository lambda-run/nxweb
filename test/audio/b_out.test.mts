// AudioOut: the calls, the silent sink's timing on the guest clock, and every transition of audio_out and audio_buf
// as the module takes them.
import assert from "node:assert/strict";
import { test, Au, sine, DEV, R, MS, RING } from "./harness.mts";

const NEVER = 0xFFFF_FFFF_FFFF_FFFFn;
const due = (frames: number, t0 = 0n) => t0 + (BigInt(frames) * 1_000_000_000n + 47999n) / 48000n;

test("out: parameters, device list, open (four overloads), the object's front fields, getters, close", () => {
  const a = new Au();
  const p = a.alloc(16); a.u8.fill(0xFF, p, p + 16);
  a.c("au_InitParam", p);
  assert.deepEqual([...a.u8.subarray(p, p + 16)], [0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]);
  const info = a.alloc(512); a.u8.fill(0xEE, info, info + 512);
  assert.equal(a.c("au_List", info, 0), 0n);
  assert.equal(a.c("au_List", info, 4), 1n);
  assert.equal(a.str(info), "DeviceOut");
  assert.ok(a.u8.subarray(info + 9, info + 256).every(b => b === 0) && a.u8[info + 256] === 0xEE);

  const forms: [string, (g: number, ev: number) => (number)[], boolean][] = [
    ["au_Open", (g, ev) => [g, ev, a.cstr("DeviceOut"), a.param(2)], true],
    ["au_Open4", (g) => [g, a.cstr("DeviceOut"), a.param(6)], false],
    ["au_OpenDef", (g, ev) => [g, ev, a.param(0, 48000)], true],
    ["au_OpenDef0", (g) => [g, a.param(1)], false],
  ];
  const chans = [2, 6, 2, 1], outs: number[] = [];
  forms.forEach(([name, args, hasEv], i) => {
    const g = a.alloc(64), ev = a.alloc(64), before = a.events.length;
    assert.equal(a.c(name, ...args(g, ev)), R.OK, name);
    assert.equal(a.events.length, before + (hasEv ? 1 : 0));
    if (hasEv) assert.deepEqual([a.events.at(-1)!.ptr, a.events.at(-1)!.autoClear], [ev, true]);
    assert.deepEqual([a.dv.getUint32(g, true), a.dv.getUint32(g + 4, true), a.dv.getUint32(g + 8, true), a.dv.getUint32(g + 12, true)], [48000, chans[i], 2, 1]);
    assert.equal(a.c("au_Rate", g), 48000n); assert.equal(a.c("au_Ch", g), BigInt(chans[i])); assert.equal(a.c("au_Fmt", g), 2n);
    assert.equal(a.c("au_State", g), 1n);   // stopped
    assert.equal(a.str(Number(a.c("au_Name", g))), "DeviceOut");
    outs.push(g);
  });
  assert.match(a.logs.find(l => l.includes("OpenAudioOut"))!, /^audio #0 OpenAudioOut DeviceOut channels 2, no device: silent sink$/);
  assert.match(a.logs.filter(l => l.includes("OpenAudioOut"))[1], /channels 6.*no release event \(the game polls\)/);
  // a rate the host does not play
  assert.equal(a.c("au_Open", a.alloc(64), a.alloc(64), 0, a.param(2, 44100)), R.FAIL);
  assert.match(a.red.at(-1)!, /sample rate 44100 not supported/);
  // close: stopped state written back, the event token released, the slot free again
  a.dv.setUint32(outs[0] + 12, 7, true);
  a.c("au_Close", outs[0]);
  assert.equal(a.dv.getUint32(outs[0] + 12, true), 1);
  assert.equal(a.events[0].released, true);
  assert.equal(a.state(outs[0]), "closed");
  // calls on an object the host did not open: one red line per function, a harmless answer
  const n = a.red.length;
  assert.equal(a.c("au_Start", outs[0]), R.FAIL); assert.equal(a.c("au_Start", outs[0]), R.FAIL);
  assert.equal(a.c("au_State", outs[0]), 1n); assert.equal(a.c("au_Released", outs[0]), 0n);
  assert.equal(a.red.length, n + 3);
  assert.match(a.red[n], /StartAudioOut.* on AudioOut 0x[0-9a-f]+ the host did not open/);
});

test("out: more than 8 outputs: the ninth open fails with a red line, and works again after a close", () => {
  const a = new Au();
  const outs = Array.from({ length: 8 }, () => a.open(2, false));
  const g = a.alloc(64);
  assert.equal(a.c("au_Open4", g, 0, a.param(2)), R.FAIL);
  assert.match(a.red.at(-1)!, /more than 8 AudioOuts open at once/);
  a.c("au_Close", outs[3]);
  assert.equal(a.c("au_Open4", g, 0, a.param(2)), R.OK);
});

test("out: buffer descriptor calls write and read the first 24 bytes of the game's struct", () => {
  const a = new Au();
  const b = a.alloc(64); a.u8.fill(0xAA, b, b + 64);
  a.c("au_SetBuf", b, 0x12345678, 4096, 960);
  assert.equal(a.dv.getBigUint64(b, true), 0x12345678n); assert.equal(a.dv.getBigUint64(b + 8, true), 4096n); assert.equal(a.dv.getBigUint64(b + 16, true), 960n);
  assert.equal(a.u8[b + 24], 0xAA);
  assert.equal(a.c("au_BufPtr", b), 0x12345678n); assert.equal(a.c("au_BufSize", b), 960n);
});

test("silent sink: four 5 ms buffers queued before Start come back at exactly +5, +10, +15, +20 ms of guest time, in order, one event signal each", () => {
  const a = new Au();
  a.tick(1234567n);
  const g = a.open(), bufs = [0, 1, 2, 3].map(() => a.buf(sine(440, 240)));
  for (const b of bufs) assert.equal(a.append(g, b), true);
  assert.equal(a.c("au_BufCount", g), 4n);
  assert.equal(a.host.nextDeadline(), NEVER);   // stopped: nobody consumes
  a.tick(50n * MS);
  assert.equal(a.released(g), 0);
  assert.equal(a.c("au_Start", g), R.OK);
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.c("au_State", g), 0n);
  assert.equal(a.devStarts, 1);
  const t0 = a.g;
  for (let i = 0; i < 4; i++) {
    const d = a.host.nextDeadline();
    assert.equal(d, t0 + BigInt(5 * (i + 1)) * MS);
    a.tick(d - a.g - 1n);                       // one nanosecond early: nothing
    assert.equal(a.released(g), 0); assert.equal(a.ev(g).signals, i);
    a.tick(1n);
    assert.equal(a.ev(g).signals, i + 1);
    assert.equal(a.released(g), bufs[i]); assert.equal(a.released(g), 0);
    assert.equal(a.c("au_BufCount", g), BigInt(3 - i));
  }
  assert.equal(a.host.nextDeadline(), NEVER);
  assert.equal(a.stat(g, 7), 0);   // no underrun while it had data
  a.tick(5n * MS);
  assert.equal(a.stat(g, 7), 1); assert.equal(a.stat(g, 8), 960);   // 5 ms of silence, counted
  assert.equal(a.red.length, 0);
});

test("silent sink: release times are sample exact for sizes that are no whole number of nanoseconds; a buffer appended to an empty queue starts when it is appended", () => {
  const a = new Au();
  const g = a.open(2, false);
  a.c("au_Start", g);
  const sizes = [100, 1, 333, 4096, 7, 480], t0 = a.g;
  for (const n of sizes) a.append(g, a.buf(n * 4));
  let cum = 0;
  for (const n of sizes) { cum += n; assert.equal(a.host.nextDeadline(), due(cum, t0)); assert.ok(a.toDeadline()); assert.equal(a.drain(g).length, 1); }
  // the queue is empty for 3.3 ms; the next buffer plays from the moment it is appended (to the frame)
  a.tick(3_300_000n);
  const at = a.g; a.append(g, a.buf(240 * 4));
  const d = a.host.nextDeadline();
  assert.ok(d <= at + 5n * MS && d > at + 5n * MS - 20834n, `released ${d - at} ns after the append`);
  a.toDeadline(); a.drain(g);
  // a mono output and a six-channel one consume 2 and 12 bytes per frame
  for (const ch of [1, 6]) {
    const o = a.open(ch, false); a.c("au_Start", o);
    const s = a.g; a.append(o, a.buf(480 * 2 * ch));
    assert.equal(Number((a.host.nextDeadline() - s) / 1000n) >= 9979 && a.host.nextDeadline() - s <= 10n * MS, true);
    a.c("au_Stop", o);
  }
});

test("silent sink: 200,000 buffers back to back (1000 s of guest time) with no drift: buffer k comes back at exactly k x 5 ms", () => {
  const a = new Au();
  const g = a.open();
  const pool = [0, 1, 2].map(() => a.buf(240 * 4));
  a.append(g, pool[0]); a.append(g, pool[1]);
  a.c("au_Start", g);
  const t0 = a.g;
  let free = pool[2];
  for (let k = 1; k <= 200000; k++) {
    a.append(g, free);
    a.toDeadline();
    if (a.g !== t0 + BigInt(k) * 5n * MS) assert.fail(`buffer ${k} at ${a.g - t0}`);
    free = Number(a.host.call(22, [g]).x0);   // GetReleasedAudioOutBuffer without a tick in between
    if (!free) assert.fail(`buffer ${k} was not released`);
  }
  assert.equal(a.ev(g).signals, 200000); assert.equal(a.stat(g, 7), 0); assert.equal(a.stat(g, 4), 200000);
});

test("silent sink: a late tick releases everything that was due, in order, with one signal; the catch-up limit of a wall-clock embedder drops the jump instead", () => {
  const a = new Au();
  const g = a.open(), bufs = [0, 1, 2, 3, 4, 5].map(() => a.buf(240 * 4));
  bufs.forEach(b => a.append(g, b));
  a.c("au_Start", g);
  a.tick(22n * MS);
  assert.equal(a.ev(g).signals, 1);
  assert.deepEqual(a.drain(g), bufs.slice(0, 4));
  assert.equal(a.stat(g, 14), 384);   // 2 ms into the fifth
  // a clock that jumped by 3 s while the process was frozen: not made up
  a.x.audio_set_catchup_limit(100n * MS);
  a.tick(3000n * MS);
  assert.deepEqual(a.drain(g), []); assert.equal(a.stat(g, 7), 0); assert.equal(a.stat(g, 10), 144000);
  a.tick(3n * MS);
  assert.deepEqual(a.drain(g), [bufs[4]]);   // goes on where it was: 3 ms of the fifth were left
  a.tick(99n * MS);                           // below the limit: made up
  assert.deepEqual(a.drain(g), [bufs[5]]); assert.equal(a.stat(g, 7), 1);
});

test("out: Stop of a started output returns every pending buffer, the partly played one too, in order with one signal; Stop of a stopped one keeps what is queued for the next Start", () => {
  // nxnative t_audio_spsc: a partially consumed buffer, queue wraparound, release notification, repeated Stop, buffers queued before Start
  const a = new Au();
  const g = a.open(), b = Array.from({ length: 8 }, () => a.buf(480 * 4));
  for (let round = 0; round < 40; round++) {   // 40 rounds of 5 pass the 64-entry queues' wrap three times
    b.slice(0, 5).forEach(x => assert.equal(a.append(g, x), true));
    a.c("au_Stop", g);                          // already stopped: nothing comes back
    assert.equal(a.released(g), 0); assert.equal(a.c("au_BufCount", g), 5n);
    a.c("au_Start", g);
    a.tick(14n * MS);                           // one played, 4 ms into the second
    const sig = a.ev(g).signals;
    assert.equal(a.stat(g, 14), 4 * 192);
    a.c("au_Stop", g);
    assert.equal(a.c("au_State", g), 1n); assert.equal(a.state(g), "Stopped");
    assert.equal(a.ev(g).signals, sig + 1);
    assert.equal(a.c("au_BufCount", g), 0n); assert.equal(a.stat(g, 14), 0);
    assert.deepEqual(a.drain(g), b.slice(0, 5));
    a.c("au_Stop", g);
    assert.equal(a.ev(g).signals, sig + 1);
    a.tick(30n * MS);
    assert.equal(a.host.nextDeadline(), NEVER);
  }
  assert.match(a.logs.filter(l => /audio #0 (Start|Stop)/.test(l)).at(-1)!, /; not logged from here on$/);
  assert.equal(a.logs.filter(l => /audio #0 (Start|Stop|Close)/.test(l)).length, 32);
  assert.equal(a.red.length, 0);
});

test("out: the pending queue takes 64 buffers and answers false for the 65th; 64 released buffers nobody takes back stop consumption until one is taken", () => {
  const a = new Au();
  const g = a.open(), b = Array.from({ length: 130 }, () => a.buf(48 * 4));
  for (let i = 0; i < 64; i++) assert.equal(a.append(g, b[i]), true);
  assert.equal(a.append(g, b[64]), false);
  assert.equal(a.append(g, 0), false);
  a.c("au_Start", g);
  a.tick(64n * MS);
  assert.equal(a.stat(g, 2), 64);
  for (let i = 64; i < 128; i++) assert.equal(a.append(g, b[i]), true);
  assert.equal(a.append(g, b[128]), false);   // every slot is in flight
  a.tick(10n * MS);
  assert.equal(a.stat(g, 2), 64); assert.equal(a.stat(g, 1), 64);
  assert.match(a.red.at(-1)!, /64 released buffers and the game takes none back: consumption waits/);
  assert.equal(a.host.nextDeadline(), NEVER);
  assert.equal(a.released(g), b[0]);
  a.tick(1n * MS);
  assert.equal(a.stat(g, 2), 64); assert.equal(a.stat(g, 1), 63);
  // the buffer that was played to its end while the queue was full comes back as soon as there is room
  assert.deepEqual(a.drain(g), b.slice(1, 66));
  a.c("au_Close", g);   // the pending ones come back by the stop, and go with the output
  assert.equal(a.red.length, 1); assert.equal(a.x.kit_refused_total(), 0);
});

test("out: volume is kept per output and read back; a negative or NaN volume is 0", () => {
  const a = new Au();
  const g = a.open(), h = a.open();
  assert.equal(a.call("au_GetVol", [g]).f, 1);
  a.call("au_SetVol", [g], { f0: 0.25 });
  assert.deepEqual([a.call("au_GetVol", [g]).f, a.call("au_GetVol", [h]).f], [0.25, 1]);
  assert.equal(a.call("au_GetVol", [g]).kind, 4);
  a.call("au_SetVol", [g], { f0: -3 }); assert.equal(a.call("au_GetVol", [g]).f, 0);
  a.call("au_SetVol", [g], { f0: NaN }); assert.equal(a.call("au_GetVol", [g]).f, 0);
});

test("machine audio_out: Start, the first device callback, a stall, the retry, a refused start, a start with no callback, the browser taking the device, hide and show, Stop from every state", () => {
  const a = new Au();
  a.attach(48000);
  const g = a.open();
  const feed = () => { while (a.stat(g, 1) < 8) a.append(g, a.buf(240 * 4)); a.drain(g); };
  // Stopped -Start-> SilentStarting: the device is asked, the silent sink consumes meanwhile
  feed(); a.c("au_Start", g);
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.devStarts, 1);
  a.dev(DEV.STARTING);                           // an AudioContext waiting for a gesture: for as long as it takes
  for (let i = 0; i < 1000; i++) { feed(); a.tick(5n * MS); }
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.stat(g, 4), 1000);   // 5 s: a thousand 5 ms buffers
  // SilentStarting -DeviceCallback-> Live
  a.dev(DEV.RUNNING); a.tick(MS); assert.equal(a.state(g), "SilentStarting");
  a.callback(); a.tick(MS);
  assert.equal(a.state(g), "Live");
  // Live: the device paces
  for (let i = 0; i < 100; i++) { feed(); a.play(5); }
  assert.equal(a.state(g), "Live"); assert.equal(a.stat(g, 7), 0);
  // Live -Stall-> SilentRetry after 200 ms without a callback
  for (let i = 0; i < 40; i++) { feed(); a.tick(5n * MS); }
  assert.equal(a.state(g), "Live");
  feed(); a.tick(5n * MS);
  assert.equal(a.state(g), "SilentRetry");
  assert.match(a.red.at(-1)!, /^\[RED\] audio #0: the device has not called back for 200 ms while playing: the silent sink stands in, retrying the device in 1 s$/);
  // SilentRetry -RetryDue-> SilentStarting after 1 s; the silent sink consumed the whole time
  const rel = a.stat(g, 4);
  for (let i = 0; i < 199; i++) { feed(); a.tick(5n * MS); }
  assert.equal(a.state(g), "SilentRetry"); assert.equal(a.devStarts, 1);
  feed(); a.tick(5n * MS);
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.devStarts, 2);
  assert.equal(a.stat(g, 4) - rel, 200);
  // SilentStarting -StartTimeout-> SilentRetry: the device says it runs and delivers nothing for 1 s; backoff 2 s
  for (let i = 0; i < 200; i++) { feed(); a.tick(5n * MS); }
  assert.equal(a.state(g), "SilentRetry"); assert.equal(a.stat(g, 11) & 15, 2);
  // ... 2 s later the next attempt, which the device refuses: SilentStarting -StartFailed-> SilentRetry, backoff 4 s
  for (let i = 0; i < 400; i++) { feed(); a.tick(5n * MS); }
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.devStarts, 3);
  a.dev(DEV.FAILED); a.tick(MS);
  assert.equal(a.state(g), "SilentRetry"); assert.equal(a.stat(g, 11) & 15, 3);
  // 4 s, then 8 s, then 8 s again
  for (const [wait, idx] of [[4000, 4], [8000, 4], [8000, 4]]) {
    for (let i = 0; i < wait / 5 - 1; i++) { feed(); a.tick(5n * MS); }
    assert.equal(a.state(g), "SilentRetry");
    feed(); a.tick(5n * MS); assert.equal(a.state(g), "SilentStarting");
    a.dev(DEV.FAILED); a.tick(0n); assert.equal(a.state(g), "SilentRetry"); assert.equal(a.stat(g, 11) & 15, idx);
  }
  assert.equal(a.red.length, 1);   // only the first failure of a run of failures is red
  // the device comes back: Live, and the backoff is forgotten
  for (let i = 0; i < 1600; i++) { feed(); a.tick(5n * MS); }
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS);
  assert.equal(a.state(g), "Live");
  assert.match(a.logs.at(-1)!, /^audio #0: the device plays again$/);
  // Live -DeviceLost-> SilentRetry: the browser suspended the context
  a.dev(DEV.LOST); a.tick(MS);
  assert.equal(a.state(g), "SilentRetry"); assert.equal(a.stat(g, 11) & 15, 1);
  assert.match(a.red.at(-1)!, /the browser took the device away/);
  // SilentRetry -Suspend-> Suspended -Resume-> SilentStarting
  const stops = a.devStops;
  a.x.audio_suspend(1);
  assert.equal(a.state(g), "Suspended"); assert.equal(a.devStops, stops + 1); assert.equal(a.c("au_State", g), 0n);
  const r0 = a.stat(g, 4);
  for (let i = 0; i < 100; i++) { feed(); a.tick(5n * MS); }
  assert.equal(a.stat(g, 4) - r0, 100);   // the silent sink keeps the game's pace while hidden
  a.x.audio_suspend(0);
  assert.equal(a.state(g), "SilentStarting"); assert.equal(a.stat(g, 11) & 15, 0);
  // SilentStarting -Suspend-> Suspended, Suspended -Stop-> Stopped, Stopped -StartHidden-> Suspended
  a.x.audio_suspend(1); assert.equal(a.state(g), "Suspended");
  a.c("au_Stop", g); assert.equal(a.state(g), "Stopped");
  const ds = a.devStarts;
  a.c("au_Start", g); assert.equal(a.state(g), "Suspended"); assert.equal(a.devStarts, ds);
  a.x.audio_suspend(0); assert.equal(a.state(g), "SilentStarting"); assert.equal(a.devStarts, ds + 1);
  // Live -Suspend-> Suspended
  a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS); assert.equal(a.state(g), "Live");
  a.x.audio_suspend(1); assert.equal(a.state(g), "Suspended");
  a.x.audio_suspend(0); a.dev(DEV.RUNNING); a.tick(MS); a.callback(); a.tick(MS); assert.equal(a.state(g), "Live");
  // Stop from Live, SilentStarting, SilentRetry
  const st = a.devStops;
  a.c("au_Stop", g); assert.equal(a.state(g), "Stopped"); assert.equal(a.devStops, st + 1);   // nobody wants the device any more
  a.c("au_Start", g); a.c("au_Stop", g); assert.equal(a.state(g), "Stopped");
  a.c("au_Start", g); a.dev(DEV.FAILED); a.tick(MS); assert.equal(a.state(g), "SilentRetry");
  a.c("au_Stop", g); assert.equal(a.state(g), "Stopped");
  assert.equal(a.x.kit_refused_total(), 0);
});

test("machine audio_buf: appended, played to the end, flushed unplayed and partly played by a Stop, taken back, dropped by a Close", () => {
  const a = new Au();
  const g = a.open(), slot = a.slotOf(g);
  const states = () => { const n = [0, 0, 0, 0]; for (let s = 0; s < 128; s++) n[a.x.audio_buf_state(slot, s)]++; return n; };   // Reclaimed, Appended, Playing, Released
  assert.deepEqual(states(), [128, 0, 0, 0]);
  const b = [0, 1, 2, 3].map(() => a.buf(240 * 4));
  b.forEach(x => a.append(g, x));
  assert.deepEqual(states(), [124, 4, 0, 0]);
  a.c("au_Start", g); a.tick(MS);
  assert.deepEqual(states(), [124, 3, 1, 0]);    // Play
  a.tick(5n * MS);
  assert.deepEqual(states(), [124, 2, 1, 1]);    // Finish, and the next one plays
  a.c("au_Stop", g);
  assert.deepEqual(states(), [124, 0, 0, 4]);    // Flush of the playing one and the two untouched
  assert.equal(a.released(g), b[0]);
  assert.deepEqual(states(), [125, 0, 0, 3]);    // Reclaim
  a.c("au_Close", g);                            // Drop
  assert.equal(a.x.kit_refused_total(), 0);
  // a buffer of no bytes is released as soon as the consumer reaches it
  const g2 = a.open(); a.c("au_Start", g2);
  const z = a.buf(0), n = a.buf(48 * 4);
  a.append(g2, z); a.append(g2, n);
  a.tick(0n);
  assert.equal(a.released(g2), z);
  a.tick(MS); assert.equal(a.released(g2), n);
});

test("out: with a device the ring header says where the device is: rate, target, capacity; nothing is mixed before an output is Live", () => {
  const a = new Au();
  a.attach(44100, 0);
  assert.deepEqual([a.ring[RING.CAP], a.ring[RING.RATE], a.ring[RING.TARGET], a.ring[RING.LIVE]], [8192, 44100, 1764, 0]);
  const g = a.open(); a.append(g, a.buf(sine(440, 4800)));
  a.c("au_Start", g); a.dev(DEV.RUNNING); a.tick(MS);
  assert.equal(a.ring[RING.WR], 0);
  a.callback(); a.tick(MS);
  assert.equal(a.state(g), "Live");
  assert.deepEqual([a.ring[RING.WR], a.ring[RING.LIVE]], [1764, 1]);
  assert.match(a.logs.find(l => l.includes("OpenAudioOut"))!, /device at 44100 Hz/);
});
