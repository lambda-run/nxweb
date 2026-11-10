// nn::hid (controllers, six-axis sensors, touch screen, vibration, the controller applet): port of nxnative
// dm/host/hle_hid.c. On a console the SDK reads the hid service's shared memory; here the take-overs answer from the
// state the embedder publishes: one export, hle_input(player, snapshot), with a full snapshot per player.
//
// Players and npads (as nxnative): player 1 is always connected, as the Handheld npad (id 0x20) in handheld mode
// (nn::oe's operation mode, oe.ts) and as No1 (id 0) docked; players 2..8 are on No2..No8 (ids 1..7) while their
// snapshot says connected and the game supports that npad (SetSupportedNpadIdType). A player whose npad the game does
// not support feeds player 1 in a one-player game and is not used otherwise. A pad that holds Joy-Cons is shown the
// way the game asked for: JoyDual, or JoyLeft / JoyRight on two npads after single assignment; a game that supports
// no Joy-Con style gets the pad's merged state as a full-key controller.
//
// What is different from nxnative, on purpose (the survey of nxnative's hle_hid.c found these):
//   - One snapshot per read. nxnative recomputes the controller style from eight atomics read one at a time, so a
//     disconnect between two reads once shifted by -1. Here every take-over starts with view(): the operation mode,
//     the connected players, the supported ids and styles, the assignment modes and every pad's Joy-Con halves are
//     copied once, and the npad table (which pad and kind each of the nine npads shows, its style) is derived from
//     that copy alone. Everything a call answers comes from that table.
//   - The input hold has reasons (machine input_hold, one instance per reason). nxnative's dm_input_hold is one
//     boolean: a second holder's release gave the game its input back under the first.
//   - A source is known by the embedder's stable id (padslots.ts), not by a name string.
//   - Player 1 has one path. nxnative ORs three (keyboard / touch, DM_KEYS / DM_CTL script, its controller); the
//     embedder merges its sources into player 1's snapshot (buttons ORed, each stick axis the more deflected one).
// Not ported: DM_KEYS, DM_CTL and DM_REC (scripting and recording are the embedder's), DM_HID_RECEIPT_LOG,
// dm_input_sampled_right, dm_pad_hook, DM_RUMBLE_LOG and DM_JCMS_LOG.
//
// The snapshot (SNAP_SIZE bytes, little endian):
//   +0x00 u32 flags (IN_*)          +0x04 u32 source id (padslots.ts; 0 = none)
//   +0x08 u64 buttons: NpadButton bits (A0 B1 X2 Y3 StickL4 StickR5 L6 R7 ZL8 ZR9 Plus10 Minus11 Left12 Up13 Right14
//         Down15), bit 63 = the controller is shaken (player 1 only; never reaches the game's buttons)
//   +0x10 i32 lx, ly, rx, ry (-32767..32767, right and up positive)
//   +0x20 f32 acc[3], rot[3]: the pad's motion in the controller's frame (IN_MOTION; G with gravity (0, 0, -1) face
//         up, rad/s; the axis map of STR_MOTION_AXES applies; timed by its arrival)
//   +0x38 f32 acc[3], rot[3], u64 sample ns: the pad's motion in the Switch frame from a raw sensor stream (IN_RAW;
//         the sample's time on the host's monotonic clock; stale and reordered samples are ignored)
//   +0x58 f32 acc[3], rot[3]: the console's own sensors in the Switch frame (IN_CONSOLE, player 1 only)
//   +0x70 the left Joy-Con, +0xA0 the right one (IN_JOY_L / IN_JOY_R): u64 buttons (NpadButton bits, rail buttons
//         SL 24 / SR 25 left, 26 / 27 right), i32 stick x, y, f32 acc[3], rot[3], u64 sample ns (IN_JMOTION_*)
//   +0xD0 the left Joy-Con's mouse sensor, +0xDC the right one's (IN_MOUSE_*): i32 dx, dy (counts since the last
//         snapshot), u32 state (bit 0 connected, bit 1 on a surface)
//   +0xE8 u32 touch count, +0xF0 16 touches { u32 id, f32 x, f32 y } (IN_TOUCH, player 1 only: the screen)
import { Inst } from "../kit/machine";
import { INPUT_HOLD, InputHoldS, InputHoldE, SIX_SHAKE, SixShakeS, SixShakeE, CTRL_PROMPT, CtrlPromptS, CtrlPromptE, CtrlPromptResult } from "../kit/gen/tables";
import { X, W, I, P, C, setC, wait, retF32, guestNs, monoNs, newEventPair, eventSignal, eventClear, cfg, strPtr, strLen,
  CFG_MOTION_OFF, CFG_MOTION_ACC_NEG, CFG_MOTION_GAIN, CFG_MOTION_LOG, CFG_PHONE_MOTION, CFG_INPUT_SCRIPTED, STR_MOTION_AXES,
  ls, ps, pc, pu, pi, px, pz, le, zero, copy } from "./base";
import { seBind, seSignal, seBinding, seSignalBinding } from "./sysevent";
import { dmOpmode, appletEnterS, appletLeave } from "./oe";
import { DM_PLAYERS, padSlotsInit, padSlotTake, padSlotFree } from "./padslots";
import { MAP_SIZE, mapIdentity, mapParse, motionReset, motionUpdate, motionFill } from "./motion";
import { touchInit, touchApply, touchFillN, gestureFill } from "./touch";
import { hapticsReset, hapticsAvailable, hapticsHasOutput, hapticsClear, hapticsSend, hapticsActual, hapticsRoute, hapticsRouted, idleValue } from "./haptics";

// The embedder's controller prompt, for a game that wants at least `min` players (at most `max`): it stays up while
// controllers join and answers with the export hle_ctrl_answer(1 OK / 0 closed), inside this import or any time later.
// Returns 0 when it is shown, -1 when there is no window (the applet then answers as the player closing it)
// @ts-ignore: decorator
@external("env", "hle_ctrl_prompt")
declare function envCtrlPrompt(min: i32, max: i32): i32;
// The Joy-Con mouse sensors are wanted (1) or not (0): a front end turns a Joy-Con's sensor on only then
// @ts-ignore: decorator
@external("env", "hle_joy_mouse_wanted")
declare function envMouseWanted(on: i32): void;

export const NPAD_NO1: u32 = 0, NPAD_HANDHELD: u32 = 0x20;
export const STYLE_FULLKEY: u32 = 1 << 0, STYLE_HANDHELD: u32 = 1 << 1, STYLE_JOYDUAL: u32 = 1 << 2, STYLE_JOYLEFT: u32 = 1 << 3, STYLE_JOYRIGHT: u32 = 1 << 4;
// The Joy-Con 2 forms of the Joy-Con styles (Switch 2 SDKs; inferred by nxnative, not documented)
const STYLE_JOYDUAL2: u32 = 1 << 12, STYLE_JOYLEFT2: u32 = 1 << 13, STYLE_JOYRIGHT2: u32 = 1 << 14;
const ATTR_CONNECTED: u32 = 1 << 0, ATTR_WIRED: u32 = 1 << 1, ATTR_LEFT_CONN: u32 = 1 << 2, ATTR_LEFT_WIRED: u32 = 1 << 3, ATTR_RIGHT_CONN: u32 = 1 << 4, ATTR_RIGHT_WIRED: u32 = 1 << 5;
const STICK_THRESH: i32 = 0x4000;   // stick direction pseudo-buttons (NpadButton 16..23): about half travel
const BTN_SHAKE: u64 = 1 << 63;
const BTN_L: u64 = 1 << 6, BTN_R: u64 = 1 << 7, BTN_ZL: u64 = 1 << 8, BTN_ZR: u64 = 1 << 9;
const RES_CTRL_CANCELED: u64 = 202 | 3101 << 9;

export const SNAP_SIZE: usize = 0x1B0;
export const IN_CONNECTED: u32 = 1, IN_MOTION: u32 = 2, IN_RAW: u32 = 4, IN_CONSOLE: u32 = 8, IN_JOY_L: u32 = 0x10, IN_JOY_R: u32 = 0x20, IN_JOY2: u32 = 0x40,
  IN_JMOTION_L: u32 = 0x80, IN_JMOTION_R: u32 = 0x100, IN_MOUSE_L: u32 = 0x200, IN_MOUSE_R: u32 = 0x400, IN_TOUCH: u32 = 0x800, IN_RUMBLE: u32 = 0x1000,
  IN_CLR_MOTION: u32 = 0x10000, IN_CLR_RAW: u32 = 0x20000, IN_CLR_JMOTION_L: u32 = 0x40000, IN_CLR_JMOTION_R: u32 = 0x80000;
const S_BTN: usize = 0x08, S_AX: usize = 0x10, S_MOTION: usize = 0x20, S_RAW: usize = 0x38, S_CONSOLE: usize = 0x58, S_JOY: usize = 0x70, JOY_SIZE: usize = 0x30,
  S_MOUSE: usize = 0xD0, S_NTOUCH: usize = 0xE8, S_TOUCH: usize = 0xF0;

// ---------------- state ----------------
const SNAP: usize = memory.data(3456, 8);        // DM_PLAYERS * SNAP_SIZE: each player's last snapshot, whole
const LATCH: usize = memory.data(64, 8);         // press edges since the game's last read, per player
const JLATCH: usize = memory.data(128, 8);       // the same per Joy-Con ([player][side])
const SINGLE_KEEP: usize = memory.data(32);      // u32 per npad: 1 the left Joy-Con stays on it, 2 the right one, 0 either (the left)
const STYLE_EV: usize = memory.data(64, 8);      // the binding id of the style update event bound per npad No1..No8, 0 = none
let peekLatch: u64 = 0;                          // presses since the last hle_input_peek (the applet's reader)
let sampling: i64 = 1 << 16;                     // starts high so the history entries below the newest keep positive sampling numbers
let players: u32 = 1, idsSupported: u32 = 0x3ff, stylesSupported: u32 = 0xffffffff, singleMask: u32 = 0;
let holdType: u32 = 0, commMode: u32 = 0, hhMode: u32 = 0, mergedLast: u32 = 0;

// @ts-ignore: decorator
@inline function snap(p: i32): usize { return SNAP + <usize>p * SNAP_SIZE; }
// @ts-ignore: decorator
@inline function sFlags(p: i32): u32 { return load<u32>(snap(p)); }
// @ts-ignore: decorator
@inline function sBtn(p: i32): u64 { return load<u64>(snap(p), S_BTN); }
// A stick axis as nxnative keeps it: 16 bits
// @ts-ignore: decorator
@inline function ax16(p: i32, i: i32): i32 { return <i32><i16>load<i32>(snap(p) + S_AX + (<usize>i << 2)); }
// @ts-ignore: decorator
@inline function joy(p: i32, side: i32): usize { return snap(p) + S_JOY + <usize>side * JOY_SIZE; }
// @ts-ignore: decorator
@inline function latch(p: i32): usize { return LATCH + (<usize>p << 3); }
// @ts-ignore: decorator
@inline function jlatch(p: i32, side: i32): usize { return JLATCH + (<usize>(p * 2 + side) << 3); }
// @ts-ignore: decorator
@inline function pick(a: i32, b: i32): i32 { return (a < 0 ? -a : a) >= (b < 0 ? -b : b) ? a : b; }   // whichever of two sources is deflected more
function take(at: usize): u64 { const v = load<u64>(at); store<u64>(at, 0); return v; }

// ---------------- the view: one copy of what decides the npads, and the npad table derived from it ----------------
const V_SIDES: usize = memory.data(8), V_TWO: usize = memory.data(8), V_KEEP: usize = memory.data(8);
const TOPO: usize = memory.data(108);            // 9 npads (No1..No8, Handheld): i32 pad (-1 none), i32 kind, u32 style
let vMode: i32 = 1, vPlayers: u32 = 1, vIds: u32 = 0x3ff, vStyles: u32 = 0xffffffff, vSingle: u32 = 0;
const KIND_NONE: i32 = 0, KIND_PAD: i32 = 1, KIND_DUAL: i32 = 2, KIND_LEFT: i32 = 3, KIND_RIGHT: i32 = 4;

// @ts-ignore: decorator
@inline function idBit(id: u32): u32 { return id < <u32>DM_PLAYERS ? <u32>1 << id : id == NPAD_HANDHELD ? 1 << 8 : id == 0x10 ? 1 << 9 : 0; }
// @ts-ignore: decorator
@inline function vSides(p: i32): u32 { return load<u8>(V_SIDES + <usize>p); }
function reported(p: i32): bool { return p == 0 || (((vPlayers >> p) & 1) != 0 && (vIds & idBit(<u32>p)) != 0); }
// Players with a controller whose npad the game does not support. A one-player game (no npad past No1 supported) gets
// them as player 1, so any controller plays it; in a game for fewer players than are connected they are not used
function unsupportedPlayers(): u32 { let m: u32 = 0; for (let p = 1; p < DM_PLAYERS; p++) if (((vPlayers >> p) & 1) && !reported(p)) m |= 1 << p; return m; }
function onePlayer(): bool { return !(vIds & ((1 << DM_PLAYERS) - 2)); }
function mergedPlayers(): u32 { return onePlayer() ? unsupportedPlayers() : 0; }
function connectedId(): u32 { return vMode == 0 ? NPAD_HANDHELD : NPAD_NO1; }
function playerOf(id: u32): i32 {   // the reported player on npad id; -1 when none
  if (id == connectedId()) return 0;
  return id > 0 && id < <u32>DM_PLAYERS && reported(<i32>id) ? <i32>id : -1;
}
// The styles the game supports for pad p's Joy-Cons: a Joy-Con 2 style counts as its plain one
function joySupported(p: i32): u32 {
  let s = vStyles;
  if (p >= 0 && p < DM_PLAYERS && load<u8>(V_TWO + <usize>p)) s |= (s >> 10) & (STYLE_JOYDUAL | STYLE_JOYLEFT | STYLE_JOYRIGHT);
  return s;
}
function joyActive(p: i32): bool { return p >= 0 && p < DM_PLAYERS && vSides(p) != 0 && !(p == 0 && vMode == 0); }
function joySplit(p: i32): bool {
  return vSides(p) == 3 && ((vSingle >> p) & 1) != 0 && (joySupported(p) & (STYLE_JOYLEFT | STYLE_JOYRIGHT)) == (STYLE_JOYLEFT | STYLE_JOYRIGHT);
}
// The npad the other Joy-Con of pad p takes when the pair is split: the lowest supported npad No2..No8 that has no
// player of its own and is not another split's; -1 for none
function splitTarget(p: i32): i32 {
  let taken: u32 = vPlayers | 1, mine = -1;
  for (let q = 0; q <= p && q < DM_PLAYERS; q++) if (joyActive(q) && joySplit(q)) {
    let t = -1;
    for (let i = 1; i < DM_PLAYERS; i++) if (!((taken >> i) & 1) && (vIds & idBit(<u32>i))) { t = i; break; }
    if (t >= 0) taken |= 1 << t;
    if (q == p) mine = t;
  }
  return mine;
}
let rPad: i32 = -1, rKind: i32 = 0;
function npadResolve(id: u32): void {
  rPad = -1; rKind = KIND_NONE;
  const pl = playerOf(id);
  if (pl >= 0) {
    rPad = pl; rKind = KIND_PAD;
    if (joyActive(pl)) {
      const s = vSides(pl);
      if (s == 3) rKind = joySplit(pl) ? (load<u8>(V_KEEP + <usize>pl) == 2 ? KIND_RIGHT : KIND_LEFT) : ((joySupported(pl) & STYLE_JOYDUAL) ? KIND_DUAL : KIND_PAD);
      else rKind = s == 1 ? KIND_LEFT : KIND_RIGHT;
      if (rKind == KIND_LEFT && !(joySupported(pl) & STYLE_JOYLEFT)) rKind = KIND_PAD;
      if (rKind == KIND_RIGHT && !(joySupported(pl) & STYLE_JOYRIGHT)) rKind = KIND_PAD;
    }
  } else if (id > 0 && id < <u32>DM_PLAYERS) {   // the other half of a split pair
    for (let p = 0; p < DM_PLAYERS; p++) if (joyActive(p) && joySplit(p) && splitTarget(p) == <i32>id) { rPad = p; rKind = load<u8>(V_KEEP + <usize>p) == 2 ? KIND_LEFT : KIND_RIGHT; break; }
  }
}
function kindStyle(pad: i32, kind: i32, id: u32): u32 {
  const two: u32 = pad >= 0 && pad < DM_PLAYERS && load<u8>(V_TWO + <usize>pad) ? vStyles : 0;
  switch (kind) {
    case KIND_PAD: return id == NPAD_HANDHELD ? STYLE_HANDHELD : STYLE_FULLKEY;
    case KIND_DUAL: return STYLE_JOYDUAL | (two & STYLE_JOYDUAL2);
    case KIND_LEFT: return STYLE_JOYLEFT | (two & STYLE_JOYLEFT2);
    case KIND_RIGHT: return STYLE_JOYRIGHT | (two & STYLE_JOYRIGHT2);
    default: return 0;
  }
}
// Take the view. Every take-over and every export that answers about npads calls this first, and again after it
// changed what the view is made of
function view(): void {
  vMode = dmOpmode(); vPlayers = players; vIds = idsSupported; vStyles = stylesSupported; vSingle = singleMask;
  for (let p = 0; p < DM_PLAYERS; p++) {
    const f = sFlags(p), sides = (f >> 4) & 3;
    store<u8>(V_SIDES + <usize>p, <u8>sides); store<u8>(V_TWO + <usize>p, (f & IN_JOY2) && sides ? 1 : 0);
    store<u8>(V_KEEP + <usize>p, <u8>load<u32>(SINGLE_KEEP + (<usize>p << 2)));
  }
  for (let k = 0; k < 9; k++) {
    const id: u32 = k < 8 ? <u32>k : NPAD_HANDHELD, t = TOPO + <usize>k * 12;
    npadResolve(id);
    store<i32>(t, rPad); store<i32>(t, rKind, 4); store<u32>(t, kindStyle(rPad, rKind, id), 8);
  }
}
// @ts-ignore: decorator
@inline function topo(id: u32): usize { return id < 8 ? TOPO + <usize>id * 12 : id == NPAD_HANDHELD ? TOPO + 96 : 0; }
function tPad(id: u32): i32 { const t = topo(id); return t ? load<i32>(t) : -1; }
function tKind(id: u32): i32 { const t = topo(id); return t ? load<i32>(t, 4) : KIND_NONE; }
function styleOf(id: u32): u32 { const t = topo(id); return t ? load<u32>(t, 8) : 0; }
// The players the game sees: player 1 and each player whose npad it supports; a pair of Joy-Cons split into two
// npads is two players
function playersReported(): i32 {
  let n = 0;
  for (let p = 0; p < DM_PLAYERS; p++) if (reported(p)) n += 1 + <i32>(joyActive(p) && joySplit(p) && splitTarget(p) >= 0);
  return n;
}

// ---------------- style update events ----------------
// Bound per npad (BindNpadStyleSetUpdateEvent, No1..No8): signalled when a player's controller comes or goes, as the
// hid service does. Only a bound one is signalled (one the game destroyed is not bound any more)
function styleChanged(id: u32): void {
  if (id >= <u32>DM_PLAYERS) return;
  const b = load<u64>(STYLE_EV + (<usize>id << 3));
  if (b && !seSignalBinding(b)) store<u64>(STYLE_EV + (<usize>id << 3), 0);
}
function noteMerged(): void {   // logs the players whose npad the game does not support, when that changes
  const m = unsupportedPlayers(), one: u32 = onePlayer() ? 1 : 0, key = m | one << 31;
  if (mergedLast == key) return;
  mergedLast = key;
  for (let p = 1; p < DM_PLAYERS; p++) if ((m >> p) & 1) {
    ls(); ps("hid: player "); pi(p + 1); ps("'s controller ");
    if (one) { ps("feeds player 1: the game supports one player (no npad "); pi(p); ps(")"); } else { ps("is not used: the game supports no npad "); pi(p); }
    le();
  }
}
function setPlayers(mask: u32): void {
  mask = (mask | 1) & ((1 << DM_PLAYERS) - 1);
  const old = players; players = mask;
  for (let p = 1; p < DM_PLAYERS; p++) if (((old ^ mask) >> p) & 1) {
    if (idsSupported & idBit(<u32>p)) styleChanged(<u32>p);
  }
  view(); noteMerged();
}

// ---------------- the shake ----------------
// Whole side-to-side cycles on the guest clock, so the controller always comes back to rest (machine six_shake)
const SHAKE_HZ: f64 = 6.0, SHAKE_G: f64 = 3.0, SHAKE_REV: f64 = 1.5;
const SHAKE_CYCLE_NS: u64 = 166666666;   // (uint64_t)(1e9 / SHAKE_HZ)
const SHAKE_INST: usize = memory.data(16);
let shakeT0: u64 = 0, shakeEnd: u64 = 0, shakeOn: bool = false;
// @ts-ignore: decorator
@inline function shake(): Inst { return Inst.at(SHAKE_INST); }
function shakeSettle(t: u64): void { if (shake().state == SixShakeS.Finishing && t >= shakeEnd) shake().step(SixShakeE.Settle); }
function shakeNote(): void {
  const on = (sBtn(0) & BTN_SHAKE) != 0;
  if (on == shakeOn) return;
  shakeOn = on;
  const t = guestNs();
  if (on) {
    shakeSettle(t);
    if (t >= shakeEnd) shakeT0 = t;   // else: a shake still finishing goes on
    shakeEnd = u64.MAX_VALUE;
    shake().step(SixShakeE.Press);
  } else {
    shakeEnd = shakeT0 + ((t - shakeT0) / SHAKE_CYCLE_NS + 1) * SHAKE_CYCLE_NS;
    shake().step(SixShakeE.Release, shakeEnd);
  }
}
// @ts-ignore: decorator
@inline function shaking(t: u64): bool { return t >= shakeT0 && t < shakeEnd; }

// ---------------- the input hold ----------------
// A library applet or prompt in front of the game: while any reason holds, the game reads no buttons and centred
// sticks on every npad, as an application out of focus does, and presses made meanwhile are dropped
export const HOLD_WEB: i32 = 1, HOLD_CTRL: i32 = 2, HOLD_KBD: i32 = 3, HOLD_EMBEDDER: i32 = 4, HOLD_REASONS: i32 = 4;
const HOLDS: usize = memory.data(64);   // HOLD_REASONS Inst
// @ts-ignore: decorator
@inline function holder(reason: i32): Inst { return Inst.at(HOLDS + (<usize>(reason - 1) << 4)); }
export function holdMask(): u32 { let m: u32 = 0; for (let r = 1; r <= HOLD_REASONS; r++) if (holder(r).state == InputHoldS.Holding) m |= 1 << r; return m; }
function dropLatches(): void { zero(LATCH, 64); }   // a press made for the applet is not the game's
export function holdSet(reason: i32, on: bool): void {
  if (reason < 1 || reason > HOLD_REASONS) { ls(); ps("[RED] hid: input hold with unknown reason "); pi(reason); ps(": ignored"); le(); return; }
  const h = holder(reason), was = holdMask() != 0;
  if ((h.state == InputHoldS.Holding) == on) return;   // the same holder asking twice changes nothing
  h.step(on ? InputHoldE.Take : InputHoldE.Release);
  if (was != (holdMask() != 0)) dropLatches();
}
// What an applet sees: every player ORed (any controller drives it), each stick axis the most deflected one, plus the
// presses since the last peek (a tap between two peeks is reported once). out: u64 buttons, i32 axes[4]
export function inputPeek(out: usize): void {
  let b: u64 = peekLatch; peekLatch = 0;
  let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let p = 0; p < DM_PLAYERS; p++) { b |= sBtn(p); a0 = pick(a0, ax16(p, 0)); a1 = pick(a1, ax16(p, 1)); a2 = pick(a2, ax16(p, 2)); a3 = pick(a3, ax16(p, 3)); }
  store<u64>(out, b & 0xffff); store<i32>(out, a0, 8); store<i32>(out, a1, 12); store<i32>(out, a2, 16); store<i32>(out, a3, 20);
}
function stickDirs(a0: i32, a1: i32, a2: i32, a3: i32): u64 {
  let b: u64 = 0;
  if (a0 < -STICK_THRESH) b |= 1 << 16;
  if (a1 > STICK_THRESH) b |= 1 << 17;
  if (a0 > STICK_THRESH) b |= 1 << 18;
  if (a1 < -STICK_THRESH) b |= 1 << 19;
  if (a2 < -STICK_THRESH) b |= 1 << 20;
  if (a3 > STICK_THRESH) b |= 1 << 21;
  if (a2 > STICK_THRESH) b |= 1 << 22;
  if (a3 < -STICK_THRESH) b |= 1 << 23;
  return b;
}
// The cheat VM's key mask: every player's buttons ORed and the merged axes' eight stick-direction bits; no latch is
// consumed and the sampling number does not move
export function cheatKeys(): u64 {
  let b: u64 = 0, a0 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let p = 0; p < DM_PLAYERS; p++) { b |= sBtn(p); a0 = pick(a0, ax16(p, 0)); a1 = pick(a1, ax16(p, 1)); a2 = pick(a2, ax16(p, 2)); a3 = pick(a3, ax16(p, 3)); }
  return (b & 0xffff) | stickDirs(a0, a1, a2, a3);
}
export function inputSamples(): u64 { return <u64>sampling; }
export function hidConnectedNpad(): u32 { return dmOpmode() == 0 ? NPAD_HANDHELD : NPAD_NO1; }   // nfp's NFC device sits on player 1's controller (sdk16.ts)
// The npad id the game reads player p + 1 on: Handheld (0x20) or No1 (0) for player 1, No n (id n - 1) for player n
export function playerNpad(p: i32): u32 { return p <= 0 ? hidConnectedNpad() : <u32>p; }
export function playersSeen(): i32 { view(); return playersReported(); }
export function npadStyle(id: u32): u32 { view(); return styleOf(id); }

// ---------------- npad states ----------------
// nn::hid::NpadFullKeyState / Handheld / JoyDual / JoyLeft / JoyRight share one layout (0x28):
// +0 i64 sampling number, +8 u64 buttons, +0x10 i32 lx, ly, rx, ry, +0x20 u32 attributes, +0x24 pad
function fillJoy(s: usize, pad: i32, kind: i32): void {
  let b: u64 = 0, a0 = 0, a1 = 0, a2 = 0, a3 = 0;
  const left = kind != KIND_RIGHT, right = kind != KIND_LEFT;
  if (left) { const j = joy(pad, 0); b |= load<u64>(j) | take(jlatch(pad, 0)); a0 = <i32><i16>load<i32>(j, 8); a1 = <i32><i16>load<i32>(j, 12); }
  if (right) { const j = joy(pad, 1); b |= load<u64>(j) | take(jlatch(pad, 1)); a2 = <i32><i16>load<i32>(j, 8); a3 = <i32><i16>load<i32>(j, 12); }
  store<i32>(s, a0, 0x10); store<i32>(s, a1, 0x14); store<i32>(s, a2, 0x18); store<i32>(s, a3, 0x1c);
  store<u64>(s, (b & 0x0f00ffff) | stickDirs(a0, a1, a2, a3), 8);
  store<u32>(s, ATTR_CONNECTED | (left ? ATTR_LEFT_CONN : 0) | (right ? ATTR_RIGHT_CONN : 0), 0x20);
}
function fill(s: usize, id: u32, style: u32): void {
  zero(s, 0x28);
  store<i64>(s, ++sampling);
  const pad = tPad(id), kind = tKind(id);
  if (!(styleOf(id) & style) || pad < 0 || pad >= DM_PLAYERS) return;   // no controller of this id / style: attributes = 0
  if (kind >= KIND_DUAL) { fillJoy(s, pad, kind); return; }
  // player 1: its own snapshot and the players merged into it; another player: its own
  const src: u32 = pad ? <u32>1 << pad : 1 | mergedPlayers();
  let b: u64 = 0, a0 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let p = 0; p < DM_PLAYERS; p++) if ((src >> p) & 1) {
    b |= sBtn(p) | take(latch(p));
    a0 = pick(a0, ax16(p, 0)); a1 = pick(a1, ax16(p, 1)); a2 = pick(a2, ax16(p, 2)); a3 = pick(a3, ax16(p, 3));
  }
  if (holdMask()) { b = 0; a0 = 0; a1 = 0; a2 = 0; a3 = 0; }   // an applet is in front: the game reads nothing (the latches were taken all the same)
  store<i32>(s, a0, 0x10); store<i32>(s, a1, 0x14); store<i32>(s, a2, 0x18); store<i32>(s, a3, 0x1c);
  store<u64>(s, (b & 0xffff) | stickDirs(a0, a1, a2, a3), 8);
  store<u32>(s, ATTR_CONNECTED | (id == NPAD_HANDHELD ? ATTR_WIRED | ATTR_LEFT_CONN | ATTR_LEFT_WIRED | ATTR_RIGHT_CONN | ATTR_RIGHT_WIRED : ATTR_LEFT_CONN | ATTR_RIGHT_CONN), 0x20);
}
// GetNpadStates(out, n, id): newest first, n entries: the current state repeated with consecutive sampling numbers.
// On hardware the 16-entry history is always full, and games read all of it whatever count comes back
function states(a: usize, style: u32): u64 {
  const out = P(a, 0), n = I(a, 1), id = load<u32>(P(a, 2));
  if (n <= 0) return 0;
  view(); fill(out, id, style);
  const top = load<i64>(out);
  for (let i = 1; i < n; i++) { const e = out + 0x28 * <usize>i; copy(e, out, 0x28); store<i64>(e, top - i); }
  return <u64><u32>n;
}
function state(a: usize, style: u32): u64 { view(); fill(P(a, 0), load<u32>(P(a, 1)), style); return 0; }
export function h_hid_StatesFullKey(a: usize): u64 { return states(a, STYLE_FULLKEY); }
export function h_hid_StatesHandheld(a: usize): u64 { return states(a, STYLE_HANDHELD); }
export function h_hid_StatesJoyDual(a: usize): u64 { return states(a, STYLE_JOYDUAL); }
export function h_hid_StatesJoyLeft(a: usize): u64 { return states(a, STYLE_JOYLEFT); }
export function h_hid_StatesJoyRight(a: usize): u64 { return states(a, STYLE_JOYRIGHT); }
export function h_hid_StateFullKey(a: usize): u64 { return state(a, STYLE_FULLKEY); }
export function h_hid_StateHandheld(a: usize): u64 { return state(a, STYLE_HANDHELD); }
export function h_hid_StateJoyDual(a: usize): u64 { return state(a, STYLE_JOYDUAL); }
export function h_hid_StateJoyLeft(a: usize): u64 { return state(a, STYLE_JOYLEFT); }
export function h_hid_StateJoyRight(a: usize): u64 { return state(a, STYLE_JOYRIGHT); }

// Supported npad ids: players 2..8 are reported only on supported npads; a one-player game ({No1, Handheld}) gets
// every controller as player 1; a four-player game gets players 1..4, and a fifth controller is not used
export function h_hid_SetIds(a: usize): u64 {
  const ids = P(a, 0), n = X(a, 1);
  let m: u32 = 0; for (let i: u64 = 0; ids && i < n; i++) m |= idBit(load<u32>(ids + (<usize>i << 2)));
  view();
  let was: u32 = 0; for (let p = 1; p < DM_PLAYERS; p++) was |= <u32>reported(p) << p;
  if (idsSupported == m) return 0;
  idsSupported = m; view();
  for (let p = 0; p < DM_PLAYERS; p++) hapticsClear(p);
  ls(); ps("hid supported controller ids "); px(m); ps(" (bit n: No n+1, bit 8 Handheld, bit 9 Other)"); le();
  for (let p = 1; p < DM_PLAYERS; p++) if (<u32>reported(p) != ((was >> p) & 1)) styleChanged(<u32>p);
  noteMerged();
  return 0;
}
export function h_hid_SetStyles(a: usize): u64 {
  const styles = W(a, 0);
  if (styles != stylesSupported) { ls(); ps("hid supported controller styles "); px(styles); le(); }
  stylesSupported = styles;
  return 0;
}
export function h_hid_GetStyle(a: usize): u64 { view(); return styleOf(load<u32>(P(a, 0))); }
export function h_hid_GetStyles(a: usize): u64 { return stylesSupported; }
export function h_hid_HoldType(a: usize): u64 { holdType = W(a, 0); return 0; }
export function h_hid_GetHold(a: usize): u64 { return holdType; }
export function h_hid_GetComm(a: usize): u64 { return commMode; }
export function h_hid_SetComm(a: usize): u64 { commMode = W(a, 0); return 0; }
export function h_hid_GetHh(a: usize): u64 { return hhMode; }
export function h_hid_SetHh(a: usize): u64 { hhMode = W(a, 0); return 0; }
// The game's choice of how the Joy-Cons of a pad are used: single (left or right staying on the npad) or dual.
// NpadJoyDeviceType: Left 0, Right 1; NpadJoyAssignmentMode: Dual 0, Single 1
function joyAssign(id: u32, single: bool, keep: u32): void {
  if (id >= <u32>DM_PLAYERS) return;
  const was = singleMask, now = single ? was | <u32>1 << id : was & ~(<u32>1 << id);
  store<u32>(SINGLE_KEEP + (<usize>id << 2), keep);
  singleMask = now; view();
  if (was != now) {
    ls(); ps("hid: npad "); pu(id); ps(single ? ": single" : ": dual"); ps(" Joy-Con assignment"); if (single && keep) ps(keep == 1 ? " (left)" : " (right)"); le();
    for (let i: u32 = 0; i < <u32>DM_PLAYERS; i++) styleChanged(i);
  }
}
export function h_hid_GetJoyAssign(a: usize): u64 { const id = load<u32>(P(a, 0)); return id < <u32>DM_PLAYERS && ((singleMask >> id) & 1) ? 1 : 0; }
export function h_hid_JoySingle(a: usize): u64 { joyAssign(load<u32>(P(a, 0)), true, 0); return 0; }
export function h_hid_JoyDual(a: usize): u64 { joyAssign(load<u32>(P(a, 0)), false, 0); return 0; }
export function h_hid_JoySingleT(a: usize): u64 { joyAssign(load<u32>(P(a, 0)), true, I(a, 1) == 1 ? 2 : 1); return 0; }
export function h_hid_JoySingleOut(a: usize): u64 {
  const out = P(a, 0), id = load<u32>(P(a, 1));
  joyAssign(id, true, I(a, 2) == 1 ? 2 : 1);
  view();
  const q = id < <u32>DM_PLAYERS && joyActive(<i32>id) && joySplit(<i32>id) ? splitTarget(<i32>id) : -1;
  if (out) store<u32>(out, q >= 0 ? <u32>q : id);
  return q >= 0 ? 1 : 0;
}
// Bound and signalled once when its controller is connected (the hid service reports the controller already attached
// at start the same way), and again whenever a player's controller comes or goes. Link's Awakening reads no
// controller state until this event has fired
export function h_hid_BindStyleEv(a: usize): u64 {
  const id = load<u32>(P(a, 0)), ev = P(a, 1);
  seBind(ev, I(a, 2));
  if (id < <u32>DM_PLAYERS) store<u64>(STYLE_EV + (<usize>id << 3), seBinding(ev));
  view();
  if (styleOf(id)) seSignal(ev);
  return 0;
}
// The Switch's player LEDs by npad (No1 1, No2 1-2, No3 1-3, No4 1-4, No5 1+4, No6 1+3, No7 1+3+4, No8 2+3; bit 0 = LED 1)
const LED: usize = memory.data<u8>([0x1, 0x3, 0x7, 0xf, 0x9, 0x5, 0xd, 0x6]);
export function h_hid_Led(a: usize): u64 { const id = load<u32>(P(a, 0)); return id < <u32>DM_PLAYERS ? load<u8>(LED + <usize>id) : 1; }
// NpadControllerColor = { main RGBA, button RGBA }: grey body, black buttons
function ctrlColor(c: usize): void { store<u32>(c, 0xff828282); store<u32>(c, 0xff0f0f0f, 4); }
export function h_hid_Color(a: usize): u64 { ctrlColor(P(a, 0)); return 0; }
export function h_hid_Color2(a: usize): u64 { ctrlColor(P(a, 0)); ctrlColor(P(a, 1)); return 0; }

// ---------------- the controller applet ----------------
// ControllerSupportResultInfo = { int playerCount; uint32_t selectedId; }; ControllerSupportArg starts with
// { int8 playerCountMin, playerCountMax }: the count is capped at the maximum. Fewer players than the minimum: on a
// Switch the applet stays open until enough controllers are there or the player closes it; the embedder's prompt does
// the same (import hle_ctrl_prompt, machine ctrl_prompt) and the calling thread waits for its answer. Without a window,
// or with scripted input (CFG_INPUT_SCRIPTED), nobody is at the controllers: canceled at once, as the player closing
// it (2202-3101). An OK with fewer players is an answer a Switch never gives.
// Continuation slots: 0 = 1 while the prompt is out, 1 = the player count before it
const PROMPT_INST: usize = memory.data(16);
const WH: usize = memory.data(8);
let promptR: u32 = 0, promptW: u32 = 0;
// @ts-ignore: decorator
@inline function prompt(): Inst { return Inst.at(PROMPT_INST); }
function promptEvent(): u32 { if (!promptR) { promptR = newEventPair(WH); promptW = load<u32>(WH); } return promptR; }
// The embedder's answer: 1 enough players joined and OK was pressed, 0 the player closed the prompt. Returns 1 when a
// prompt was waiting
export function ctrlAnswer(result: i32): i32 {
  if (prompt().state != CtrlPromptS.Asking) { ls(); ps("[RED] hid: a controller prompt answer with no prompt waiting: ignored"); le(); return 0; }
  prompt().step(CtrlPromptE.Answer, result > 0 ? CtrlPromptResult.ok : CtrlPromptResult.closed);
  if (promptW) eventSignal(promptW);
  return 1;
}
export function ctrlPromptState(): u8 { return prompt().state; }
function logApplet(min: i32, max: i32, count: i32): void { ps("hid controller applet: "); pi(min); ps(" to "); pi(max); ps(" players wanted, "); pi(count); ps(" connected"); }
function showCtrl(a: usize, info: usize, arg: usize): u64 {
  const min: i32 = arg ? load<i8>(arg) : 0, max: i32 = arg ? load<i8>(arg, 1) : 0;
  let count = 0, canceled = false;
  if (C(a, 0) == 0) {
    if (prompt().state != CtrlPromptS.Idle) return wait(promptEvent(), 100000000);   // another thread's prompt is up: one applet at a time
    appletEnterS("controller support");
    view(); count = playersReported();
    // Too few players, but a pair of Joy-Cons is two when each is held sideways (single assignment): the applet splits
    // the pair, as the player does on a Switch, to reach the minimum
    for (let p = 0; arg && count < min && p < DM_PLAYERS; p++)
      if (reported(p) && joyActive(p) && vSides(p) == 3 && !((vSingle >> p) & 1)) {
        joyAssign(<u32>p, true, 0);
        if (joySplit(p) && splitTarget(p) >= 0) count++; else joyAssign(<u32>p, false, 0);
      }
    if (arg && min > count) {
      let r = -1;
      if (!cfg(CFG_INPUT_SCRIPTED)) {
        prompt().step(CtrlPromptE.Ask);
        promptEvent(); eventClear(promptW);
        if (envCtrlPrompt(min, max) < 0) { if (prompt().state == CtrlPromptS.Asking) prompt().step(CtrlPromptE.Answer, CtrlPromptResult.noWindow); }
        if (prompt().state != CtrlPromptS.Answered) { setC(a, 0, 1); setC(a, 1, <u64>count); return wait(promptR, -1); }
        r = takePrompt();
      }
      canceled = promptDone(r, min, max, count);
    } else if (arg) { ls(); logApplet(min, max, count); le(); }
  } else {
    if (prompt().state != CtrlPromptS.Answered) return wait(promptEvent(), -1);
    canceled = promptDone(takePrompt(), min, max, <i32>C(a, 1));
  }
  view(); count = playersReported();
  if (arg && max > 0 && count > max) count = max;
  if (info) { store<i32>(info, count); store<i32>(info, <i32>connectedId(), 4); }
  appletLeave();
  return canceled ? RES_CTRL_CANCELED : 0;
}
// 1 OK, 0 closed, -1 no window
function takePrompt(): i32 {
  const r = <u32>prompt().data;
  prompt().step(CtrlPromptE.Take);
  if (promptW) eventSignal(promptW);   // a thread that found the prompt busy looks again
  return r == CtrlPromptResult.ok ? 1 : r == CtrlPromptResult.closed ? 0 : -1;
}
function promptDone(r: i32, min: i32, max: i32, was: i32): bool {
  view();
  const count = playersReported();
  ls(); logApplet(min, max, was);
  if (r < 0) ps(": too few, closed as the player would (canceled)");
  else { ps(": the prompt waited, "); pi(count); ps(r && min <= count ? " now (OK)" : " now (canceled)"); }
  le();
  return r <= 0 || min > count;
}
export function h_hid_ShowCtrl(a: usize): u64 { return showCtrl(a, P(a, 0), P(a, 1)); }
export function h_hid_ShowCtrl0(a: usize): u64 { return showCtrl(a, 0, P(a, 0)); }

// ---------------- six-axis sensors ----------------
// SixAxisSensorState (0x60): +0 i64 delta time ns, +8 i64 sampling number, +0x10 f32 acceleration[3] (G), +0x1c
// angular velocity[3] (revolutions / s), +0x28 angle[3] (revolutions), +0x34 direction[9] (the controller's three
// axes), +0x58 u32 attributes (1 connected). At rest it lies flat: gravity (0, 0, -1), no rotation, the identity
// direction. While shaking it moves side to side, x acceleration +-3 G with a yaw of +-1.5 revolutions / s. Samples
// are 5 ms apart on the guest clock and numbered by time, so a history read returns the samples at those times.
// Live motion: while a player's samples keep arriving (within 300 ms on the host clock) their sensor reports them
// (motion.ts) instead of lying flat; every history entry is then the newest sample, numbered by time.
const SIX_PERIOD_NS: u64 = 5000000, MOTION_STALE_NS: u64 = 300000000;
const TWO_PI: f64 = 2 * Math.PI;
// live_motion (104 bytes): +0 motion_state (76), +80 u64 last sample ns, +88 u64 received ns, +96 u64 logged ns
const LM_SIZE: usize = 104, LM_GC: i32 = 0, LM_RAW: i32 = 8, LM_JOY: i32 = 16, LM_PHONE: i32 = 32;
const LM: usize = memory.data(3432, 8);          // 33 sources: each transport owns its orientation
const MMAP: usize = memory.data(32), MIDENT: usize = memory.data(32), MS: usize = memory.data(76), MS2: usize = memory.data(76);
let motionReady: bool = false, motionOff: bool = false, motionLog: bool = false, phoneMode: i32 = -1, motionGain: f32 = 0.5;
// @ts-ignore: decorator
@inline function lm(i: i32): usize { return LM + <usize>i * LM_SIZE; }
function motionEnv(): void {
  if (motionReady) return;
  motionReady = true;
  motionOff = cfg(CFG_MOTION_OFF) != 0;
  mapIdentity(MIDENT);
  if (!mapParse(MMAP, strLen(STR_MOTION_AXES) > 0 ? strPtr(STR_MOTION_AXES) : 0)) { ls(); ps("[hid] DM_MOTION_AXES='"); pz(strPtr(STR_MOTION_AXES)); ps("' is not like \"x,-z,y\": using x,y,z"); le(); }
  if (cfg(CFG_MOTION_ACC_NEG)) store<f32>(MMAP, -1, 24);
  motionGain = <f32>reinterpret<f64>(cfg(CFG_MOTION_GAIN));
  motionLog = cfg(CFG_MOTION_LOG) != 0;
  phoneMode = <i32>cfg(CFG_PHONE_MOTION);
}
// source: 0 the controller's frame (the axis map applies), 1 the console's own sensors, 2 a raw stream in the Switch frame
function motionSetTo(m: usize, p: i32, acc: usize, rot: usize, source: i32, sampleNs: u64): void {
  motionEnv(); if (motionOff) return;
  // Each transport owns its orientation. Raw batches carry sample times; arrival time controls freshness, never their integration intervals
  const now = monoNs(), t = sampleNs ? sampleNs : now;
  if (!t || t > now || now - t > MOTION_STALE_NS) return;
  if (!load<u64>(m, 80) || now - load<u64>(m, 88) > MOTION_STALE_NS) { motionReset(m); store<u64>(m, 0, 80); }
  const last = load<u64>(m, 80);
  if (last && t <= last) return;
  const dt: f32 = last && t > last ? <f32>(<f64>(t - last) / 1e9) : 0;
  motionUpdate(m, source ? MIDENT : MMAP, acc, rot, dt, motionGain);
  if (motionLog && !p && t - load<u64>(m, 96) > 1000000000) {
    store<u64>(m, t, 96);
    ls(); ps("[hid] motion player 1 ("); ps(source == 1 ? "console" : source == 2 ? "controller raw" : "controller"); ps("): acc milli-G");
    for (let i = 0; i < 3; i++) { pc(32); pi(<i64>(load<f32>(m + 48 + (<usize>i << 2)) * 1000)); }
    ps(", gyro milli-rev/s"); for (let i = 0; i < 3; i++) { pc(32); pi(<i64>(load<f32>(m + 60 + (<usize>i << 2)) * 1000)); }
    ps(" (flat and still should read acc 0 0 -1000)"); le();
  }
  store<u64>(m, t, 80); store<u64>(m, now, 88);
}
function motionCopy(m: usize, out: usize): u64 {   // copies a source while it is fresh; returns its timestamp
  const t = load<u64>(m, 80) && monoNs() - load<u64>(m, 88) <= MOTION_STALE_NS ? load<u64>(m, 80) : 0;
  if (t) copy(out, m, 76);
  return t;
}
function motionLive(p: i32, out: usize): bool {
  if (p < 0 || p >= DM_PLAYERS) return false;
  motionEnv();
  if (!p && phoneMode > 0) return motionCopy(lm(LM_PHONE), out) != 0;
  // match the button path: in a one-player game, a controller in another slot also drives player 1
  const src: u32 = p ? <u32>1 << p : 1 | mergedPlayers();
  let newest: u64 = 0;
  for (let i = 0; i < DM_PLAYERS; i++) if ((src >> i) & 1) {
    let t = motionCopy(lm(LM_GC + i), MS2);
    if (!t) t = motionCopy(lm(LM_RAW + i), MS2);
    if (t > newest) { newest = t; copy(out, MS2, 76); }
  }
  if (newest) return true;
  return !p && phoneMode < 0 && motionCopy(lm(LM_PHONE), out) != 0;
}
// One Joy-Con's sensor: its own stream while fresh, else the pad's merged one
function motionJoy(p: i32, side: i32, out: usize): bool {
  if (p >= 0 && p < DM_PLAYERS && (side == 0 || side == 1)) { motionEnv(); if (!motionOff && motionCopy(lm(LM_JOY + p * 2 + side), out)) return true; }
  return motionLive(p, out);
}
function shakePhase(t: u64): f64 { return TWO_PI * SHAKE_HZ * <f64>(t - shakeT0) / 1e9; }
function sixSampleLive(s: usize, samp: i64, ms: usize, shakes: bool): void {
  zero(s, 0x60);
  const t = <u64>samp * SIX_PERIOD_NS;
  store<i64>(s, <i64>SIX_PERIOD_NS); store<i64>(s, samp, 8); store<u32>(s, 1, 0x58);
  motionFill(ms, s + 0x10);
  if (shakes && shaking(t)) store<f32>(s, load<f32>(s, 0x10) + <f32>(SHAKE_G * Math.sin(shakePhase(t))), 0x10);
}
function sixSample(s: usize, samp: i64, shakes: bool): void {
  zero(s, 0x60);
  const t = <u64>samp * SIX_PERIOD_NS;
  store<i64>(s, <i64>SIX_PERIOD_NS); store<i64>(s, samp, 8); store<u32>(s, 1, 0x58);   // IsConnected
  store<f32>(s, -1, 0x18);
  let yaw: f64 = 0;
  if (shakes && shaking(t)) {
    const ph = shakePhase(t);
    store<f32>(s, <f32>(SHAKE_G * Math.sin(ph)), 0x10);
    store<f32>(s, <f32>(SHAKE_REV * Math.sin(ph)), 0x24);
    yaw = SHAKE_REV / (TWO_PI * SHAKE_HZ) * (1 - Math.cos(ph)); store<f32>(s, <f32>yaw, 0x30);
  }
  const c = <f32>Math.cos(TWO_PI * yaw), sn = <f32>Math.sin(TWO_PI * yaw);
  store<f32>(s, c, 0x34); store<f32>(s, sn, 0x38); store<f32>(s, -sn, 0x40); store<f32>(s, c, 0x44); store<f32>(s, 1, 0x54);
}
// SixAxisSensorHandle: byte 0 the style's bit number, byte 1 the npad id, byte 2 the device (left / right Joy-Con of a
// pair). A handle reads as connected while its controller is connected in that style; otherwise its entries are zero
// and the count 0. Only player 1's controller shakes
function sixConnected(h: u32): bool { return (h & 0xff) < 32 && ((styleOf((h >> 8) & 0xff) >> (h & 0xff)) & 1) != 0; }
function sixStates(out: usize, n: i32, h: u32): i32 {
  if (n <= 0) return 0;
  view();
  if (!sixConnected(h)) { zero(out, 0x60 * <usize>n); return 0; }
  const now = guestNs(), samp = <i64>(now / SIX_PERIOD_NS), id = (h >> 8) & 0xff;
  shakeSettle(now);
  const pad = tPad(id), kind = tKind(id);
  const pl = kind >= KIND_DUAL ? pad : playerOf(id), shakes = pl == 0 && kind < KIND_DUAL;
  const live = kind >= KIND_DUAL ? motionJoy(pad, kind == KIND_LEFT ? 0 : kind == KIND_RIGHT ? 1 : <i32>((h >> 16) & 1), MS) : motionLive(pl, MS);
  for (let i = 0; i < n; i++) { if (live) sixSampleLive(out + 0x60 * <usize>i, samp - i, MS, shakes); else sixSample(out + 0x60 * <usize>i, samp - i, shakes); }
  return n;
}
export function h_hid_SixHandles(a: usize): u64 {
  const h = P(a, 0), n = I(a, 1), id = load<u32>(P(a, 2)), style = W(a, 3);
  let k = (style & (STYLE_HANDHELD | STYLE_JOYDUAL)) ? 2 : 1; if (k > n) k = n;
  for (let i = 0; i < k; i++) store<u32>(h + (<usize>i << 2), <u32>(style ? ctz<u32>(style) : 0) | (id & 0xff) << 8 | <u32>i << 16);
  return k > 0 ? <u64>k : 0;
}
export function h_hid_SixStates(a: usize): u64 { return <u64><u32>sixStates(P(a, 0), I(a, 1), load<u32>(P(a, 2))); }
export function h_hid_SixState(a: usize): u64 { sixStates(P(a, 0), 1, load<u32>(P(a, 1))); return 0; }
export function h_hid_SixRest(a: usize): u64 {
  view();
  const pl = playerOf((load<u32>(P(a, 0)) >> 8) & 0xff), now = guestNs();
  shakeSettle(now);
  if (motionLive(pl, MS)) return Mathf.abs(load<f32>(MS, 60)) + Mathf.abs(load<f32>(MS, 64)) + Mathf.abs(load<f32>(MS, 68)) < <f32>0.01 && !(pl == 0 && shaking(now)) ? 1 : 0;
  return pl != 0 || !shaking(now) ? 1 : 0;
}

// ---------------- Joy-Con 2 mouse sensor (Jcms) and pointer (Nmouse) ----------------
// A Jcms handle is the npad id in byte 0 and the JcmsType in byte 1 (0 left, 1 right). JcmsState (32 bytes): 8 bytes
// the game does not read, i64 sampling number at 8 (newest first; above 0 is a sample), i32 movement x, y at 0x10,
// u32 attributes at 0x18 (bit 0 connected, bit 1 on a surface). A ring of 16 per player and Joy-Con.
// NmouseState (48 bytes): 8 bytes, i64 sampling number, i32 x, y, dx, dy, wheel x, y, u32 buttons at 0x28 (left 1,
// right 2: R / ZR on a right Joy-Con, L / ZL on a left one), u32 attributes at 0x2c (bit 1 connected, bit 0 on a surface)
const JCMS_RING: i64 = 16, NMOUSE_TAG: u64 = 0x4e4d0000, NMOUSE_SCALE: f32 = 0.25, MOUSE_ON_SURFACE: u32 = 2;
const JCMS: usize = memory.data(8192, 8);        // [player][side][16] JcmsState
const JCMS_N: usize = memory.data(128, 8);       // i64 samples so far per player and side
const NM_POS: usize = memory.data(128), NM_D: usize = memory.data(128), NM_STATE: usize = memory.data(64), NM_LAST: usize = memory.data(32);
let jcmsWanted: u32 = 0, nmW: i32 = 0, nmH: i32 = 0;
// @ts-ignore: decorator
@inline function ji(p: i32, side: i32): usize { return <usize>(p * 2 + side); }
// @ts-ignore: decorator
@inline function jcmsN(p: i32, side: i32): i64 { return load<i64>(JCMS_N + (ji(p, side) << 3)); }
function wanted(bit: u32, on: bool): void {
  const was = jcmsWanted != 0;
  if (on) jcmsWanted |= bit; else jcmsWanted &= ~bit;
  if (was != (jcmsWanted != 0)) envMouseWanted(jcmsWanted != 0 ? 1 : 0);
}
export function mouseWanted(): i32 { return jcmsWanted != 0 ? 1 : 0; }
function joyMouse(p: i32, side: i32, dx: i32, dy: i32, state: u32): void {
  const k = ji(p, side), n = jcmsN(p, side) + 1;
  store<i64>(JCMS_N + (k << 3), n);
  const e = JCMS + ((k << 4) + <usize>((n - 1) % JCMS_RING)) * 32;
  zero(e, 32); store<i64>(e, n, 8); store<i32>(e, dx, 0x10); store<i32>(e, dy, 0x14); store<u32>(e, state & 3, 0x18);
  const w = nmW > 0 ? nmW : 1920, hgt = nmH > 0 ? nmH : 1080, xy = NM_POS + (k << 3);
  if (n == 1) { store<f32>(xy, <f32>w / 2); store<f32>(xy, <f32>hgt / 2, 4); }
  store<f32>(xy, Mathf.min(<f32>(w - 1), Mathf.max(0, load<f32>(xy) + <f32>dx * NMOUSE_SCALE)));
  store<f32>(xy, Mathf.min(<f32>(hgt - 1), Mathf.max(0, load<f32>(xy, 4) + <f32>dy * NMOUSE_SCALE)), 4);
  store<i32>(NM_D + (k << 3), <i32>nearest<f32>(<f32>dx * NMOUSE_SCALE)); store<i32>(NM_D + (k << 3), <i32>nearest<f32>(<f32>dy * NMOUSE_SCALE), 4);
  store<u32>(NM_STATE + (k << 2), state);
  if (state & MOUSE_ON_SURFACE) store<i32>(NM_LAST + (<usize>p << 2), side);
}
// A handle's player and Joy-Con: the player the npad shows (a split pair's other half included), -1 for none
let jSide: i32 = 0;
function jcmsTarget(h: u32): i32 {
  const id = h & 0xff, type = (h >> 8) & 0xff; if (type > 1 || id >= <u32>DM_PLAYERS) return -1;
  const pad = tPad(id); if (pad < 0) return -1;
  jSide = <i32>type; return pad;
}
function jcmsCopy(out: usize, n: i32, h: u32): i32 {
  view();
  const p = jcmsTarget(h);
  if (p < 0 || !out || n <= 0) return 0;
  const have = jcmsN(p, jSide); let k = 0;
  for (; k < n && k < <i32>JCMS_RING && have - k > 0; k++) copy(out + 32 * <usize>k, JCMS + ((ji(p, jSide) << 4) + <usize>((have - 1 - k) % JCMS_RING)) * 32, 32);
  return k;
}
function nmouseOf(h: u64): i32 {
  if ((h & ~<u64>0xffff) != NMOUSE_TAG) return -1;
  const p = jcmsTarget(<u32>((h >> 8) & 0xff) | <u32>(h & 1) << 8);
  return p >= 0 && jcmsN(p, jSide) ? p : -1;
}
export function h_hid_JcmsInit(a: usize): u64 { wanted(1, true); return 0; }
export function h_hid_JcmsFini(a: usize): u64 { wanted(1, false); return 0; }
export function h_hid_NmouseInit(a: usize): u64 { wanted(2, true); return 0; }
export function h_hid_NmouseInitT(a: usize): u64 { nmW = I(a, 2); nmH = I(a, 3); wanted(2, true); return 0; }
export function h_hid_NmouseFini(a: usize): u64 { wanted(2, false); return 0; }
export function h_hid_JcmsHandle(a: usize): u64 { return (load<u32>(P(a, 0)) & 0xff) | (load<u32>(P(a, 1)) & 0xff) << 8; }
export function h_hid_JcmsStates(a: usize): u64 { const h = P(a, 2); return h ? <u64><u32>jcmsCopy(P(a, 0), I(a, 1), load<u32>(h)) : 0; }
// The newest state alone: with no sensor, a cleared state (sampling number 0, no movement, attributes 0: not connected)
export function h_hid_JcmsState(a: usize): u64 { const out = P(a, 0), h = P(a, 1); if (out) { zero(out, 32); if (h) jcmsCopy(out, 1, load<u32>(h)); } return 0; }
export function h_hid_MouseSpeed(a: usize): u64 { return retF32(1.0); }
// A Joy-Con whose sensor reports has a pointer handle on its npad: NMOUSE_TAG | npad id << 8 | side. The Joy-Con last
// used on a surface comes first, and stays first while lifted
export function h_hid_NmouseHandles(a: usize): u64 {
  const o = P(a, 0), n = I(a, 1), id = W(a, 2);
  view();
  let k = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let side = 0; side < 2 && o && k < n; side++) {
      const h = NMOUSE_TAG | <u64>(id & 0xff) << 8 | <u64>side, p = nmouseOf(h); if (p < 0) continue;
      const last = load<i32>(NM_LAST + (<usize>p << 2)), first = last < 0 ? jSide == 1 : last == jSide;
      if (first == !pass) { store<u64>(o + (<usize>k << 3), h); k++; }
    }
  return <u64>k;
}
export function h_hid_NmouseSetRange(a: usize): u64 { nmW = I(a, 0); nmH = I(a, 1); return 0; }
export function h_hid_NmouseGetRange(a: usize): u64 { store<i32>(P(a, 0), nmW); store<i32>(P(a, 1), nmH); return 0; }
export function h_hid_NmouseEnable(a: usize): u64 { const h = X(a, 0); view(); return h == 0 || nmouseOf(h) >= 0 ? 1 : 0; }
export function h_hid_NmousePos(a: usize): u64 {
  const h = X(a, 0);
  view();
  const p = nmouseOf(h);
  if (p < 0) return h == 0 ? 1 : 0;
  const xy = NM_POS + (ji(p, jSide) << 3);
  store<f32>(xy, <f32>I(a, 1)); store<f32>(xy, <f32>I(a, 2), 4);
  return 1;
}
export function h_hid_NmouseState(a: usize): u64 {
  const out = P(a, 0), h = X(a, 1);
  view();
  const p = nmouseOf(h);
  if (p < 0 || !out) return 0;
  const side = jSide, k = ji(p, side), b = load<u64>(joy(p, side));
  zero(out, 48);
  store<i64>(out, jcmsN(p, side), 8);
  store<i32>(out, <i32>nearest<f32>(load<f32>(NM_POS + (k << 3))), 0x10); store<i32>(out, <i32>nearest<f32>(load<f32>(NM_POS + (k << 3), 4)), 0x14);
  store<i32>(out, load<i32>(NM_D + (k << 3)), 0x18); store<i32>(out, load<i32>(NM_D + (k << 3), 4), 0x1c);
  store<u32>(out, side ? ((b & BTN_R) ? 1 : 0) | ((b & BTN_ZR) ? 2 : 0) : ((b & BTN_L) ? 1 : 0) | ((b & BTN_ZL) ? 2 : 0), 0x28);
  store<u32>(out, 2 | ((load<u32>(NM_STATE + (k << 2)) & MOUSE_ON_SURFACE) ? 1 : 0), 0x2c);
  return 1;
}

// ---------------- vibration ----------------
// Vibration handles: byte 0 = the SDK's style index (FullKey 3, Handheld 4, JoyDual 5, JoyLeft 6, JoyRight 7), byte 1
// = npad id, byte 2 = motor. A Joy-Con style's handle reaches the pad's motor of its Joy-Con: the left one's is motor
// 0, the right one's motor 1, whichever npad the right one is on. The values go to haptics.ts, which hands every
// changed player state to the embedder (import hle_vibration)
let vMotor: i32 = 0;
function vibTargets(h: u32): u32 {
  const type = h & 0xff, id = (h >> 8) & 0xff, dev = (h >> 16) & 0xff;
  vMotor = <i32>(dev & 1);
  if ((h >> 24) || dev > 1 || type < 3 || type > 7) return 0;
  const pad = tPad(id), kind = tKind(id);
  if (type >= 5) {
    if (kind != (type == 5 ? KIND_DUAL : type == 6 ? KIND_LEFT : KIND_RIGHT) || (type != 5 && dev)) return 0;
    if (type != 5) vMotor = type == 7 ? 1 : 0;
    return hapticsAvailable() & (<u32>1 << pad);
  }
  const p = playerOf(id);
  // A full-key handle on an npad that now holds Joy-Cons still reaches them: a game keeps the handles it got before the
  // Joy-Cons connected. Its motor is the Joy-Con of that side; a single Joy-Con takes the handle of its side
  if (p >= 0 && kind >= KIND_DUAL && type == 3 && id != NPAD_HANDHELD) {
    if (kind == KIND_LEFT && dev) return 0;
    if (kind == KIND_RIGHT && !dev) return 0;
    return hapticsAvailable() & (<u32>1 << pad);
  }
  if (p < 0 || kind != KIND_PAD || styleOf(id) != (<u32>1 << (type - 3))) return 0;
  return hapticsAvailable() & (p == 0 ? 1 | mergedPlayers() : <u32>1 << p);
}
const UPD: usize = memory.data(384, 8);   // DM_PLAYERS * 2 updates of 24 bytes { i32 player, i32 motor, VibrationValue }
const IDLE: usize = memory.data(16);
function vibSend(handles: usize, values: usize, n: i32): void {
  if (!handles || !values || n <= 0) return;
  view();
  let used: u32 = 0;
  for (let i = 0; i < n; i++) {
    const targets = vibTargets(load<u32>(handles + (<usize>i << 2))), m = vMotor;
    for (let p = 0; p < DM_PLAYERS; p++) if ((targets >> p) & 1) {
      const k = p * 2 + m, u = UPD + <usize>k * 24;
      store<i32>(u, p); store<i32>(u, m, 4); copy(u + 8, values + (<usize>i << 4), 16); used |= 1 << k;
    }
  }
  let count = 0;
  for (let k = 0; k < DM_PLAYERS * 2; k++) if ((used >> k) & 1) { if (count != k) copy(UPD + <usize>count * 24, UPD + <usize>k * 24, 24); count++; }
  hapticsSend(UPD, count);
}
export function h_hid_VibPermit(a: usize): u64 { return hapticsAvailable() != 0 ? 1 : 0; }
// On Horizon handles are computed from npad id and style, so they are handed out before an output is routed, and with
// rumble off too (IsVibrationPermitted answers false then): vibSend checks for an output at each send
export function h_hid_VibHandles(a: usize): u64 {
  const h = P(a, 0), n = I(a, 1), idp = P(a, 2), style = W(a, 3);
  view();
  if (!h || !idp || n <= 0 || !(style & styleOf(load<u32>(idp))) || !hapticsHasOutput()) return 0;
  const id = load<u32>(idp), kind = tKind(id);
  const type: u32 = kind == KIND_DUAL ? 5 : kind == KIND_LEFT ? 6 : kind == KIND_RIGHT ? 7 : id == NPAD_HANDHELD ? 4 : 3;
  const base = (id << 8) | type, most = kind == KIND_LEFT || kind == KIND_RIGHT ? 1 : 2, count = n < most ? n : most;
  for (let i = 0; i < count; i++) store<u32>(h + (<usize>i << 2), base | <u32>i << 16);
  return <u64>count;
}
export function h_hid_InitVib(a: usize): u64 { idleValue(IDLE); vibSend(P(a, 0), IDLE, 1); return 0; }
export function h_hid_SendVib(a: usize): u64 { vibSend(P(a, 0), P(a, 1), 1); return 0; }
export function h_hid_SendVibs(a: usize): u64 { vibSend(P(a, 0), P(a, 1), I(a, 2)); return 0; }
// VibrationDeviceInfo = { device type (1 linear resonant actuator), position (1 left, 2 right) }
export function h_hid_VibInfo(a: usize): u64 {
  const info = P(a, 0), h = P(a, 1);
  view();
  const on = h != 0 && vibTargets(load<u32>(h)) != 0;
  store<u32>(info, on ? 1 : 0); store<u32>(info, on ? 1 + <u32>vMotor : 0, 4);
  return 0;
}
// Mounted when the channel has an output, as GetVibrationDeviceInfo reports it
export function h_hid_VibMounted(a: usize): u64 { const h = P(a, 0); view(); return h != 0 && vibTargets(load<u32>(h)) != 0 ? 1 : 0; }
export function h_hid_VibMountedOunce(a: usize): u64 { return h_hid_VibMounted(a); }
// The value last accepted for the channel (the sanitized guest value, before output-device adaptation)
export function h_hid_VibActual(a: usize): u64 {
  const v = P(a, 0), h = P(a, 1);
  view();
  const targets = h ? vibTargets(load<u32>(h)) : 0;
  if (targets) hapticsActual(<i32>ctz<u32>(targets), vMotor, v); else idleValue(v);
  return 0;
}

// ---------------- mouse, keyboard, debug pad: not connected ----------------
// MouseState is 0x28 bytes, KeyboardState 0x30, DebugPadState 32: zeroed with a sampling number; attributes 0 = not connected
export function h_hid_MouseState(a: usize): u64 { const s = P(a, 0); zero(s, 0x28); store<i64>(s, ++sampling); return 0; }
export function h_hid_KbdState(a: usize): u64 { const s = P(a, 0); zero(s, 0x30); store<i64>(s, ++sampling); return 0; }
// The history forms: every requested entry, newest first, with consecutive sampling numbers
function history(a: usize, size: usize): u64 {
  const s = P(a, 0), n = I(a, 1), top = ++sampling;
  for (let i = 0; i < n; i++) { zero(s + size * <usize>i, size); store<i64>(s + size * <usize>i, top - i); }
  return n > 0 ? <u64>n : 0;
}
export function h_hid_KbdStates(a: usize): u64 { return history(a, 0x30); }
export function h_hid_DbgPadStates(a: usize): u64 { return history(a, 32); }

// ---------------- touch screen and gestures ----------------
// Filled from the embedder's touch points in handheld mode, as on the Switch, whose screen is out of reach when
// docked: a game may read touches without checking the mode, so in console mode the state stays empty (only the
// header is written)
function touchRead(s: usize, n: i32): void {
  if (dmOpmode() == 0) { touchFillN(s, n, monoNs()); return; }
  store<i64>(s, ++sampling); store<i32>(s, 0, 8); store<i32>(s, 0, 12);
}
function touch1(a: usize, n: i32): u64 { touchRead(P(a, 0), n); return 0; }
function touchN(a: usize, n: i32): u64 { if (I(a, 1) <= 0) return 0; touchRead(P(a, 0), n); return 1; }
// GetTouchScreenState<N> and GetTouchScreenStates<N> (1 entry), N = 1..16: nxnative's TOUCH(N)
export function h_hid_Touch1_1(a: usize): u64 { return touch1(a, 1); }
export function h_hid_TouchN_1(a: usize): u64 { return touchN(a, 1); }
export function h_hid_Touch1_2(a: usize): u64 { return touch1(a, 2); }
export function h_hid_TouchN_2(a: usize): u64 { return touchN(a, 2); }
export function h_hid_Touch1_3(a: usize): u64 { return touch1(a, 3); }
export function h_hid_TouchN_3(a: usize): u64 { return touchN(a, 3); }
export function h_hid_Touch1_4(a: usize): u64 { return touch1(a, 4); }
export function h_hid_TouchN_4(a: usize): u64 { return touchN(a, 4); }
export function h_hid_Touch1_5(a: usize): u64 { return touch1(a, 5); }
export function h_hid_TouchN_5(a: usize): u64 { return touchN(a, 5); }
export function h_hid_Touch1_6(a: usize): u64 { return touch1(a, 6); }
export function h_hid_TouchN_6(a: usize): u64 { return touchN(a, 6); }
export function h_hid_Touch1_7(a: usize): u64 { return touch1(a, 7); }
export function h_hid_TouchN_7(a: usize): u64 { return touchN(a, 7); }
export function h_hid_Touch1_8(a: usize): u64 { return touch1(a, 8); }
export function h_hid_TouchN_8(a: usize): u64 { return touchN(a, 8); }
export function h_hid_Touch1_9(a: usize): u64 { return touch1(a, 9); }
export function h_hid_TouchN_9(a: usize): u64 { return touchN(a, 9); }
export function h_hid_Touch1_10(a: usize): u64 { return touch1(a, 10); }
export function h_hid_TouchN_10(a: usize): u64 { return touchN(a, 10); }
export function h_hid_Touch1_11(a: usize): u64 { return touch1(a, 11); }
export function h_hid_TouchN_11(a: usize): u64 { return touchN(a, 11); }
export function h_hid_Touch1_12(a: usize): u64 { return touch1(a, 12); }
export function h_hid_TouchN_12(a: usize): u64 { return touchN(a, 12); }
export function h_hid_Touch1_13(a: usize): u64 { return touch1(a, 13); }
export function h_hid_TouchN_13(a: usize): u64 { return touchN(a, 13); }
export function h_hid_Touch1_14(a: usize): u64 { return touch1(a, 14); }
export function h_hid_TouchN_14(a: usize): u64 { return touchN(a, 14); }
export function h_hid_Touch1_15(a: usize): u64 { return touch1(a, 15); }
export function h_hid_TouchN_15(a: usize): u64 { return touchN(a, 15); }
export function h_hid_Touch1_16(a: usize): u64 { return touch1(a, 16); }
export function h_hid_TouchN_16(a: usize): u64 { return touchN(a, 16); }
export function h_hid_Gestures(a: usize): u64 { return dmOpmode() == 0 ? <u64><u32>gestureFill(P(a, 0), I(a, 1), monoNs()) : 0; }

// ---------------- the embedder's snapshot ----------------
// One player's whole input. player 0..7: that player; -1: the player slot of the snapshot's source id (padslots.ts:
// taken when the snapshot says connected, freed when it does not). Returns the player, -1 when there is none
export function inputSet(p: i32, s: usize): i32 {
  if (p < 0) {
    const id = load<u32>(s, 4);
    p = (load<u32>(s) & IN_CONNECTED) ? padSlotTake(id) : padSlotFree(id);
    if (p < 0) return -1;
  }
  if (p >= DM_PLAYERS) return -1;
  const dst = snap(p), conn = p == 0 || (load<u32>(s) & IN_CONNECTED) != 0;
  const oldFlags = sFlags(p), oldB = sBtn(p), oldJ0 = load<u64>(joy(p, 0)), oldJ1 = load<u64>(joy(p, 1));
  if (conn) copy(dst, s, SNAP_SIZE);
  else { zero(dst, SNAP_SIZE); store<u32>(dst, load<u32>(s, 4), 4); }   // a controller that went away leaves nothing pressed
  let fl = load<u32>(dst);
  if (!(fl & IN_JOY_L)) zero(joy(p, 0), JOY_SIZE);
  if (!(fl & IN_JOY_R)) zero(joy(p, 1), JOY_SIZE);
  // which players have a controller
  setPlayers((players & ~(<u32>1 << p)) | (conn ? <u32>1 << p : 0));
  // which Joy-Cons the pad holds: the style events tell the game that its npads changed
  if (((oldFlags >> 4) & 3) != ((fl >> 4) & 3)) { for (let i: u32 = 0; i < <u32>DM_PLAYERS; i++) styleChanged(i); }
  // press edges are latched until the game's next read, so a short press is not lost
  const b = sBtn(p), edge = b & ~oldB;
  store<u64>(latch(p), load<u64>(latch(p)) | edge); peekLatch |= edge;
  store<u64>(jlatch(p, 0), load<u64>(jlatch(p, 0)) | (load<u64>(joy(p, 0)) & ~oldJ0));
  store<u64>(jlatch(p, 1), load<u64>(jlatch(p, 1)) | (load<u64>(joy(p, 1)) & ~oldJ1));
  if (p == 0) shakeNote();
  // motion
  if (!conn) fl |= IN_CLR_MOTION | IN_CLR_RAW | IN_CLR_JMOTION_L | IN_CLR_JMOTION_R;
  if (fl & IN_CLR_MOTION) store<u64>(lm(LM_GC + p), 0, 80);
  if (fl & IN_CLR_RAW) store<u64>(lm(LM_RAW + p), 0, 80);
  if (fl & IN_MOTION) motionSetTo(lm(LM_GC + p), p, dst + S_MOTION, dst + S_MOTION + 12, 0, 0);
  if (fl & IN_RAW) { const t = load<u64>(dst + S_RAW, 24); if (t) motionSetTo(lm(LM_RAW + p), p, dst + S_RAW, dst + S_RAW + 12, 2, t); }
  if ((fl & IN_CONSOLE) && p == 0) motionSetTo(lm(LM_PHONE), 0, dst + S_CONSOLE, dst + S_CONSOLE + 12, 1, 0);
  for (let side = 0; side < 2; side++) {
    const j = joy(p, side), m = lm(LM_JOY + p * 2 + side);
    if (fl & (IN_CLR_JMOTION_L << side)) store<u64>(m, 0, 80);
    if (fl & (IN_JMOTION_L << side)) { const t = load<u64>(j, 0x28); if (t) motionSetTo(m, p, j + 0x10, j + 0x1c, 2, t); }
    if (fl & (IN_MOUSE_L << side)) { const q = dst + S_MOUSE + <usize>side * 12; joyMouse(p, side, load<i32>(q), load<i32>(q, 4), load<u32>(q, 8)); }
  }
  // the screen
  if ((fl & IN_TOUCH) && p == 0) { const n = load<u32>(dst, S_NTOUCH); touchApply(dst + S_TOUCH, n > 16 ? 16 : <i32>n); }
  // the controller's motor
  const routed = (fl & IN_RUMBLE) != 0;
  if (routed != hapticsRouted(p)) hapticsRoute(p, routed);
  return p;
}

export function hidInit(): void {
  zero(SNAP, 3456); zero(LATCH, 64); zero(JLATCH, 128); zero(SINGLE_KEEP, 32); zero(STYLE_EV, 64); zero(LM, 3432);
  zero(JCMS, 8192); zero(JCMS_N, 128); zero(NM_POS, 128); zero(NM_D, 128); zero(NM_STATE, 64);
  for (let p = 0; p < DM_PLAYERS; p++) store<i32>(NM_LAST + (<usize>p << 2), -1);
  peekLatch = 0; sampling = 1 << 16; players = 1; idsSupported = 0x3ff; stylesSupported = 0xffffffff; singleMask = 0;
  holdType = 0; commMode = 0; hhMode = 0; mergedLast = 0;
  shake().init(SIX_SHAKE, 0); shakeT0 = 0; shakeEnd = 0; shakeOn = false;
  for (let r = 1; r <= HOLD_REASONS; r++) holder(r).init(INPUT_HOLD, <u32>r);
  prompt().init(CTRL_PROMPT, 0); promptR = 0; promptW = 0;
  motionReady = false; motionOff = false; motionLog = false; phoneMode = -1; motionGain = 0.5;
  jcmsWanted = 0; nmW = 0; nmH = 0;
  padSlotsInit(); touchInit(); hapticsReset();
  store<u32>(snap(0), IN_CONNECTED);
  view();
}
