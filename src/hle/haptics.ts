// Game vibration state before it is adapted to a device: port of nxnative dm/host/hle_haptics.c (no table entries of
// its own; hid.ts's vibration take-overs feed it). nn::hid vibration is persistent device state: a motor keeps its
// value until it is written again. The embedder is the sink: import hle_vibration(state) gets every changed player
// state, in order.
//   dm_haptic_state (48 bytes): +0 i32 player, +8 u64 epoch (a changed epoch invalidates everything queued before),
//   +16 two motors (left, right), each a VibrationValue { f32 amplitude low, frequency low, amplitude high, frequency high }
// Not ported: dm_haptics_level (the Core Haptics intensity / sharpness mapping), which is the Apple output's.
import { DM_PLAYERS } from "./padslots";

// @ts-ignore: decorator
@external("env", "hle_vibration")
declare function envVibration(state: usize): void;

const STATES: usize = memory.data(384, 8);   // DM_PLAYERS * 48
const TMP: usize = memory.data(16);
let output: bool = false, enabled: bool = false, available: u32 = 0, suspended: u32 = 0;
export const HAPTICS_INACTIVE: u32 = 1, HAPTICS_INTERRUPTED: u32 = 2;

// @ts-ignore: decorator
@inline function st(p: i32): usize { return STATES + <usize>p * 48; }
// @ts-ignore: decorator
@inline function valid(p: i32): bool { return p >= 0 && p < DM_PLAYERS; }
export function idleValue(v: usize): void { store<f32>(v, 0); store<f32>(v, 160, 4); store<f32>(v, 0, 8); store<f32>(v, 320, 12); }
function clearLocked(p: i32): void {
  const s = st(p);
  store<i32>(s, p); store<u64>(s, load<u64>(s, 8) + 1, 8);
  idleValue(s + 16); idleValue(s + 32);
  if (output) envVibration(s);
}
export function hapticsReset(): void { memory.fill(STATES, 0, 384); output = false; enabled = false; available = 0; suspended = 0; }
// sink: the embedder plays vibration (import hle_vibration); on: rumble is switched on
export function hapticsInit(sink: bool, on: bool): void {
  output = sink; enabled = on; available = 0; suspended = 0;
  for (let p = 0; p < DM_PLAYERS; p++) clearLocked(p);
}
// The player's rumble switch while the game runs: off stops every motor at once
export function hapticsSetEnabled(on: bool): void {
  if (enabled != on) { enabled = on; for (let p = 0; p < DM_PLAYERS; p++) clearLocked(p); }
}
export function hapticsHasOutput(): bool { return output; }
// Player p's controller has (or lost) a motor; clears the old state even when the availability stays the same
export function hapticsRoute(p: i32, on: bool): void {
  if (!valid(p)) return;
  if (on) available |= 1 << p; else available &= ~(<u32>1 << p);
  clearLocked(p);
}
export function hapticsRouted(p: i32): bool { return valid(p) && ((available >> p) & 1) != 0; }
export function hapticsClear(p: i32): void { if (valid(p)) clearLocked(p); }
export function hapticsEpoch(p: i32): u64 { return valid(p) ? load<u64>(st(p), 8) : 0; }
export function hapticsEnabled(): bool { return enabled && output; }
export function hapticsAvailable(): u32 { return enabled && output ? available : 0; }
export function hapticsSuspend(reason: u32, on: bool): void {
  const before = suspended;
  if (on) suspended |= reason; else suspended &= ~reason;
  if (before != suspended) for (let p = 0; p < DM_PLAYERS; p++) clearLocked(p);
}
function amplitude(x: f32): f32 { return isFinite<f32>(x) ? Mathf.max(0, Mathf.min(1, x)) : 0; }
function frequency(x: f32, fallback: f32): f32 { return isFinite<f32>(x) && x > 0 ? Mathf.max(40, Mathf.min(1250, x)) : fallback; }
// One atomic batch: n updates of 24 bytes { i32 player, i32 motor, VibrationValue }
export function hapticsSend(u: usize, n: i32): void {
  if (!u || n <= 0) return;
  if (!enabled || !output || suspended) return;
  let changed: u32 = 0;
  for (let i = 0; i < n; i++) {
    const e = u + <usize>i * 24, p = load<i32>(e), m = load<i32>(e, 4);
    if (!valid(p) || m < 0 || m > 1 || !((available >> p) & 1)) continue;
    store<f32>(TMP, amplitude(load<f32>(e, 8))); store<f32>(TMP, frequency(load<f32>(e, 12), 160), 4);
    store<f32>(TMP, amplitude(load<f32>(e, 16)), 8); store<f32>(TMP, frequency(load<f32>(e, 20), 320), 12);
    const cur = st(p) + 16 + (<usize>m << 4);
    if (memory.compare(TMP, cur, 16) == 0) continue;
    memory.copy(cur, TMP, 16); changed |= 1 << p;
  }
  for (let p = 0; p < DM_PLAYERS; p++) if ((changed >> p) & 1) envVibration(st(p));
}
// The value last accepted for a motor (the idle value when it has none) at out
export function hapticsActual(p: i32, m: i32, out: usize): void {
  if (enabled && !suspended && valid(p) && m >= 0 && m < 2 && ((available >> p) & 1)) memory.copy(out, st(p) + 16 + (<usize>m << 4), 16);
  else idleValue(out);
}
