// nxem: what nxnative's nn::codec video decoder (hle_codec_video.c, built unedited) takes from files that are not in
// the build: the AV1 decoder (hle_movie_av1.c: VideoToolbox / dav1d), the picture conversions (hle_movie.c, NEON) and
// libvpx's image container. Here the AV1 decoder is the browser's (WebCodecs through nxweb's src/glue/
// video_webcodecs.ts, on the owner thread): mav1_decode hands a packet over and waits for its picture.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include "hle_movie_av1.h"
#include "vpx/vpx_image.h"

// ---- libvpx's image container (I420 only: what hle_codec_video.c keeps)
vpx_image_t *vpx_img_alloc(vpx_image_t *img, vpx_img_fmt_t fmt, unsigned int d_w, unsigned int d_h, unsigned int align) {
    if (fmt != VPX_IMG_FMT_I420) return NULL;
    int own = !img; if (own) img = calloc(1, sizeof *img); else memset(img, 0, sizeof *img);
    if (!img) return NULL;
    if (!align) align = 1;
    unsigned w = (d_w + 1) & ~1u, h = (d_h + 1) & ~1u, s = (w + align - 1) / align * align, cs = (w / 2 + align - 1) / align * align;
    img->img_data = malloc((size_t)s * h + 2 * (size_t)cs * (h / 2));
    if (!img->img_data) { if (own) free(img); return NULL; }
    img->fmt = fmt; img->w = w; img->h = h; img->d_w = d_w; img->d_h = d_h; img->bit_depth = 8; img->x_chroma_shift = img->y_chroma_shift = 1; img->bps = 12;
    img->img_data_owner = 1; img->self_allocd = own;
    img->planes[0] = img->img_data; img->planes[1] = img->planes[0] + (size_t)s * h; img->planes[2] = img->planes[1] + (size_t)cs * (h / 2);
    img->stride[0] = (int)s; img->stride[1] = img->stride[2] = (int)cs;
    return img;
}
void vpx_img_free(vpx_image_t *img) { if (!img) return; if (img->img_data_owner) free(img->img_data); if (img->self_allocd) free(img); }

// Host code wrote [p, p + n) of guest memory: nxweb's recorder (owner thread) marks what lies over it for upload
void nx_owner_do(int code, uint64_t *regs);   // kernel/nx_proc.c
void nx_guest_wrote(const void *p, size_t n) { _Alignas(16) uint64_t blk[0x80]; blk[0] = (uint64_t)(uintptr_t)p; blk[1] = n; nx_owner_do(4 << 24, blk); }

// ---- I420 -> NV12 / RGBA (the semantics of hle_movie.c md_nv12 / md_rgba, without NEON)
void md_nv12(const vpx_image_t *im, uint8_t *dst, int w, int h) {
    int cw = (int)im->d_w < w ? (int)im->d_w : w, ch = (int)im->d_h < h ? (int)im->d_h : h;
    if (cw < w || ch < h) { memset(dst, 16, (size_t)w * h); memset(dst + (size_t)w * h, 128, (size_t)w * h / 2); }
    for (int y = 0; y < ch; y++) memcpy(dst + (size_t)y * w, im->planes[0] + (size_t)y * im->stride[0], (size_t)cw);
    int cw2 = (cw + 1) / 2, ch2 = (ch + 1) / 2;
    for (int y = 0; y < ch2 && y < h / 2; y++) {
        const uint8_t *u = im->planes[1] + (size_t)y * im->stride[1], *v = im->planes[2] + (size_t)y * im->stride[2];
        uint8_t *o = dst + (size_t)w * h + (size_t)y * w;
        for (int x = 0; x < cw2 && 2 * x + 1 < w; x++) { o[2 * x] = u[x]; o[2 * x + 1] = v[x]; }
    }
    nx_guest_wrote(dst, (size_t)w * h * 3 / 2);
}
static inline uint8_t clamp8(int v) { return v < 0 ? 0 : v > 255 ? 255 : (uint8_t)v; }
void md_rgba(const vpx_image_t *im, uint8_t *dst, int w, int h) {
    int full = im->range == VPX_CR_FULL_RANGE, b709 = im->cs == VPX_CS_BT_709 || (im->cs == VPX_CS_UNKNOWN && h >= 720);
    double ky = full ? 1.0 : 255.0 / 219.0, kc = full ? 1.0 : 255.0 / 224.0;
    double rv = b709 ? 1.5748 : 1.402, gu = b709 ? 0.1873 : 0.3441, gv = b709 ? 0.4681 : 0.7141, bu = b709 ? 1.8556 : 1.772;
    int Y = (int)(ky * 65536), RV = (int)(rv * kc * 65536), GU = (int)(gu * kc * 65536), GV = (int)(gv * kc * 65536), BU = (int)(bu * kc * 65536), y0 = full ? 0 : 16;
    int cw = (int)im->d_w < w ? (int)im->d_w : w, ch = (int)im->d_h < h ? (int)im->d_h : h;
    if (cw < w || ch < h) for (size_t i = 0; i < (size_t)w * h; i++) ((uint32_t *)dst)[i] = 0xff000000u;
    for (int y = 0; y < ch; y++) {
        const uint8_t *py = im->planes[0] + (size_t)y * im->stride[0], *pu = im->planes[1] + (size_t)(y / 2) * im->stride[1], *pv = im->planes[2] + (size_t)(y / 2) * im->stride[2];
        uint8_t *o = dst + (size_t)y * w * 4;
        for (int x = 0; x < cw; x++) {
            int yy = (py[x] - y0) * Y + 32768, u = pu[x / 2] - 128, v = pv[x / 2] - 128;
            o[4 * x] = clamp8((yy + RV * v) >> 16); o[4 * x + 1] = clamp8((yy - GU * u - GV * v) >> 16); o[4 * x + 2] = clamp8((yy + BU * u) >> 16); o[4 * x + 3] = 255;
        }
    }
    nx_guest_wrote(dst, (size_t)w * h * 4);
}

// ---- the AV1 decoder on the owner thread. A request block as a host call's (x0.. at its start, the completion cell at +0x3F0):
// x0 op (1 open, 2 decode, 3 reset, 4 close), x1 decoder, x2 packet, x3 length, x4 picture buffer, x5 its size, x6 packet number;
// back: x0 = 1 a picture (x1 w, x2 h, x3 matrix, x4 full range; NV12 in the buffer, rows of w), 0 none
enum { OWNER_VIDEO = 3 << 24, PIC_MAX = 4096 * 2304 * 3 / 2 };
struct mav1 { int id; uint8_t *buf; uint64_t seq; };
static _Atomic int g_av1_ids;
static uint64_t video(mav1 *a, int op, const uint8_t *data, size_t n, uint64_t *blk) {
    memset(blk, 0, 0x400);
    blk[0] = (uint64_t)op; blk[1] = (uint64_t)a->id; blk[2] = (uint64_t)(uintptr_t)data; blk[3] = n; blk[4] = (uint64_t)(uintptr_t)a->buf; blk[5] = PIC_MAX; blk[6] = a->seq;
    nx_owner_do(OWNER_VIDEO, blk);
    return blk[0];
}
mav1 *mav1_new(void) { mav1 *a = calloc(1, sizeof *a); if (!a) return NULL; a->id = ++g_av1_ids; _Alignas(16) uint64_t blk[0x80]; video(a, 1, NULL, 0, blk); return a; }
void mav1_reset(mav1 *a) { _Alignas(16) uint64_t blk[0x80]; video(a, 3, NULL, 0, blk); }
void mav1_free(mav1 *a) { if (!a) return; _Alignas(16) uint64_t blk[0x80]; video(a, 4, NULL, 0, blk); free(a->buf); free(a); }
const char *mav1_backend(const mav1 *a) { (void)a; return "WebCodecs (the browser's decoder, on the owner thread)"; }
int mav1_decode(mav1 *a, const uint8_t *data, size_t n, mav1_picture *out) {
    if (!a->buf && !(a->buf = malloc(PIC_MAX))) return 0;
    _Alignas(16) uint64_t blk[0x80];
    a->seq++;
    if (video(a, 2, data, n, blk) != 1) return 0;
    out->w = (int)blk[1]; out->h = (int)blk[2]; out->matrix = (int)blk[3]; out->full_range = (int)blk[4];
    out->y = a->buf; out->uv = a->buf + (size_t)out->w * out->h; out->ystride = out->uvstride = (size_t)out->w;
    return 1;
}
