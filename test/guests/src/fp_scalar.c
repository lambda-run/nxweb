// Scalar floating point: arithmetic, conversions in both directions,
// comparisons, rounding, min/max. NaN results are canonicalised before they
// are hashed or printed (fp_nan_bits.c checks the exact NaN bit patterns).
#include "rt.h"

#define NOINLINE __attribute__((noinline))
typedef uint64_t u64;

#define INF __builtin_inf()
#define NAN_ __builtin_nan("")

static volatile double dv[] = {
    0.0, -0.0, 1.0, -1.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.1, 3.141592653589793, -2.718281828459045,
    1e-10, 1e10, 123456789.125, -987654321.75, 4294967296.0, 9007199254740993.0, 1e300, -1e300,
    1e-300, 4.9e-324, 2.2250738585072014e-308, 1.7976931348623157e308, INF, -INF, NAN_, 0.3333333333333333,
};
#define ND (int)(sizeof dv / sizeof dv[0])

static volatile float fv[] = {
    0.0f, -0.0f, 1.0f, -1.0f, 0.5f, 1.5f, -2.5f, 0.1f, 3.1415927f, -2.7182817f, 1e-10f, 1e10f,
    16777216.0f, 16777217.0f, -123456.79f, 3.4028235e38f, 1e-45f, 1.17549435e-38f,
    __builtin_inff(), -__builtin_inff(), __builtin_nanf(""), 0.33333334f,
};
#define NF (int)(sizeof fv / sizeof fv[0])

static u64 cd(double d) { return d != d ? 0x7ff8000000000000ull : f64_bits(d); }
static u64 cf(float f) { return f != f ? 0x7fc00000u : f32_bits(f); }

#define D2(name, expr)                                             \
    do {                                                           \
        u64 h = 0;                                                 \
        for (int i = 0; i < ND; i++)                               \
            for (int j = 0; j < ND; j++) {                         \
                double a = dv[i], b = dv[j];                       \
                (void)b;                                           \
                h = mix64(h, expr);                                \
            }                                                      \
        printf("%-12s %016lx\n", name, h);                         \
    } while (0)

#define F2(name, expr)                                             \
    do {                                                           \
        u64 h = 0;                                                 \
        for (int i = 0; i < NF; i++)                               \
            for (int j = 0; j < NF; j++) {                         \
                float a = fv[i], b = fv[j];                        \
                (void)b;                                           \
                h = mix64(h, expr);                                \
            }                                                      \
        printf("%-12s %016lx\n", name, h);                         \
    } while (0)

// Conversions go through noinline functions so that the conversion
// instruction itself runs even for out-of-range inputs (ARM saturates and
// converts NaN to 0).
static NOINLINE int32_t d_i32(double x) { return (int32_t)x; }
static NOINLINE int64_t d_i64(double x) { return (int64_t)x; }
static NOINLINE uint32_t d_u32(double x) { return (uint32_t)x; }
static NOINLINE u64 d_u64(double x) { return (u64)x; }
static NOINLINE int32_t f_i32(float x) { return (int32_t)x; }
static NOINLINE int64_t f_i64(float x) { return (int64_t)x; }
static NOINLINE uint32_t f_u32(float x) { return (uint32_t)x; }
static NOINLINE u64 f_u64(float x) { return (u64)x; }
static NOINLINE double i32_d(int32_t x) { return x; }
static NOINLINE double i64_d(int64_t x) { return (double)x; }
static NOINLINE double u32_d(uint32_t x) { return x; }
static NOINLINE double u64_d(u64 x) { return (double)x; }
static NOINLINE float i32_f(int32_t x) { return (float)x; }
static NOINLINE float i64_f(int64_t x) { return (float)x; }
static NOINLINE float u32_f(uint32_t x) { return (float)x; }
static NOINLINE float u64_f(u64 x) { return (float)x; }
static NOINLINE float d_f(double x) { return (float)x; }
static NOINLINE double f_d(float x) { return x; }

// Instructions C does not generate directly.
#define DASM(name, body)                                                         \
    static NOINLINE u64 name(u64 a, u64 b, u64 c)                                \
    {                                                                            \
        u64 r;                                                                   \
        __asm__ volatile("fmov d0, %[a]\n fmov d1, %[b]\n fmov d2, %[c]\n"       \
                         "fmov s4, %w[a]\n fmov s5, %w[b]\n fmov s6, %w[c]\n"    \
                         "mov %[r], #0\n" body                                   \
                         : [r] "=&r"(r)                                          \
                         : [a] "r"(a), [b] "r"(b), [c] "r"(c)                    \
                         : "cc", "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"); \
        return r;                                                                \
    }
DASM(a_fmin, "fmin d3, d0, d1\n fmov %[r], d3")
DASM(a_fmax, "fmax d3, d0, d1\n fmov %[r], d3")
DASM(a_fminnm, "fminnm d3, d0, d1\n fmov %[r], d3")
DASM(a_fmaxnm, "fmaxnm d3, d0, d1\n fmov %[r], d3")
DASM(a_fmins, "fmin s7, s4, s5\n fmov %w[r], s7")
DASM(a_fmaxs, "fmax s7, s4, s5\n fmov %w[r], s7")
DASM(a_fmadd, "fmadd d3, d0, d1, d2\n fmov %[r], d3")
DASM(a_fmsub, "fmsub d3, d0, d1, d2\n fmov %[r], d3")
DASM(a_fnmadd, "fnmadd d3, d0, d1, d2\n fmov %[r], d3")
DASM(a_fnmsub, "fnmsub d3, d0, d1, d2\n fmov %[r], d3")
DASM(a_fmadds, "fmadd s7, s4, s5, s6\n fmov %w[r], s7")
DASM(a_fnmul, "fnmul d3, d0, d1\n fmov %[r], d3")
DASM(a_fabd, "fabd d3, d0, d1\n fmov %[r], d3")
DASM(a_frintn, "frintn d3, d0\n fmov %[r], d3")
DASM(a_frintns, "frintn s7, s4\n fmov %w[r], s7")
DASM(a_fcvtns, "fcvtns %[r], d0")
DASM(a_fcvtnu, "fcvtnu %[r], d0")
DASM(a_fcvtas, "fcvtas %[r], d0")
DASM(a_fcvtau, "fcvtau %w[r], d0")
DASM(a_fcvtms, "fcvtms %[r], d0")
DASM(a_fcvtmu, "fcvtmu %w[r], d0")
DASM(a_fcvtps, "fcvtps %[r], d0")
DASM(a_fcvtpu, "fcvtpu %[r], d0")
DASM(a_fcvtzs_w, "fcvtzs %w[r], d0")
DASM(a_fcvtzu_s, "fcvtzu %[r], s4")
DASM(a_fcvtms_s, "fcvtms %w[r], s4")
DASM(a_fix_to, "fcvtzs %[r], d0, #16")
DASM(a_fix_tou, "fcvtzu %w[r], d0, #8")
DASM(a_fix_from, "scvtf d3, %[a], #20\n fmov %[r], d3")
DASM(a_fix_fromu, "ucvtf s7, %w[a], #31\n fmov %w[r], s7")
DASM(a_fmov_imm, "fmov d3, #-1.25\n fmov s7, #31.0\n fadd d3, d3, d0\n fmov %[r], d3\n fmov w9, s7\n eor %[r], %[r], x9")
DASM(a_fmov_hi, "ins v3.d[0], %[a]\n fmov v3.d[1], %[b]\n fmov %[r], v3.d[1]\n fmov x9, d3\n eor %[r], %[r], x9, ror #1")
DASM(a_scalar_cm, "fcmgt d3, d0, d1\n fcmge d7, d1, d0\n fcmeq d2, d0, d1\n fmov %[r], d3\n fmov x9, d7\n"
                  "eor %[r], %[r], x9, lsl #1\n fmov x9, d2\n eor %[r], %[r], x9, lsl #2\n and %[r], %[r], #7")

static u64 canon_if_fp(u64 v, int kind)
{
    if (kind == 1 && (v & 0x7fffffffffffffffull) > 0x7ff0000000000000ull) return 0x7ff8000000000000ull;
    if (kind == 2 && (v & 0x7fffffffu) > 0x7f800000u) return 0x7fc00000u;
    return v;
}

// kind: 0 integer result, 1 double result, 2 float result (in the low word)
static void run_asm(const char *name, u64 (*fn)(u64, u64, u64), int kind, int isfloat)
{
    u64 h = 0;
    int n = isfloat ? NF : ND;
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++) {
            u64 a = isfloat ? f32_bits(fv[i]) : f64_bits(dv[i]);
            u64 b = isfloat ? f32_bits(fv[j]) : f64_bits(dv[j]);
            u64 c = isfloat ? f32_bits(fv[(i + j) % n]) : f64_bits(dv[(i + j) % n]);
            h = mix64(h, canon_if_fp(fn(a, b, c), kind));
        }
    printf("%-12s %016lx\n", name, h);
}

static NOINLINE double horner(double x)
{
    static const double c[] = {1.0, -0.5, 0.25, -0.125, 0.0625, -0.03125, 0.015625};
    double r = 0;
    for (int i = 6; i >= 0; i--) r = r * x + c[i];
    return r;
}

static NOINLINE double newton_sqrt(double x)
{
    double g = x * 0.5 + 0.5;
    for (int i = 0; i < 30; i++) g = 0.5 * (g + x / g);
    return g;
}

static NOINLINE double sin_taylor(double x)
{
    double term = x, sum = x;
    for (int i = 1; i < 12; i++) {
        term *= -x * x / (double)((2 * i) * (2 * i + 1));
        sum += term;
    }
    return sum;
}

int main(void)
{
    puts("== double arithmetic ==");
    D2("dadd", cd(a + b));
    D2("dsub", cd(a - b));
    D2("dmul", cd(a * b));
    D2("ddiv", cd(a / b));
    D2("dneg-abs", cd(-a) ^ cd(__builtin_fabs(b)) << 1);
    D2("dsqrt", cd(__builtin_sqrt(a)));
    D2("dfmin", cd(__builtin_fmin(a, b)));
    D2("dfmax", cd(__builtin_fmax(a, b)));
    D2("dfma", cd(__builtin_fma(a, b, dv[i ^ 1])));
    D2("dmuladd", cd(a * b + 1.5) ^ cd(a - b * 0.25));
    D2("dcopysign", cd(__builtin_copysign(a, b)));
    D2("dcmp", (u64)((a < b) | (a <= b) << 1 | (a > b) << 2 | (a >= b) << 3 | (a == b) << 4 | (a != b) << 5));
    D2("dcmp-sel", cd(a < b ? a : b) + cd(a >= b ? a + 1.0 : b - 1.0));
    D2("dclass", (u64)(__builtin_isnan(a) | __builtin_isinf(a) << 1 | __builtin_signbit(a) << 2 |
                       __builtin_isfinite(a) << 3 | __builtin_isless(a, b) << 4 |
                       __builtin_isgreaterequal(a, b) << 5 | __builtin_isunordered(a, b) << 6));

    puts("== float arithmetic ==");
    F2("fadd", cf(a + b));
    F2("fsub", cf(a - b));
    F2("fmul", cf(a * b));
    F2("fdiv", cf(a / b));
    F2("fneg-abs", cf(-a) ^ cf(__builtin_fabsf(b)) << 1);
    F2("fsqrt", cf(__builtin_sqrtf(a)));
    F2("ffmin", cf(__builtin_fminf(a, b)));
    F2("ffmax", cf(__builtin_fmaxf(a, b)));
    F2("ffma", cf(__builtin_fmaf(a, b, fv[j ^ 1])));
    F2("fmuladd", cf(a * b + 1.5f) ^ cf(a - b * 0.25f));
    F2("fcopysign", cf(__builtin_copysignf(a, b)));
    F2("fcmp", (u64)((a < b) | (a <= b) << 1 | (a > b) << 2 | (a >= b) << 3 | (a == b) << 4 | (a != b) << 5));
    F2("fmixed", cd((double)a * b) ^ cf((float)((double)a + 0.1)));

    puts("== rounding ==");
    D2("dfloor", cd(__builtin_floor(a)));
    D2("dceil", cd(__builtin_ceil(a)));
    D2("dtrunc", cd(__builtin_trunc(a)));
    D2("dround", cd(__builtin_round(a)));
    D2("drint", cd(__builtin_rint(a)));
    D2("dnearbyint", cd(__builtin_nearbyint(a)));
    F2("ffloor", cf(__builtin_floorf(a)));
    F2("fceil", cf(__builtin_ceilf(a)));
    F2("ftrunc", cf(__builtin_truncf(a)));
    F2("fround", cf(__builtin_roundf(a)));
    F2("frint", cf(__builtin_rintf(a)));
    {
        static volatile double rv[] = {0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, 2.4, -2.6, 1e15 + 0.5, -0.0};
        for (unsigned i = 0; i < sizeof rv / sizeof rv[0]; i++) {
            double x = rv[i];
            printf("%22.17f floor %.1f ceil %.1f trunc %.1f round %.1f rint %.1f\n", x, __builtin_floor(x),
                   __builtin_ceil(x), __builtin_trunc(x), __builtin_round(x), __builtin_rint(x));
        }
    }

    puts("== float to integer ==");
    {
        static volatile double cv[] = {
            0.0, -0.0, 0.5, -0.5, 0.999999, 1.5, 2.5, -1.5, -2.5, 127.9, -128.9, 65535.5,
            2147483647.0, 2147483647.5, 2147483648.0, -2147483648.0, -2147483649.0, 4294967295.0,
            4294967296.0, 9223372036854775807.0, -9223372036854775808.0, 1.8446744073709552e19,
            -9.3e18, 1e30, -1e30, INF, -INF, NAN_, 1e-320, 16777217.0, -1.0,
        };
        u64 h = 0;
        for (unsigned i = 0; i < sizeof cv / sizeof cv[0]; i++) {
            double x = cv[i];
            float f = (float)x;
            int32_t a = d_i32(x);
            int64_t b = d_i64(x);
            uint32_t c = d_u32(x);
            u64 d = d_u64(x);
            h = mix64(h, (u64)a); h = mix64(h, (u64)b); h = mix64(h, c); h = mix64(h, d);
            h = mix64(h, (u64)f_i32(f)); h = mix64(h, (u64)f_i64(f)); h = mix64(h, f_u32(f)); h = mix64(h, f_u64(f));
            h = mix64(h, (u64)__builtin_lround(x)); h = mix64(h, (u64)__builtin_llrint(x));
            h = mix64(h, (u64)(int64_t)__builtin_floor(x)); h = mix64(h, (u64)(int32_t)__builtin_ceilf(f));
            if (i % 2 == 0 || i > 20)
                printf("%016lx -> i32 %d i64 %ld u32 %u u64 %lu | f: %d %lu\n", cd(x),
                       a, b, c, d, f_i32(f), f_u64(f));
        }
        printf("to-int hash %016lx\n", h);
    }

    puts("== integer to float ==");
    {
        static volatile int64_t iv[] = {
            0, 1, -1, 2147483647, -2147483648LL, 4294967295LL, 16777217, 16777219, -16777217,
            9007199254740993LL, 9007199254740995LL, -9007199254740993LL, INT64_MAX, INT64_MIN,
            0x7fffffbfffffffffLL, 0x7fffffffffffff00LL, 1234567890123456789LL, -1,
        };
        u64 h = 0;
        for (unsigned i = 0; i < sizeof iv / sizeof iv[0]; i++) {
            int64_t x = iv[i];
            u64 r[8] = {f64_bits(i64_d(x)), f64_bits(u64_d((u64)x)), f64_bits(i32_d((int32_t)x)),
                        f64_bits(u32_d((uint32_t)x)), f32_bits(i64_f(x)), f32_bits(u64_f((u64)x)),
                        f32_bits(i32_f((int32_t)x)), f32_bits(u32_f((uint32_t)x))};
            for (int k = 0; k < 8; k++) h = mix64(h, r[k]);
            if (i % 3 == 0) printf("%ld -> %016lx %016lx %08lx %08lx\n", x, r[0], r[1], r[4], r[5]);
        }
        printf("from-int hash %016lx\n", h);
    }

    puts("== float <-> double ==");
    {
        u64 h = 0;
        for (int i = 0; i < ND; i++) h = mix64(h, cf(d_f(dv[i])));
        for (int i = 0; i < NF; i++) h = mix64(h, cd(f_d(fv[i])));
        printf("fcvt hash %016lx  (float)0.1=%08x (double)0.1f=%016lx (float)1e300=%08x (float)1e-320=%08x\n", h,
               f32_bits(d_f(dv[10])), f64_bits(f_d(fv[7])), f32_bits(d_f(dv[19])), f32_bits(d_f(1e-320)));
    }

    puts("== instructions via inline asm ==");
    run_asm("fmin", a_fmin, 1, 0); run_asm("fmax", a_fmax, 1, 0);
    run_asm("fminnm", a_fminnm, 1, 0); run_asm("fmaxnm", a_fmaxnm, 1, 0);
    run_asm("fmin.s", a_fmins, 2, 1); run_asm("fmax.s", a_fmaxs, 2, 1);
    run_asm("fmadd", a_fmadd, 1, 0); run_asm("fmsub", a_fmsub, 1, 0);
    run_asm("fnmadd", a_fnmadd, 1, 0); run_asm("fnmsub", a_fnmsub, 1, 0);
    run_asm("fmadd.s", a_fmadds, 2, 1); run_asm("fnmul", a_fnmul, 1, 0); run_asm("fabd", a_fabd, 1, 0);
    run_asm("frintn", a_frintn, 1, 0); run_asm("frintn.s", a_frintns, 2, 1);
    run_asm("fcvtns", a_fcvtns, 0, 0); run_asm("fcvtnu", a_fcvtnu, 0, 0);
    run_asm("fcvtas", a_fcvtas, 0, 0); run_asm("fcvtau", a_fcvtau, 0, 0);
    run_asm("fcvtms", a_fcvtms, 0, 0); run_asm("fcvtmu", a_fcvtmu, 0, 0);
    run_asm("fcvtps", a_fcvtps, 0, 0); run_asm("fcvtpu", a_fcvtpu, 0, 0);
    run_asm("fcvtzs.w", a_fcvtzs_w, 0, 0); run_asm("fcvtzu.s", a_fcvtzu_s, 0, 1);
    run_asm("fcvtms.s", a_fcvtms_s, 0, 1);
    run_asm("fcvtzs.fix", a_fix_to, 0, 0); run_asm("fcvtzu.fix", a_fix_tou, 0, 0);
    run_asm("scvtf.fix", a_fix_from, 1, 0); run_asm("ucvtf.fix", a_fix_fromu, 2, 1);
    run_asm("fmov.imm", a_fmov_imm, 0, 0); run_asm("fmov.hi", a_fmov_hi, 0, 0);
    run_asm("fcm.scalar", a_scalar_cm, 0, 0);
    printf("fmin(-0,+0)=%016lx fmax(-0,+0)=%016lx fcvtns(2.5)=%ld fcvtas(2.5)=%ld fcvtms(-0.5)=%ld fcvtps(0.5)=%ld\n",
           a_fmin(f64_bits(-0.0), 0, 0), a_fmax(f64_bits(-0.0), 0, 0), a_fcvtns(f64_bits(2.5), 0, 0),
           a_fcvtas(f64_bits(2.5), 0, 0), a_fcvtms(f64_bits(-0.5), 0, 0), a_fcvtps(f64_bits(0.5), 0, 0));

    puts("== small numeric kernels ==");
    for (int i = -2; i <= 2; i++) {
        double x = i * 0.75;
        printf("horner(%.2f)=%.12f %016lx\n", x, horner(x), f64_bits(horner(x)));
    }
    for (int i = 1; i <= 5; i++) {
        double x = (double)(i * i * i) + 0.5;
        printf("newton_sqrt(%.1f)=%.12f sqrt=%.12f\n", x, newton_sqrt(x), __builtin_sqrt(x));
    }
    for (int i = 0; i <= 6; i++) {
        double x = i * 0.5 - 1.5;
        printf("sin(%.1f)~%.12f %016lx\n", x, sin_taylor(x), f64_bits(sin_taylor(x)));
    }
    {
        double pi = 0;
        float pif = 0;
        for (int k = 0; k < 2000; k++) {
            double t = 4.0 / (double)(2 * k + 1);
            pi += (k & 1) ? -t : t;
            pif += (float)((k & 1) ? -t : t);
        }
        printf("leibniz pi=%.12f %016lx float=%.6f %08x\n", pi, f64_bits(pi), (double)pif, f32_bits(pif));
        double e = 1, term = 1;
        for (int k = 1; k < 20; k++) {
            term /= k;
            e += term;
        }
        printf("e=%.15f %016lx\n", e, f64_bits(e));
    }
    return 0;
}
