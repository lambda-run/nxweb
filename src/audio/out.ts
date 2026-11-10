// AudioOut: the outputs, their buffer queues, the two machines, the silent sink, the guards that decide who
// consumes. Port of the queue and backend parts of nxnative dm/host/hle_audio.c; see README.md for what changed.
//
// One output has ONE pending queue and ONE position in its head buffer, whoever consumes: the silent sink (on the
// guest clock) and the device mixer (mix.ts) both go through pull(). A change of consumer is a transition of the
// `audio_out` machine and touches neither the queue nor the position, so a handover cannot lose a buffer or release
// one twice; the `audio_buf` machine of each slot would refuse it besides.
import { Inst } from "../kit/machine";
import { AUDIO_OUT, AudioOutS, AudioOutE, AUDIO_BUF, AudioBufS, AudioBufE } from "../kit/gen/tables";
import { begin, red, end, puts, putu, putx, putz, eventSignal, eventRelease, devStart, devStop, RATE, NS, NEVER } from "./base";
import * as dev from "./dev";

export const AOMAX: i32 = 8;
export const QMAX: u32 = 64;       // pending buffers of one output (AppendAudioOutBuffer answers false beyond)
export const RELMAX: u32 = 64;     // released and not yet taken back
const SLOTS: i32 = 128;            // QMAX + RELMAX
const SLOT_SIZE: usize = 32;       // +0 Inst, +16 guest AudioOutBuffer (0: a host block), +20 data, +24 size, +28 aux
export const STATE_STARTED: u32 = 0, STATE_STOPPED: u32 = 1, FMT_PCM16: u32 = 2;
export const KIND_GUEST: u32 = 0, KIND_STREAM: u32 = 1, KIND_SINK: u32 = 2;

// @ts-ignore: decorator
@unmanaged
export class Out {
  used: u32;
  index: u32;
  id: u32;          // open sequence number (#N in the log)
  key: u32;         // the guest AudioOut object; 0 for a host output (OutputStream, render sink)
  kind: u32;
  ch: u32;
  event: u32;       // token of the game's release event, 0 when the game polls
  hostEvent: u32;   // token of a host event signalled for each release as well (render sink), or 0
  vol: f32;
  pos: u32;         // bytes consumed of the head buffer
  qHead: u32; qTail: u32;       // pending: slots q[qHead..qTail)
  relHead: u32; relTail: u32;   // released: slots rel[relHead..relTail)
  nfree: u32;
  nlog: u32;
  dirty: u32;       // a buffer was released since the last flushSignals
  relFull: u32;     // the released queue is full: consumption stands still until the game takes one (logged once)
  oddCh: u32;
  relNoted: u32;
  underN: u64; underB: u64;   // times the queue was empty when the consumer needed data / bytes of silence instead
  appended: u64; released: u64; reclaimed: u64; signals: u64; consumed: u64;
  epoch: u64;       // silent sink: guest time its frame count starts at
  sinkFrames: u64;  // silent sink: frames consumed since epoch
  skipped: u64;     // silent sink: frames not made up after a clock jump (audio_set_catchup_limit)

  // @ts-ignore: decorator
  @inline get inst(): Inst { return Inst.at(changetype<usize>(this) + 192); }
  // @ts-ignore: decorator
  @inline get qPtr(): usize { return changetype<usize>(this) + 208; }
  // @ts-ignore: decorator
  @inline get relPtr(): usize { return changetype<usize>(this) + 272; }
  // @ts-ignore: decorator
  @inline get freePtr(): usize { return changetype<usize>(this) + 336; }
  // @ts-ignore: decorator
  @inline slot(i: u32): usize { return changetype<usize>(this) + 464 + <usize>i * SLOT_SIZE; }
  // @ts-ignore: decorator
  @inline get state(): u8 { return this.inst.state; }
  // @ts-ignore: decorator
  @inline get frameBytes(): u32 { return 2 * this.ch; }
  // @ts-ignore: decorator
  @inline get pending(): u32 { return this.qTail - this.qHead; }
  // @ts-ignore: decorator
  @inline get releasedCount(): u32 { return this.relTail - this.relHead; }
}
const OUT_SIZE: usize = 464 + 128 * 32;   // 4560
const OUTS: usize = memory.data(36480);   // AOMAX * OUT_SIZE

// @ts-ignore: decorator
@inline export function outAt(i: i32): Out { return changetype<Out>(OUTS + <usize>i * OUT_SIZE); }
export function outOfKey(key: u32): Out | null {
  for (let i = 0; i < AOMAX; i++) { const o = outAt(i); if (o.used && o.key == key && o.kind == KIND_GUEST) return o; }
  return null;
}

let opens: u32 = 0;
let catchupLimit: u64 = 0;   // ns; 0 = the sink makes up any jump of the guest clock
export function setCatchupLimit(ns: u64): void { catchupLimit = ns; }

// @ts-ignore: decorator
@inline export function isSilent(s: u8): bool { return s == AudioOutS.SilentStarting || s == AudioOutS.SilentRetry || s == AudioOutS.Suspended; }
// @ts-ignore: decorator
@inline function wantsDevice(s: u8): bool { return s == AudioOutS.SilentStarting || s == AudioOutS.SilentRetry || s == AudioOutS.Live; }
function anyWantsDevice(): bool {
  for (let i = 0; i < AOMAX; i++) { const o = outAt(i); if (o.used && wantsDevice(o.state)) return true; }
  return false;
}

// ---- log ----
function head(o: Out): void { puts("audio #"); putu(o.id); }
// Start / Stop / Close: at most 32 lines per output; middleware calls them at init, suspend and resume, more means it keeps toggling
function lifeNote(o: Out, what: string, lr: u64): void {
  if (o.nlog >= 32) return;
  o.nlog++;
  begin(); head(o); putc32(); puts(what);
  if (lr) { puts(" (call site "); putx(lr); puts(")"); }
  if (o.nlog == 32) puts("; not logged from here on");
  end();
}
function putc32(): void { puts(" "); }

// ---- open / close ----
export function open(key: u32, kind: u32, event: u32, ch: u32, name: usize, lr: u64): Out | null {
  let o: Out | null = null;
  for (let i = 0; i < AOMAX && o == null; i++) if (!outAt(i).used) { o = outAt(i); o.index = i; }
  if (o == null) { red(); puts("audio: more than "); putu(AOMAX); puts(" AudioOuts open at once: the open fails"); end(); return null; }
  const index = o.index;
  memory.fill(changetype<usize>(o), 0, OUT_SIZE);
  o.used = 1; o.index = index; o.id = opens++; o.key = key; o.kind = kind; o.event = event; o.ch = ch; o.vol = 1.0;
  o.inst.init(AUDIO_OUT, o.id);
  for (let s = 0; s < SLOTS; s++) { Inst.at(o.slot(s)).init(AUDIO_BUF, (o.id << 8) | <u32>s); store<u8>(o.freePtr + s, <u8>(SLOTS - 1 - s)); }
  o.nfree = SLOTS;
  if (ch != 1 && ch != 2 && ch != 6) { o.oddCh = 1; red(); head(o); puts(": "); putu(ch); puts(" channels: only the first two reach the device"); end(); }
  begin(); head(o); puts(kind == KIND_STREAM ? " OpenOutputStream " : kind == KIND_SINK ? " render sink " : " OpenAudioOut ");
  if (name) putz(name, 64); else puts(kind == KIND_GUEST ? "(default)" : "");
  puts(" channels "); putu(ch); puts(dev.attached ? ", device at " : ", no device: silent sink"); if (dev.attached) { putu(dev.rate); puts(" Hz"); }
  if (!event && kind != KIND_SINK) puts(", no release event (the game polls)");
  if (lr) { puts(" (call site "); putx(lr); puts(")"); }
  end();
  return o;
}

export function close(o: Out, lr: u64): void {
  lifeNote(o, "Close", lr);
  stop(o, 0, false);
  // Released buffers nobody took back go with the output
  while (o.relHead != o.relTail) {
    const s = <u32>load<u8>(o.relPtr + (o.relHead++ & (RELMAX - 1)));
    Inst.at(o.slot(s)).step(AudioBufE.Drop);
  }
  if (o.event) eventRelease(o.event);
  if (o.hostEvent) eventRelease(o.hostEvent);
  o.used = 0;
}

// ---- Start / Stop ----
const BACKOFF_US: StaticArray<u64> = [0, 1000000, 2000000, 4000000, 8000000];
// @ts-ignore: decorator
@inline function pack(us: u64, backoff: u64): u64 { return (us << 4) | backoff; }

function sinkBegin(o: Out): void { o.epoch = dev.gNow; o.sinkFrames = 0; }

export function start(o: Out, lr: u64): void {
  if (o.state != AudioOutS.Stopped) { lifeNote(o, "Start (already playing)", lr); return; }
  if (dev.hidden) {
    lifeNote(o, "Start (the page is hidden: the silent sink takes over for now)", lr);
    o.inst.step(AudioOutE.StartHidden);
  } else {
    lifeNote(o, "Start", lr);
    o.inst.step(AudioOutE.Start, pack(dev.wNow, 0));
    devStart();
  }
  sinkBegin(o);
}

// After a started -> stopped transition every pending buffer comes back, the partly played one too: FMOD waits for
// these releases before it joins its output thread (nxnative: Pokémon Brilliant Diamond). A Stop of a stopped
// output keeps what was appended for its next Start.
export function releasePending(o: Out): void {
  while (o.qHead != o.qTail) {
    if (o.releasedCount == RELMAX) { relFullNote(o); break; }
    const s = <u32>load<u8>(o.qPtr + (o.qHead & (QMAX - 1)));
    Inst.at(o.slot(s)).step(AudioBufE.Flush);
    store<u8>(o.relPtr + (o.relTail++ & (RELMAX - 1)), <u8>s);
    o.qHead++; o.released++; o.dirty = 1;
  }
  o.pos = 0;
}

export function stop(o: Out, lr: u64, log: bool = true): void {
  const was = o.state;
  if (log) lifeNote(o, was != AudioOutS.Stopped ? "Stop" : "Stop (already stopped)", lr);
  if (was == AudioOutS.Stopped) return;
  if (isSilent(was)) sinkAdvance(o);   // what was due before the stop is played, not flushed
  o.inst.step(AudioOutE.Stop);
  releasePending(o);
  if (!anyWantsDevice()) devStop();
}

// ---- the queues ----
// The buffer the game described with SetAudioOutBufferInfo: { ptr, capacity, size } in the first 24 bytes
function relFullNote(o: Out): void {
  o.relFull = 1;
  if (o.relNoted) return;
  o.relNoted = 1;
  red(); head(o); puts(": "); putu(RELMAX); puts(" released buffers and the game takes none back: consumption waits"); end();
}

// guest: the game's AudioOutBuffer, or 0 with data / size for a host block (aux is the owner's)
export function append(o: Out, guest: u32, data: u32, size: u32, aux: u32): bool {
  if (isSilent(o.state)) sinkAdvance(o);   // an empty queue has been playing silence up to now: the buffer starts here
  if (o.pending >= QMAX || !o.nfree) return false;
  const s = <u32>load<u8>(o.freePtr + --o.nfree), p = o.slot(s);
  if (!Inst.at(p).step(AudioBufE.Append)) { o.nfree++; return false; }
  store<u32>(p, guest, 16); store<u32>(p, data, 20); store<u32>(p, size, 24); store<u32>(p, aux, 28);
  store<u8>(o.qPtr + (o.qTail++ & (QMAX - 1)), <u8>s);
  o.appended++;
  return true;
}

// The oldest released buffer: its slot, or -1. The slot is free again; read it before the next append.
export function takeReleased(o: Out): i32 {
  if (o.relHead == o.relTail) return -1;
  const s = <u32>load<u8>(o.relPtr + (o.relHead++ & (RELMAX - 1)));
  Inst.at(o.slot(s)).step(AudioBufE.Reclaim);
  store<u8>(o.freePtr + o.nfree++, <u8>s);
  o.reclaimed++; o.relFull = 0;
  return <i32>s;
}

// A guest buffer's pointer and size are read when the consumer reaches it, as nxnative reads them when it plays
function latch(p: usize): void {
  const g = <usize>load<u32>(p, 16);
  if (g) { store<u32>(p, <u32>load<u64>(g), 20); store<u32>(p, <u32>min(load<u64>(g, 16), <u64>0x7FFFFFFF), 24); }
}

// Take n bytes off the pending queue for the consumer (dst == 0: the silent sink, which only counts them). A buffer
// played to its end goes to the released queue. What the queue cannot give is silence.
export function pull(o: Out, dst: usize, n: u32): void {
  for (;;) {
    if (o.qHead == o.qTail) {
      if (n) { o.underN++; o.underB += n; if (dst) memory.fill(dst, 0, n); }
      return;
    }
    const s = <u32>load<u8>(o.qPtr + (o.qHead & (QMAX - 1))), p = o.slot(s), b = Inst.at(p);
    if (b.state == AudioBufS.Appended) { latch(p); b.step(AudioBufE.Play); }
    const size = load<u32>(p, 24);
    const k = o.pos < size ? min(size - o.pos, n) : 0;
    if (k) {
      if (dst) { memory.copy(dst, <usize>load<u32>(p, 20) + o.pos, k); dst += k; }
      n -= k; o.pos += k; o.consumed += k;
    }
    if (o.pos < size) return;   // n is used up
    if (o.releasedCount == RELMAX) { relFullNote(o); if (n && dst) memory.fill(dst, 0, n); return; }
    b.step(AudioBufE.Finish);
    store<u8>(o.relPtr + (o.relTail++ & (RELMAX - 1)), <u8>s);
    o.qHead++; o.pos = 0; o.released++; o.dirty = 1;
  }
}

// Whole frames queued and not yet consumed (the pending buffers' bytes less the position in the first)
export function queuedFrames(o: Out): u64 {
  let bytes: u64 = 0;
  for (let q = o.qHead; q != o.qTail; q++) {
    const p = o.slot(<u32>load<u8>(o.qPtr + (q & (QMAX - 1))));
    const g = <usize>load<u32>(p, 16);
    bytes += Inst.at(p).state == AudioBufS.Appended && g ? min(load<u64>(g, 16), <u64>0x7FFFFFFF) : <u64>load<u32>(p, 24);
  }
  return bytes > o.pos ? (bytes - o.pos) / o.frameBytes : 0;
}

// One wake-up per entry into the module in which the output released something (nxnative: one notify per pull)
export function flushSignals(): void {
  for (let i = 0; i < AOMAX; i++) {
    const o = outAt(i);
    if (!o.used || !o.dirty) continue;
    o.dirty = 0; o.signals++;
    if (o.event) eventSignal(o.event);
    if (o.hostEvent) eventSignal(o.hostEvent);
  }
}

// ---- the silent sink: consumes at exactly 48000 frames per second of the guest clock ----
// @ts-ignore: decorator
@inline function framesAt(dt: u64): u64 { return min(dt, 10000000000000) * RATE / NS; }

export function sinkAdvance(o: Out): void {
  let n: u64 = 0;
  if (dev.gNow > o.epoch) {
    const t = framesAt(dev.gNow - o.epoch);
    if (t > o.sinkFrames) {
      n = t - o.sinkFrames; o.sinkFrames = t;
      if (t >= RATE) { const secs = t / RATE; o.epoch += secs * NS; o.sinkFrames -= secs * RATE; }   // whole seconds: exact
    }
  }
  // A jump of the clock beyond the limit is not made up (nxnative: more than 100 ms behind after the process was
  // suspended: making it up released every buffer at once and logged hundreds of underruns)
  if (catchupLimit && n > framesAt(catchupLimit)) { o.skipped += n; n = 0; }
  const fb = <u64>o.frameBytes;
  if (!n) { pull(o, 0, 0); return; }   // a buffer of no bytes at the head is released without time passing
  while (n) { const k = min(n, 0x100000); pull(o, 0, <u32>(k * fb)); n -= k; if (o.relFull) break; }
}

// The guest time at which the sink releases its next buffer, NEVER when it has none
export function sinkDeadline(o: Out): u64 {
  if (!isSilent(o.state) || o.qHead == o.qTail || o.releasedCount == RELMAX) return NEVER;
  const p = o.slot(<u32>load<u8>(o.qPtr + (o.qHead & (QMAX - 1))));
  let size = <u64>load<u32>(p, 24);
  if (Inst.at(p).state == AudioBufS.Appended) { const g = <usize>load<u32>(p, 16); if (g) size = min(load<u64>(g, 16), <u64>0x7FFFFFFF); }
  const fb = <u64>o.frameBytes;
  const rem = size > o.pos ? (size - o.pos + fb - 1) / fb : 0;
  const f = o.sinkFrames + rem;
  return o.epoch + (f * NS + RATE - 1) / RATE;
}

// ---- who consumes: the guards of the audio_out machine, once per tick and output ----
const START_TIMEOUT_US: u64 = 1000000;   // a running device owes its first callback within a second
const STALL_US: u64 = 200000;            // a playing device must call back within 200 ms

function retry(o: Out, ev: u8, why: string): void {
  const prev = <i32>(o.inst.data & 15);   // SilentStarting carries the backoff reached; Live starts from none
  const from = o.state;
  const b = from == AudioOutS.Live ? 1 : min(prev + 1, 4);
  if (!o.inst.step(ev, pack(dev.wNow + unchecked(BACKOFF_US[b]), b))) return;
  if (from == AudioOutS.Live) sinkBegin(o);
  if (from == AudioOutS.Live || prev == 0) {
    red(); head(o); puts(": "); puts(why); puts(": the silent sink stands in, retrying the device in ");
    putu(unchecked(BACKOFF_US[b]) / 1000000); puts(" s"); end();
  }
}

export function guard(o: Out): void {
  const st = o.state, w = dev.wNow;
  if (st == AudioOutS.SilentStarting) {
    if (!dev.attached) return;
    const since = o.inst.data >> 4;
    if (dev.state == dev.DEV_RUNNING) {
      if (dev.cbAt > since) {
        const again = (o.inst.data & 15) != 0;
        if (o.inst.step(AudioOutE.DeviceCallback) && again) { begin(); head(o); puts(": the device plays again"); end(); }
      } else if (w - max(since, dev.stateAt) >= START_TIMEOUT_US) retry(o, AudioOutE.StartTimeout, "no device callback within 1 s of its start");
    } else if ((dev.state == dev.DEV_FAILED || dev.state == dev.DEV_LOST) && (dev.stateAt >= since || w - since >= START_TIMEOUT_US))
      retry(o, AudioOutE.StartFailed, "the device did not start");
  } else if (st == AudioOutS.Live) {
    if (dev.state != dev.DEV_RUNNING) retry(o, AudioOutE.DeviceLost, "the browser took the device away");
    else if (w - dev.cbAt > STALL_US) retry(o, AudioOutE.Stall, "the device has not called back for 200 ms while playing");
  } else if (st == AudioOutS.SilentRetry) {
    if (w >= o.inst.data >> 4 && o.inst.step(AudioOutE.RetryDue, pack(w, o.inst.data & 15))) devStart();
  }
}

// The page was hidden or shown again (nxnative: dm_audio_suspend). While hidden the silent sink consumes for every
// started output, so a game whose audio thread waits for its buffers keeps its pace.
export function suspend(on: bool): void {
  if (dev.hidden == on) return;
  dev.setHidden(on);
  let any = false;
  for (let i = 0; i < AOMAX; i++) {
    const o = outAt(i);
    if (!o.used) continue;
    const st = o.state;
    if (on && wantsDevice(st)) { if (o.inst.step(AudioOutE.Suspend) && st == AudioOutS.Live) sinkBegin(o); any = true; }
    else if (!on && st == AudioOutS.Suspended) { o.inst.step(AudioOutE.Resume, pack(dev.wNow, 0)); any = true; }
  }
  if (dev.attached) { if (on) devStop(); else if (any) devStart(); }
  begin(); puts(on ? "audio suspended (the page is hidden)" : "audio resumed (the page is visible)"); end();
}
