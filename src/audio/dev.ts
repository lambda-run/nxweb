// What the module knows about time and about the device: inputs only. Nothing here reads a clock or calls a browser
// API; the embedder gives the two clocks to audio_tick and the device's state to audio_device_state, and the
// device's callbacks are seen as the ring header's callback counter moving.

// ---- the clocks (audio_tick) ----
export let gNow: u64 = 0;      // guest clock, ns: what the silent sink consumes on
export let hNow: u64 = 0;      // host clock, ns: only differences are used
// The watchdog's clock, microseconds: host time that does not advance over a gap of more than WATCH_GAP_US between
// two ticks. A page or Worker that was frozen (or a tick that came late) then does not look like a device that
// stopped calling back, as nxnative's watchdog restarts its count after a late wake-up of its own.
export let wNow: u64 = 0;
export const WATCH_GAP_US: u64 = 200000;
let hLast: u64 = 0, ticked = false;

export function setTime(guestNs: u64, hostNs: u64): void {
  if (guestNs > gNow) gNow = guestNs;   // the guest clock never runs backwards
  if (ticked) { const gap = hostNs > hLast ? (hostNs - hLast) / 1000 : 0; if (gap <= WATCH_GAP_US) wNow += gap; }
  ticked = true; hLast = hostNs; hNow = hostNs;
}

// ---- the device ----
export const DEV_NONE: u8 = 0;       // not asked to run, or stopped by the module's own audio_dev_stop
export const DEV_STARTING: u8 = 1;   // asked; an AudioContext that waits for a user gesture stays here
export const DEV_RUNNING: u8 = 2;    // the context runs; callbacks are expected
export const DEV_FAILED: u8 = 3;     // the start was refused
export const DEV_LOST: u8 = 4;       // the browser suspended, interrupted or closed it while it ran

export let attached = false;   // a device exists at all (false under Node and wherever there is no AudioContext)
export let rate: u32 = 48000;  // the device's sample rate
export let target: u32 = 1920; // frames the mixer keeps ahead of the device in the ring
export let state: u8 = DEV_NONE;
export let stateAt: u64 = 0;   // wNow when the state was reported
export let cbAt: u64 = 0;      // wNow when the callback counter was last seen to move
let cbSeen: u32 = 0;
export let hidden = false;     // the page is hidden (audio_suspend): outputs are Suspended

export function setHidden(on: bool): void { hidden = on; }
export function setState(s: u8): void { state = s; stateAt = wNow; }

// ---- the ring the device reads: interleaved stereo f32 at the device rate ----
// Header, 8 u32 words. The module writes `wr` and the frames; the device side (an AudioWorklet reading the shared
// memory, or the glue on its behalf when it feeds the worklet by messages) writes rd, underrun and callbacks.
//   +0 wr         frames written since attach (wraps at 2^32)
//   +4 rd         frames the device has taken
//   +8 cap        capacity in frames, a power of two
//   +12 underrun  frames the device had to fill with silence because the ring was empty
//   +16 callbacks device callbacks so far (the watchdog's evidence)
//   +20 live      outputs the mixer is playing; with 0 an empty ring is not an underrun
//   +24 rate      the device rate the frames are in
//   +28 target
export const RING_CAP: u32 = 8192;
export const RING: usize = memory.data(32);
export const RING_DATA: usize = memory.data(65536);   // RING_CAP * 2 * 4
export const R_WR: usize = 0, R_RD: usize = 4, R_CAP: usize = 8, R_UNDER: usize = 12, R_CB: usize = 16, R_LIVE: usize = 20, R_RATE: usize = 24, R_TARGET: usize = 28;

// @ts-ignore: decorator
@inline export function ringGet(off: usize): u32 { return ASC_FEATURE_THREADS ? atomic.load<u32>(RING + off) : load<u32>(RING + off); }
// @ts-ignore: decorator
@inline export function ringSet(off: usize, v: u32): void { if (ASC_FEATURE_THREADS) atomic.store<u32>(RING + off, v); else store<u32>(RING + off, v); }

export function attach(deviceRate: u32, targetFrames: u32): void {
  attached = deviceRate != 0;
  rate = deviceRate ? deviceRate : 48000;
  target = targetFrames ? min(targetFrames, RING_CAP - 256) : min(rate / 25, RING_CAP - 256);   // 40 ms by default
  ringSet(R_WR, 0); ringSet(R_RD, 0); ringSet(R_UNDER, 0); ringSet(R_CB, 0);
  ringSet(R_CAP, RING_CAP); ringSet(R_LIVE, 0); ringSet(R_RATE, rate); ringSet(R_TARGET, target);
  cbSeen = 0; cbAt = wNow; state = DEV_NONE; stateAt = wNow;
}

// Look at the callback counter (once per tick)
export function observe(): void {
  const cb = ringGet(R_CB);
  if (cb != cbSeen) { cbSeen = cb; cbAt = wNow; }
}
