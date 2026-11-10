// The device side of the Live outputs: pull their PCM16, apply each output's volume, bring them to stereo, mix them
// (up to AOMAX outputs), resample 48 kHz to the device rate and write interleaved f32 into the ring the device reads.
import { AudioOutS } from "../kit/gen/tables";
import { red, end, puts, putu, RATE } from "./base";
import * as dev from "./dev";
import { Out, outAt, AOMAX, pull, queuedFrames } from "./out";

// ---- one output's frames as stereo f32, added to an accumulator ----
const BLOCK: u32 = 256;
const SCRATCH: usize = memory.data(4096);   // BLOCK frames of up to 8 channels, 16 bit
// nxnative's 6 -> 2 downmix (the audio renderer's default Q15 coefficients): front 1.0, center 0.707, LFE 0.251, back 0.707
const CF: i64 = 32768, CC: i64 = 23167, CL: i64 = 8224, CB: i64 = 23167;
const INV: f32 = 1.0 / 32768.0;

// @ts-ignore: decorator
@inline function sat16(v: i64): i32 { return <i32>(v > 32767 ? 32767 : v < -32768 ? -32768 : v); }

// The output's volume (SetAudioOutVolume) on PCM16, saturating, as the audout session applies it
function gain(p: usize, n: u32, v: f32): void {
  for (let i: u32 = 0; i < n; i++) {
    const x = <f32>load<i16>(p + (<usize>i << 1)) * v;
    store<i16>(p + (<usize>i << 1), <i16>(x > 32767.0 ? 32767.0 : x < -32768.0 ? -32768.0 : x));
  }
}

// frames (at most BLOCK) of output o, added to acc (stereo f32)
function addStereo(o: Out, acc: usize, frames: u32): void {
  const ch = o.ch, c = min(ch, 8);
  if (ch > 8) {   // not a real layout: consume it, play nothing
    for (let left = frames * ch * 2; left;) { const k = min(left, 4096); pull(o, SCRATCH, k); left -= k; }
    return;
  }
  pull(o, SCRATCH, frames * c * 2);
  if (o.vol != 1.0) gain(SCRATCH, frames * c, o.vol);
  if (c == 6) {
    for (let i: u32 = 0; i < frames; i++) {
      const p = SCRATCH + <usize>i * 12, a = acc + (<usize>i << 3);
      const cc = <i64>load<i16>(p, 4) * CC + <i64>load<i16>(p, 6) * CL;
      const l = sat16((<i64>load<i16>(p) * CF + cc + <i64>load<i16>(p, 8) * CB) >> 15);
      const r = sat16((<i64>load<i16>(p, 2) * CF + cc + <i64>load<i16>(p, 10) * CB) >> 15);
      store<f32>(a, load<f32>(a) + <f32>l * INV); store<f32>(a, load<f32>(a, 4) + <f32>r * INV, 4);
    }
  } else if (c == 1) {
    for (let i: u32 = 0; i < frames; i++) {
      const a = acc + (<usize>i << 3), s = <f32>load<i16>(SCRATCH + (<usize>i << 1)) * INV;
      store<f32>(a, load<f32>(a) + s); store<f32>(a, load<f32>(a, 4) + s, 4);
    }
  } else {
    const fb = <usize>c * 2;
    for (let i: u32 = 0; i < frames; i++) {
      const p = SCRATCH + <usize>i * fb, a = acc + (<usize>i << 3);
      store<f32>(a, load<f32>(a) + <f32>load<i16>(p) * INV); store<f32>(a, load<f32>(a, 4) + <f32>load<i16>(p, 2) * INV, 4);
    }
  }
}

// ---- resampler: 48 kHz -> device rate, a polyphase windowed sinc ----
// in/out = M/L in lowest terms (48000 -> 44100: 160/147). One filter of TAPS taps per phase, Kaiser window, cutoff
// at 0.96 of the lower Nyquist frequency; evaluated TAPS/2 input frames late so every tap is known.
export const TAPS: i32 = 32;
const MAXPHASE: u32 = 640;
const KAISER_BETA: f64 = 8.6;
const TABLE: usize = memory.data(81920);        // MAXPHASE * TAPS f32
const IN_CAP: u32 = 1024;                       // new input frames per pass
const INBUF: usize = memory.data(8448);         // (TAPS + IN_CAP) stereo f32
let rsL: u32 = 1, rsM: u32 = 1, rsRate: u32 = 0;
let rsQ: i32 = 0;   // position of the next output in 1/L input frames, relative to INBUF's frame TAPS - 1; >= -L

function gcd(a: u32, b: u32): u32 { while (b) { const t = a % b; a = b; b = t; } return a; }
function bessel0(x: f64): f64 { let sum = 1.0, t = 1.0; for (let k = 1; k < 40; k++) { t *= (x / (2.0 * k)) * (x / (2.0 * k)); sum += t; } return sum; }

export function resamplerSet(inRate: u32, outRate: u32): void {
  if (rsRate == outRate) return;
  rsRate = outRate;
  const g = gcd(inRate, outRate);
  rsL = outRate / g; rsM = inRate / g;
  if (rsL > MAXPHASE) {   // not a rate a device has: the nearest ratio of MAXPHASE phases, and a red line
    red(); puts("audio: device rate "); putu(outRate); puts(" Hz needs "); putu(rsL); puts(" filter phases, only "); putu(MAXPHASE); puts(" are kept: resampled at the nearest ratio"); end();
    rsM = <u32>(<u64>inRate * MAXPHASE / outRate); rsL = MAXPHASE; if (!rsM) rsM = 1;
  }
  rsQ = 0;
  memory.fill(INBUF, 0, <usize>TAPS * 8);
  if (rsL == rsM) return;
  const fc = 0.96 * (rsL < rsM ? <f64>rsL / <f64>rsM : 1.0), half = <f64>(TAPS / 2), i0b = bessel0(KAISER_BETA);
  for (let p: u32 = 0; p < rsL; p++) {
    let sum = 0.0;
    const row = TABLE + <usize>p * <usize>TAPS * 4;
    for (let k = 0; k < TAPS; k++) {
      const x = <f64>p / <f64>rsL + half - 1.0 - <f64>k;
      const s = x == 0.0 ? fc : Math.sin(Math.PI * fc * x) / (Math.PI * x);
      const t = x / half, w = t > -1.0 && t < 1.0 ? bessel0(KAISER_BETA * Math.sqrt(1.0 - t * t)) / i0b : 0.0;
      const h = s * w;
      store<f32>(row + (<usize>k << 2), <f32>h); sum += h;
    }
    for (let k = 0; k < TAPS; k++) store<f32>(row + (<usize>k << 2), <f32>(<f64>load<f32>(row + (<usize>k << 2)) / sum));   // unity gain at 0 Hz in every phase
  }
}
// Input frames the next nOut output frames need
// @ts-ignore: decorator
@inline function needIn(nOut: u32): u32 { return <u32>((<i64>rsQ + <i64>rsL + <i64>(nOut - 1) * <i64>rsM) / <i64>rsL); }

// ---- the mix ----
const MIXOUT: usize = memory.data(2048);   // BLOCK stereo f32

function liveCount(): i32 {
  let n = 0;
  for (let i = 0; i < AOMAX; i++) { const o = outAt(i); if (o.used && o.state == AudioOutS.Live) n++; }
  return n;
}
// n frames of the sum of all Live outputs at 48 kHz into acc (stereo f32, cleared first)
function mixIn(acc: usize, n: u32): void {
  memory.fill(acc, 0, <usize>n << 3);
  for (let i = 0; i < AOMAX; i++) {
    const o = outAt(i);
    if (!o.used || o.state != AudioOutS.Live) continue;
    for (let done: u32 = 0; done < n;) { const k = min(n - done, BLOCK); addStereo(o, acc + (<usize>done << 3), k); done += k; }
  }
}

// nOut (at most BLOCK) device frames into MIXOUT
function produce(nOut: u32): void {
  if (rsL == rsM) { mixIn(MIXOUT, nOut); return; }
  const n = needIn(nOut);   // <= IN_CAP: nOut <= 256 and M/L <= 4 for every rate from 12 kHz up
  const fresh = INBUF + <usize>TAPS * 8;
  if (n) mixIn(fresh, n);
  let q = rsQ;
  const L = <i32>rsL, M = <i32>rsM;
  for (let j: u32 = 0; j < nOut; j++, q += M) {
    const qq = q + L, idx = qq / L, row = TABLE + <usize>(qq - idx * L) * <usize>TAPS * 4;   // idx = floor(q / L) + 1: the first tap's frame in INBUF
    const x = INBUF + (<usize>idx << 3);
    let l: f32 = 0, r: f32 = 0;
    for (let k = 0; k < TAPS; k++) {
      const c = load<f32>(row + (<usize>k << 2));
      l += c * load<f32>(x + (<usize>k << 3)); r += c * load<f32>(x + (<usize>k << 3), 4);
    }
    store<f32>(MIXOUT + (<usize>j << 3), l); store<f32>(MIXOUT + (<usize>j << 3), r, 4);
  }
  rsQ = q - <i32>n * L;
  if (n) memory.copy(INBUF, INBUF + (<usize>n << 3), <usize>TAPS * 8);   // the last TAPS frames stay for the next pass
}

let mixedFrames: u64 = 0, paddedFrames: u64 = 0;
let primed = false;   // the ring holds its lead of silence for the current run of Live outputs
export function mixed(): u64 { return mixedFrames; }
export function padded(): u64 { return paddedFrames; }

function put(wr: u32, n: u32): void {
  for (let i: u32 = 0; i < n; i++) {
    const s = MIXOUT + (<usize>i << 3), d = dev.RING_DATA + (<usize>((wr + i) & (dev.RING_CAP - 1)) << 3);
    const l = load<f32>(s), r = load<f32>(s, 4);
    store<f32>(d, l > 1.0 ? 1.0 : l < -1.0 ? -1.0 : l); store<f32>(d, r > 1.0 ? 1.0 : r < -1.0 ? -1.0 : r, 4);
  }
}
// Device frames the Live outputs can supply right now without any of them running empty: the least over the
// outputs that have something queued (an output with nothing queued does not hold the others back; it underruns)
function supply(): u32 {
  let least: u64 = u64.MAX_VALUE;
  for (let i = 0; i < AOMAX; i++) {
    const o = outAt(i);
    if (!o.used || o.state != AudioOutS.Live) continue;
    const f = queuedFrames(o);
    if (f && f < least) least = f;
  }
  if (least == u64.MAX_VALUE) return 0;
  if (rsL == rsM) return <u32>min(least, 0x7FFFFFFF);
  const t = <i64>min(least, 0x100000) * <i64>rsL - <i64>rsQ - 1;   // the most outputs whose input is at hand: needIn(n) <= least
  return t < 0 ? 0 : <u32>(t / <i64>rsM) + 1;
}

// Once per tick. The ring is kept `target` frames ahead of the device, so the Live outputs are consumed at the
// device's own pace: what is mixed is what the device took since the last tick, as nxnative pulls what a device
// callback asks for.
//  - The lead is silence, written once when the first output goes Live: going Live does not swallow 40 ms of the
//    game's queue at once.
//  - After a late tick the device has taken more than the game keeps queued (a renderer has 20 ms in flight). The
//    outputs are then asked only for what they have; the game is woken by those releases and appends, and the rest
//    is mixed in the following ticks. The ring's lead absorbs the lateness instead of the game's queue.
//  - Only when the ring is down to a quarter of its lead is silence mixed for whatever an output lacks: that is the
//    output's underrun, counted on it. The ring is then filled to its whole lead again, so a game that has stopped
//    appending does not leave the device a few milliseconds from running dry.
export function pump(): void {
  if (!dev.attached) return;
  const live = liveCount();
  dev.ringSet(dev.R_LIVE, live);
  // Nobody plays: the ring is left to run empty, which the device does not count as an underrun (the header's `live`)
  if (!live || dev.state != dev.DEV_RUNNING) { primed = false; return; }
  resamplerSet(RATE, dev.rate);
  let wr = dev.ringGet(dev.R_WR);
  const fill = wr - dev.ringGet(dev.R_RD);
  if (fill >= dev.target) { primed = true; return; }
  let room = dev.target - fill;
  if (!primed) {
    primed = true;
    memory.fill(MIXOUT, 0, <usize>BLOCK << 3);
    while (room) { const n = min(room, BLOCK); put(wr, n); wr += n; room -= n; paddedFrames += n; }
    dev.ringSet(dev.R_WR, wr);
    return;
  }
  const low = dev.target >> 2;
  let want = min(room, supply());
  if (fill + want < low) want = room;
  while (want) {
    let n = min(want, BLOCK);
    while (n > 1 && rsL != rsM && needIn(n) > IN_CAP) n >>= 1;   // a device rate far below 48 kHz
    produce(n);
    put(wr, n);
    wr += n; want -= n; mixedFrames += n;
    dev.ringSet(dev.R_WR, wr);
  }
}

// For the tests: n frames of stereo f32 at 48 kHz from src through the resampler to dst at the device rate `outRate`;
// returns the output frames (the resampler's state is the module's, so only use it with no output Live)
export function resampleTest(src: usize, n: u32, dst: usize, outRate: u32): u32 {
  resamplerSet(RATE, outRate);
  if (rsL == rsM) { memory.copy(dst, src, <usize>n << 3); return n; }
  let out: u32 = 0, used: u32 = 0;
  const L = <i32>rsL, M = <i32>rsM, fresh = INBUF + <usize>TAPS * 8;
  for (;;) {
    // as many outputs as the remaining input allows, at most BLOCK
    let nOut: u32 = 0;
    while (nOut < BLOCK && needIn(nOut + 1) <= min(n - used, IN_CAP)) nOut++;
    if (!nOut) break;
    const k = needIn(nOut);
    memory.copy(fresh, src + (<usize>used << 3), <usize>k << 3);
    let q = rsQ;
    for (let j: u32 = 0; j < nOut; j++, q += M) {
      const qq = q + L, idx = qq / L, row = TABLE + <usize>(qq - idx * L) * <usize>TAPS * 4, x = INBUF + (<usize>idx << 3);
      let l: f32 = 0, r: f32 = 0;
      for (let t = 0; t < TAPS; t++) { const c = load<f32>(row + (<usize>t << 2)); l += c * load<f32>(x + (<usize>t << 3)); r += c * load<f32>(x + (<usize>t << 3), 4); }
      store<f32>(dst + (<usize>(out + j) << 3), l); store<f32>(dst + (<usize>(out + j) << 3), r, 4);
    }
    rsQ = q - <i32>k * L;
    if (k) memory.copy(INBUF, INBUF + (<usize>k << 3), <usize>TAPS * 8);
    out += nOut; used += k;
  }
  return out;
}
