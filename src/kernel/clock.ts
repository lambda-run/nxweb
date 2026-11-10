// The guest clock (nxnative hle_os.c). Time is an input: the embedder passes the host's monotonic ns to
// kernel_tick, and nothing here reads a clock. The machine `guest_clock` holds the whole state: its state number is
// the set of freeze reasons, and it carries the lag while running or the guest ns it stands at while frozen.
import { Inst } from "../kit/machine";
import { GUEST_CLOCK } from "../kit/gen/tables";

export const REASON_HOLD: u32 = 0;         // a test or loading-screen hold (nxnative guest_clock_freeze)
export const REASON_BACKGROUND: u32 = 1;   // the app is not in focus: guest reads of the counter wait
export const REASON_KEYBOARD: u32 = 2;     // the system keyboard is up
export const REASON_COUNT: u32 = 3;

const CLK: usize = memory.data(16);
let hostNow: u64 = 0;
let switch2: bool = false;
let rng: u64 = 0x5357444554524e47;

export function clockInit(isSwitch2: bool): void {
  Inst.at(CLK).init(GUEST_CLOCK, 0);
  hostNow = 0; switch2 = isSwitch2; rng = 0x5357444554524e47;
}
// The host's time moved on (never backwards)
export function clockSetNow(now: u64): void { if (now > hostNow) hostNow = now; }
export function clockHostNow(): u64 { return hostNow; }
// The reason set, bit n = reason n: one byte, one snapshot
// @ts-ignore: decorator
@inline export function clockReasons(): u32 { return Inst.at(CLK).state; }
export function guestNs(): u64 {
  const c = Inst.at(CLK);
  return c.state ? c.data : hostNow - c.data;
}
// The system counter: 19.2 MHz on the Switch, 31.25 MHz (32 ns a tick) on the Switch 2
export function guestTicks(): u64 {
  const ns = guestNs();
  return switch2 ? ns / 32 : ns * 12 / 625;
}
// The host time at which the guest clock reaches guestDeadline; FOREVER while the clock stands
export function hostTimeOf(guestDeadline: u64): u64 {
  const c = Inst.at(CLK);
  if (c.state) return u64.MAX_VALUE;
  return guestDeadline > u64.MAX_VALUE - c.data ? u64.MAX_VALUE : guestDeadline + c.data;
}
// Hold or release one reason. Returns the reasons that ended (a bit mask): the caller wakes what waited for them.
export function clockFreeze(reason: u32, on: bool): u32 {
  if (reason >= REASON_COUNT) return 0;
  const c = Inst.at(CLK);
  const was: u32 = c.state, g = guestNs(), bit: u32 = 1 << reason;
  const to = on ? was | bit : was & ~bit;
  // the value the target state carries: the new lag when the clock starts again, else where it stands
  c.step(<u8>(reason * 2 + (on ? 0 : 1)), to ? g : hostNow - g);
  return was & ~<u32>c.state;
}
// GetInfo RandomEntropy: a deterministic splitmix64 stream (nxnative's stream under DM_DETCLOCK, same seed)
export function entropy64(): u64 {
  rng += 0x9E3779B97F4A7C15;
  let z = rng;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) * 0x94D049BB133111EB; z ^= z >> 31;
  return z;
}
export function entropySeed(seed: u64): void { rng = seed; }
