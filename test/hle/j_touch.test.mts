// The touch screen and the gesture recognizer (src/hle/touch.ts, port of nxnative dm/host/hle_touch.c), read through
// the hid take-overs GetTouchScreenState<N> / GetTouchScreenStates<N> / GetGestureStates in handheld mode.
// First nxnative's dm/host/tests/t_touch.c and t_gesture.c, check for check; then the layouts and the modes; then
// random touch sequences run through hle_touch.c itself, compiled with cc (test/hle/ref/touch_ref.c).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, Hle, ROOT, NXNATIVE } from "./harness.mts";

const TOUCH1 = (n: number) => `_ZN2nn3hid19GetTouchScreenStateILm${n}EEEvPNS0_16TouchScreenStateIXT_EEE`;
const TOUCHN = (n: number) => `_ZN2nn3hid20GetTouchScreenStatesILm${n}EEEiPNS0_16TouchScreenStateIXT_EEEi`;
type Pt = { id: number; x: number; y: number };
function handheld(): Hle { const h = new Hle(); h.host.config({ opmode: 0 }); return h; }
const set = (h: Hle, t: Pt[]) => { h.host.input(0, { touches: t }); };

interface Want { dt: bigint; attr: number; fid: number; x: number; y: number }
function expectState(h: Hle, what: string, now: bigint, samp: bigint, w: Want[]) {
  const out = h.alloc(0x290 + 32, 0xEE) + 16, exp = Buffer.alloc(0x290);
  h.monoNs = now;
  h.call(TOUCH1(16), out);
  exp.writeBigInt64LE(samp, 0); exp.writeInt32LE(w.length, 8);
  w.forEach((p, i) => { const s = 0x10 + 0x28 * i; exp.writeBigInt64LE(p.dt, s); exp.writeUInt32LE(p.attr, s + 8); exp.writeInt32LE(p.fid, s + 0xc); exp.writeInt32LE(p.x, s + 0x10); exp.writeInt32LE(p.y, s + 0x14); exp.writeInt32LE(30, s + 0x18); exp.writeInt32LE(30, s + 0x1c); });
  assert.deepEqual(h.read(out, 0x290), exp, what);
  assert.ok(h.read(out - 16, 16).every(b => b === 0xEE) && h.read(out + 0x290, 16).every(b => b === 0xEE), `${what}: nothing outside the 0x290 bytes`);
}

test("touch (t_touch.c): TouchScreenState<16> byte for byte: Start, move, End, the short-press latch, clamping, id order, a re-press", () => {
  const h = handheld(), T0 = 1000000000n, D = 16666667n;
  set(h, [{ id: 2, x: 0.5, y: 0.25 }]);
  expectState(h, "press reports Start (640, 180)", T0, 1n, [{ dt: 0n, attr: 1, fid: 2, x: 640, y: 180 }]);
  set(h, [{ id: 2, x: 0.75, y: 0.5 }]);
  expectState(h, "move attribute 0 (960, 360), delta_time is the interval between two reads", T0 + D, 2n, [{ dt: D, attr: 0, fid: 2, x: 960, y: 360 }]);
  set(h, []);
  expectState(h, "lift reports End (960, 360)", T0 + 2n * D, 3n, [{ dt: D, attr: 2, fid: 2, x: 960, y: 360 }]);
  expectState(h, "0 touch points after End", T0 + 3n * D, 4n, []);
  set(h, [{ id: 0, x: 0.1, y: 0.1 }]); set(h, []);
  expectState(h, "short-press latch: Start first (128, 72)", T0 + 4n * D, 5n, [{ dt: D, attr: 1, fid: 0, x: 128, y: 72 }]);
  expectState(h, "short-press latch: then End", T0 + 5n * D, 6n, [{ dt: D, attr: 2, fid: 0, x: 128, y: 72 }]);
  expectState(h, "empty after the short-press latch", T0 + 6n * D, 7n, []);
  set(h, [{ id: 3, x: 0.9999, y: 1.5 }, { id: 4, x: -0.2, y: -1.0 }]);
  expectState(h, "coordinates clamped to [0,1279] x [0,719]", T0 + 7n * D, 8n, [{ dt: D, attr: 1, fid: 3, x: 1279, y: 719 }, { dt: D, attr: 1, fid: 4, x: 0, y: 0 }]);
  set(h, []); const scratch = h.alloc(0x290); h.monoNs = T0 + 8n * D; h.call(TOUCH1(16), scratch);   // sample 9: two End
  expectState(h, "empty after both Ends", T0 + 9n * D, 10n, []);
  set(h, [{ id: 5, x: 0.25, y: 0.5 }, { id: 1, x: 0.5, y: 0.75 }]);
  expectState(h, "multiple fingers in ascending id order (1:(640,540) 5:(320,360))", T0 + 10n * D, 11n, [{ dt: D, attr: 1, fid: 1, x: 640, y: 540 }, { dt: D, attr: 1, fid: 5, x: 320, y: 360 }]);
  set(h, []); h.monoNs = T0 + 11n * D; h.call(TOUCH1(16), scratch); h.monoNs = T0 + 12n * D; h.call(TOUCH1(16), scratch);   // samples 12 (two End), 13 (empty)
  set(h, [{ id: 3, x: 0.25, y: 0.25 }]);
  expectState(h, "before the re-press: Start (320, 180)", T0 + 13n * D, 14n, [{ dt: D, attr: 1, fid: 3, x: 320, y: 180 }]);
  set(h, []); set(h, [{ id: 3, x: 0.5, y: 0.5 }]);
  expectState(h, "re-press: the old End first (320, 180)", T0 + 14n * D, 15n, [{ dt: D, attr: 2, fid: 3, x: 320, y: 180 }]);
  expectState(h, "re-press: then the new Start (640, 360)", T0 + 15n * D, 16n, [{ dt: D, attr: 1, fid: 3, x: 640, y: 360 }]);
  assert.deepEqual(h.red, []);
});

test("touch: every finger state, the sizes of TouchScreenState<1..16>, the count of GetTouchScreenStates, and no touches when docked", () => {
  const h = handheld(), buf = h.alloc(0x290 + 32, 0xEE) + 16;
  const read = (n: number, fn = TOUCH1(n), ...more: number[]) => { h.u8.fill(0xEE, buf - 16, buf + 0x290 + 16); const r = h.w0(fn, buf, ...more); return { r, count: h.i32(buf + 8), attr: (i: number) => h.u32(buf + 0x10 + 0x28 * i + 8), id: (i: number) => h.i32(buf + 0x10 + 0x28 * i + 0xc) }; };
  // a finger lifted before its Start was read and pressed again before any read: held down all along (one Start)
  set(h, [{ id: 7, x: 0.5, y: 0.5 }]); set(h, []); set(h, [{ id: 7, x: 0.25, y: 0.5 }]);
  let s = read(16); assert.deepEqual([s.count, s.attr(0), h.i32(buf + 0x10 + 0x10)], [1, 1, 320], "Start at the newest point");
  s = read(16); assert.deepEqual([s.count, s.attr(0)], [1, 0]);
  // lifted, pressed again and lifted again before End went out: the re-press is dropped, one End
  set(h, []); set(h, [{ id: 7, x: 0.75, y: 0.5 }]); set(h, [{ id: 7, x: 0.875, y: 0.5 }]); set(h, []);
  s = read(16); assert.deepEqual([s.count, s.attr(0), h.i32(buf + 0x10 + 0x10)], [1, 2, 320], "End at the point it lifted from");
  assert.equal(read(16).count, 0);
  // the sizes: TouchScreenState<N> is 0x10 + 0x28 * N bytes, and fingers beyond N wait for a later read
  for (let n = 1; n <= 16; n++) {
    set(h, [{ id: 1, x: 0.1, y: 0.1 }, { id: 2, x: 0.2, y: 0.2 }, { id: 9, x: 0.3, y: 0.3 }]);
    s = read(n);
    const size = 0x10 + 0x28 * n;
    assert.equal(s.count, Math.min(n, 3), `TouchScreenState<${n}>`);
    assert.ok(h.read(buf + size, 16).every(b => b === 0xEE) && h.read(buf - 16, 16).every(b => b === 0xEE), `TouchScreenState<${n}> writes ${size} bytes`);
    if (n === 1) { assert.deepEqual([s.id(0), s.attr(0)], [1, 1]); s = read(1); assert.deepEqual([s.id(0), s.attr(0)], [1, 0], "the first finger again; the others have not been reported yet"); s = read(3); assert.deepEqual([s.attr(0), s.attr(1), s.attr(2)], [0, 1, 1], "their Start is not used up"); }
    set(h, []); read(16); read(16);
  }
  // GetTouchScreenStates<N>(out, n): one entry, 0 for n <= 0
  set(h, [{ id: 4, x: 0.5, y: 0.5 }]);
  s = read(4, TOUCHN(4), 16); assert.deepEqual([s.r, s.count], [1, 1]);
  s = read(4, TOUCHN(4), 0); assert.equal(s.r, 0); assert.equal(h.u8[buf], 0xEE, "n <= 0 writes nothing");
  s = read(4, TOUCHN(4), -1 >>> 0); assert.equal(s.r, 0);
  // console mode: the screen is out of reach; only the header is written, with an npad sampling number
  h.host.setOpmode(1);
  h.u8.fill(0xEE, buf, buf + 0x290);
  h.call(TOUCH1(16), buf);
  assert.ok(h.i64(buf) > 65536n, "an npad sampling number"); assert.deepEqual([h.i32(buf + 8), h.i32(buf + 12)], [0, 0]);
  assert.ok(h.read(buf + 16, 0x280).every(b => b === 0xEE), "docked: nothing but the header");
  const g = h.alloc(0x60 * 4, 0xEE);
  assert.equal(h.w0("_ZN2nn3hid16GetGestureStatesEPNS0_12GestureStateEi", g, 4), 0, "docked: no gestures"); assert.equal(h.u8[g], 0xEE);
  h.host.setOpmode(0);
  assert.equal(read(16).count, 1, "back in handheld mode the finger is there");
  assert.equal(h.w0("_ZN2nn3hid21InitializeTouchScreenEv"), 0); h.call("_ZN2nn3hid21InitializeTouchScreenEii", 1, 2); h.call("_ZN2nn3hid17InitializeGestureEv");
  // touches of another player's snapshot are not the screen's
  h.host.input(1, { touches: [{ id: 0, x: 0.5, y: 0.5 }, { id: 4, x: 0.5, y: 0.5 }] });
  assert.equal(read(16).count, 1, "only player 1's snapshot carries the screen");
  // ids past 15 are ignored
  set(h, [{ id: 16, x: 0.5, y: 0.5 }]); s = read(16); assert.deepEqual([s.count, s.attr(0)], [1, 2], "id 16 is no finger: the one that was down lifted");
});

// ---------- gestures (t_gesture.c) ----------
const [IDLE, COMPLETE, CANCEL, TOUCH, PRESS, TAP, PAN, SWIPE, PINCH, ROTATE] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const NEW = 1 << 4, DOUBLE = 1 << 8;
interface G { samp: bigint; ctx: bigint; type: number; dir: number; x: number; y: number; dx: number; dy: number; vx: number; vy: number; attr: number; scale: number; rot: number; npt: number; pt: number[][] }
function gestures(h: Hle, t: bigint, n = 16): G[] {
  const p = h.alloc(0x60 * n + 32, 0xCC) + 16;
  h.monoNs = t;
  const k = h.w0("_ZN2nn3hid16GetGestureStatesEPNS0_12GestureStateEi", p, n);
  assert.ok(h.read(p + 0x60 * k, 16).every(b => b === 0xCC) && h.read(p - 16, 16).every(b => b === 0xCC), "nothing outside the entries returned");
  return Array.from({ length: k }, (_, i) => { const e = p + 0x60 * i; return { samp: h.i64(e), ctx: h.i64(e + 8), type: h.i32(e + 16), dir: h.i32(e + 20), x: h.i32(e + 24), y: h.i32(e + 28), dx: h.i32(e + 32), dy: h.i32(e + 36),
    vx: h.f32(e + 40), vy: h.f32(e + 44), attr: h.u32(e + 48), scale: h.f32(e + 52), rot: h.f32(e + 56), npt: h.i32(e + 60), pt: [0, 1, 2, 3].map(q => [h.i32(e + 64 + 8 * q), h.i32(e + 68 + 8 * q)]) }; });
}

test("gestures (t_gesture.c): tap, double tap, slop, pan, swipe, press, finger count change, pinch, a tap between reads", () => {
  const h = handheld(), S = 1000000000n, MS = 1000000n;
  let g: G[] = [];
  const rd = (t: bigint) => { g = gestures(h, t); };
  const newest = (what: string, samp: number, ctx: number, type: number, x: number, y: number, dx: number, dy: number, attr: number, dir: number, npt: number) => {
    assert.ok(g.length > 0, what); const e = g[0];
    assert.deepEqual([e.samp, e.ctx, e.type, e.x, e.y, e.dx, e.dy, e.attr, e.dir, e.npt], [BigInt(samp), BigInt(ctx), type, x, y, dx, dy, attr, dir, npt], what);
  };
  const one = (x: number, y: number) => set(h, [{ id: 0, x, y }]), up = () => set(h, []);
  rd(1n * S); assert.equal(g.length, 0, "no touch yet: no entries");
  one(0.5, 0.5); rd(1n * S);
  newest("tap: Touch (640,360), IsNewTouch", 1, 1, TOUCH, 640, 360, 0, 0, NEW, 0, 1);
  rd(1n * S + 16n * MS); assert.ok(g.length === 1 && g[0].samp === 1n, "tap: a read with nothing changed adds no entry");
  up(); rd(1n * S + 33n * MS); newest("tap: Tap (640,360)", 2, 1, TAP, 640, 360, 0, 0, 0, 0, 1);
  assert.ok(g.length === 2 && g[1].samp === 1n && g[1].type === TOUCH, "tap: entries newest first (Tap, then Touch)");
  rd(1n * S + 50n * MS); newest("tap: Complete", 3, 1, COMPLETE, 0, 0, 0, 0, 0, 0, 0);
  rd(1n * S + 66n * MS); newest("tap: Idle, next context", 4, 2, IDLE, 0, 0, 0, 0, 0, 0, 0);
  rd(1n * S + 83n * MS); assert.ok(g.length === 4 && g[0].samp === 4n, "tap: nothing more after Idle");
  one(0.5, 0.5); rd(1n * S + 100n * MS); newest("double tap: Touch", 5, 3, TOUCH, 640, 360, 0, 0, NEW, 0, 1);
  up(); rd(1n * S + 116n * MS); newest("double tap: Tap with IsDoubleTap", 6, 3, TAP, 640, 360, 0, 0, DOUBLE, 0, 1);
  rd(1n * S + 133n * MS); rd(1n * S + 150n * MS); newest("double tap: Complete, then Idle", 8, 4, IDLE, 0, 0, 0, 0, 0, 0, 0);
  one(0.25, 0.25); rd(2n * S); newest("slop: Touch (320,180)", 9, 5, TOUCH, 320, 180, 0, 0, NEW, 0, 1);
  one(0.25390625, 0.25); rd(2n * S + 16n * MS); assert.ok(g.length > 0 && g[0].samp === 9n, "slop: a 5 px move adds no entry");
  up(); rd(2n * S + 33n * MS); newest("slop: Tap at the down point (320,180), not a double tap (0.9 s later)", 10, 5, TAP, 320, 180, 0, 0, 0, 0, 1);
  rd(2n * S + 50n * MS); rd(2n * S + 66n * MS); newest("slop: Complete, then Idle", 12, 6, IDLE, 0, 0, 0, 0, 0, 0, 0);
  one(0.5, 0.5); rd(3n * S); newest("slow pan: Touch", 13, 7, TOUCH, 640, 360, 0, 0, NEW, 0, 1);
  one(0.515625, 0.5); rd(3n * S + 100n * MS); newest("slow pan: Pan (660,360) delta (20,0)", 14, 7, PAN, 660, 360, 20, 0, 0, 0, 1);
  assert.ok(g[0].vx > 199.9 && g[0].vx < 200.1 && g[0].vy === 0, "slow pan: velocity 200 px/s");
  up(); rd(3n * S + 200n * MS); newest("slow pan: released at 100 px/s -> Complete", 15, 7, COMPLETE, 0, 0, 0, 0, 0, 0, 0);
  rd(3n * S + 216n * MS); newest("slow pan: Idle", 16, 8, IDLE, 0, 0, 0, 0, 0, 0, 0);
  one(0.5, 0.5); rd(4n * S); newest("swipe: Touch", 17, 9, TOUCH, 640, 360, 0, 0, NEW, 0, 1);
  one(0.4375, 0.5); rd(4n * S + 16n * MS); newest("swipe: Pan (560,360) delta (-80,0)", 18, 9, PAN, 560, 360, -80, 0, 0, 0, 1);
  up(); rd(4n * S + 32n * MS); newest("swipe: Swipe left (560,360) delta (-80,0)", 19, 9, SWIPE, 560, 360, -80, 0, 0, 1, 1);
  assert.ok(g[0].vx < -2499.0 && g[0].vx > -2501.0, "swipe: velocity -2500 px/s");
  rd(4n * S + 48n * MS); rd(4n * S + 64n * MS); newest("swipe: Complete, then Idle", 21, 10, IDLE, 0, 0, 0, 0, 0, 0, 0);
  assert.ok(g.length === 16 && g[15].samp === 6n, "16 entries kept, newest first");
  one(0.5, 0.5); rd(5n * S); newest("press: Touch", 22, 11, TOUCH, 640, 360, 0, 0, NEW, 0, 1);
  rd(5n * S + 400n * MS); assert.equal(g[0].samp, 22n, "press: not yet at 0.4 s");
  rd(5n * S + 600n * MS); newest("press: Press after 0.5 s", 23, 11, PRESS, 640, 360, 0, 0, 0, 0, 1);
  up(); rd(5n * S + 700n * MS); newest("press: released -> Complete, no Tap", 24, 11, COMPLETE, 0, 0, 0, 0, 0, 0, 0);
  rd(5n * S + 716n * MS); newest("press: Idle", 25, 12, IDLE, 0, 0, 0, 0, 0, 0, 0);
  one(0.25, 0.5); rd(6n * S); newest("count change: Touch of one finger (320,360)", 26, 13, TOUCH, 320, 360, 0, 0, NEW, 0, 1);
  const two = [{ id: 0, x: 0.25, y: 0.5 }, { id: 1, x: 0.75, y: 0.5 }]; set(h, two);
  rd(6n * S + 16n * MS); newest("count change: Cancel", 27, 13, CANCEL, 0, 0, 0, 0, 0, 0, 0);
  rd(6n * S + 33n * MS); newest("count change: Touch of two fingers, mid point (640,360), no IsNewTouch after Cancel", 28, 14, TOUCH, 640, 360, 0, 0, 0, 0, 2);
  assert.ok(g[0].pt[0][0] === 320 && g[0].pt[1][0] === 960, "count change: points in finger id order");
  up(); rd(6n * S + 50n * MS); newest("count change: released -> Cancel, no Tap", 29, 14, CANCEL, 0, 0, 0, 0, 0, 0, 0);
  rd(6n * S + 66n * MS); newest("count change: Idle", 30, 15, IDLE, 0, 0, 0, 0, 0, 0, 0);
  set(h, [{ id: 0, x: 0.375, y: 0.5 }, { id: 1, x: 0.625, y: 0.5 }]);
  rd(7n * S); newest("pinch: Touch of two fingers", 31, 16, TOUCH, 640, 360, 0, 0, NEW, 0, 2);
  set(h, two); rd(7n * S + 16n * MS); newest("pinch: Pinch (640,360)", 32, 16, PINCH, 640, 360, 0, 0, 0, 0, 2);
  assert.ok(g[0].scale > 1.999 && g[0].scale < 2.001, "pinch: scale 2");
  up(); rd(7n * S + 33n * MS); newest("pinch: released -> Complete", 33, 16, COMPLETE, 0, 0, 0, 0, 0, 0, 0);
  rd(7n * S + 50n * MS); one(0.5, 0.5); up();
  rd(8n * S); newest("between reads: Touch", 35, 18, TOUCH, 640, 360, 0, 0, NEW, 0, 1);
  rd(8n * S + 16n * MS); newest("between reads: Tap", 36, 18, TAP, 640, 360, 0, 0, 0, 0, 1);
  // beyond t_gesture.c: two fingers turning about their mid point: Rotate, in degrees, with no scale
  rd(8n * S + 33n * MS); rd(8n * S + 50n * MS);
  set(h, [{ id: 0, x: 0.375, y: 0.5 }, { id: 1, x: 0.625, y: 0.5 }]); rd(9n * S);
  set(h, [{ id: 0, x: 0.4, y: 0.35 }, { id: 1, x: 0.6, y: 0.65 }]); rd(9n * S + 16n * MS);
  assert.equal(g[0].type, ROTATE); assert.equal(g[0].scale, 0); assert.ok(Math.abs(g[0].rot) > 1, `rotation in degrees: ${g[0].rot}`);
  assert.equal(gestures(h, 9n * S + 20n * MS, 3).length, 3, "a smaller buffer gets the newest"); assert.equal(h.w0("_ZN2nn3hid16GetGestureStatesEPNS0_12GestureStateEi", 0, 0), 0);
  assert.deepEqual(h.red, []);
});

// ---------- against hle_touch.c compiled with cc ----------
function reference(): string | null {
  const src = join(NXNATIVE, "dm", "host", "hle_touch.c"), dir = join(ROOT, "build", "hle", "touch_ref"), exe = join(dir, "touch_ref");
  if (!existsSync(src)) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hle_touch.c"), readFileSync(src));
  writeFileSync(join(dir, "dm.h"), "#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#define LOG(...) ((void)0)\n");
  writeFileSync(join(dir, "front.h"), "#include <stdint.h>\ntypedef struct { uint32_t id; float x, y; } dm_touch;\nvoid dm_touch_set(const dm_touch *t, int n);\nvoid dm_touch_script(const dm_touch *t, int n);\n");
  try { execFileSync("cc", ["-O1", "-ffp-contract=off", "-D_GNU_SOURCE", "-w", "-o", exe, join(ROOT, "test", "hle", "ref", "touch_ref.c"), join(dir, "hle_touch.c"), "-lm", "-lpthread"], { stdio: "pipe" }); return exe; } catch { return null; }
}

test("touch and gestures: random touch sequences give the bytes of nxnative's hle_touch.c compiled with cc", () => {
  const exe = reference();
  if (!exe) { console.log("     hle_touch.c or cc not found: the comparison with the C code was NOT made"); assert.ok(!process.env.HLE_REQUIRE_CC, "cc is required"); return; }
  let seed = 99;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const hexf = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readUInt32LE(0).toString(16); };
  type Op = { line: string; pts?: Pt[]; kind: "t" | "f" | "g"; n?: number; now?: bigint };
  const ops: Op[] = [];
  let now = 1000000000n, pts: Pt[] = [];
  for (let i = 0; i < 6000; i++) {
    const r = rnd();
    if (r < 0.45) {
      // fingers come, go and move: by pixels (within and beyond the slop), sometimes off the panel, sometimes a bad id
      if (rnd() < 0.2) pts = pts.filter(() => rnd() < 0.5);
      if (rnd() < 0.25 && pts.length < 5) { const id = rnd() < 0.05 ? 16 + Math.trunc(rnd() * 3) : Math.trunc(rnd() * (rnd() < 0.8 ? 3 : 16)); if (!pts.some(p => p.id === id)) pts.push({ id, x: Math.fround(rnd() * 1.2 - 0.1), y: Math.fround(rnd() * 1.2 - 0.1) }); }
      pts = pts.map(p => rnd() < 0.5 ? p : { id: p.id, x: Math.fround(p.x + (rnd() - 0.5) * (rnd() < 0.5 ? 0.008 : 0.2)), y: Math.fround(p.y + (rnd() - 0.5) * (rnd() < 0.5 ? 0.008 : 0.2)) });
      if (rnd() < 0.1) pts = [];
      ops.push({ kind: "t", pts: [...pts], line: `t ${pts.length} ${pts.map(p => `${p.id} ${hexf(p.x)} ${hexf(p.y)}`).join(" ")}` });
    } else {
      now += BigInt(Math.trunc(rnd() < 0.1 ? rnd() * 700e6 : rnd() * 20e6));
      if (r < 0.7) { const n = rnd() < 0.7 ? 16 : Math.trunc(rnd() * 19) - 1; ops.push({ kind: "f", n, now, line: `f ${n} ${now}` }); }
      else { const n = rnd() < 0.7 ? 16 : Math.trunc(rnd() * 20) - 1; ops.push({ kind: "g", n, now, line: `g ${n} ${now}` }); }
    }
  }
  const out = execFileSync(exe, { input: ops.map(o => o.line).join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n");
  const h = handheld(), buf = h.alloc(0x60 * 32 + 64, 0xEE) + 16;
  let line = 0, states = 0, entries = 0, inexact = 0;
  const kinds = new Set<number>();
  for (const op of ops) {
    if (op.kind === "t") { set(h, op.pts!); continue; }
    const [tag, k, bytes = ""] = out[line++].split(" ");
    h.monoNs = op.now!;
    if (op.kind === "f") {
      // touch_fill_n takes any max (clamped to 1..16); the take-overs exist for 1..16, so the test uses the clamped one
      const n = Math.max(1, Math.min(16, op.n!));
      h.call(TOUCH1(n), buf);
      assert.equal(tag, "F"); assert.equal(h.i32(buf + 8), Number(k), `count at ${op.line}`);
      assert.equal(h.read(buf, 0x10 + 0x28 * n).toString("hex"), bytes, `TouchScreenState<${n}> at ${op.line}`);
      states++;
    } else {
      const n = op.n!, got = h.w0("_ZN2nn3hid16GetGestureStatesEPNS0_12GestureStateEi", buf, n >>> 0);
      assert.equal(tag, "G"); assert.equal(got, Number(k), `count at ${op.line}`);
      const want = Buffer.from(bytes, "hex"), have = h.read(buf, 0x60 * got);
      for (let e = 0; e < got; e++) {
        const w = want.subarray(0x60 * e, 0x60 * e + 0x60), g = have.subarray(0x60 * e, 0x60 * e + 0x60);
        kinds.add(w.readInt32LE(16)); entries++;
        if (w.equals(g)) continue;
        // only the scale (a quotient of hypotf sums) and the rotation (atanf of atan2f differences) may differ in a last place
        inexact++;
        for (let o = 0; o < 0x60; o += 4) {
          if (o === 52 || o === 56) { const a = g.readFloatLE(o), b = w.readFloatLE(o); assert.ok(Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b)), `entry ${e} at ${op.line}: float at +${o} is ${a}, C has ${b}`); }
          else assert.equal(g.readUInt32LE(o), w.readUInt32LE(o), `entry ${e} at ${op.line}: the word at +0x${o.toString(16)}`);
        }
      }
    }
  }
  assert.equal(line, out.length);
  assert.deepEqual([...kinds].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "every gesture type came up");
  console.log(`     ${states} touch screen states byte for byte and ${entries} gesture entries (${entries - inexact} byte for byte, ${inexact} with scale or rotation in the last place) against hle_touch.c compiled with cc`);
});
