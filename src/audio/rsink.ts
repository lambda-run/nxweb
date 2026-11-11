// The audio renderer's sink and timing (nxnative dm/host/hle_audren.c: render_main, capture's output half, up_3_2,
// the catch-up queue of AudioRenderSystem::Update). nxnative runs the SDK's own renderer in-process and supplies
// only this: where a rendered frame goes and when the next one is due. Nothing here calls the SDK; the embedder's
// render loop (a guest thread) does, between these calls. See README.md, "Audio renderer".
import { red, end, puts, putu, begin, eventBind, eventSignal, eventRelease, RATE } from "./base";
import * as out from "./out";
import { Out } from "./out";

export const AR_MAX: i32 = 4;
const NBUF: u32 = 4;               // blocks in flight: the output paces the renderer, one render per block handed back
const CQ: u32 = 4;                 // catch-up frames waiting to be played
export const FRAME_MAX: u32 = 1024;
const FRAME_BYTES: usize = 4096;   // FRAME_MAX stereo s16
const RS_T: i32 = 16;              // up_3_2: taps per phase

// @ts-ignore: decorator
@unmanaged
class Sink {
  open: u32;
  out: u32;
  cqEvent: u32;       // signalled for each catch-up frame taken off the queue
  frameN: u32;        // frames in `frame`, 0: nothing rendered
  nfree: u32;
  cqHead: u32; cqTail: u32;
  upPos: u32;
  updated: u32;
  lastBlock: u32; lastN: u32;   // the block last given to the output and its frames
  frames: u64; nonsilent: u64; updates: u64; renders: u64; catchups: u64; lastR: u64; played: u64; discarded: u64;
  // @ts-ignore: decorator
  @inline get freeList(): usize { return changetype<usize>(this) + 112; }         // NBUF u8
  // @ts-ignore: decorator
  @inline get cqN(): usize { return changetype<usize>(this) + 120; }              // CQ u32
  // @ts-ignore: decorator
  @inline get frame(): usize { return changetype<usize>(this) + 136; }
  // @ts-ignore: decorator
  @inline cq(i: u32): usize { return changetype<usize>(this) + 136 + FRAME_BYTES * (1 + <usize>(i % CQ)); }
  // @ts-ignore: decorator
  @inline pcm(i: u32): usize { return changetype<usize>(this) + 136 + FRAME_BYTES * (1 + CQ + <usize>i); }
  // @ts-ignore: decorator
  @inline get upBuf(): usize { return changetype<usize>(this) + 136 + FRAME_BYTES * (1 + CQ + NBUF); }   // 2 * (15 + FRAME_MAX) i32
}
const SINK_SIZE: usize = 136 + 4096 * 9 + 8320;   // 45320
const SINKS: usize = memory.data(181280);          // AR_MAX * SINK_SIZE
const ST: usize = memory.data(8192);               // the stereo downmix before clamping, FRAME_MAX stereo i32
// @ts-ignore: decorator
@inline function at(i: i32): Sink { return changetype<Sink>(SINKS + <usize>i * SINK_SIZE); }
function sinkOf(i: i32): Sink | null { return i >= 0 && i < AR_MAX && at(i).open ? at(i) : null; }
// @ts-ignore: decorator
@inline function outOf(s: Sink): Out { return out.outAt(<i32>s.out); }

export function open(): i32 {
  for (let i = 0; i < AR_MAX; i++) {
    const s = at(i);
    if (s.open) continue;
    const name = memory.data<u8>([65, 117, 100, 105, 111, 82, 101, 110, 100, 101, 114, 101, 114, 0]);
    const o = out.open(0, out.KIND_SINK, 0, 2, name, 0);
    if (o == null) return -1;
    memory.fill(changetype<usize>(s), 0, SINK_SIZE);
    s.open = 1; s.out = o.index; s.nfree = NBUF;
    for (let b: u32 = 0; b < NBUF; b++) store<u8>(s.freeList + b, <u8>b);
    o.hostEvent = eventBind(0, 1);   // each release wakes the render loop (nxnative: rel_sem)
    s.cqEvent = eventBind(0, 1);
    out.start(o, 0);
    begin(); puts("audren: render sink "); putu(i); puts(" opened ("); putu(NBUF); puts(" buffers in flight, paced by the output)"); end();
    return i;
  }
  red(); puts("audren: more than "); putu(AR_MAX); puts(" renderers: this one is not rendered"); end();
  return -1;
}
export function close(i: i32): void {
  const s = sinkOf(i);
  if (s == null) return;
  out.close(outOf(s), 0);   // the output would otherwise keep consuming and hold one of the AudioOut slots
  s.open = 0;
  if (s.cqEvent) { eventSignal(s.cqEvent); eventRelease(s.cqEvent); }   // an update waiting for queue space sees the sink closed
}
export function releaseEvent(i: i32): u32 { const s = sinkOf(i); return s == null ? 0 : outOf(s).hostEvent; }
export function cqEvent(i: i32): u32 { const s = sinkOf(i); return s == null ? 0 : s.cqEvent; }
export function playedPtr(i: i32): usize { const s = sinkOf(i); return s == null ? 0 : <usize>s.lastBlock; }
export function playedFrames(i: i32): u32 { const s = sinkOf(i); return s == null ? 0 : s.lastN; }
export function outIndex(i: i32): i32 { const s = sinkOf(i); return s == null ? -1 : <i32>s.out; }
export function stat(i: i32, which: i32): u64 {
  const s = sinkOf(i);
  if (s == null) return 0;
  return which == 0 ? s.frames : which == 1 ? s.nonsilent : which == 2 ? s.updates : which == 3 ? s.renders : which == 4 ? s.catchups
    : which == 5 ? s.played : which == 6 ? <u64>(s.cqTail - s.cqHead) : which == 7 ? <u64>s.nfree : s.discarded;
}

// The render loop's question, each round: is a block free? 0: wait for the release event (at most 10 ms) and ask again
export function ready(i: i32): i32 {
  const s = sinkOf(i);
  if (s == null) return 0;
  const o = outOf(s);
  for (let slot = out.takeReleased(o); slot >= 0; slot = out.takeReleased(o)) store<u8>(s.freeList + s.nfree++, <u8>load<u32>(o.slot(<u32>slot), out.SLOT_AUX));
  return s.nfree ? 1 : 0;
}
function play(s: Sink, src: usize, got: u32): void {
  const n = got ? got : 240;   // nothing rendered: 5 ms of silence, so the pace holds
  const b = <u32>load<u8>(s.freeList + --s.nfree), p = s.pcm(b);
  if (got) memory.copy(p, src, <usize>n * 4); else memory.fill(p, 0, <usize>n * 4);
  if (!out.append(outOf(s), 0, p, n * 4, b)) { s.nfree++; return; }
  s.played++; s.lastBlock = <u32>p; s.lastN = n;
}
// With a block free: a queued catch-up frame is played in place of a render (returns 0); otherwise the caller
// renders one frame with the SDK (which ends in capture(i, 0, ...)) and then calls rendered(i) (returns 1)
export function next(i: i32): i32 {
  const s = sinkOf(i);
  if (s == null || !s.nfree) return 0;
  if (s.cqHead != s.cqTail) {
    play(s, s.cq(s.cqHead), load<u32>(s.cqN + (<usize>(s.cqHead % CQ) << 2)));
    s.cqHead++;
    // A queued frame does not signal the game's renderer event (the SDK signals it in each render): a game woken
    // by one would update with nothing rendered since and render the next catch-up frame, and so on
    if (s.cqEvent) eventSignal(s.cqEvent);
    return 0;
  }
  s.frameN = 0;
  return 1;
}
// The frame the render left in `frame` goes to the output
export function rendered(i: i32): void {
  const s = sinkOf(i);
  if (s == null || !s.nfree) return;
  play(s, s.frame, s.frameN);
  s.frameN = 0;
}
// One render happened (render_once), whoever asked for it
export function countRender(i: i32): void { const s = sinkOf(i); if (s != null) s.renders++; }

// AudioRenderSystem::Update is about to run. At least one frame must be rendered between two updates: an effect's
// "needs initialization" lives for one update only (nxnative: the light limiter's null state). Returns
//   0  go on with the SDK's Update
//   1  render a catch-up frame first, captured with dest 1 (the queue)
//   2  the queue is full: wait for the catch-up event, at most 50 ms, and ask again with waited = 1, so that
//      catch-up frames keep real time (a sound driver that never waits ran 50 times too fast otherwise)
//   3  still full after the wait (the output stopped): render anyway, captured with dest 2 (discarded)
export function updateBegin(i: i32, waited: i32): i32 {
  const s = sinkOf(i);
  if (s == null) return 0;
  if (!waited) {
    s.updates++;
    if (!s.updated || s.renders != s.lastR) return 0;
    s.catchups++;
    if (s.catchups <= 3) { begin(); puts("audren: renderer "); putu(i); puts(": no frame rendered before update "); putu(s.updates); puts(", rendering a catch-up frame first ("); putu(s.catchups); puts(" so far)"); end(); }
  }
  if (s.cqTail - s.cqHead < CQ) return 1;
  return waited ? 3 : 2;
}
export function updateEnd(i: i32): void { const s = sinkOf(i); if (s != null) { s.lastR = s.renders; s.updated = 1; } }

// A renderer below 48 kHz has no upsampler with CPU rendering: the stereo downmix is resampled 3:2 here, a windowed
// sinc (Blackman, 16 taps, cutoff 0.9 of the input's Nyquist) in three phases, 8 input samples late, the last 15
// samples kept across frames. nxnative's up_3_2, coefficient for coefficient.
const UP_H: usize = memory.data(192);   // 3 * RS_T f32
let upInit = false;
function up32(s: Sink, io: usize, n: u32): u32 {
  if (!upInit) {
    upInit = true;
    for (let p = 0; p < 3; p++) {
      let sum = 0.0;
      for (let k = 0; k < RS_T; k++) {
        const x = <f64>p / 3.0 + <f64>(RS_T / 2 - 1 - k), fc = 0.9, sv = x == 0.0 ? fc : Math.sin(Math.PI * fc * x) / (Math.PI * x);
        const t = (x + <f64>(RS_T / 2)) / <f64>RS_T, win = 0.42 - 0.5 * Math.cos(2.0 * Math.PI * t) + 0.08 * Math.cos(4.0 * Math.PI * t);
        const w = sv * win;
        store<f32>(UP_H + (<usize>(p * RS_T + k) << 2), <f32>w); sum += w;
      }
      for (let k = 0; k < RS_T; k++) { const a = UP_H + (<usize>(p * RS_T + k) << 2); store<f32>(a, <f32>(<f64>load<f32>(a) / sum)); }
    }
  }
  const buf = s.upBuf;
  let pos = s.upPos;   // the next output's position in thirds of an input sample, from the frame start
  memory.copy(buf + <usize>(2 * (RS_T - 1)) * 4, io, <usize>n * 8);   // the frame after the last RS_T - 1 samples of the one before (copied first: out is in)
  let m: u32 = 0;
  for (; pos < 3 * n; pos += 2, m++) {
    const x = buf + (<usize>(2 * (pos / 3)) << 2), c = UP_H + (<usize>((pos % 3) * <u32>RS_T) << 2);
    let l: f32 = 0, r: f32 = 0;
    for (let k = 0; k < RS_T; k++) { const h = load<f32>(c + (<usize>k << 2)); l += h * <f32>load<i32>(x + (<usize>(2 * k) << 2)); r += h * <f32>load<i32>(x + (<usize>(2 * k + 1) << 2)); }
    store<i32>(io + (<usize>(2 * m) << 2), <i32>nearest(l)); store<i32>(io + (<usize>(2 * m + 1) << 2), <i32>nearest(r));
  }
  s.upPos = pos - 3 * n;
  memory.copy(buf, buf + <usize>(2 * n) * 4, <usize>(RS_T - 1) * 8);
  return m;
}

// The DeviceSink's input mix buffers after CommandListProcessor::Process -> stereo PCM16 at 48 kHz.
//   mix: the mix buffers, int32 samples holding 16-bit range, buffer b at mix + b * samples * 4
//   idx: the sink's input indices, nIn of them, idxSize bytes each (1: SDK 4's s8; 2: s16)
//   rate: the renderer's rate, 48000 or 32000
//   dest: 0 the sink's frame (a render of the render loop), 1 the catch-up queue, 2 nowhere
// Returns the frames produced (0: nothing was captured, the frame is silence).
export function capture(i: i32, dest: i32, mix: usize, samples: u32, rate: u32, idx: usize, nIn: u32, idxSize: u32): u32 {
  const s = sinkOf(i);
  if (s == null) return 0;
  if (!samples || !nIn || (rate != RATE && rate != 32000) || samples > (rate == RATE ? FRAME_MAX : FRAME_MAX * 2 / 3)) {
    red(); puts("audren: a DeviceSink of "); putu(samples); puts(" samples at "); putu(rate); puts(" Hz with "); putu(nIn); puts(" inputs is not played"); end();
    return 0;
  }
  const k = min(nIn, 6);
  // front-left front-right center LFE back-left back-right; 6 -> 2 with the system default downmix (Q15)
  const CF: i64 = 32768, CC: i64 = 23167, CL: i64 = 8224, CB: i64 = 23167;
  const stride = <usize>samples << 2;
  for (let n: u32 = 0; n < samples; n++) {
    let l: i32, r: i32;
    const o = <usize>n << 2;
    if (k >= 6) {
      const c = <i64>load<i32>(mix + chan(idx, 2, idxSize) * stride + o) * CC + <i64>load<i32>(mix + chan(idx, 3, idxSize) * stride + o) * CL;
      l = <i32>((<i64>load<i32>(mix + chan(idx, 0, idxSize) * stride + o) * CF + c + <i64>load<i32>(mix + chan(idx, 4, idxSize) * stride + o) * CB) >> 15);
      r = <i32>((<i64>load<i32>(mix + chan(idx, 1, idxSize) * stride + o) * CF + c + <i64>load<i32>(mix + chan(idx, 5, idxSize) * stride + o) * CB) >> 15);
    } else {
      l = load<i32>(mix + chan(idx, 0, idxSize) * stride + o);
      r = k > 1 ? load<i32>(mix + chan(idx, 1, idxSize) * stride + o) : l;
    }
    store<i32>(ST + (<usize>(2 * n) << 2), l); store<i32>(ST + (<usize>(2 * n + 1) << 2), r);
  }
  const nout = rate == RATE ? samples : up32(s, ST, samples);
  if (dest == 1 && s.cqTail - s.cqHead >= CQ) dest = 2;
  const dst = dest == 0 ? s.frame : dest == 1 ? s.cq(s.cqTail) : 0;
  let loud: i32 = 0;
  for (let n: u32 = 0; n < 2 * nout; n++) {
    let v = load<i32>(ST + (<usize>n << 2));
    v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    if (dst) store<i16>(dst + (<usize>n << 1), <i16>v);
    loud |= v;
  }
  s.frames++; if (loud) s.nonsilent++;
  if (loud && s.nonsilent == 1) { begin(); puts("audren: renderer "); putu(i); puts(" rendered its first frame that is not silent, frame "); putu(s.frames); end(); }
  if (s.frames == 200 || s.frames % 12000 == 0) { begin(); puts("audren: renderer "); putu(i); puts(" rendered "); putu(s.frames); puts(" frames, "); putu(s.nonsilent); puts(" of them not silent"); end(); }
  if (dest == 0) s.frameN = nout;
  else if (dest == 1) { store<u32>(s.cqN + (<usize>(s.cqTail % CQ) << 2), nout); s.cqTail++; }
  else s.discarded++;
  return nout;
}
// @ts-ignore: decorator
@inline function chan(idx: usize, j: u32, size: u32): usize { return size == 1 ? <usize><u8>load<i8>(idx + j) : <usize><u16>load<i16>(idx + (<usize>j << 1)); }

// ---- the DSP service's work buffer budget (ar_service_work_size), through renderer revision 15 ----
// @ts-ignore: decorator
@inline function al(n: u64, a: u64): u64 { return (n + a - 1) & ~(a - 1); }
// p: an AudioRendererParameter (0x40 bytes readable). 0: a revision the model does not cover, ask the SDK
export function serviceWorkSize(p: usize): u64 {
  let revision = load<u32>(p, 0x34);
  if ((revision & 0xffffff) != 0x564552) revision = load<u32>(p, 0x38);
  if ((revision & 0xffffff) != 0x564552 || revision < 0x31564552 || revision > 0x3f564552) return 0;
  const r = (revision >> 24) - 0x30;
  // words 0..10 of the parameter; word 8 (voice drop) is a byte followed by uninitialized padding
  for (let w = 0; w < 11; w++) { if (w == 8) continue; const v = load<i32>(p + (<usize>w << 2)); if (v < 0 || v > 0x100000) return 0; }
  const mix = <u64>load<u32>(p, 8), sub = <u64>load<u32>(p, 12), voices = <u64>load<u32>(p, 16), sinks = <u64>load<u32>(p, 20), effects = <u64>load<u32>(p, 24),
    perf = <u64>load<u32>(p, 28), splitters = <u64>load<u32>(p, 36), dest = <u64>load<u32>(p, 40), n1 = <u64>load<u32>(p, 4), mixes = sub + 1;
  let size = al(((sinks + sub) * 0x3c0 + n1 * 4) * (mix + 6), 64);
  size += al(mix * 4, 64) + sub * 0x400 + mixes * 0x940 + al(mixes * 8, 16);
  size += voices * 0x1d0 + al(voices * (r >= 15 ? 0x238 : 0x220), 16) + al(voices * 8, 16);
  if (r >= 2) {
    const graph = mixes * mixes * 4 + mixes * 12 + 2 * al(mixes, 64) / 8 + al(mixes * mixes, 64) / 8;
    size += al(graph, 16);
    size += splitters * 0x20 + al(dest * (r >= 12 ? (r >= 15 ? 0x130 : 8) : 0xe0), 16);
    if (r < 5) size += al(dest * 4, 16);
  }
  size += (effects + voices * 4) * 0x20 + 0x50;
  if (r >= 12 && splitters && dest) size += al(dest * (r >= 14 ? 0xe0 : 0x80), 64);
  size = al(size + (r >= 9 ? effects * 0x80 : 0), 64);
  size += (sinks + sub) * 0x280 + effects * (r >= 9 ? 0x530 : 0x4b0) + sinks * 0x170 + voices * 0x100 + 0x40;
  if (perf) {
    const frame = (sub + voices + sinks + effects + 1) * (r >= 5 ? 0x18 : 0x10) + (r >= 5 ? 0x990 : 0x658);
    size += al(frame * (perf + 1), 64) + 0xc0;
  }
  let commands: u64 = 0x18000;
  if (r >= 5) commands = effects * 0x540 + sub * 0x3f24 + sinks * 0x130 + dest * 0x360
    + voices * (splitters * 0x50 + (r >= 8 ? 0x284 : 0x250)) + (voices + sub + effects + sinks + 0x65) * 0x28 + 0x2c4;
  return al(size + commands + 0x7e, 0x1000);
}
