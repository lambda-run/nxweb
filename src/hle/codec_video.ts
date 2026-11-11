// nn::codec video decoders (the Switch 2's SDK) and the sync point events its players wait on: a port of nxnative
// dm/host/hle_codec_video.c. The protocol is nxnative's: one image pool per output picture, registered with a
// decoder under an index that goes into an 8-deep queue of acquirable buffers; Release gives a buffer back to be
// filled (pictures go into released buffers in release order) and Acquire takes the oldest (3604 when none);
// Submit takes a packet or refuses it with 3603 (busy, which NintendoSDK_movie retries: no fault). The
// submission-ready event (inside the decoder type at +0x100) is signalled at Initialize and Start, rises when a
// packet was taken or room came back and goes down at CV_READY pictures waiting; packets are refused only at
// CV_HOLD, so a signal in flight still finds room (movies.md "The submission-ready event counted as packets").
//
// Where nxnative decodes on the submitting thread, the decoder here is the embedder's (HleEnv.video: WebCodecs in a
// browser, src/glue/video_webcodecs.ts): a packet it takes is in flight until its completion comes back through
// hle_cv_picture, now or later, and in-flight packets count with the waiting pictures. A completion signals the
// events (the sync point event of the buffer it fills, the submission-ready event) from outside any guest call.
// With no decoder for the codec, every packet gives a picture of video black of the stream's size, so a player
// still runs through its movie and on (nxnative: the movie module aborts on a decoder that does not initialize).
//
// Pictures are kept as tight I420 in memory of the host (hostAlloc, reused), with the stream's matrix and range;
// the readers convert them as md_nv12 / md_rgba do. A pool a native image handle was asked for also gets each
// picture as RGBA in the game's pool memory (16 KB aligned, 64-byte stride), where nvnTextureInitializeFromNativeImage
// makes its linear texture.
import { X, W, P, X8, stackArg, guestSym, guestCall1, guestCall2, hostAlloc, zero, ls, ps, pz, pu, px, le, red, log } from "./base";
import { seBind, seSignal, seClear } from "./sysevent";

// The embedder's decoder (HleEnv.video). codec: 0 VP8, 1 VP9, 2 H.264, 3 AV1. Writes its name (at most cap bytes)
// and returns the length, 0 when it cannot decode the codec
// @ts-ignore: decorator
@external("env", "hle_cv_open")
declare function cvOpen(dec: u32, codec: u32, w: u32, h: u32, name: usize, cap: i32): i32;
// A packet (copied before the call returns): 1 its completion follows (hle_cv_picture, maybe before this returns),
// 2 taken with no picture to come, 0 no decoder. size 0 with eos: drain what is in flight (the result is not used)
// @ts-ignore: decorator
@external("env", "hle_cv_decode")
declare function cvDecode(dec: u32, gen: u32, seq: u64, data: usize, size: usize, eos: i32): i32;
// Drop everything in flight: completions of older generations are refused
// @ts-ignore: decorator
@external("env", "hle_cv_reset")
declare function cvReset(dec: u32, gen: u32): void;
// @ts-ignore: decorator
// a picture was written into the game's memory (the graphics side is told: a texture over it has new texels)
@external("env", "hle_cv_wrote")
declare function cvWrote(ptr: usize, size: usize): void;
@external("env", "hle_cv_close")
declare function cvClose(dec: u32): void;

const CV_MAGIC: u32 = 0x56436d44;   // 'DmCV'
const CV_SYNC: u32 = 0x53436d44;    // 'DmCS': a sync handle the host made (decoder, index, generation)
const NDEC: u32 = 16;
const NBUF: u32 = 32;
const NFIFO: u32 = 8;
const CV_READY: u32 = 4;
const CV_HOLD: u32 = 12;
const CV_EVENT_OFF: usize = 0x100;
const NPOOL: u32 = 64;
const POOL_IMGS: u32 = 32;
const NPIC: u32 = 160;
const NSPT: i32 = 64;
const NATIVE_ALIGN: u64 = 0x4000;
const CV_VP8: u32 = 0, CV_VP9: u32 = 1, CV_H264: u32 = 2, CV_AV1: u32 = 3;
@inline function R(desc: u32): u64 { return <u64>(0x6f | (desc << 9)); }
const ERR_DEC: u32 = 2004, BUSY: u32 = 3603, NONE: u32 = 3604;
// Colour matrices (AV1 / H.273 codes): 1 BT.709, 2 not given, 6 BT.601, 9 BT.2020
const CS_709: u32 = 1, CS_UNSET: u32 = 2, CS_601: u32 = 6, CS_2020: u32 = 9;

@unmanaged class Dec {
  used: u32; codec: u32; w: u32; h: u32; gen: u32; nheld: u32; ninfl: u32; eosPending: u32;
  backend: u32; fhead: u32; fcount: u32; phead: u32; pcount: u32; busyLogs: u32; dropLogs: u32; blackLogs: u32;
  event: u64; submits: u64; pictures: u64; eosAt: u64; black: u64;
}
@unmanaged class Buf { pool: u32; pidx: u32; reg: u32; filled: u32; gen: u32; filledGen: u32; w: u32; h: u32; eos: u32; pad: u32; ts: i64; }
@unmanaged class Held { pic: u32; eos: u32; ts: i64; }
@unmanaged class Infl { seq: u64; ts: i64; }
@unmanaged class Pool { used: u32; w: u32; h: u32; fmt: u32; count: u32; native: u32; mem: u64; size: u64; }
@unmanaged class Pic { ptr: u64; cap: u64; w: u32; h: u32; cs: u32; full: u32; used: u32; pad: u32; }

const DSZ: usize = offsetof<Dec>(), BSZ: usize = offsetof<Buf>(), HSZ: usize = offsetof<Held>(), ISZ: usize = offsetof<Infl>();
const PSZ: usize = offsetof<Pool>(), QSZ: usize = offsetof<Pic>();
const DECS: usize = memory.data(<i32>(NDEC * 112), 8);
const BUFS: usize = memory.data(<i32>(NDEC * NBUF * 48), 8);
const FIFO: usize = memory.data(<i32>(NDEC * NFIFO * 4), 8);
const PEND: usize = memory.data(<i32>(NDEC * NBUF * 4), 8);
const HELD: usize = memory.data(<i32>(NDEC * CV_HOLD * 16), 8);
const INFL: usize = memory.data(<i32>(NDEC * CV_HOLD * 16), 8);
const POOLS: usize = memory.data(<i32>(NPOOL * 40), 8);
const POOLPICS: usize = memory.data(<i32>(NPOOL * POOL_IMGS * 4), 8);
const PICS: usize = memory.data(<i32>(NPIC * 40), 8);
const SPT: usize = memory.data(NSPT * 8, 8);
const NAME: usize = memory.data(40);
const TMP: usize = memory.data(128, 4);
let genCounter: u32 = 0;
let poolLogs: u32 = 0, nativeLogs: u32 = 0, rgbaRegionRed = false, nv12RegionRed = false, hdrRed = false, encRed = false, syncRed = false, sptFullRed = false, picFullRed = false;
let nativeWrites: u64 = 0;
let fnDestroy: u64 = 0, fnTryWait: u64 = 0, fnHolder: u64 = 0;

export function cvInit(): void {
  zero(DECS, <usize>NDEC * 112); zero(BUFS, <usize>(NDEC * NBUF) * 48); zero(FIFO, <usize>(NDEC * NFIFO) * 4); zero(PEND, <usize>(NDEC * NBUF) * 4);
  zero(HELD, <usize>(NDEC * CV_HOLD) * 16); zero(INFL, <usize>(NDEC * CV_HOLD) * 16); zero(POOLS, <usize>NPOOL * 40); zero(POOLPICS, <usize>(NPOOL * POOL_IMGS) * 4);
  zero(PICS, <usize>NPIC * 40); zero(SPT, <usize>NSPT * 8);
  poolLogs = 0; nativeLogs = 0; rgbaRegionRed = false; nv12RegionRed = false; hdrRed = false; encRed = false; syncRed = false; sptFullRed = false; picFullRed = false;
  nativeWrites = 0; genCounter = 0; initLogged = false; fnDestroy = 0; fnTryWait = 0; fnHolder = 0;
}
function sdkFns(): void {   // looked up until found
  if (!fnDestroy) fnDestroy = guestSym("_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
  if (!fnTryWait) fnTryWait = guestSym("_ZN2nn2os18TryWaitSystemEventEPNS0_15SystemEventTypeE");
  if (!fnHolder) fnHolder = guestSym("_ZN2nn2os25InitializeMultiWaitHolderEPNS0_19MultiWaitHolderTypeEPNS0_15SystemEventTypeE");
}

@inline function dec(id: u32): Dec { return changetype<Dec>(DECS + <usize>(id - 1) * DSZ); }
@inline function buf(id: u32, i: u32): Buf { return changetype<Buf>(BUFS + (<usize>(id - 1) * NBUF + i) * BSZ); }
@inline function fifoAt(id: u32, k: u32): usize { return FIFO + (<usize>(id - 1) * NFIFO + k) * 4; }
@inline function pendAt(id: u32, k: u32): usize { return PEND + (<usize>(id - 1) * NBUF + k) * 4; }
@inline function held(id: u32, k: u32): Held { return changetype<Held>(HELD + (<usize>(id - 1) * CV_HOLD + k) * HSZ); }
@inline function infl(id: u32, k: u32): Infl { return changetype<Infl>(INFL + (<usize>(id - 1) * CV_HOLD + k) * ISZ); }
@inline function pool(slot: u32): Pool { return changetype<Pool>(POOLS + <usize>(slot - 1) * PSZ); }
@inline function poolPicAt(slot: u32, i: u32): usize { return POOLPICS + (<usize>(slot - 1) * POOL_IMGS + i) * 4; }
@inline function pic(id: u32): Pic { return changetype<Pic>(PICS + <usize>(id - 1) * QSZ); }

// The decoder a type holds (its first 8 bytes: magic, id), 0 for none
function decOf(t: usize): u32 {
  if (!t) return 0;
  const v = load<u64>(t);
  if (<u32>(v >> 32) != CV_MAGIC) return 0;
  const id = <u32>v;
  return id >= 1 && id <= NDEC && dec(id).used ? id : 0;
}
function poolOf(t: usize): u32 {
  if (!t) return 0;
  const v = load<u64>(t);
  if (<u32>(v >> 32) != CV_MAGIC) return 0;
  const s = <u32>v;
  return s >= 1 && s <= NPOOL && pool(s).used ? s : 0;
}
function name(id: u32): void { const c = dec(id).codec; ps(c == CV_VP8 ? "VP8" : c == CV_VP9 ? "VP9" : c == CV_H264 ? "H.264" : c == CV_AV1 ? "AV1" : "video"); }

// ---------- pictures: tight I420 ----------
function picBytes(w: u32, h: u32): u64 { const cw = <u64>((w + 1) >> 1), ch = <u64>((h + 1) >> 1); return <u64>w * h + 2 * cw * ch; }
export function picAlloc(w: u32, h: u32): u32 {
  if (!w || !h || w > 16384 || h > 16384) return 0;
  const need = picBytes(w, h);
  let empty: u32 = 0;
  for (let i: u32 = 1; i <= NPIC; i++) {
    const p = pic(i);
    if (p.used) continue;
    if (p.ptr && p.cap >= need && p.cap <= need * 2) { p.used = 1; p.w = w; p.h = h; p.cs = CS_UNSET; p.full = 0; return i; }
    if (!p.ptr && !empty) empty = i;
  }
  if (empty) {
    const cap = (need + 63) & ~(<u64>63);
    const ptr = hostAlloc(cap);
    if (ptr) { const p = pic(empty); p.ptr = ptr; p.cap = cap; p.used = 1; p.w = w; p.h = h; p.cs = CS_UNSET; p.full = 0; return empty; }
  }
  if (!picFullRed) { picFullRed = true; ls(); ps("[RED] nn::codec: no room for a "); pu(w); ps("x"); pu(h); ps(" picture (the host keeps "); pu(NPIC); ps("): it is dropped"); le(); }
  return 0;
}
export function picPtr(id: u32): usize { return id >= 1 && id <= NPIC && pic(id).used ? <usize>pic(id).ptr : 0; }
function picFree(id: u32): void { if (id >= 1 && id <= NPIC) pic(id).used = 0; }
function picBlack(id: u32): void {
  const p = pic(id), n = <usize>p.w * p.h;
  memory.fill(<usize>p.ptr, 16, n); memory.fill(<usize>p.ptr + n, 128, <usize>(picBytes(p.w, p.h) - <u64>n));
}
// I420 → NV12 at ydst (stride w) / uvdst (stride w, h / 2 rows); a smaller picture is padded with black, a larger one cropped (md_nv12)
function picNv12(id: u32, ydst: usize, uvdst: usize, w: u32, h: u32): void {
  const p = pic(id), pw = p.w, ph = p.h, cw = (pw + 1) >> 1, ch = (ph + 1) >> 1;
  const py = <usize>p.ptr, pu_ = py + <usize>pw * ph, pv = pu_ + <usize>cw * ch;
  const vw = pw < w ? pw : w, vh = ph < h ? ph : h;
  if (vw < w || vh < h) { memory.fill(ydst, 16, <usize>w * h); memory.fill(uvdst, 128, <usize>w * (h >> 1)); }
  for (let y: u32 = 0; y < vh; y++) memory.copy(ydst + <usize>y * w, py + <usize>y * pw, vw);
  const vw2 = (vw + 1) >> 1, vh2 = (vh + 1) >> 1;
  for (let y: u32 = 0; y < vh2 && y < (h >> 1); y++) {
    const u = pu_ + <usize>y * cw, v = pv + <usize>y * cw, o = uvdst + <usize>y * w;
    for (let x: u32 = 0; (x < vw2) && (x * 2 + 1 < w); x++) { store<u8>(o + 2 * <usize>x, load<u8>(u + x)); store<u8>(o + 2 * <usize>x + 1, load<u8>(v + x)); }
  }
  cvWrote(ydst, <usize>w * h); cvWrote(uvdst, <usize>w * (h >> 1));
}
// I420 → RGBA rows of `stride` bytes, by the matrix and range the picture declares (not given: BT.709 from 720 lines
// up, else BT.601, as md_rgba), 16-bit fixed point; a smaller picture is padded with opaque black, a larger one cropped
function picRgba(id: u32, dst: usize, w: u32, h: u32, stride: usize): void {
  const p = pic(id), pw = p.w, ph = p.h, cw = (pw + 1) >> 1, ch = (ph + 1) >> 1;
  const full = p.full != 0;
  const cs = p.cs == CS_UNSET || (p.cs != CS_709 && p.cs != CS_601 && p.cs != CS_2020) ? (ph >= 720 ? CS_709 : CS_601) : p.cs;
  const ky = full ? 1.0 : 255.0 / 219.0, kc = full ? 1.0 : 255.0 / 224.0;
  const rv = cs == CS_709 ? 1.5748 : cs == CS_2020 ? 1.4746 : 1.402;
  const gu = cs == CS_709 ? 0.1873 : cs == CS_2020 ? 0.16455 : 0.3441;
  const gv = cs == CS_709 ? 0.4681 : cs == CS_2020 ? 0.57135 : 0.7141;
  const bu = cs == CS_709 ? 1.8556 : cs == CS_2020 ? 1.8814 : 1.772;
  const KY = <i32>(ky * 65536), RV = <i32>(rv * kc * 65536), GU = <i32>(gu * kc * 65536), GV = <i32>(gv * kc * 65536), BU = <i32>(bu * kc * 65536), y0: i32 = full ? 0 : 16;
  const vw = pw < w ? pw : w, vh = ph < h ? ph : h;
  if (vw < w || vh < h) for (let y: u32 = 0; y < h; y++) { const o = dst + <usize>y * stride; for (let x: u32 = 0; x < w; x++) store<u32>(o + (<usize>x << 2), 0xff000000); }
  const py = <usize>p.ptr, pu_ = py + <usize>pw * ph, pv = pu_ + <usize>cw * ch;
  for (let y: u32 = 0; y < vh; y++) {
    const ry = py + <usize>y * pw, ru = pu_ + <usize>(y >> 1) * cw, rv_ = pv + <usize>(y >> 1) * cw, o = dst + <usize>y * stride;
    for (let x: u32 = 0; x < vw; x++) {
      const l = (<i32>load<u8>(ry + x) - y0) * KY, u = <i32>load<u8>(ru + (x >> 1)) - 128, v = <i32>load<u8>(rv_ + (x >> 1)) - 128;
      let r = (l + RV * v + 32768) >> 16, g = (l - GU * u - GV * v + 32768) >> 16, b = (l + BU * u + 32768) >> 16;
      r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
      store<u32>(o + (<usize>x << 2), <u32>r | (<u32>g << 8) | (<u32>b << 16) | 0xff000000);
    }
  }
}

// ---------- pools and native images ----------
function nativeStride(w: u32): u32 { return (w * 4 + 63) & ~63; }
function nativeSize(w: u32, h: u32): u64 { return (<u64>nativeStride(w) * h + NATIVE_ALIGN - 1) & ~(NATIVE_ALIGN - 1); }
function poolNativeWrite(slot: u32, i: u32, id: u32): void {
  const p = pool(slot);
  if (!p.native || !p.mem || <u64>(i + 1) * nativeSize(p.w, p.h) > p.size) return;
  picRgba(id, <usize>(p.mem + <u64>i * nativeSize(p.w, p.h)), p.w, p.h, nativeStride(p.w));
  nativeWrites++;
}
// A native image handle (slot << 8 | picture): the picture's memory, size, width, height and stride at out
// (u64, u64, u32, u32, u32), for nvnTextureInitializeFromNativeImage; false when it names no picture
export function cvNativeImage(handle: u32, out: usize): bool {
  const slot = handle >> 8, i = handle & 0xff;
  if (handle >> 31 || slot < 1 || slot > NPOOL || !pool(slot).used) return false;
  const p = pool(slot);
  if (!p.mem || i >= p.count || <u64>(i + 1) * nativeSize(p.w, p.h) > p.size) return false;
  store<u64>(out, p.mem + <u64>i * nativeSize(p.w, p.h)); store<u64>(out, nativeSize(p.w, p.h), 8);
  store<u32>(out, p.w, 16); store<u32>(out, p.h, 20); store<u32>(out, nativeStride(p.w), 24);
  return true;
}
export function cvNativeWrites(): u64 { return nativeWrites; }

// VideoDecoderImagePreference as nxnative fills it, returned through x8: { u16 w, h; u32 format, mode, magic; u32 pad[2] }
function pref(a: usize): u64 {
  const out = X8(a);
  if (out) { zero(out, 24); store<u16>(out, <u16>X(a, 0)); store<u16>(out, <u16>X(a, 1), 2); store<u32>(out, W(a, 2), 4); store<u32>(out, W(a, 3), 8); store<u32>(out, CV_MAGIC, 12); }
  return 0;
}
export function h_cv_pref(a: usize): u64 { return pref(a); }
export function h_cv_pref22(a: usize): u64 { return pref(a); }
export function h_cv_pref19(a: usize): u64 { return pref(a); }
let initLogged = false;
// The first sign of the movie path in a run's log: the game reached nn::codec's video decoders
export function h_cv_init(a: usize): u64 { if (!initLogged) { initLogged = true; log("[codec] nn::codec::video::Initialize: the video decoders are the host's (src/hle/codec_video.ts)"); } return 0; }
export function h_cv_fin(a: usize): u64 { return 0; }
// CalculateDecoderImagePoolBuffer(size*, align*, pref, n): room for RGBA pictures (a native image's texture is made over it)
export function h_cv_poolsize(a: usize): u64 {
  const size = P(a, 0), align = P(a, 1), p = P(a, 2), n = W(a, 3);
  const w = p ? <u32>load<u16>(p) : 0, h = p ? <u32>load<u16>(p, 2) : 0;
  if (size) store<u64>(size, nativeSize(w, h) * <u64>(n ? n : 1));
  if (align) store<u64>(align, NATIVE_ALIGN);
  return 0;
}
function poolInit(t: usize, mem: usize, size: u64, pr: usize, n: u32): u64 {
  if (!t || !pr) return R(ERR_DEC);
  let slot: u32 = 0;
  for (let s: u32 = 1; s <= NPOOL; s++) if (!pool(s).used) { slot = s; break; }
  if (!slot) { red("nn::codec: more than 64 decoder image pools"); return R(ERR_DEC); }
  const p = pool(slot);
  p.used = 1; p.w = <u32>load<u16>(pr); p.h = <u32>load<u16>(pr, 2); p.fmt = load<u32>(pr, 4); p.count = n ? n : 1; p.native = 0; p.mem = <u64>mem; p.size = size;
  if (p.count > POOL_IMGS) { ls(); ps("[RED] nn::codec: an image pool of "); pu(p.count); ps(" pictures: only "); pu(POOL_IMGS); ps(" are kept"); le(); p.count = POOL_IMGS; }
  for (let i: u32 = 0; i < POOL_IMGS; i++) store<u32>(poolPicAt(slot, i), 0);
  store<u64>(t, (<u64>CV_MAGIC << 32) | slot);
  if (poolLogs++ < 4) { ls(); ps("[codec] image pool "); pu(p.w); ps("x"); pu(p.h); ps(" format "); pu(p.fmt); ps(", tiling or mode "); pu(load<u32>(pr, 8)); ps(", "); pu(p.count); ps(" picture(s): the host keeps the decoded pictures"); le(); }
  return 0;
}
export function h_cv_pool(a: usize): u64 { return poolInit(P(a, 0), P(a, 1), X(a, 2), P(a, 3), W(a, 4)); }
export function h_cv_pool22(a: usize): u64 { return poolInit(P(a, 0), P(a, 1), X(a, 2), P(a, 3), W(a, 4)); }
export function h_cv_poolfin(a: usize): u64 {
  const t = P(a, 0), slot = poolOf(t);
  if (!slot) return 0;
  // a decoder still holding a buffer of this pool keeps it, with no pool to put its picture into
  for (let id: u32 = 1; id <= NDEC; id++) if (dec(id).used) for (let i: u32 = 0; i < NBUF; i++) if (buf(id, i).pool == slot) buf(id, i).pool = 0;
  for (let i: u32 = 0; i < POOL_IMGS; i++) { picFree(load<u32>(poolPicAt(slot, i))); store<u32>(poolPicAt(slot, i), 0); }
  pool(slot).used = 0;
  store<u64>(t, 0);
  return 0;
}
// GetDecoderImagePoolNativeImageHandle(pool, i): a handle the native image take-overs know; the pool keeps its pictures as RGBA in its memory from now on
export function h_cv_native(a: usize): u64 {
  const slot = poolOf(P(a, 0)), i = W(a, 1);
  if (!slot || i >= pool(slot).count) return 0;
  const p = pool(slot);
  if (!p.native && nativeLogs++ < 4) { ls(); ps("[codec] native image handles for the "); pu(p.w); ps("x"); pu(p.h); ps(" pool: its pictures go into its memory as RGBA (stride "); pu(nativeStride(p.w)); ps(")"); le(); }
  p.native = 1;
  return <u64>((slot << 8) | i);
}
// ReadDecoderOutputImageRgbaHdr(pool, i, x, y, w, h, dst, stride, size): HDR pictures are not served, black
export function h_cv_rgbahdr(a: usize): u64 {
  const dst = P(a, 6), size = <usize>stackArg(0);
  if (!hdrRed) { hdrRed = true; red("nn::codec::ReadDecoderOutputImageRgbaHdr: HDR pictures are not served, black"); }
  if (dst && size) zero(dst, size);
  return 0;
}
// ReadDecoderOutputImageRgba(pool, i, x, y, w, h, dst, stride, size): whole tight pictures only
export function h_cv_rgba(a: usize): u64 {
  const size = stackArg(0);
  const slot = poolOf(P(a, 0)), i = W(a, 1), x = <u32><u16>X(a, 2), y = <u32><u16>X(a, 3), w = <u32><u16>X(a, 4), h = <u32><u16>X(a, 5), dst = P(a, 6), stride = X(a, 7);
  const id = slot && i < pool(slot).count ? load<u32>(poolPicAt(slot, i)) : 0;
  if (!id) { if (dst && size) zero(dst, <usize>size); return 0; }
  if (x || y || stride != <u64>w * 4 || size < <u64>w * h * 4) {
    if (!rgbaRegionRed) { rgbaRegionRed = true; ls(); ps("[RED] nn::codec::ReadDecoderOutputImageRgba: region "); pu(x); ps(","); pu(y); ps(" stride "); pu(stride); ps(": only whole tight pictures are served"); le(); }
    return 0;
  }
  picRgba(id, dst, w, h, <usize>w * 4);
  return 0;
}
// ReadDecoderOutputImageNv12(pool, i, x, y, w, h, y dst, y stride, y size, uv dst, uv stride, uv size): whole tight
// pictures only; no picture is video black (Y 16, UV 128)
export function h_cv_nv12(a: usize): u64 {
  const ysize = stackArg(0), uvdst = <usize>stackArg(1), uvstride = stackArg(2), uvsize = stackArg(3);
  const slot = poolOf(P(a, 0)), i = W(a, 1);
  const x = <u32><u16>X(a, 2), y = <u32><u16>X(a, 3), w = <u64><u16>X(a, 4), h = <u64><u16>X(a, 5), ydst = P(a, 6), ystride = X(a, 7);
  if (x || y || ystride != w || uvstride != w || ysize < w * h || uvsize < w * h / 2) {
    if (!nv12RegionRed) { nv12RegionRed = true; ls(); ps("[RED] nn::codec::ReadDecoderOutputImageNv12: region "); pu(x); ps(","); pu(y); ps(" strides "); pu(ystride); ps(" / "); pu(uvstride); ps(": only whole tight pictures are served"); le(); }
    return 0;
  }
  const id = slot && i < pool(slot).count ? load<u32>(poolPicAt(slot, i)) : 0;
  if (!id) { if (ydst) memory.fill(ydst, 16, <usize>ysize); if (uvdst) memory.fill(uvdst, 128, <usize>uvsize); return 0; }
  if (ydst && uvdst) picNv12(id, ydst, uvdst, <u32>w, <u32>h);
  return 0;
}

// ---------- decoders ----------
function load_(id: u32): u32 { const d = dec(id); return d.nheld + d.ninfl; }
// Buffer i of decoder id was filled: signal the sync point events waiting for it
function sptFire(id: u32, i: u32): void {
  const b = buf(id, i);
  for (let k = 0; k < NSPT; k++) {
    const e = <usize>load<u64>(SPT + (<usize>k << 3));
    if (!e) continue;
    if (load<u32>(e + 0x48) == CV_SYNC && load<u32>(e + 0x4c) == id && load<u32>(e + 0x50) == i && b.filledGen >= load<u32>(e + 0x54)) {
      store<u32>(e + 0x44, 0); store<u64>(SPT + (<usize>k << 3), 0); seSignal(e);
    }
  }
}
function sptUnarm(e: usize): void {
  for (let k = 0; k < NSPT; k++) if (<usize>load<u64>(SPT + (<usize>k << 3)) == e) store<u64>(SPT + (<usize>k << 3), 0);
  store<u32>(e + 0x44, 0);
}
// Pictures (and a pending end of stream) into released buffers, in release order; then the submission-ready event:
// down at CV_READY waiting, up when a packet was taken or room came back
function drain(id: u32, took: bool, before: u32): void {
  const d = dec(id);
  while (d.pcount && (d.nheld || d.eosPending)) {
    const i = load<u32>(pendAt(id, d.phead)); d.phead = (d.phead + 1) % NBUF; d.pcount--;
    const b = buf(id, i);
    if (d.nheld) {
      const h0 = held(id, 0), pid = h0.pic, ts = h0.ts, eos = h0.eos;
      for (let k: u32 = 1; k < d.nheld; k++) { const s = held(id, k), o = held(id, k - 1); o.pic = s.pic; o.eos = s.eos; o.ts = s.ts; }
      d.nheld--;
      const p = pic(pid);
      b.w = p.w; b.h = p.h; b.ts = ts; b.eos = eos;
      if (b.pool && b.pidx < pool(b.pool).count) {
        poolNativeWrite(b.pool, b.pidx, pid);
        const at = poolPicAt(b.pool, b.pidx);
        picFree(load<u32>(at)); store<u32>(at, pid);
      } else picFree(pid);
      if (!d.pictures++) { ls(); ps("[codec] "); name(id); ps(" decoder "); pu(id); ps(": first picture "); pu(b.w); ps("x"); pu(b.h); ps(" into buffer "); pu(i); if (d.black) ps(" (video black: no decoder)"); le(); }
    } else { b.w = 0; b.h = 0; b.ts = 0; b.eos = 1; d.eosPending = 0; }
    if (b.eos) { ls(); ps("[codec] "); name(id); ps(" decoder "); pu(id); ps(": end of stream after "); pu(d.pictures); ps(" pictures"); le(); }
    b.filled = 1; b.filledGen = b.gen;
    sptFire(id, i);
  }
  if (d.event) {
    const n = load_(id);
    if (n >= CV_READY) seClear(<usize>d.event); else if (took || before >= CV_READY) seSignal(<usize>d.event);
  }
}
function hold(id: u32, pid: u32, ts: i64, eos: bool): bool {
  const d = dec(id);
  if (d.nheld >= CV_HOLD) {
    if (d.dropLogs++ < 4) { ls(); ps("[RED] nn::codec "); name(id); ps(": a packet gave more pictures than the host holds: one dropped"); le(); }
    picFree(pid); return false;
  }
  const h = held(id, d.nheld); h.pic = pid; h.ts = ts; h.eos = eos ? 1 : 0; d.nheld++;
  return true;
}
function inflDrop(id: u32, seq: u64): i32 {   // removes seq's in-flight entry; its index, -1 when it was not in flight
  const d = dec(id);
  for (let k: u32 = 0; k < d.ninfl; k++) if (infl(id, k).seq == seq) {
    for (let j = k + 1; j < d.ninfl; j++) { const s = infl(id, j), o = infl(id, j - 1); o.seq = s.seq; o.ts = s.ts; }
    d.ninfl--; return <i32>k;
  }
  return -1;
}
// A packet's completion from the embedder's decoder: pic 0 for none. 1 when the picture was kept (otherwise it is freed)
export function cvComplete(id: u32, gen: u32, seq: u64, pid: u32, cs: u32, full: u32): i32 {
  if (id < 1 || id > NDEC || !dec(id).used || dec(id).gen != gen) { picFree(pid); return 0; }
  const d = dec(id);
  let ts: i64 = 0, found = false;
  for (let k: u32 = 0; k < d.ninfl; k++) if (infl(id, k).seq == seq) { ts = infl(id, k).ts; found = true; break; }
  if (!found) { picFree(pid); return 0; }
  const before = load_(id);
  inflDrop(id, seq);
  const eos = d.eosAt != 0 && d.eosAt == seq;
  if (eos) d.eosAt = 0;
  let got = false;
  if (pid) { pic(pid).cs = cs; pic(pid).full = full; got = hold(id, pid, ts, eos); }
  if (eos && !got) d.eosPending = 1;
  drain(id, false, before);
  return got ? 1 : 0;
}
function blackPicture(id: u32, ts: i64, eos: bool): bool {
  const d = dec(id);
  if (!d.w || !d.h) return false;
  const pid = picAlloc(d.w, d.h);
  if (!pid) return false;
  picBlack(pid);
  d.black++;
  return hold(id, pid, ts, eos);
}

function decInit(t: usize, codec: u32, w: u32, h: u32, fin: u32, fout: u32): u64 {
  if (!t) return R(ERR_DEC);
  let id: u32 = 0;
  for (let i: u32 = 1; i <= NDEC; i++) if (!dec(i).used) { id = i; break; }
  if (!id) { red("nn::codec: more than 16 video decoders: Initialize refused"); return R(ERR_DEC); }
  zero(changetype<usize>(dec(id)), DSZ);
  for (let i: u32 = 0; i < NBUF; i++) zero(changetype<usize>(buf(id, i)), BSZ);
  const d = dec(id);
  d.used = 1; d.codec = codec; d.w = w; d.h = h; d.gen = ++genCounter;
  const n = cvOpen(id, codec, w, h, NAME, 32);
  d.backend = n > 0 ? 1 : 0;
  d.event = <u64>(t + CV_EVENT_OFF);
  seBind(t + CV_EVENT_OFF, 0); seSignal(t + CV_EVENT_OFF);
  store<u64>(t, (<u64>CV_MAGIC << 32) | id);
  ls(); ps(n > 0 ? "[codec] " : "[RED] nn::codec "); name(id); ps(" decoder "); pu(id); ps(": "); pu(w); ps("x"); pu(h); ps(", input format "); pu(fin); ps(", output format "); pu(fout);
  if (n > 0) { const nl: i32 = n < 32 ? n : 32; store<u8>(NAME + <usize>nl, 0); ps(" ("); pz(NAME, 32); ps(" on the host)"); }
  else ps(": no decoder for it on the host (HleEnv.video), every packet gives a picture of video black");
  le();
  return 0;
}
function decFin(t: usize): u64 {
  const id = decOf(t);
  if (!id) return 0;
  const d = dec(id);
  if (d.backend) cvClose(id);
  for (let k: u32 = 0; k < d.nheld; k++) picFree(held(id, k).pic);
  ls(); ps("[codec] "); name(id); ps(" decoder "); pu(id); ps(" finalized: "); pu(d.submits); ps(" packets, "); pu(d.pictures); ps(" pictures"); if (d.black) { ps(", "); pu(d.black); ps(" of them video black"); } le();
  d.nheld = 0; d.ninfl = 0; d.used = 0; d.gen = ++genCounter;
  sdkFns();
  if (fnDestroy) guestCall1(fnDestroy, d.event);
  store<u64>(t, 0);
  return 0;
}
function decReg(t: usize, i: u32, pl: usize, pidx: u32): u64 {
  const id = decOf(t);
  if (!id || i >= NBUF) { ls(); ps("[RED] nn::codec::Register…DecoderBuffer index "); pu(i); le(); return R(ERR_DEC); }
  const d = dec(id), b = buf(id, i);
  b.pool = poolOf(pl); b.pidx = pidx; b.reg = 1; b.filled = 0; b.gen = 0; b.filledGen = 0;
  if (d.fcount < NFIFO) { store<u32>(fifoAt(id, (d.fhead + d.fcount) % NFIFO), i); d.fcount++; }
  else { ls(); ps("[RED] nn::codec: acquirable queue full at register "); pu(i); le(); }
  return 0;
}
function dropIndex(id: u32, fifo: bool, i: u32): void {   // removes i from a ring of indices, keeping the others' order
  const d = dec(id), cap = fifo ? NFIFO : NBUF;
  const head = fifo ? d.fhead : d.phead, count = fifo ? d.fcount : d.pcount;
  let n: u32 = 0;
  const tmp = TMP;
  for (let k: u32 = 0; k < count; k++) { const at = fifo ? fifoAt(id, (head + k) % cap) : pendAt(id, (head + k) % cap); const v = load<u32>(at); if (v != i) { store<u32>(tmp + (<usize>n << 2), v); n++; } }
  for (let k: u32 = 0; k < n; k++) store<u32>(fifo ? fifoAt(id, k) : pendAt(id, k), load<u32>(tmp + (<usize>k << 2)));
  if (fifo) { d.fhead = 0; d.fcount = n; } else { d.phead = 0; d.pcount = n; }
}
function decUnreg(t: usize, i: u32): u64 {
  const id = decOf(t);
  if (!id || i >= NBUF) return R(ERR_DEC);
  const b = buf(id, i);
  b.reg = 0; b.filled = 0; b.pool = 0; b.gen++;
  dropIndex(id, true, i); dropIndex(id, false, i);
  return 0;
}
// Stop / Flush: pictures not yet in a buffer, packets in flight and a pending end of stream are dropped; the decoder
// starts over at the next key frame
function decReset(t: usize): u64 {
  const id = decOf(t);
  if (!id) return 0;
  const d = dec(id);
  for (let k: u32 = 0; k < d.nheld; k++) picFree(held(id, k).pic);
  d.nheld = 0; d.ninfl = 0; d.eosPending = 0; d.eosAt = 0; d.gen = ++genCounter;
  if (d.backend) cvReset(id, d.gen);
  if (d.event) seSignal(<usize>d.event);
  return 0;
}
function decStart(t: usize): u64 {
  const id = decOf(t);
  if (!id) return R(ERR_DEC);
  const d = dec(id);
  if (d.event && load_(id) < CV_READY) seSignal(<usize>d.event);
  return 0;
}
function decSubmit(out: usize, t: usize, data: usize, size: u64, ts: i64, eos: bool): u64 {
  const id = decOf(t);
  if (!id) return R(ERR_DEC);
  const d = dec(id);
  if (load_(id) >= CV_HOLD) {
    if (d.busyLogs++ < 4) { ls(); ps("nn::codec "); name(id); ps(": busy (result 3603), a packet refused with "); pu(d.nheld); ps(" pictures waiting for a released buffer and "); pu(d.ninfl); ps(" packets decoding"); le(); }
    if (d.event) seClear(<usize>d.event);
    return R(BUSY);
  }
  const seq = ++d.submits, gen = d.gen;
  if (size && data) {
    let r: i32 = 0;
    if (d.backend) {
      const f = infl(id, d.ninfl); f.seq = seq; f.ts = ts; d.ninfl++;
      if (eos) d.eosAt = seq;
      r = cvDecode(id, gen, seq, data, <usize>size, eos ? 1 : 0);
      if (d.gen != gen) r = 2;            // reset from inside the decoder's call
      else if (r != 1) { inflDrop(id, seq); if (d.eosAt == seq) d.eosAt = 0; }
    }
    if (r == 0) {
      if (d.backend && !d.blackLogs++) { ls(); ps("[RED] nn::codec "); name(id); ps(" decoder "); pu(id); ps(": the host decoder took no packet: video black"); le(); }
      if (!blackPicture(id, ts, eos) && eos) d.eosPending = 1;
    } else if (r == 2 && eos) {
      if (d.ninfl) d.eosAt = infl(id, d.ninfl - 1).seq; else d.eosPending = 1;
    }
  } else if (eos) {
    if (d.ninfl) d.eosAt = infl(id, d.ninfl - 1).seq; else d.eosPending = 1;
    if (d.backend) cvDecode(id, gen, seq, 0, 0, 1);
  }
  if (out) store<u64>(out, seq);
  drain(id, true, 0);
  return 0;
}
function decAcq(idx: usize, sync: usize, t: usize): u64 {
  const id = decOf(t);
  if (!id) return R(ERR_DEC);
  const d = dec(id);
  if (!d.fcount) return R(NONE);
  const i = load<u32>(fifoAt(id, d.fhead)); d.fhead = (d.fhead + 1) % NFIFO; d.fcount--;
  if (idx) store<u32>(idx, i);
  if (sync) { store<u32>(sync, CV_SYNC); store<u32>(sync, id, 4); store<u32>(sync, i, 8); store<u32>(sync, buf(id, i).gen, 12); }
  return 0;
}
function decRel(t: usize, i: u32): u64 {
  const id = decOf(t);
  if (!id || i >= NBUF || !buf(id, i).reg) { ls(); ps("[RED] nn::codec::Release…DecoderOutputBuffer index "); pu(i); le(); return 0; }
  const d = dec(id), b = buf(id, i), before = load_(id);
  b.gen++; b.filled = 0;
  if (d.pcount < NBUF) { store<u32>(pendAt(id, (d.phead + d.pcount) % NBUF), i); d.pcount++; }
  if (d.fcount < NFIFO) { store<u32>(fifoAt(id, (d.fhead + d.fcount) % NFIFO), i); d.fcount++; }
  else { ls(); ps("[RED] nn::codec: acquirable queue full at release "); pu(i); le(); }
  drain(id, false, before);
  return 0;
}
function decProps(w: usize, h: usize, cw: usize, ch: usize, ts: usize, eos: usize, t: usize, i: u32): u64 {
  const id = decOf(t);
  if (!id || i >= NBUF) return R(ERR_DEC);
  const b = buf(id, i);
  if (!b.filled) return R(NONE);
  if (w) store<u16>(w, <u16>b.w); if (cw) store<u16>(cw, <u16>b.w);
  if (h) store<u16>(h, <u16>b.h); if (ch) store<u16>(ch, <u16>b.h);
  if (ts) store<i64>(ts, b.ts);
  if (eos) store<u8>(eos, b.eos ? 1 : 0);
  return 0;
}
function decEvent(out: usize, t: usize): u64 { const id = decOf(t); if (out) store<u64>(out, id ? dec(id).event : 0); return id ? 0 : R(ERR_DEC); }
function encrypted(): u64 { if (!encRed) { encRed = true; red("nn::codec: an encrypted input buffer: protected streams are not served"); } return R(ERR_DEC); }

// CalculateXxxDecoderWorkBuffer(size*, align*, bs, w, h): the host decoder needs no work memory
function work(a: usize): u64 { const s = P(a, 0), al = P(a, 1); if (s) store<u64>(s, 0x1000); if (al) store<u64>(al, 0x1000); return 0; }
// Initialize(t, work, wsize, bs, w, h, refs, in; [sp] out ...)
function initW(a: usize, codec: u32): u64 { const out = <u32>stackArg(0); return decInit(P(a, 0), codec, <u32><u16>X(a, 4), <u32><u16>X(a, 5), W(a, 7), out); }
// Initialize(t, bs, w, h, refs, in, out ...) (SDK 22 ByRemoteMemory has the same registers)
function init2(a: usize, codec: u32): u64 { return decInit(P(a, 0), codec, <u32><u16>X(a, 2), <u32><u16>X(a, 3), W(a, 5), W(a, 6)); }
// SDK 19 Initialize(t, bs, mem, w, h, refs, in, out)
function init19(a: usize, codec: u32): u64 { return decInit(P(a, 0), codec, <u32><u16>X(a, 3), <u32><u16>X(a, 4), W(a, 6), W(a, 7)); }
function submit(a: usize): u64 { return decSubmit(P(a, 0), P(a, 1), P(a, 2), X(a, 3), <i64>X(a, 4), (W(a, 5) & 0xff) != 0); }
function props(a: usize): u64 { return decProps(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 4), P(a, 5), P(a, 6), W(a, 7)); }
// SDK 19: (w, h, cw, ch, colour space*, ts, eos, t; [sp] i)
function props19(a: usize): u64 { const i = <u32>stackArg(0), cs = P(a, 4); if (cs) store<u32>(cs, 0); return decProps(P(a, 0), P(a, 1), P(a, 2), P(a, 3), P(a, 5), P(a, 6), P(a, 7), i); }
function ev22(a: usize): u64 { const id = decOf(P(a, 0)); return id ? dec(id).event : 0; }

export function h_cv_vp8work(a: usize): u64 { return work(a); }
export function h_cv_vp9work(a: usize): u64 { return work(a); }
export function h_cv_h264work(a: usize): u64 { return work(a); }
export function h_cv_av1work(a: usize): u64 { return work(a); }
export function h_cv_vp8init(a: usize): u64 { return initW(a, CV_VP8); }
export function h_cv_vp9init(a: usize): u64 { return initW(a, CV_VP9); }
export function h_cv_h264init(a: usize): u64 { return initW(a, CV_H264); }
export function h_cv_av1init(a: usize): u64 { return initW(a, CV_AV1); }
export function h_cv_h264init3(a: usize): u64 { return initW(a, CV_H264); }
export function h_cv_vp8tm(a: usize): u64 { return initW(a, CV_VP8); }
export function h_cv_vp9tm(a: usize): u64 { return initW(a, CV_VP9); }
export function h_cv_h264tm(a: usize): u64 { return initW(a, CV_H264); }
export function h_cv_av1tm(a: usize): u64 { return initW(a, CV_AV1); }
export function h_cv_vp8init2(a: usize): u64 { return init2(a, CV_VP8); }
export function h_cv_vp9init2(a: usize): u64 { return init2(a, CV_VP9); }
export function h_cv_h264init2(a: usize): u64 { return init2(a, CV_H264); }
export function h_cv_av1init2(a: usize): u64 { return init2(a, CV_AV1); }
export function h_cv_vp8rm(a: usize): u64 { return init2(a, CV_VP8); }
export function h_cv_vp9rm(a: usize): u64 { return init2(a, CV_VP9); }
export function h_cv_h264rm(a: usize): u64 { return init2(a, CV_H264); }
export function h_cv_av1rm(a: usize): u64 { return init2(a, CV_AV1); }
export function h_cv_vp8rm19(a: usize): u64 { return init19(a, CV_VP8); }
export function h_cv_vp9rm19(a: usize): u64 { return init19(a, CV_VP9); }
export function h_cv_h264rm19(a: usize): u64 { return init19(a, CV_H264); }
export function h_cv_av1rm19(a: usize): u64 { return init19(a, CV_AV1); }
export function h_cv_vp8fin(a: usize): u64 { return decFin(P(a, 0)); }
export function h_cv_vp9fin(a: usize): u64 { return decFin(P(a, 0)); }
export function h_cv_h264fin(a: usize): u64 { return decFin(P(a, 0)); }
export function h_cv_av1fin(a: usize): u64 { return decFin(P(a, 0)); }
export function h_cv_vp8reg(a: usize): u64 { return decReg(P(a, 0), W(a, 1), P(a, 2), W(a, 3)); }
export function h_cv_vp9reg(a: usize): u64 { return decReg(P(a, 0), W(a, 1), P(a, 2), W(a, 3)); }
export function h_cv_h264reg(a: usize): u64 { return decReg(P(a, 0), W(a, 1), P(a, 2), W(a, 3)); }
export function h_cv_av1reg(a: usize): u64 { return decReg(P(a, 0), W(a, 1), P(a, 2), W(a, 3)); }
export function h_cv_vp8unreg(a: usize): u64 { return decUnreg(P(a, 0), W(a, 1)); }
export function h_cv_vp9unreg(a: usize): u64 { return decUnreg(P(a, 0), W(a, 1)); }
export function h_cv_h264unreg(a: usize): u64 { return decUnreg(P(a, 0), W(a, 1)); }
export function h_cv_av1unreg(a: usize): u64 { return decUnreg(P(a, 0), W(a, 1)); }
export function h_cv_vp8start(a: usize): u64 { return decStart(P(a, 0)); }
export function h_cv_vp9start(a: usize): u64 { return decStart(P(a, 0)); }
export function h_cv_h264start(a: usize): u64 { return decStart(P(a, 0)); }
export function h_cv_av1start(a: usize): u64 { return decStart(P(a, 0)); }
export function h_cv_vp8stop(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_vp9stop(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_h264stop(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_av1stop(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_vp8flush(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_vp9flush(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_h264flush(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_av1flush(a: usize): u64 { return decReset(P(a, 0)); }
export function h_cv_vp8event(a: usize): u64 { return decEvent(P(a, 0), P(a, 1)); }
export function h_cv_vp9event(a: usize): u64 { return decEvent(P(a, 0), P(a, 1)); }
export function h_cv_h264event(a: usize): u64 { return decEvent(P(a, 0), P(a, 1)); }
export function h_cv_av1event(a: usize): u64 { return decEvent(P(a, 0), P(a, 1)); }
export function h_cv_vp8ev22(a: usize): u64 { return ev22(a); }
export function h_cv_vp9ev22(a: usize): u64 { return ev22(a); }
export function h_cv_h264ev22(a: usize): u64 { return ev22(a); }
export function h_cv_av1ev22(a: usize): u64 { return ev22(a); }
export function h_cv_vp8submit(a: usize): u64 { return submit(a); }
export function h_cv_vp9submit(a: usize): u64 { return submit(a); }
export function h_cv_h264submit(a: usize): u64 { return submit(a); }
export function h_cv_av1submit(a: usize): u64 { return submit(a); }
export function h_cv_vp8enc(a: usize): u64 { return encrypted(); }
export function h_cv_vp9enc(a: usize): u64 { return encrypted(); }
export function h_cv_h264enc(a: usize): u64 { return encrypted(); }
export function h_cv_av1enc(a: usize): u64 { return encrypted(); }
export function h_cv_vp8acq(a: usize): u64 { return decAcq(P(a, 0), P(a, 1), P(a, 2)); }
export function h_cv_vp9acq(a: usize): u64 { return decAcq(P(a, 0), P(a, 1), P(a, 2)); }
export function h_cv_h264acq(a: usize): u64 { return decAcq(P(a, 0), P(a, 1), P(a, 2)); }
export function h_cv_av1acq(a: usize): u64 { return decAcq(P(a, 0), P(a, 1), P(a, 2)); }
// Release(t, i, sync by value in x2:x3): the sync handle is not looked at
export function h_cv_vp8rel(a: usize): u64 { return decRel(P(a, 0), W(a, 1)); }
export function h_cv_vp9rel(a: usize): u64 { return decRel(P(a, 0), W(a, 1)); }
export function h_cv_h264rel(a: usize): u64 { return decRel(P(a, 0), W(a, 1)); }
export function h_cv_av1rel(a: usize): u64 { return decRel(P(a, 0), W(a, 1)); }
export function h_cv_vp8props(a: usize): u64 { return props(a); }
export function h_cv_vp9props(a: usize): u64 { return props(a); }
export function h_cv_h264props(a: usize): u64 { return props(a); }
export function h_cv_av1props(a: usize): u64 { return props(a); }
export function h_cv_vp8props19(a: usize): u64 { return props19(a); }
export function h_cv_vp9props19(a: usize): u64 { return props19(a); }
export function h_cv_h264props19(a: usize): u64 { return props19(a); }
export function h_cv_av1props19(a: usize): u64 { return props19(a); }

// ---------- sync handles and sync point events ----------
// A sync handle no decoder made reads as reached, as in nxnative
function syncReached(s: usize): bool {
  if (!s) return true;
  const magic = load<u32>(s), id = load<u32>(s, 4), i = load<u32>(s, 8), gen = load<u32>(s, 12);
  if (magic != CV_SYNC) {
    if (!syncRed && (magic || id)) { syncRed = true; ls(); ps("[RED] nn::codec: a sync handle the host did not make ("); px(magic); ps("): signalled"); le(); }
    return true;
  }
  if (!gen) return true;
  if (id < 1 || id > NDEC || !dec(id).used || i >= NBUF) return true;
  const b = buf(id, i);
  return b.filled != 0 && b.filledGen >= gen;
}
export function h_gs_trywait(a: usize): u64 { return syncReached(P(a, 0)) ? 1 : 0; }
// The event type: a SystemEvent the SDK's nn::os made at +0, the host's { magic, armed, wanted sync handle } at +0x40
export function h_spt_create(a: usize): u64 {
  const e = P(a, 0);
  if (!e) return 0;
  zero(e, 0x58); seBind(e, 0); store<u32>(e + 0x40, CV_SYNC);
  return 0;
}
export function h_spt_holder(a: usize): u64 {
  sdkFns();
  if (fnHolder) guestCall2(fnHolder, X(a, 0), X(a, 1)); else red("nn::syncpt: no nn::os::InitializeMultiWaitHolder(SystemEventType) in the guest");
  return 0;
}
export function h_spt_request(a: usize): u64 {
  const e = P(a, 0), s = P(a, 1);
  if (!e) return 0;
  sptUnarm(e); seClear(e);
  if (s) memory.copy(e + 0x48, s, 16); else zero(e + 0x48, 16);
  store<u32>(e + 0x44, 1);
  let k = 0;
  while (k < NSPT && load<u64>(SPT + (<usize>k << 3))) k++;
  if (k == NSPT) { if (!sptFullRed) { sptFullRed = true; red("nn::syncpt: more than 64 armed events: signalled at once"); } store<u32>(e + 0x44, 0); seSignal(e); return 0; }
  store<u64>(SPT + (<usize>k << 3), <u64>e);
  if (syncReached(e + 0x48)) { sptUnarm(e); seSignal(e); }
  return 0;
}
export function h_spt_cancel(a: usize): u64 { const e = P(a, 0); if (e) { sptUnarm(e); seClear(e); } return 0; }
export function h_spt_trywait(a: usize): u64 {
  sdkFns();
  return fnTryWait ? ((guestCall1(fnTryWait, X(a, 0)) & 0xff) != 0 ? 1 : 0) : 1;
}
export function h_spt_destroy(a: usize): u64 {
  const e = P(a, 0);
  if (!e) return 0;
  sptUnarm(e);
  sdkFns();
  if (fnDestroy) guestCall1(fnDestroy, <u64>e);
  store<u32>(e + 0x40, 0);
  return 0;
}
