// nn::codec video decoders (the Switch 2's SDK) and the sync point events its players wait on: nxnative
// dm/host/hle_codec_video.c decodes VP8 / VP9 / H.264 / AV1 on the host. Video codecs are CUT here: every name of that
// file is in the table as a stub (tools/hle_names.py CUT) that logs one red line. nxnative has no "cannot decode" path
// for these calls (its initializers always succeed), so the stubs answer what its calls answer for a decoder or pool
// type that holds no host object (cv_of / pool_of null): result module 111 description 2004 from Register, Start,
// Submit, Acquire and the property reads, success from Finalize / Stop / Flush, no native image handle, a black
// picture from the readers. The initializers create nothing, leave the type's host pointer null and return the same
// 2004, so a player that checks its Result skips the movie at InitializeXxxDecoder; one that does not gets 2004 from
// every later call. The sync point events (nn::syncpt) and nn::gs::TryWaitNativeSync are served just enough not to
// hang: a sync handle no decoder made reads as reached, as in nxnative, so a requested event is signalled at once.
// The results are op words (cut_ops in the tool); here are the calls that return a struct, take sizes from the stack
// or forward to the SDK's nn::os.
import { X, W, P, X8, stackArg, guestSym, guestCall1, guestCall2, zero } from "./base";
import { seClear } from "./sysevent";

const CV_MAGIC: u32 = 0x56436d44;   // 'DmCV'
// VideoDecoderImagePreference as nxnative fills it, returned through x8: { u16 w, h; u32 format, mode, magic; u32 pad[2] }
function pref(a: usize): u64 {
  const out = X8(a);
  if (out) { zero(out, 24); store<u16>(out, <u16>X(a, 0)); store<u16>(out, <u16>X(a, 1), 2); store<u32>(out, W(a, 2), 4); store<u32>(out, W(a, 3), 8); store<u32>(out, CV_MAGIC, 12); }
  return 0;
}
export function h_cv_pref(a: usize): u64 { return pref(a); }
export function h_cv_pref22(a: usize): u64 { return pref(a); }
export function h_cv_pref19(a: usize): u64 { return pref(a); }
// ReadDecoderOutputImageRgba(Hdr)(pool, index, x, y, w, h, dst, stride, size): no picture, black
function black(a: usize): u64 { const dst = P(a, 6), size = <usize>stackArg(0); if (dst && size) zero(dst, size); return 0; }
export function h_cv_rgbahdr(a: usize): u64 { return black(a); }
export function h_cv_rgba(a: usize): u64 { return black(a); }
// ReadDecoderOutputImageNv12(pool, index, x, y, w, h, y dst, y stride, y size, uv dst, uv stride, uv size): only whole
// tight pictures are served; no picture is video black (Y 16, UV 128)
export function h_cv_nv12(a: usize): u64 {
  const x = <u32><u16>X(a, 2), y = <u32><u16>X(a, 3), w = <u64><u16>X(a, 4), h = <u64><u16>X(a, 5), ydst = P(a, 6), ystride = X(a, 7);
  const ysize = stackArg(0), uvdst = <usize>stackArg(1), uvstride = stackArg(2), uvsize = stackArg(3);
  if (x || y || ystride != w || uvstride != w || ysize < w * h || uvsize < w * h / 2) return 0;
  if (ydst) memory.fill(ydst, 16, <usize>ysize);
  if (uvdst) memory.fill(uvdst, 128, <usize>uvsize);
  return 0;
}
// nn::syncpt::sdk: the event type holds a SystemEvent the SDK's nn::os made (CreateSyncPointEvent binds one)
export function h_spt_holder(a: usize): u64 {
  const init = guestSym("_ZN2nn2os25InitializeMultiWaitHolderEPNS0_19MultiWaitHolderTypeEPNS0_15SystemEventTypeE");
  if (init) guestCall2(init, X(a, 0), X(a, 1));
  return 0;
}
export function h_spt_cancel(a: usize): u64 { seClear(P(a, 0)); return 0; }
export function h_spt_trywait(a: usize): u64 {
  const tw = guestSym("_ZN2nn2os18TryWaitSystemEventEPNS0_15SystemEventTypeE");
  return tw ? ((guestCall1(tw, X(a, 0)) & 0xff) != 0 ? 1 : 0) : 1;
}
export function h_spt_destroy(a: usize): u64 {
  const destroy = guestSym("_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE");
  if (destroy) guestCall1(destroy, X(a, 0));
  return 0;
}
