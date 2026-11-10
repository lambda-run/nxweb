// nn::codec's hardware Opus decoders (nxnative dm/host/hle_codec.c).
//  - The synchronous interfaces (the HardwareOpusDecoder / HardwareOpusMultiStreamDecoder classes and their C
//    interfaces) are forwarded to the software decoders of the game's own SDK, with a host-held state per game
//    object, exactly as nxnative does. They need the SDK (audio_guest_fn / audio_guest_call).
//  - SDK 21's asynchronous decoder manager is implemented here: the request machine (`opus_req`), the queues, the
//    I/O buffer accounting, the event. Who decodes is a backend: the SDK's software OpusDecoder inside Execute
//    (nxnative's way), or the embedder's decoder (audio_opus_* imports), which may answer at once or later
//    (WebCodecs' AudioDecoder is asynchronous). See README.md, "Opus".
import { Inst } from "../kit/machine";
import { OPUS_REQ, OpusReqS, OpusReqE } from "../kit/gen/tables";
import { red, end, puts, putu, putx, begin, guestFn, guestCall, arenaAlloc, arenaFree, eventBind, eventSignal, eventRelease, gp } from "./base";

// @ts-ignore: decorator
@external("env", "audio_opus_open")
declare function hostOpen(dec: u32, rate: i32, ch: i32): i32;
// >= 1: samples per channel written at out; PENDING: audio_opus_complete will follow; anything else: failed
// @ts-ignore: decorator
@external("env", "audio_opus_decode")
declare function hostDecode(dec: u32, req: u32, inPtr: usize, inLen: u32, outPtr: usize, outCap: u32): i32;
// @ts-ignore: decorator
@external("env", "audio_opus_reset")
declare function hostReset(dec: u32): void;
// @ts-ignore: decorator
@external("env", "audio_opus_close")
declare function hostClose(dec: u32): void;

export const OPUS_PENDING: i32 = -1;
const ERR: u32 = 0x3a6f;                 // what nxnative answers for "not now" (no buffer, nothing completed, bad packet)
const MAX_PACKET: u32 = 0x1800;          // Nintendo's 8-byte header and the packet
const MAX_PCM: u32 = 11520;              // a frame of up to 60 ms, stereo, 16 bit
const SOFT_STATE: usize = 0x200;         // bytes for the SDK's software decoder state (larger than any SDK's)
const BACKEND_AUTO: i32 = 0, BACKEND_SDK: i32 = 1, BACKEND_HOST: i32 = 2;
let backend: i32 = BACKEND_AUTO;
export function setBackend(b: i32): void { backend = b; }

// ---- SDK functions by name, looked up once each ----
const N_FN: i32 = 20;
const FN_ADDR: usize = memory.data(160);
const FN_KNOWN: usize = memory.data(20);
const SDK: StaticArray<string> = [
  "_ZN2nn5codec11OpusDecoderC1Ev",
  "_ZN2nn5codec28GetOpusDecoderWorkBufferSizeEii",
  "_ZN2nn5codec21InitializeOpusDecoderEPNS0_15OpusDecoderTypeEiiPvm",
  "_ZN2nn5codec19FinalizeOpusDecoderEPNS0_15OpusDecoderTypeE",
  "_ZN2nn5codec24GetOpusDecoderSampleRateEPKNS0_15OpusDecoderTypeE",
  "_ZN2nn5codec26GetOpusDecoderChannelCountEPKNS0_15OpusDecoderTypeE",
  "_ZN2nn5codec16ResetOpusDecoderEPNS0_15OpusDecoderTypeE",
  "_ZN2nn5codec21DecodeOpusInterleavedEPNS0_15OpusDecoderTypeEPmPiPsmPKvm",
  "_ZN2nn5codec22OpusMultiStreamDecoderC1Ev",
  "_ZN2nn5codec39GetOpusMultiStreamDecoderWorkBufferSizeEiiii",
  "_ZN2nn5codec32InitializeOpusMultiStreamDecoderEPNS0_26OpusMultiStreamDecoderTypeEiiiiPKhPvm",
  "_ZN2nn5codec30FinalizeOpusMultiStreamDecoderEPNS0_26OpusMultiStreamDecoderTypeE",
  "_ZN2nn5codec35GetOpusMultiStreamDecoderSampleRateEPKNS0_26OpusMultiStreamDecoderTypeE",
  "_ZN2nn5codec37GetOpusMultiStreamDecoderChannelCountEPKNS0_26OpusMultiStreamDecoderTypeE",
  "_ZN2nn5codec41GetOpusMultiStreamDecoderTotalStreamCountEPKNS0_26OpusMultiStreamDecoderTypeE",
  "_ZN2nn5codec42GetOpusMultiStreamDecoderStereoStreamCountEPKNS0_26OpusMultiStreamDecoderTypeE",
  "_ZN2nn5codec27ResetOpusMultiStreamDecoderEPNS0_26OpusMultiStreamDecoderTypeE",
  "_ZN2nn5codec32DecodeOpusMultiStreamInterleavedEPNS0_26OpusMultiStreamDecoderTypeEPmPiPsmPKvm",
];
export const enum S { Ctor, WorkSize, Init, Fini, Rate, Ch, Reset, Decode, MsCtor, MsWorkSize, MsInit, MsFini, MsRate, MsCh, MsTotal, MsStereo, MsReset, MsDecode }
// The SDK's function, 0 with one red line per name when the SDK does not have it
export function sdk(which: S, quiet: bool = false): u64 {
  const k = load<u8>(FN_KNOWN + which);
  if (k) return load<u64>(FN_ADDR + (<usize>which << 3));
  const f = guestFn(unchecked(SDK[which]));
  if (!f && quiet) return 0;
  store<u8>(FN_KNOWN + which, 1); store<u64>(FN_ADDR + (<usize>which << 3), f);
  if (!f) { red(); puts("codec: the SDK lacks "); puts(unchecked(SDK[which])); puts(": the hardware Opus call that needs it fails"); end(); }
  return f;
}

// ---- the synchronous interfaces: a software decoder state per game object ----
const SOFT_MAX: i32 = 64;
// (the key is the game object's address, the state a block of the arena: both anywhere in a 64-bit memory)
const SOFT: usize = memory.data(1024);   // SOFT_MAX * { u64 key, u64 state }
function softFind(key: u64): i32 { for (let i = 0; i < SOFT_MAX; i++) if (load<u64>(SOFT + (<usize>i << 4)) == key) return i; return -1; }
export function softGet(key: u64): usize { const i = softFind(key); return i < 0 ? 0 : <usize>load<u64>(SOFT + (<usize>i << 4), 8); }
// The state kept for the game's decoder object, made on first use
export function softMake(key: u64): usize {
  let p = softGet(key);
  if (p) return p;
  const i = softFind(0);
  if (i < 0 || !(p = arenaAlloc(SOFT_STATE))) { red(); puts("codec: no room for another software Opus decoder state"); end(); return 0; }
  store<u64>(SOFT + (<usize>i << 4), key); store<u64>(SOFT + (<usize>i << 4), p, 8);
  return p;
}
export function softDel(key: u64): usize {
  const i = softFind(key);
  if (i < 0) return 0;
  const p = <usize>load<u64>(SOFT + (<usize>i << 4), 8);
  store<u64>(SOFT + (<usize>i << 4), 0); store<u64>(SOFT + (<usize>i << 4), 0, 8);
  return p;
}
export function softFree(p: usize): void { arenaFree(p); }
// The software state of a game decoder object of either form (opus_soft), 0 with a red line when the host made none
export function softOf(key: u64): usize {
  const d = decFind(key);
  if (d != null && d.soft) return <usize>d.soft;
  const p = softGet(key);
  if (!p) { red(); puts("codec: Opus decoder "); putx(key); puts(" was not initialized by the host"); end(); }
  return p;
}

// ---- the decoder manager ----
const MGR_MAX: i32 = 8, DEC_MAX: i32 = 256, SPARE: u32 = 16;
const REQ_SIZE: usize = 32 + 0x1800 + 11520;   // +0 Inst, +16 next (slot + 1), +20 bytes, +24 samples, +28 decoder; the packet; the PCM
// @ts-ignore: decorator
@unmanaged
class Mgr {
  used: u32; gen: u32; event: u32;
  ioTotal: u32; ioUsed: u32;     // I/O buffers: one per request from Enqueue to Dequeue
  abandoned: u32;                // slots an asynchronous decode still holds after its request was cancelled
  nreq: u32; nfree: u32;
  pool: u64;                     // nreq request records, then the free stack (u16 each): a block of the arena
  // @ts-ignore: decorator
  @inline req(slot: u32): usize { return <usize>this.pool + <usize>slot * REQ_SIZE; }
  // @ts-ignore: decorator
  @inline get freeStack(): usize { return <usize>this.pool + <usize>this.nreq * REQ_SIZE; }
}
// @ts-ignore: decorator
@unmanaged
class Dec {
  key: u64;                      // the game's decoder object (its address)
  soft: u64; work: u64;          // the SDK's software decoder state and its work buffer: blocks of the arena
  used: u32;
  mgr: i32;                      // -1: its manager was finalized
  rate: i32; ch: i32;
  host: u32;                     // 1: the embedder decodes (audio_opus_*); 0: the SDK's software decoder
  head: u32; tail: u32;          // its requests in the order they were enqueued (slot + 1, 0 = none)
  nwait: u32; nexec: u32; ndone: u32;
  order: u32;                    // position among its manager's decoders (Execute goes in this order)
}
const MGR_REC: usize = 40, DEC_REC: usize = 72;
const MGRS: usize = memory.data(320);     // MGR_MAX * MGR_REC
const DECS: usize = memory.data(18432);   // DEC_MAX * DEC_REC
// @ts-ignore: decorator
@inline function mgrAt(i: i32): Mgr { return changetype<Mgr>(MGRS + <usize>i * MGR_REC); }
// @ts-ignore: decorator
@inline function decAt(i: i32): Dec { return changetype<Dec>(DECS + <usize>i * DEC_REC); }
let lastDec: i32 = 0, orderSeq: u32 = 0, decodeReds: u32 = 0;

// The game tells an initialized manager by the first word of its HardwareOpusDecoderManagerType: it holds index + 1
function mgrOf(gm: usize): Mgr | null {
  const v = load<u64>(gm);
  if (v >= 1 && v <= <u64>MGR_MAX && mgrAt(<i32>v - 1).used) return mgrAt(<i32>v - 1);
  red(); puts("codec: Opus decoder manager "); putx(gm); puts(" was not initialized by the host"); end();
  return null;
}
// @ts-ignore: decorator
@inline function mgrIndex(m: Mgr): i32 { return <i32>((changetype<usize>(m) - MGRS) / MGR_REC); }
// @ts-ignore: decorator
@inline function decIndex(d: Dec): i32 { return <i32>((changetype<usize>(d) - DECS) / DEC_REC); }
// A decoder of a manager by the game's object (nxnative keeps these under another key than the synchronous form's)
export function decFind(key: u64): Dec | null {
  if (decAt(lastDec).used && decAt(lastDec).key == key) return decAt(lastDec);
  for (let i = 0; i < DEC_MAX; i++) { const d = decAt(i); if (d.used && d.key == key) { lastDec = i; return d; } }
  return null;
}
function decOf(key: u64): Dec | null {
  const d = decFind(key);
  if (d == null) { red(); puts("codec: Opus decoder "); putx(key); puts(" was not initialized by the host"); end(); }
  return d;
}
// @ts-ignore: decorator
@inline function handle(m: Mgr, slot: u32): u32 { return ((m.gen & 0xFF) << 24) | (<u32>mgrIndex(m) << 16) | slot; }

export function mgrWorkSize(): u64 { return 0x1000; }   // the host keeps the manager's state, the work buffer is not used

export function mgrInit(gm: usize, event: usize, decoders: i32, io: i32): u32 {
  let m: Mgr | null = null;
  for (let i = 0; i < MGR_MAX && m == null; i++) if (!mgrAt(i).used) m = mgrAt(i);
  if (m == null || io < 0 || io > 4096) { red(); puts("codec: no room for an Opus decoder manager of "); putu(<u32>io); puts(" I/O buffers"); end(); return ERR; }
  const nreq = <u32>io + SPARE;
  const pool = arenaAlloc(<usize>nreq * REQ_SIZE + <usize>nreq * 2);
  if (!pool) { red(); puts("codec: no arena memory for an Opus decoder manager of "); putu(<u32>io); puts(" I/O buffers"); end(); return ERR; }
  const gen = m.gen + 1;
  m.used = 1; m.gen = gen; m.event = eventBind(event, 1); m.ioTotal = <u32>io; m.ioUsed = 0; m.abandoned = 0; m.nreq = nreq; m.nfree = nreq; m.pool = pool;
  for (let s: u32 = 0; s < nreq; s++) { Inst.at(m.req(s)).init(OPUS_REQ, (<u32>mgrIndex(m) << 16) | s); store<u16>(m.freeStack + (<usize>s << 1), <u16>(nreq - 1 - s)); }
  store<u64>(gm, <u64>(mgrIndex(m) + 1));
  return 0;
}
export function mgrFini(gm: usize): void {
  const v = load<u64>(gm);
  if (v < 1 || v > <u64>MGR_MAX || !mgrAt(<i32>v - 1).used) return;
  const m = mgrAt(<i32>v - 1), mi = mgrIndex(m);
  for (let i = 0; i < DEC_MAX; i++) { const d = decAt(i); if (d.used && d.mgr == mi) { clear(d, m); d.mgr = -1; } }
  store<u64>(gm, 0);
  eventRelease(m.event);
  arenaFree(<usize>m.pool);   // a late answer of an asynchronous decode finds another generation and is dropped
  m.used = 0; m.pool = 0;
}
export function mgrFreeIo(gm: usize): i32 { const m = mgrOf(gm); return m == null ? 0 : <i32>(m.ioTotal - m.ioUsed); }

export function decInit(gd: u64, rate: i32, ch: i32, gm: usize): u32 {
  const m = mgrOf(gm);
  if (m == null) return ERR;
  if (decFind(gd) != null) decFini(gd);
  let d: Dec | null = null;
  for (let i = 0; i < DEC_MAX && d == null; i++) if (!decAt(i).used) d = decAt(i);
  if (d == null) { red(); puts("codec: more than "); putu(DEC_MAX); puts(" Opus decoders"); end(); return ERR; }
  memory.fill(changetype<usize>(d), 0, DEC_REC);
  const useHost = backend == BACKEND_HOST || (backend == BACKEND_AUTO && !sdk(S.Decode, true));
  if (useHost) {
    const r = hostOpen(<u32>decIndex(d), rate, ch);
    if (r) return <u32>r;
    d.host = 1;
  } else {
    const wsize = sdk(S.WorkSize), init = sdk(S.Init);
    if (!wsize || !init || !sdk(S.Decode)) return ERR;
    const ws = <usize>guestCall(wsize, <u64>rate, <u64>ch);
    const soft = arenaAlloc(SOFT_STATE), work = arenaAlloc(ws);
    if (!soft || !work) { arenaFree(soft); arenaFree(work); red(); puts("codec: no arena memory for an Opus decoder's work buffer"); end(); return ERR; }
    const r = <u32>guestCall(init, soft, <u64>rate, <u64>ch, work, ws);
    if (r) { arenaFree(soft); arenaFree(work); return r; }
    d.soft = soft; d.work = work;
  }
  d.used = 1; d.key = gd; d.mgr = mgrIndex(m); d.rate = rate; d.ch = ch; d.order = orderSeq++;
  return 0;
}

function freeSlot(m: Mgr, slot: u32): void { store<u16>(m.freeStack + (<usize>(m.nfree++) << 1), <u16>slot); }
// Every request of the decoder dropped, its I/O buffers back to the pool (opus_dec_clear)
function clear(d: Dec, m: Mgr): void {
  for (let n = d.head; n;) {
    const slot = n - 1, p = m.req(slot), r = Inst.at(p);
    n = load<u32>(p, 16);
    if (r.state == OpusReqS.Executing) { r.step(OpusReqE.Abandon); m.abandoned++; }   // the decoder still holds it: the slot waits for its answer
    else { r.step(OpusReqE.Cancel); freeSlot(m, slot); }
    m.ioUsed--;
  }
  d.head = d.tail = 0; d.nwait = d.nexec = d.ndone = 0;
}
// FinalizeHardwareOpusDecoder and ResetHardwareOpusDecoder serve both forms: true when gd is a manager's decoder
export function decFini(gd: u64): bool {
  const d = decFind(gd);
  if (d == null) return false;
  if (d.mgr >= 0) clear(d, mgrAt(d.mgr));
  if (d.host) hostClose(<u32>decIndex(d));
  else { const fini = sdk(S.Fini); if (fini) guestCall(fini, d.soft); arenaFree(<usize>d.soft); arenaFree(<usize>d.work); }
  d.used = 0;
  return true;
}
export function decReset(gd: u64): bool {
  const d = decFind(gd);
  if (d == null) return false;
  if (d.mgr >= 0) clear(d, mgrAt(d.mgr));
  if (d.host) hostReset(<u32>decIndex(d));
  else { const reset = sdk(S.Reset); if (reset) guestCall(reset, d.soft); }
  return true;
}
export function decRate(d: Dec): i32 { return d.rate; }
export function decCh(d: Dec): i32 { return d.ch; }

export function enqueue(gd: u64, consumed: usize, inp: usize, size: u64): u32 {
  if (consumed) store<u64>(consumed, 0);
  const d = decOf(gd);
  if (d == null || d.mgr < 0) return ERR;   // not a decoder of a manager, or the manager was finalized
  if (size < 8 || size > MAX_PACKET) { red(); puts("codec: Opus packet of "); putu(size); puts(" bytes enqueued"); end(); return ERR; }
  const m = mgrAt(d.mgr);
  if (m.ioUsed >= m.ioTotal || !m.nfree) return ERR;   // no free I/O buffer: the game checks the count first
  const slot = <u32>load<u16>(m.freeStack + (<usize>(--m.nfree) << 1)), p = m.req(slot);
  if (!Inst.at(p).step(OpusReqE.Enqueue)) { m.nfree++; return ERR; }
  store<u32>(p, 0, 16); store<u32>(p, <u32>size, 20); store<i32>(p, 0, 24); store<u32>(p, <u32>decIndex(d), 28);
  memory.copy(p + 32, inp, <usize>size);
  if (d.tail) store<u32>(m.req(d.tail - 1), slot + 1, 16); else d.head = slot + 1;
  d.tail = slot + 1;
  m.ioUsed++; d.nwait++;
  if (consumed) store<u64>(consumed, size);
  return 0;
}

// A decoded frame: samples per channel at the request's PCM area. A frame the decoder refuses still completes, as
// 20 ms of silence, so the game's stream stays in step.
function complete(m: Mgr, d: Dec, p: usize, samples: i32, res: u32): void {
  if (samples <= 0 || <u32>samples * <u32>d.ch * 2 > MAX_PCM) {
    if (decodeReds++ < 4) { red(); puts("codec: Opus decode of a "); putu(load<u32>(p, 20)); puts("-byte packet failed ("); putx(res); puts("), silence instead"); end(); }
    samples = 960; memory.fill(p + 32 + MAX_PACKET, 0, <usize>samples * <usize>d.ch * 2);
  }
  Inst.at(p).step(OpusReqE.Complete);
  store<i32>(p, samples, 24); store<u32>(p, <u32>samples * <u32>d.ch * 2, 20);
  d.nexec--; d.ndone++;
}
const USED: usize = memory.data(16);   // DecodeOpusInterleaved's two results: consumed (u64), samples (i32)

export function execute(gm: usize): u32 {
  const m = mgrOf(gm);
  if (m == null) return ERR;
  const mi = mgrIndex(m);
  let any = false;
  // the manager's decoders in the order they were initialized
  for (let after: i64 = -1;;) {
    let d: Dec | null = null;
    for (let i = 0; i < DEC_MAX; i++) { const c = decAt(i); if (c.used && c.mgr == mi && <i64>c.order > after && (d == null || c.order < d.order)) d = c; }
    if (d == null) break;
    after = <i64>d.order;
    if (!d.nwait) continue;
    for (let n = d.head; n; n = load<u32>(m.req(n - 1), 16)) {
      const slot = n - 1, p = m.req(slot), r = Inst.at(p);
      if (r.state != OpusReqS.Waiting) continue;
      r.step(OpusReqE.Execute);
      d.nwait--; d.nexec++;
      const size = load<u32>(p, 20), pcm = p + 32 + MAX_PACKET;
      if (d.host) {
        // Nintendo's header: big-endian packet size and final range, then the packet
        const len = bswap<u32>(load<u32>(p, 32));
        const got = len <= size - 8 ? hostDecode(<u32>decIndex(d), handle(m, slot), p + 40, len, pcm, MAX_PCM) : -2;
        if (got == OPUS_PENDING) continue;
        complete(m, d, p, got, <u32>got); any = true;
      } else {
        store<u64>(USED, 0); store<i32>(USED, 0, 8);
        const res = <u32>guestCall(sdk(S.Decode), d.soft, USED, USED + 8, pcm, MAX_PCM, p + 32, size);
        complete(m, d, p, res ? 0 : load<i32>(USED, 8), res); any = true;
      }
    }
  }
  if (any) eventSignal(m.event);
  return 0;
}

// The embedder's asynchronous decoder is done with a request: where its PCM goes (0: the request is gone, write nothing)
export function reqOut(h: u32): usize {
  const mi = <i32>((h >> 16) & 0xFF), slot = h & 0xFFFF;
  if (mi >= MGR_MAX) return 0;
  const m = mgrAt(mi);
  if (!m.used || (m.gen & 0xFF) != h >> 24 || slot >= m.nreq) return 0;
  const s = Inst.at(m.req(slot)).state;
  return s == OpusReqS.Executing || s == OpusReqS.Abandoned ? m.req(slot) + 32 + MAX_PACKET : 0;
}
// ... and its answer: samples per channel, or <= 0 for a failure
export function reqComplete(h: u32, samples: i32): void {
  if (!reqOut(h)) return;
  const m = mgrAt(<i32>((h >> 16) & 0xFF)), slot = h & 0xFFFF, p = m.req(slot), r = Inst.at(p);
  if (r.state == OpusReqS.Abandoned) { r.step(OpusReqE.Complete); m.abandoned--; freeSlot(m, slot); return; }
  complete(m, decAt(<i32>load<u32>(p, 28)), p, samples, <u32>samples);
  eventSignal(m.event);
}

export function dequeue(gd: u64, samples: usize, outp: usize, outSize: u64): u32 {
  if (samples) store<i32>(samples, 0);
  const d = decOf(gd);
  if (d == null || d.mgr < 0) return ERR;
  const m = mgrAt(d.mgr);
  if (!d.head) return ERR;
  const slot = d.head - 1, p = m.req(slot), r = Inst.at(p);
  if (r.state != OpusReqS.Completed) return ERR;   // nothing completed: the game dequeues only as many as the completed count
  const n = load<u32>(p, 20);
  if (<u64>n > outSize) { red(); puts("codec: a "); putu(n); puts("-byte Opus frame for a "); putu(outSize); puts("-byte buffer"); end(); return ERR; }
  r.step(OpusReqE.Dequeue);
  d.head = load<u32>(p, 16); if (!d.head) d.tail = 0;
  d.ndone--; m.ioUsed--;
  memory.copy(outp, p + 32 + MAX_PACKET, n);
  if (samples) store<i32>(samples, load<i32>(p, 24));
  freeSlot(m, slot);
  return 0;
}
// which: 0 waiting, 1 executing, 2 completed
export function count(gd: u64, which: i32): i32 {
  const d = decOf(gd);
  if (d == null || d.mgr < 0) return 0;
  return <i32>(which == 0 ? d.nwait : which == 1 ? d.nexec : d.ndone);
}
export function mgrStat(i: i32, which: i32): u32 {
  if (i < 0 || i >= MGR_MAX || !mgrAt(i).used) return 0;
  const m = mgrAt(i);
  return which == 0 ? m.ioUsed : which == 1 ? m.abandoned : which == 2 ? m.nfree : m.nreq;
}
