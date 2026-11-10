// FPCR rounding modes: the same operations under round-to-nearest, toward
// +inf, toward -inf and toward zero. A translator that only implements
// round-to-nearest fails this program and nothing else in the corpus.
#include "rt.h"

static volatile double vd[] = {1.0, 3.0, 2.0, 0.1, 1e16, 1.5, 2.5, -1.5, -2.5, 0.3, -0.7, 9007199254740993.0};
static volatile float vf[] = {1.0f, 3.0f, 0.1f, 16777216.0f, 1.5f, -2.5f};
static volatile int64_t vi[] = {9007199254740993, -9007199254740993, 16777217, -16777219, 0x7fffffffffffffff};
static volatile double rd[16];
static volatile float rf[8];
static volatile int64_t ri[8];

static void set_rmode(uint64_t mode)
{
    uint64_t v;
    __asm__ volatile("mrs %[v], fpcr" : [v] "=r"(v));
    v = (v & ~(3ull << 22)) | (mode << 22);
    __asm__ volatile("msr fpcr, %[v]" : : [v] "r"(v));
}

static __attribute__((noinline)) void compute(void)
{
    rd[0] = vd[0] / vd[1];
    rd[1] = vd[2] / vd[1];
    rd[2] = vd[3] * vd[1];
    rd[3] = vd[4] + vd[0];
    rd[4] = vd[4] - vd[9];
    rd[5] = __builtin_sqrt(vd[2]);
    rd[6] = __builtin_rint(vd[5]);
    rd[7] = __builtin_rint(vd[6]);
    rd[8] = __builtin_rint(vd[7]);
    rd[9] = __builtin_rint(vd[8]);
    rd[10] = __builtin_nearbyint(vd[9]);
    rd[11] = __builtin_nearbyint(vd[10]);
    rd[12] = (double)vi[0];
    rd[13] = (double)vi[1];
    rd[14] = (double)(uint64_t)vi[4];
    rd[15] = -vd[0] / vd[1];
    rf[0] = vf[0] / vf[1];
    rf[1] = vf[2] * vf[1];
    rf[2] = vf[3] + vf[0];
    rf[3] = (float)vd[3];
    rf[4] = (float)vd[11];
    rf[5] = (float)vi[2];
    rf[6] = (float)vi[3];
    rf[7] = __builtin_rintf(vf[5]);
    // These do not depend on the rounding mode (explicit rounding in the instruction).
    ri[0] = (int64_t)vd[7];
    ri[1] = (int64_t)__builtin_floor(vd[10]);
    ri[2] = (int64_t)__builtin_ceil(vd[9]);
    ri[3] = (int64_t)__builtin_round(vd[8]);
    ri[4] = (int64_t)__builtin_trunc(vd[6]);
    ri[5] = __builtin_llrint(vd[6]);        // this one does (frintx + fcvtzs)
    ri[6] = __builtin_llrint(vd[8]);
    ri[7] = __builtin_lrintf(vf[4]);
}

int main(void)
{
    static const char *names[4] = {"nearest", "+inf", "-inf", "zero"};
    for (uint64_t m = 0; m < 4; m++) {
        set_rmode(m);
        compute();
        set_rmode(0);
        printf("== round to %s ==\n", names[m]);
        for (int i = 0; i < 16; i++) printf("d%-2d %016lx\n", i, f64_bits(rd[i]));
        for (int i = 0; i < 8; i++) printf("f%d %08x\n", i, f32_bits(rf[i]));
        for (int i = 0; i < 8; i++) printf("i%d %ld\n", i, ri[i]);
    }
    return 0;
}
