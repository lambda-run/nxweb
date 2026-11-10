// Reciprocal and reciprocal square root estimates (frecpe/frsqrte/urecpe and
// the Newton-Raphson step instructions). These return table-driven values
// that are fully specified by the architecture, so they must match exactly;
// they are kept apart from neon.c because they need dedicated emulation.
#include <arm_neon.h>
#include "rt.h"

static volatile float fin[] = {
    1.0f, 2.0f, 3.0f, 0.5f, 0.1f, 100.0f, 1e-3f, 1e10f, 1.5f, 7.75f, 123456.0f, 0.999f,
    1e-20f, 1e20f, 4.0f, 0.3333f, 1e-39f, 3e38f, 0.0f, -0.0f, -2.0f, 16.0f, 255.0f, 65536.0f,
};
static volatile double din[] = {1.0, 2.0, 3.0, 0.5, 0.1, 1e100, 1e-100, 7.75, 0.0, -4.0, 1e-310, 1.7e308};
static volatile uint32_t uin[] = {0x80000000u, 0xffffffffu, 0xc0000000u, 0x7fffffffu, 0x40000000u, 0x12345678u,
                                  0x9abcdef0u, 0u};

int main(void)
{
    puts("== single precision ==");
    for (unsigned i = 0; i < sizeof fin / sizeof fin[0]; i += 4) {
        float t[4] = {fin[i], fin[i + 1], fin[i + 2], fin[i + 3]};
        float32x4_t v = vld1q_f32(t);
        uint32_t r[4], q[4], s1[4], s2[4];
        vst1q_u32(r, vreinterpretq_u32_f32(vrecpeq_f32(v)));
        vst1q_u32(q, vreinterpretq_u32_f32(vrsqrteq_f32(v)));
        vst1q_u32(s1, vreinterpretq_u32_f32(vrecpsq_f32(v, vrecpeq_f32(v))));
        vst1q_u32(s2, vreinterpretq_u32_f32(vrsqrtsq_f32(vmulq_f32(v, vrsqrteq_f32(v)), vrsqrteq_f32(v))));
        for (int k = 0; k < 4; k++)
            printf("%08x: recpe %08x rsqrte %08x recps %08x rsqrts %08x\n", f32_bits(t[k]), r[k], q[k], s1[k], s2[k]);
    }
    puts("== scalar forms ==");
    for (unsigned i = 0; i < sizeof fin / sizeof fin[0]; i += 3) {
        float x = fin[i];
        printf("%08x: recpes %08x rsqrtes %08x recpxs %08x\n", f32_bits(x), f32_bits(vrecpes_f32(x)),
               f32_bits(vrsqrtes_f32(x)), f32_bits(vrecpxs_f32(x)));
    }
    puts("== double precision ==");
    for (unsigned i = 0; i < sizeof din / sizeof din[0]; i++) {
        double x = din[i];
        printf("%016lx: recpe %016lx rsqrte %016lx\n", f64_bits(x), f64_bits(vrecped_f64(x)), f64_bits(vrsqrted_f64(x)));
    }
    puts("== unsigned fixed point ==");
    {
        uint32_t t[8], r[4], q[4];
        for (int i = 0; i < 8; i++) t[i] = uin[i];
        for (int i = 0; i < 8; i += 4) {
            vst1q_u32(r, vrecpeq_u32(vld1q_u32(t + i)));
            vst1q_u32(q, vrsqrteq_u32(vld1q_u32(t + i)));
            for (int k = 0; k < 4; k++) printf("%08x: urecpe %08x ursqrte %08x\n", t[i + k], r[k], q[k]);
        }
    }
    puts("== refined 1/sqrt(x), two Newton steps ==");
    for (unsigned i = 0; i < 12; i++) {
        float x = fin[i];
        float e = vrsqrtes_f32(x);
        e = e * vrsqrtss_f32(x * e, e);
        e = e * vrsqrtss_f32(x * e, e);
        printf("x=%.6f rsqrt=%.9f %08x\n", (double)x, (double)e, f32_bits(e));
    }
    return 0;
}
