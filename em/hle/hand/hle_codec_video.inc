// Hand-written thunks of nxnative's hle_codec_video.c: what tools/gen_hle.py does not generate.
//   cv_pref (24 bytes) is returned through the pointer the caller passes in x8;
//   cv_sync (16 bytes) passed by value arrives in two registers.
#define NXT_HAVE_h_cv_pref 1
void nxt_hle_codec_video_h_cv_pref(uint64_t *ctx) { cv_pref r = h_cv_pref((uint16_t)ctx[0], (uint16_t)ctx[1], (uint32_t)ctx[2], (uint32_t)ctx[3]); memcpy((void *)(uintptr_t)ctx[8], &r, sizeof r); }
#define NXT_HAVE_h_cv_pref22 1
void nxt_hle_codec_video_h_cv_pref22(uint64_t *ctx) { cv_pref r = h_cv_pref22(ctx[0], ctx[1], (uint32_t)ctx[2], (uint32_t)ctx[3]); memcpy((void *)(uintptr_t)ctx[8], &r, sizeof r); }
#define NXT_HAVE_h_cv_pref19 1
void nxt_hle_codec_video_h_cv_pref19(uint64_t *ctx) { cv_pref r = h_cv_pref19(ctx[0], ctx[1], (uint32_t)ctx[2], (uint32_t)ctx[3]); memcpy((void *)(uintptr_t)ctx[8], &r, sizeof r); }
#define NX_CV_REL(tag) void nxt_hle_codec_video_h_cv_##tag##rel(uint64_t *ctx) { cv_sync s; memcpy(&s, &ctx[2], sizeof s); h_cv_##tag##rel((void *)(uintptr_t)ctx[0], (uint32_t)ctx[1], s); }
#define NXT_HAVE_h_cv_vp9rel 1
NX_CV_REL(vp9)
#define NXT_HAVE_h_cv_vp8rel 1
NX_CV_REL(vp8)
#define NXT_HAVE_h_cv_h264rel 1
NX_CV_REL(h264)
#define NXT_HAVE_h_cv_av1rel 1
NX_CV_REL(av1)
// the native image of a handle, for the NVN side on the owner thread (nxweb's RtGfx.nativeImageOf): out = mem, size, w, h, stride
#include <emscripten.h>
EMSCRIPTEN_KEEPALIVE int nx_native_image(uint32_t handle, double out_) {
    uint64_t *out = (uint64_t *)(uintptr_t)out_; uint8_t *mem; uint64_t size; uint32_t w, h, stride;
    if (!dm_native_image(handle, &mem, &size, &w, &h, &stride)) return 0;
    out[0] = (uint64_t)(uintptr_t)mem; out[1] = size; out[2] = w; out[3] = h; out[4] = stride;
    return 1;
}
