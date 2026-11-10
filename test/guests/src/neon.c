// NEON through arm_neon.h intrinsics. Every result vector is printed lane by
// lane, for three rounds of input data.
#include <arm_neon.h>
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static uint8_t bufa[64], bufb[64];
static float fbufa[16], fbufb[16];
static double dbufa[4], dbufb[4];
static volatile uint64_t vseed = 0x6a09e667f3bcc908ull;

static NOINLINE void pu8(const char *n, uint8x16_t v)
{
    uint8_t t[16];
    vst1q_u8(t, v);
    printf("%-14s", n);
    for (int i = 0; i < 16; i++) printf(" %02x", t[i]);
    printf("\n");
}
static NOINLINE void pu16(const char *n, uint16x8_t v)
{
    uint16_t t[8];
    vst1q_u16(t, v);
    printf("%-14s", n);
    for (int i = 0; i < 8; i++) printf(" %04x", t[i]);
    printf("\n");
}
static NOINLINE void pu32(const char *n, uint32x4_t v)
{
    uint32_t t[4];
    vst1q_u32(t, v);
    printf("%-14s %08x %08x %08x %08x\n", n, t[0], t[1], t[2], t[3]);
}
static NOINLINE void pu64(const char *n, uint64x2_t v)
{
    uint64_t t[2];
    vst1q_u64(t, v);
    printf("%-14s %016lx %016lx\n", n, t[0], t[1]);
}
static NOINLINE void pd8(const char *n, uint8x8_t v) { pu8(n, vcombine_u8(v, vdup_n_u8(0))); }
#define ps8(n, v) pu8(n, vreinterpretq_u8_s8(v))
#define ps16(n, v) pu16(n, vreinterpretq_u16_s16(v))
#define ps32(n, v) pu32(n, vreinterpretq_u32_s32(v))
#define ps64(n, v) pu64(n, vreinterpretq_u64_s64(v))
#define pf32(n, v) pu32(n, vreinterpretq_u32_f32(v))
#define pf64(n, v) pu64(n, vreinterpretq_u64_f64(v))

static NOINLINE void fill(int round)
{
    uint64_t s = vseed + (uint64_t)round * 0x9e3779b97f4a7c15ull;
    for (int i = 0; i < 64; i++) {
        uint64_t r = rng_next(&s);
        bufa[i] = (uint8_t)r;
        bufb[i] = (uint8_t)(r >> 8);
    }
    for (int i = 0; i < 16; i++) {
        uint64_t r = rng_next(&s);
        fbufa[i] = (float)(int32_t)(r & 0xfffff) / 1024.0f - 400.0f;
        fbufb[i] = (float)(int32_t)((r >> 20) & 0xfffff) / 4096.0f - 100.0f;
    }
    for (int i = 0; i < 4; i++) {
        uint64_t r = rng_next(&s);
        dbufa[i] = (double)(int64_t)(r >> 20) / 65536.0 - 1e8;
        dbufb[i] = (double)(int32_t)r / 3.0;
    }
    if (round == 1) {       // edge values
        bufa[0] = 0x80; bufa[1] = 0x7f; bufa[2] = 0xff; bufa[3] = 0; bufb[0] = 0x80; bufb[1] = 0x7f; bufb[2] = 1;
        bufa[16] = bufb[16]; bufa[21] = bufb[21];
        fbufa[0] = 2.5f; fbufa[1] = -2.5f; fbufa[2] = 3e9f; fbufa[3] = -3e9f; fbufb[0] = 2.5f; fbufb[1] = 0.0f;
    }
}

static NOINLINE void integer_tests(void)
{
    uint8x16_t a8 = vld1q_u8(bufa), b8 = vld1q_u8(bufb);
    int8x16_t sa8 = vreinterpretq_s8_u8(a8), sb8 = vreinterpretq_s8_u8(b8);
    uint16x8_t a16 = vld1q_u16((const uint16_t *)(bufa + 16)), b16 = vld1q_u16((const uint16_t *)(bufb + 16));
    int16x8_t sa16 = vreinterpretq_s16_u16(a16), sb16 = vreinterpretq_s16_u16(b16);
    uint32x4_t a32 = vld1q_u32((const uint32_t *)(bufa + 32)), b32 = vld1q_u32((const uint32_t *)(bufb + 32));
    int32x4_t sa32 = vreinterpretq_s32_u32(a32), sb32 = vreinterpretq_s32_u32(b32);
    uint64x2_t a64 = vld1q_u64((const uint64_t *)(bufa + 48)), b64 = vld1q_u64((const uint64_t *)(bufb + 48));
    int64x2_t sa64 = vreinterpretq_s64_u64(a64), sb64 = vreinterpretq_s64_u64(b64);

    pu8("a8", a8); pu8("b8", b8);
    pu8("vaddq_u8", vaddq_u8(a8, b8));
    pu16("vaddq_u16", vaddq_u16(a16, b16));
    pu32("vaddq_u32", vaddq_u32(a32, b32));
    pu64("vaddq_u64", vaddq_u64(a64, b64));
    pu8("vsubq_u8", vsubq_u8(a8, b8));
    pu64("vsubq_u64", vsubq_u64(a64, b64));
    pu8("vmulq_u8", vmulq_u8(a8, b8));
    pu16("vmulq_u16", vmulq_u16(a16, b16));
    pu32("vmulq_u32", vmulq_u32(a32, b32));
    ps32("vmlaq_s32", vmlaq_s32(sa32, sb32, sa32));
    ps16("vmlsq_s16", vmlsq_s16(sa16, sb16, sa16));
    ps16("vmulq_n_s16", vmulq_n_s16(sa16, -3));
    ps32("vmulq_lane", vmulq_laneq_s32(sa32, sb32, 2));
    pu8("vqaddq_u8", vqaddq_u8(a8, b8));
    ps8("vqaddq_s8", vqaddq_s8(sa8, sb8));
    pu8("vqsubq_u8", vqsubq_u8(a8, b8));
    ps16("vqsubq_s16", vqsubq_s16(sa16, sb16));
    ps32("vqaddq_s32", vqaddq_s32(sa32, sb32));
    pu8("vhaddq_u8", vhaddq_u8(a8, b8));
    pu8("vrhaddq_u8", vrhaddq_u8(a8, b8));
    pu8("vabdq_u8", vabdq_u8(a8, b8));
    ps16("vabdq_s16", vabdq_s16(sa16, sb16));
    ps8("vabsq_s8", vabsq_s8(sa8));
    ps32("vnegq_s32", vnegq_s32(sa32));
    ps8("vqabsq_s8", vqabsq_s8(sa8));
    ps16("vqdmulhq_s16", vqdmulhq_s16(sa16, sb16));
    ps16("vqrdmulhq_s16", vqrdmulhq_s16(sa16, sb16));

    pu8("vmaxq_u8", vmaxq_u8(a8, b8));
    pu8("vminq_u8", vminq_u8(a8, b8));
    ps8("vmaxq_s8", vmaxq_s8(sa8, sb8));
    ps16("vminq_s16", vminq_s16(sa16, sb16));
    ps32("vmaxq_s32", vmaxq_s32(sa32, sb32));
    pu32("vminq_u32", vminq_u32(a32, b32));
    pu8("vpmaxq_u8", vpmaxq_u8(a8, b8));

    pu8("vceqq_u8", vceqq_u8(a8, b8));
    pu16("vceqq_u16", vceqq_u16(a16, b16));
    pu8("vcgtq_u8", vcgtq_u8(a8, b8));
    pu8("vcgtq_s8", vcgtq_s8(sa8, sb8));
    pu16("vcgeq_s16", vcgeq_s16(sa16, sb16));
    pu32("vcltq_s32", vcltq_s32(sa32, sb32));
    pu32("vcleq_u32", vcleq_u32(a32, b32));
    pu64("vcgtq_s64", vcgtq_s64(sa64, sb64));
    pu8("vtstq_u8", vtstq_u8(a8, b8));
    pu8("vceqzq_s8", vceqzq_s8(sa8));
    pu16("vcltzq_s16", vcltzq_s16(sa16));
    pu8("vbslq(gt)", vbslq_u8(vcgtq_u8(a8, b8), a8, b8));
    ps16("vbslq(eq)", vbslq_s16(vceqq_s16(sa16, sb16), vdupq_n_s16(0x1111), sa16));
    pu32("vbslq(bits)", vbslq_u32(vdupq_n_u32(0x00ffff00), a32, b32));

    pu8("vandq", vandq_u8(a8, b8));
    pu8("vorrq", vorrq_u8(a8, b8));
    pu8("veorq", veorq_u8(a8, b8));
    pu8("vbicq", vbicq_u8(a8, b8));
    pu8("vornq", vornq_u8(a8, b8));
    pu8("vmvnq", vmvnq_u8(a8));
    pu8("vcntq", vcntq_u8(a8));
    pu8("vclzq_u8", vclzq_u8(a8));
    pu32("vclzq_u32", vclzq_u32(a32));
    ps16("vclsq_s16", vclsq_s16(sa16));
    pu8("vrbitq", vrbitq_u8(a8));
    pu8("vrev16q", vrev16q_u8(a8));
    pu8("vrev32q", vrev32q_u8(a8));
    pu8("vrev64q", vrev64q_u8(a8));

    pu8("vshlq_n_u8", vshlq_n_u8(a8, 3));
    pu16("vshlq_n_u16", vshlq_n_u16(a16, 9));
    pu32("vshlq_n_u32", vshlq_n_u32(a32, 17));
    pu64("vshlq_n_u64", vshlq_n_u64(a64, 33));
    pu8("vshrq_n_u8", vshrq_n_u8(a8, 3));
    ps8("vshrq_n_s8", vshrq_n_s8(sa8, 3));
    ps16("vshrq_n_s16", vshrq_n_s16(sa16, 15));
    pu32("vshrq_n_u32", vshrq_n_u32(a32, 31));
    ps64("vshrq_n_s64", vshrq_n_s64(sa64, 40));
    ps16("vrshrq_n_s16", vrshrq_n_s16(sa16, 4));
    pu32("vrshrq_n_u32", vrshrq_n_u32(a32, 8));
    pu16("vsraq_n_u16", vsraq_n_u16(a16, b16, 5));
    ps32("vsraq_n_s32", vsraq_n_s32(sa32, sb32, 11));
    pu8("vsliq_n_u8", vsliq_n_u8(a8, b8, 3));
    pu16("vsriq_n_u16", vsriq_n_u16(a16, b16, 6));
    ps8("vshlq_s8", vshlq_s8(sa8, vshrq_n_s8(sb8, 5)));        // per-lane counts -4..3
    pu32("vshlq_u32", vshlq_u32(a32, vshrq_n_s32(sb32, 26)));  // -32..31
    ps16("vqshlq_n_s16", vqshlq_n_s16(sa16, 3));
    pu8("vqshluq_n_s8", vqshluq_n_s8(sa8, 2));
    ps64("vshlq_s64", vshlq_s64(sa64, vshrq_n_s64(sb64, 58)));
    ps16("vrshlq_s16", vrshlq_s16(sa16, vshrq_n_s16(sb16, 12)));

    pu16("vmovl_u8", vmovl_u8(vget_low_u8(a8)));
    ps16("vmovl_s8", vmovl_s8(vget_high_s8(sa8)));
    pu32("vmovl_u16", vmovl_u16(vget_low_u16(a16)));
    ps64("vmovl_s32", vmovl_s32(vget_high_s32(sa32)));
    pd8("vmovn_u16", vmovn_u16(a16));
    pu16("vmovn_u32", vcombine_u16(vmovn_u32(a32), vmovn_u32(b32)));
    pu32("vmovn_u64", vcombine_u32(vmovn_u64(a64), vmovn_u64(b64)));
    pd8("vqmovn_u16", vqmovn_u16(a16));
    pd8("vqmovun_s16", vqmovun_s16(sa16));
    ps8("vqmovn_s16", vcombine_s8(vqmovn_s16(sa16), vqmovn_s16(sb16)));
    pd8("vshrn_n_u16", vshrn_n_u16(a16, 4));
    pd8("vrshrn_n_u16", vrshrn_n_u16(a16, 4));
    pd8("vqrshrun_n", vqrshrun_n_s16(sa16, 5));
    pd8("vaddhn_u16", vaddhn_u16(a16, b16));
    pu16("vmull_u8", vmull_u8(vget_low_u8(a8), vget_low_u8(b8)));
    ps32("vmull_s16", vmull_s16(vget_low_s16(sa16), vget_high_s16(sb16)));
    pu64("vmull_u32", vmull_u32(vget_low_u32(a32), vget_low_u32(b32)));
    ps32("vmull_high", vmull_high_s16(sa16, sb16));
    ps32("vmlal_s16", vmlal_s16(sa32, vget_low_s16(sa16), vget_low_s16(sb16)));
    pu16("vmlsl_u8", vmlsl_u8(a16, vget_high_u8(a8), vget_high_u8(b8)));
    pu16("vaddl_u8", vaddl_u8(vget_low_u8(a8), vget_high_u8(b8)));
    ps32("vsubl_s16", vsubl_s16(vget_low_s16(sa16), vget_low_s16(sb16)));
    pu16("vaddw_u8", vaddw_u8(a16, vget_low_u8(b8)));
    pu16("vabdl_u8", vabdl_u8(vget_low_u8(a8), vget_low_u8(b8)));
    pu16("vshll_n_u8", vshll_n_u8(vget_low_u8(a8), 3));
    pu16("vpaddlq_u8", vpaddlq_u8(a8));
    ps32("vpaddlq_s16", vpaddlq_s16(sa16));
    pu32("vpadalq_u16", vpadalq_u16(a32, b16));
    pu8("vpaddq_u8", vpaddq_u8(a8, b8));
    ps32("vpaddq_s32", vpaddq_s32(sa32, sb32));

    printf("vaddvq u8 %u s8 %d u16 %u s16 %d u32 %u s32 %d u64 %lu\n", vaddvq_u8(a8), vaddvq_s8(sa8), vaddvq_u16(a16),
           vaddvq_s16(sa16), vaddvq_u32(a32), vaddvq_s32(sa32), vaddvq_u64(a64));
    printf("vaddlvq u8 %u s16 %d u32 %lu  vmaxvq u8 %u s16 %d u32 %u  vminvq u8 %u s8 %d s32 %d\n", vaddlvq_u8(a8),
           vaddlvq_s16(sa16), vaddlvq_u32(a32), vmaxvq_u8(a8), vmaxvq_s16(sa16), vmaxvq_u32(a32), vminvq_u8(a8),
           vminvq_s8(sa8), vminvq_s32(sa32));
    printf("vgetq_lane u8[5] %u s8[15] %d u16[7] %u s16[0] %d u32[3] %u s32[1] %d u64[1] %lx\n", vgetq_lane_u8(a8, 5),
           vgetq_lane_s8(sa8, 15), vgetq_lane_u16(a16, 7), vgetq_lane_s16(sa16, 0), vgetq_lane_u32(a32, 3),
           vgetq_lane_s32(sa32, 1), vgetq_lane_u64(a64, 1));

    pu8("vdupq_n_u8", vdupq_n_u8(bufa[7]));
    pu16("vdupq_n_u16", vdupq_n_u16((uint16_t)(bufa[7] << 8 | bufb[7])));
    pu32("vdupq_n_u32", vdupq_n_u32(vgetq_lane_u32(b32, 2)));
    pu64("vdupq_n_u64", vdupq_n_u64(vgetq_lane_u64(b64, 0)));
    pu32("vdupq_laneq", vdupq_laneq_u32(a32, 3));
    pu8("vld1q_dup_u8", vld1q_dup_u8(bufb + 9));
    pu16("vmovq_n+set", vsetq_lane_u16(0xbeef, vsetq_lane_u16(bufa[1], vmovq_n_u16(0x1234), 6), 2));
    pu8("vsetq_lane_u8", vsetq_lane_u8(bufb[3], a8, 11));
    pu64("vsetq_lane_u64", vsetq_lane_u64(0x1122334455667788ull, a64, 1));
    pu32("vcopyq_laneq", vcopyq_laneq_u32(a32, 0, b32, 3));
    pu8("vcombine", vcombine_u8(vget_high_u8(a8), vget_low_u8(b8)));
    pu32("vcombine(64)", vreinterpretq_u32_u64(vcombine_u64(vget_low_u64(b64), vget_high_u64(a64))));
    pu8("vextq_u8 #3", vextq_u8(a8, b8, 3));
    pu8("vextq_u8 #13", vextq_u8(a8, b8, 13));
    pu16("vextq_u16 #5", vextq_u16(a16, b16, 5));
    pu32("vextq_u32 #1", vextq_u32(a32, b32, 1));
    pu64("vextq_u64 #1", vextq_u64(a64, b64, 1));
    pu8("vzip1q_u8", vzip1q_u8(a8, b8));
    pu8("vzip2q_u8", vzip2q_u8(a8, b8));
    pu16("vzip1q_u16", vzip1q_u16(a16, b16));
    pu32("vzip2q_u32", vzip2q_u32(a32, b32));
    pu64("vzip1q_u64", vzip1q_u64(a64, b64));
    pu8("vuzp1q_u8", vuzp1q_u8(a8, b8));
    pu8("vuzp2q_u8", vuzp2q_u8(a8, b8));
    pu16("vuzp2q_u16", vuzp2q_u16(a16, b16));
    pu32("vuzp1q_u32", vuzp1q_u32(a32, b32));
    pu8("vtrn1q_u8", vtrn1q_u8(a8, b8));
    pu16("vtrn2q_u16", vtrn2q_u16(a16, b16));
    {
        uint8x16x2_t z = vzipq_u8(a8, b8);
        uint16x8x2_t u = vuzpq_u16(a16, b16);
        pu8("vzipq.0^1", veorq_u8(z.val[0], z.val[1]));
        pu16("vuzpq.0+1", vaddq_u16(u.val[0], u.val[1]));
    }
    {
        uint8x16_t idx = vandq_u8(b8, vdupq_n_u8(0x1f));    // indices 0..31, >= 16 gives 0
        pu8("vqtbl1q_u8", vqtbl1q_u8(a8, idx));
        pu8("vqtbx1q_u8", vqtbx1q_u8(b8, a8, idx));
        uint8x16x2_t t2 = {{a8, b8}};
        pu8("vqtbl2q_u8", vqtbl2q_u8(t2, vandq_u8(b8, vdupq_n_u8(0x3f))));
        pd8("vtbl1_u8", vtbl1_u8(vget_low_u8(a8), vand_u8(vget_high_u8(b8), vdup_n_u8(0x0f))));
        static const uint8_t rev[16] = {15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0};
        pu8("vqtbl1q(rev)", vqtbl1q_u8(a8, vld1q_u8(rev)));
    }
    {
        // Structure loads and stores.
        uint8_t out[64];
        uint8x16x2_t d2 = vld2q_u8(bufa);
        pu8("vld2q.0", d2.val[0]); pu8("vld2q.1", d2.val[1]);
        uint8x16x3_t d3 = vld3q_u8(bufa);
        pu8("vld3q.2", d3.val[2]);
        uint8x16x4_t d4 = vld4q_u8(bufa);
        pu8("vld4q.3", d4.val[3]);
        uint16x8x2_t s2 = {{a16, b16}};
        vst2q_u16((uint16_t *)out, s2);
        pu8("vst2q lo", vld1q_u8(out)); pu8("vst2q hi", vld1q_u8(out + 16));
        memset(out, 0, sizeof out);
        d3.val[1] = b8;
        vst3q_u8(out, d3);
        pu8("vst3q 16..31", vld1q_u8(out + 16));
        uint32x4x4_t s4 = {{a32, b32, vmvnq_u32(a32), vdupq_n_u32(0x01020304)}};
        vst4q_u32((uint32_t *)out, s4);
        pu8("vst4q 0..15", vld1q_u8(out)); pu8("vst4q 48..63", vld1q_u8(out + 48));
        vst1q_lane_u32((uint32_t *)(out + 5), a32, 2);
        vst1_u8(out + 20, vget_high_u8(b8));
        pu8("vst1 lanes", vld1q_u8(out + 4)); pu8("vst1 half", vld1q_u8(out + 16));
        pu32("vld1q_lane", vld1q_lane_u32((const uint32_t *)(bufb + 1), a32, 1));
    }
}

static NOINLINE void float_tests(void)
{
    float32x4_t a = vld1q_f32(fbufa), b = vld1q_f32(fbufb), c = vld1q_f32(fbufa + 4);
    float64x2_t da = vld1q_f64(dbufa), db = vld1q_f64(dbufb);

    pf32("fa", a); pf32("fb", b);
    pf32("vaddq_f32", vaddq_f32(a, b));
    pf32("vsubq_f32", vsubq_f32(a, b));
    pf32("vmulq_f32", vmulq_f32(a, b));
    pf32("vdivq_f32", vdivq_f32(a, b));
    pf32("vfmaq_f32", vfmaq_f32(c, a, b));
    pf32("vfmsq_f32", vfmsq_f32(c, a, b));
    pf32("vmulq_n_f32", vmulq_n_f32(a, 0.3f));
    pf32("vfmaq_laneq", vfmaq_laneq_f32(c, a, b, 3));
    pf32("vabsq_f32", vabsq_f32(a));
    pf32("vnegq_f32", vnegq_f32(a));
    pf32("vsqrtq_f32", vsqrtq_f32(vabsq_f32(a)));
    pf32("vabdq_f32", vabdq_f32(a, b));
    pf32("vmaxq_f32", vmaxq_f32(a, b));
    pf32("vminq_f32", vminq_f32(a, b));
    pf32("vmaxnmq_f32", vmaxnmq_f32(a, b));
    pf32("vpaddq_f32", vpaddq_f32(a, b));
    pu32("vceqq_f32", vceqq_f32(a, b));
    pu32("vcgtq_f32", vcgtq_f32(a, b));
    pu32("vcgeq_f32", vcgeq_f32(a, b));
    pu32("vcltq_f32", vcltq_f32(a, b));
    pu32("vcagtq_f32", vcagtq_f32(a, b));
    pu32("vcltzq_f32", vcltzq_f32(a));
    pf32("vbslq_f32", vbslq_f32(vcgtq_f32(a, b), a, b));
    ps32("vcvtq_s32_f32", vcvtq_s32_f32(a));
    pu32("vcvtq_u32_f32", vcvtq_u32_f32(a));
    ps32("vcvtnq_s32", vcvtnq_s32_f32(a));
    ps32("vcvtaq_s32", vcvtaq_s32_f32(a));
    ps32("vcvtmq_s32", vcvtmq_s32_f32(a));
    ps32("vcvtpq_s32", vcvtpq_s32_f32(a));
    ps32("vcvtq_n_s32", vcvtq_n_s32_f32(b, 8));
    pf32("vcvtq_f32_s32", vcvtq_f32_s32(vld1q_s32((const int32_t *)(bufa + 32))));
    pf32("vcvtq_f32_u32", vcvtq_f32_u32(vld1q_u32((const uint32_t *)(bufa + 32))));
    pf32("vcvtq_n_f32", vcvtq_n_f32_s32(vld1q_s32((const int32_t *)(bufb + 32)), 16));
    pf32("vrndq", vrndq_f32(b));
    pf32("vrndnq", vrndnq_f32(b));
    pf32("vrndmq", vrndmq_f32(b));
    pf32("vrndpq", vrndpq_f32(b));
    pf32("vrndaq", vrndaq_f32(b));
    pf32("vrndiq", vrndiq_f32(b));
    printf("lanes %08x %08x  vaddvq %08x vmaxvq %08x vminvq %08x\n", f32_bits(vgetq_lane_f32(a, 0)),
           f32_bits(vgetq_lane_f32(b, 3)), f32_bits(vaddvq_f32(a)), f32_bits(vmaxvq_f32(a)), f32_bits(vminvq_f32(b)));
    pf32("vdupq_n_f32", vdupq_n_f32(fbufa[5]));
    pf32("vsetq_lane_f32", vsetq_lane_f32(fbufb[6], a, 2));
    pf32("vcombine_f32", vcombine_f32(vget_high_f32(a), vget_low_f32(b)));
    pf32("vextq_f32", vextq_f32(a, b, 3));
    pf32("vzip1q_f32", vzip1q_f32(a, b));
    pf32("vuzp2q_f32", vuzp2q_f32(a, b));
    pf32("vrev64q_f32", vrev64q_f32(a));

    pf64("da", da); pf64("db", db);
    pf64("vaddq_f64", vaddq_f64(da, db));
    pf64("vmulq_f64", vmulq_f64(da, db));
    pf64("vdivq_f64", vdivq_f64(da, db));
    pf64("vfmaq_f64", vfmaq_f64(da, db, db));
    pf64("vsqrtq_f64", vsqrtq_f64(vabsq_f64(da)));
    pf64("vmaxq_f64", vmaxq_f64(da, db));
    pu64("vcgtq_f64", vcgtq_f64(da, db));
    ps64("vcvtq_s64_f64", vcvtq_s64_f64(db));
    pf64("vcvtq_f64_s64", vcvtq_f64_s64(vld1q_s64((const int64_t *)(bufa + 48))));
    pf64("vcvtq_f64_u64", vcvtq_f64_u64(vld1q_u64((const uint64_t *)(bufa + 48))));
    pf64("vcvt_f64_f32", vcvt_f64_f32(vget_low_f32(a)));
    pf64("vcvt_high_f64", vcvt_high_f64_f32(a));
    pf32("vcvt_f32_f64", vcombine_f32(vcvt_f32_f64(da), vcvt_f32_f64(db)));
    pf64("vrndmq_f64", vrndmq_f64(db));
    pf64("vzip2q_f64", vzip2q_f64(da, db));
    printf("f64 lanes %016lx %016lx vaddvq %016lx\n", f64_bits(vgetq_lane_f64(da, 1)), f64_bits(vgetq_lane_f64(db, 0)),
           f64_bits(vaddvq_f64(da)));
}

// A few kernels written the way hand-vectorised game code looks.
static NOINLINE uint32_t adler_like(const uint8_t *p, int n)
{
    uint32x4_t acc = vdupq_n_u32(0);
    for (int i = 0; i + 16 <= n; i += 16) {
        uint8x16_t v = vld1q_u8(p + i);
        uint16x8_t s = vpaddlq_u8(v);
        acc = vpadalq_u16(acc, s);
        acc = vaddq_u32(acc, vshlq_n_u32(acc, 3));
    }
    return vaddvq_u32(acc);
}

static NOINLINE void mat4_mul(float *restrict out, const float *restrict a, const float *restrict b)
{
    float32x4_t c0 = vld1q_f32(a), c1 = vld1q_f32(a + 4), c2 = vld1q_f32(a + 8), c3 = vld1q_f32(a + 12);
    for (int i = 0; i < 4; i++) {
        float32x4_t r = vld1q_f32(b + 4 * i);
        float32x4_t acc = vmulq_laneq_f32(c0, r, 0);
        acc = vfmaq_laneq_f32(acc, c1, r, 1);
        acc = vfmaq_laneq_f32(acc, c2, r, 2);
        acc = vfmaq_laneq_f32(acc, c3, r, 3);
        vst1q_f32(out + 4 * i, acc);
    }
}

int main(void)
{
    for (int round = 0; round < 3; round++) {
        fill(round);
        printf("==== round %d: integer ====\n", round);
        integer_tests();
        printf("==== round %d: float ====\n", round);
        float_tests();
        float m[16];
        mat4_mul(m, fbufa, fbufb);
        uint64_t h = 0;
        for (int i = 0; i < 16; i++) h = mix64(h, f32_bits(m[i]));
        printf("adler_like %08x mat4 %016lx\n", adler_like(bufa, 64), h);
    }
    return 0;
}
