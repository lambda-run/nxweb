// The touch screen and the gesture recognizer: port of nxnative dm/host/hle_touch.c (no table entries of its own;
// hid.ts's GetTouchScreenState(s) and GetGestureStates read through it). The embedder pushes the whole set of touch
// points with every snapshot of player 1 (hid.ts hle_input): id 0..15, x and y normalized on the output picture
// (origin top left). The panel is 1280x720: x = nx * 1280 clamped to [0, 1279], y = ny * 720 clamped to [0, 719].
//
// TouchState (0x28 bytes): +0 delta time (ns, i64), +8 attributes (bit 0 Start, bit 1 End), +0xc finger id, +0x10 x,
// +0x14 y, +0x18 diameter x, +0x1c diameter y, +0x20 rotation angle, +0x24 reserved.
// TouchScreenState<N>: +0 sampling number, +8 touch count, N TouchStates from +0x10.
// A finger is reported once as Start and, after it lifted, once as End (machine touch_finger, 16 instances).
//
// Gestures: the rules are yuzu's (hid_core gesture_handler.cpp) as nxnative took them: a new touch is Touch
// (IsNewTouch, unless the entry before is Cancel), one held still for 0.5 s becomes Press, a moving one Pan (delta
// from the last entry's position, velocity over the time since it), two or more fingers whose spread changes by more
// than 0.5 px Pinch (scale = new / old spread) or whose angle turns more than 0.015 rad Rotate (degrees), a change in
// the finger count Cancel. On release Touch becomes Tap (IsDoubleTap within 0.35 s of the last tap), Pan becomes
// Swipe above 400 px/s or Complete, the others Complete; an Idle entry follows a Complete or a Cancel. A gesture
// stays put until a finger has moved GESTURE_SLOP pixels from where it went down. Sampled at each read.
// GestureState (0x60 bytes): +0 sampling number, +8 context number, +0x10 type, +0x14 direction, +0x18 x, +0x1c y,
// +0x20 delta x, +0x24 delta y, +0x28 velocity x, +0x2c velocity y (px/s), +0x30 attributes (bit 4 IsNewTouch, bit 8
// IsDoubleTap), +0x34 scale, +0x38 rotation angle, +0x3c point count, +0x40 four points (x, y).
// Not ported: DM_TOUCH_LOG.
import { Inst } from "../kit/machine";
import { TOUCH_FINGER, TouchFingerS, TouchFingerE } from "../kit/gen/tables";

const NF: i32 = 16;
const FI: usize = memory.data(256);      // NF Inst
const FP: usize = memory.data(256);      // per finger: f32 x, y, ax, ay
const GF: usize = memory.data(256);      // the recognizer's own view: i32 down, pend; f32 x, y
const SEEN: usize = memory.data(16);
let tsamp: i64 = 0, tlastNs: u64 = 0;

// @ts-ignore: decorator
@inline function fin(i: i32): Inst { return Inst.at(FI + (<usize>i << 4)); }
// @ts-ignore: decorator
@inline function fp(i: i32): usize { return FP + (<usize>i << 4); }
// @ts-ignore: decorator
@inline function gf(i: i32): usize { return GF + (<usize>i << 4); }

// n touch points of 12 bytes { u32 id, f32 x, f32 y }: the whole set that is down now
export function touchApply(t: usize, n: i32): void {
  memory.fill(SEEN, 0, 16);
  for (let i = 0; i < n; i++) {
    const e = t + <usize>i * 12, id = load<u32>(e); if (id >= <u32>NF) continue;
    const x = load<f32>(e, 4), y = load<f32>(e, 8), f = fin(<i32>id), p = fp(<i32>id), g = gf(<i32>id);
    store<u8>(SEEN + <usize>id, 1);
    if (!load<i32>(g)) store<i32>(g, 1, 4);
    store<i32>(g, 1); store<f32>(g, x, 8); store<f32>(g, y, 12);
    if (f.state == TouchFingerS.Lifted || f.state == TouchFingerS.LiftedAgain) {   // pressed again before End went out
      if (f.state == TouchFingerS.Lifted) f.step(TouchFingerE.Press);
      store<f32>(p, x, 8); store<f32>(p, y, 12); continue;
    }
    if (f.state == TouchFingerS.Empty || f.state == TouchFingerS.LiftedNew) f.step(TouchFingerE.Press);   // LiftedNew: held down all along
    store<f32>(p, x); store<f32>(p, y, 4);
  }
  for (let id = 0; id < NF; id++) {
    if (load<u8>(SEEN + <usize>id)) continue;
    store<i32>(gf(id), 0);
    const f = fin(id);
    // LiftedAgain: pressed again and lifted again before End went out: the re-press is dropped, End still goes out
    if (f.state == TouchFingerS.DownNew || f.state == TouchFingerS.Down || f.state == TouchFingerS.LiftedAgain) f.step(TouchFingerE.Lift);
  }
}
function clampi(v: f32, hi: i32): i32 { const r = <i32>(v * <f32>(hi + 1)); return r < 0 ? 0 : r > hi ? hi : r; }
// Fill one TouchScreenState<max> at out (0x10 + 0x28 * max bytes, max 1..16); nowNs is for the delta time. Returns the
// touch count. Fingers beyond max are left for a later read (their Start / End is not used up)
export function touchFillN(out: usize, max: i32, nowNs: u64): i32 {
  if (max < 1) max = 1; else if (max > 16) max = 16;
  memory.fill(out, 0, 0x10 + 0x28 * <usize>max);
  const samp = ++tsamp, dt: i64 = tlastNs ? <i64>(nowNs - tlastNs) : 0; tlastNs = nowNs;
  let k = 0;
  for (let id = 0; id < NF && k < max; id++) {
    const f = fin(id), st = f.state;
    if (st == TouchFingerS.Empty) continue;
    const attr: u32 = st == TouchFingerS.DownNew || st == TouchFingerS.LiftedNew ? 1 : st == TouchFingerS.Lifted || st == TouchFingerS.LiftedAgain ? 2 : 0;
    const s = out + 0x10 + 0x28 * <usize>k, p = fp(id); k++;
    store<i64>(s, dt); store<u32>(s, attr, 8); store<i32>(s, id, 0xc);
    store<i32>(s, clampi(load<f32>(p), 1279), 0x10); store<i32>(s, clampi(load<f32>(p, 4), 719), 0x14); store<i32>(s, 30, 0x18); store<i32>(s, 30, 0x1c);
    f.step(TouchFingerE.Report);
    if (st == TouchFingerS.LiftedAgain) { store<f32>(p, load<f32>(p, 8)); store<f32>(p, load<f32>(p, 12), 4); }   // End went out: the new press, at its own point
  }
  store<i64>(out, samp); store<i32>(out, k, 8);
  return k;
}

// ---------------- gestures ----------------
const GT_IDLE = 0, GT_COMPLETE = 1, GT_CANCEL = 2, GT_TOUCH = 3, GT_PRESS = 4, GT_TAP = 5, GT_PAN = 6, GT_SWIPE = 7, GT_PINCH = 8, GT_ROTATE = 9;
const GD_LEFT = 1, GD_UP = 2, GD_RIGHT = 3, GD_DOWN = 4;
const GESTURE_SLOP: i32 = 8;
const PROPS: usize = 52;                 // i32 n, i32 pt[4][2] (+4), i32 mx (+36), my (+40), f32 dist (+44), angle (+48)
const GR: usize = memory.data(1536, 8);  // the history: 16 GestureStates
const GLAST: usize = memory.data(52), GDOWN: usize = memory.data(52), GCUR: usize = memory.data(52), GS: usize = memory.data(96, 8);
let gw: u64 = 0, gctx: i64 = 0, gforce: bool = false, gtapOk: bool = false, gslop: bool = false, gupdNs: u64 = 0, gtapNs: u64 = 0, gpanDt: f32 = 0;
// @ts-ignore: decorator
@inline function iabs(v: i32): i32 { return v < 0 ? -v : v; }
// @ts-ignore: decorator
@inline function ptx(g: usize, i: i32): i32 { return load<i32>(g + 4 + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline function pty(g: usize, i: i32): i32 { return load<i32>(g + 8 + (<usize>i << 3)); }

function gestureRead(g: usize): void {   // the fingers down now (or pressed since the last sample), in finger id order, at most 4
  memory.fill(g, 0, PROPS);
  let n = 0;
  for (let id = 0; id < NF; id++) {
    const f = gf(id);
    if ((load<i32>(f) || load<i32>(f, 4)) && n < 4) { store<i32>(g + 4 + (<usize>n << 3), clampi(load<f32>(f, 8), 1279)); store<i32>(g + 8 + (<usize>n << 3), clampi(load<f32>(f, 12), 719)); n++; }
    store<i32>(f, 0, 4);
  }
  store<i32>(g, n);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += ptx(g, i) / n; my += pty(g, i) / n; }
  store<i32>(g, mx, 36); store<i32>(g, my, 40);
  let dist: f32 = 0;
  for (let i = 0; i < n; i++) dist += Mathf.hypot(<f32>(mx - ptx(g, i)), <f32>(my - pty(g, i))) / <f32>n;
  store<f32>(g, dist, 44);
  if (n) store<f32>(g, Mathf.atan2(<f32>(my - pty(g, 0)), <f32>(mx - ptx(g, 0))), 48);
}
function gestureSample(now: u64): void {
  const g = GCUR; gestureRead(g);
  const le: usize = gw ? GR + <usize>((gw - 1) % 16) * 0x60 : 0;
  const ltype = le ? load<i32>(le, 16) : GT_IDLE;
  const dt: f32 = gupdNs ? <f32>(now - gupdNs) / <f32>1e9 : 0;
  let gn = load<i32>(g);
  const lastN = load<i32>(GLAST);
  if (gn && gn == lastN && !gslop) {   // within the slop the fingers stay where they went down
    let out = false;
    for (let i = 0; i < gn; i++) if (iabs(ptx(g, i) - ptx(GDOWN, i)) > GESTURE_SLOP || iabs(pty(g, i) - pty(GDOWN, i)) > GESTURE_SLOP) out = true;
    if (out) gslop = true; else memory.copy(g, GLAST, PROPS);
  }
  const moved = memory.compare(g + 4, GLAST + 4, 32) != 0;
  let upd = gforce || gn != lastN || moved;
  if (!upd && ltype == GT_TOUCH && load<i32>(le, 60) == 1 && dt > <f32>0.5) upd = gtapOk;   // due to become Press
  if (!upd) return;
  gforce = false;
  const s = GS; memory.fill(s, 0, 0x60);
  store<i64>(s, le ? load<i64>(le) + 1 : 1);
  let type = GT_IDLE, attr: u32 = 0;
  if (gn) {
    if (!lastN) {   // a new gesture
      gctx++; type = GT_TOUCH; memory.copy(GDOWN, g, PROPS); gslop = false;
      if (ltype != GT_CANCEL) { attr |= 1 << 4; gtapOk = true; }
    } else if (gn != lastN) {   // the finger count changed: cancel and start over at the next sample
      type = GT_CANCEL; gtapOk = false; memory.fill(g, 0, PROPS); gn = 0;
    } else if (moved) {
      type = GT_PAN;
      const dx = load<i32>(g, 36) - (le ? load<i32>(le, 24) : load<i32>(g, 36)), dy = load<i32>(g, 40) - (le ? load<i32>(le, 28) : load<i32>(g, 40));
      store<i32>(s, dx, 32); store<i32>(s, dy, 36);
      if (dt > 0) { store<f32>(s, <f32>dx / dt, 40); store<f32>(s, <f32>dy / dt, 44); }
      gpanDt = dt;
      const dist = load<f32>(g, 44), ldist = load<f32>(GLAST, 44), ang = load<f32>(g, 48), lang = load<f32>(GLAST, 48);
      if (Mathf.abs(dist - ldist) > <f32>0.5) { type = GT_PINCH; store<f32>(s, ldist > 0 ? dist / ldist : 1, 52); }
      const turn: f32 = Mathf.atan((ang - lang) / (1 + ang * lang));
      if (Mathf.abs(turn) > <f32>0.015) { type = GT_ROTATE; store<f32>(s, 0, 52); store<f32>(s, turn * <f32>180.0 / <f32>3.14159274101257324, 56); }
    } else if (ltype == GT_TOUCH) type = GT_PRESS;
  } else if (lastN) {   // released
    switch (ltype) {
      case GT_TOUCH:
        gforce = true;
        if (!gtapOk) { type = GT_CANCEL; break; }
        type = GT_TAP; memory.copy(g, GLAST, PROPS); gn = lastN;
        if (gtapNs && now - gtapNs < 350000000) attr |= 1 << 8;
        gtapNs = now; break;
      case GT_PRESS: case GT_TAP: case GT_SWIPE: case GT_PINCH: case GT_ROTATE: type = GT_COMPLETE; gforce = true; break;
      case GT_PAN: {
        const t: f32 = gpanDt + dt, ldx = load<i32>(le, 32), ldy = load<i32>(le, 36);
        const vx: f32 = t > 0 ? <f32>ldx / t : 0, vy: f32 = t > 0 ? <f32>ldy / t : 0;
        gforce = true;
        if (Mathf.hypot(vx, vy) <= <f32>400.0) { type = GT_COMPLETE; break; }
        type = GT_SWIPE; memory.copy(g, GLAST, PROPS); gn = lastN;
        store<f32>(s, vx, 40); store<f32>(s, vy, 44); store<i32>(s, ldx, 32); store<i32>(s, ldy, 36);
        store<i32>(s, iabs(ldx) > iabs(ldy) ? (ldx > 0 ? GD_RIGHT : GD_LEFT) : (ldy > 0 ? GD_DOWN : GD_UP), 20);
        break;
      }
      default: break;
    }
  } else if (ltype == GT_COMPLETE || ltype == GT_CANCEL) gctx++;
  store<i64>(s, gctx, 8); store<i32>(s, type, 16); store<u32>(s, attr, 48);
  store<i32>(s, load<i32>(g, 36), 24); store<i32>(s, load<i32>(g, 40), 28); store<i32>(s, gn, 60); memory.copy(s + 64, g + 4, 32);
  memory.copy(GLAST, g, PROPS); gupdNs = now;
  memory.copy(GR + <usize>(gw++ % 16) * 0x60, s, 0x60);
}
// Up to n GestureStates at out, newest first; returns how many
export function gestureFill(out: usize, n: i32, nowNs: u64): i32 {
  if (n <= 0) return 0;
  gestureSample(nowNs);
  let k: i32 = gw < 16 ? <i32>gw : 16; if (k > n) k = n;
  for (let i = 0; i < k; i++) memory.copy(out + 0x60 * <usize>i, GR + <usize>((gw - 1 - <u64>i) % 16) * 0x60, 0x60);
  return k;
}
export function touchInit(): void {
  for (let i = 0; i < NF; i++) fin(i).init(TOUCH_FINGER, <u32>i);
  memory.fill(FP, 0, 256); memory.fill(GF, 0, 256); memory.fill(GR, 0, 1536); memory.fill(GLAST, 0, PROPS); memory.fill(GDOWN, 0, PROPS);
  tsamp = 0; tlastNs = 0; gw = 0; gctx = 0; gforce = false; gtapOk = false; gslop = false; gupdNs = 0; gtapNs = 0; gpanDt = 0;
}
