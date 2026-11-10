// Loops that clang auto-vectorises at -O2 (and partly at -Os) with NEON.
// At -O0 the same loops run as scalar code and must print the same values.
// Lengths are not multiples of the vector width so that tails run as well.
#include "rt.h"

#define NOINLINE __attribute__((noinline))
#define N 1027

static float fa[N], fb[N], fc[N];
static double da[N], db[N], dc[N];
static int8_t i8a[N], i8b[N], i8c[N];
static uint8_t u8a[N], u8b[N], u8c[N];
static int16_t i16a[N], i16b[N], i16c[N];
static uint16_t u16a[N], u16c[N];
static int32_t i32a[N], i32b[N], i32c[N];
static uint32_t u32a[N], u32c[N];
static int64_t i64a[N], i64b[N], i64c[N];

static NOINLINE void saxpy(float *restrict y, const float *restrict x, float a, int n)
{
    for (int i = 0; i < n; i++) y[i] = a * x[i] + y[i];
}
static NOINLINE void daxpy(double *restrict y, const double *restrict x, double a, int n)
{
    for (int i = 0; i < n; i++) y[i] = a * x[i] + y[i];
}
static NOINLINE void fmuladd3(float *restrict d, const float *restrict a, const float *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (a[i] - b[i]) * (a[i] + b[i]) / (b[i] * b[i] + 1.0f);
}
static NOINLINE float dot_fast(const float *a, const float *b, int n)
{
#pragma clang fp reassociate(on)
    float s = 0;
    for (int i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}
static NOINLINE double dsum_fast(const double *a, int n)
{
#pragma clang fp reassociate(on)
    double s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
static NOINLINE float dot_strict(const float *a, const float *b, int n)
{
    float s = 0;
    for (int i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}
static NOINLINE int32_t dot_i16(const int16_t *a, const int16_t *b, int n)
{
    int32_t s = 0;
    for (int i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}
static NOINLINE uint32_t sum_u8(const uint8_t *a, int n)
{
    uint32_t s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
static NOINLINE int32_t sum_i8(const int8_t *a, int n)
{
    int32_t s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
static NOINLINE uint64_t sum_u32_wide(const uint32_t *a, int n)
{
    uint64_t s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
static NOINLINE int64_t sum_i64(const int64_t *a, int n)
{
    int64_t s = 0;
    for (int i = 0; i < n; i++) s += a[i] ^ (a[i] >> 3);
    return s;
}
static NOINLINE int32_t max_i32(const int32_t *a, int n)
{
    int32_t m = INT32_MIN;
    for (int i = 0; i < n; i++) m = a[i] > m ? a[i] : m;
    return m;
}
static NOINLINE int32_t min_i32(const int32_t *a, int n)
{
    int32_t m = INT32_MAX;
    for (int i = 0; i < n; i++) m = a[i] < m ? a[i] : m;
    return m;
}
static NOINLINE uint8_t max_u8(const uint8_t *a, int n)
{
    uint8_t m = 0;
    for (int i = 0; i < n; i++) m = a[i] > m ? a[i] : m;
    return m;
}
static NOINLINE int16_t min_i16(const int16_t *a, int n)
{
    int16_t m = INT16_MAX;
    for (int i = 0; i < n; i++) m = a[i] < m ? a[i] : m;
    return m;
}
static NOINLINE uint32_t umin_u32(const uint32_t *a, int n)
{
    uint32_t m = UINT32_MAX;
    for (int i = 0; i < n; i++) m = a[i] < m ? a[i] : m;
    return m;
}
static NOINLINE float max_f32(const float *a, int n)
{
#pragma clang fp reassociate(on)
    float m = -1e30f;
    for (int i = 0; i < n; i++) m = __builtin_fmaxf(m, a[i]);
    return m;
}
static NOINLINE void add_i8(int8_t *restrict d, const int8_t *restrict a, const int8_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (int8_t)(a[i] + b[i] * 3);
}
static NOINLINE void avg_u8(uint8_t *restrict d, const uint8_t *restrict a, const uint8_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (uint8_t)((a[i] + b[i] + 1) >> 1);
}
static NOINLINE void sat_add_u8(uint8_t *restrict d, const uint8_t *restrict a, const uint8_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) {
        unsigned s = (unsigned)a[i] + b[i];
        d[i] = s > 255 ? 255 : (uint8_t)s;
    }
}
static NOINLINE void absdiff_u8(uint8_t *restrict d, const uint8_t *restrict a, const uint8_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
}
static NOINLINE void mul_i16(int16_t *restrict d, const int16_t *restrict a, const int16_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (int16_t)((a[i] * b[i]) >> 5);
}
static NOINLINE void widen_u8_u16(uint16_t *restrict d, const uint8_t *restrict a, const uint8_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (uint16_t)(a[i] * b[i] + 7);
}
static NOINLINE void narrow_i32_i16(int16_t *restrict d, const int32_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (int16_t)(a[i] >> 9);
}
static NOINLINE void clamp_i32_u8(uint8_t *restrict d, const int32_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) {
        int32_t v = a[i] >> 20;
        d[i] = (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
    }
}
static NOINLINE void ops_i32(int32_t *restrict d, const int32_t *restrict a, const int32_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = ((a[i] + b[i]) ^ (a[i] * b[i])) - ((a[i] & b[i]) | (a[i] >> 7)) + (b[i] << 3);
}
static NOINLINE void shifts_u32(uint32_t *restrict d, const uint32_t *restrict a, const int32_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (a[i] << (b[i] & 31)) ^ (a[i] >> ((b[i] >> 5) & 31));
}
static NOINLINE void select_i32(int32_t *restrict d, const int32_t *restrict a, const int32_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = a[i] > b[i] ? a[i] - b[i] : (a[i] == 0 ? 77 : b[i] + 1);
}
static NOINLINE void abs_neg_i32(int32_t *restrict d, const int32_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (a[i] < 0 ? -a[i] : a[i]) - (i & 1 ? a[i] : -a[i]);
}
static NOINLINE void ops_i64(int64_t *restrict d, const int64_t *restrict a, const int64_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (a[i] + b[i]) ^ (a[i] - (b[i] << 2)) ^ (a[i] > b[i] ? a[i] : b[i]);
}
static NOINLINE void i32_to_f32(float *restrict d, const int32_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (float)a[i] * 0.001f;
}
static NOINLINE void f32_to_i32(int32_t *restrict d, const float *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (int32_t)(a[i] * 100.0f);
}
static NOINLINE void f32_to_f64(double *restrict d, const float *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (double)a[i] * 1.0000001;
}
static NOINLINE void f64_to_f32(float *restrict d, const double *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (float)(a[i] * 0.5);
}
static NOINLINE void u8_to_f32(float *restrict d, const uint8_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = (float)a[i] / 255.0f;
}
static NOINLINE void fsel(float *restrict d, const float *restrict a, const float *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = a[i] > b[i] ? a[i] : (b[i] < 0.0f ? -b[i] : __builtin_sqrtf(b[i]));
}
static NOINLINE void dsqrt_abs(double *restrict d, const double *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = __builtin_sqrt(__builtin_fabs(a[i])) + __builtin_floor(a[i]);
}
static NOINLINE void reverse_i32(int32_t *restrict d, const int32_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = a[n - 1 - i];
}
static NOINLINE void reverse_u8(uint8_t *restrict d, const uint8_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = a[n - 1 - i];
}
static NOINLINE void interleave_u16(uint16_t *restrict d, const uint8_t *restrict a, const uint8_t *restrict b, int n)
{
    for (int i = 0; i < n; i++) d[i] = (uint16_t)(a[i] | b[i] << 8);
}
static NOINLINE void stride2(int32_t *restrict d, const int32_t *restrict a, int n)
{
    for (int i = 0; i < n / 2; i++) d[i] = a[2 * i] + a[2 * i + 1];
}
static NOINLINE void rgb_to_gray(uint8_t *restrict d, const uint8_t *restrict rgb, int n)
{
    for (int i = 0; i < n; i++) d[i] = (uint8_t)((rgb[3 * i] * 77 + rgb[3 * i + 1] * 150 + rgb[3 * i + 2] * 29) >> 8);
}
static NOINLINE int count_eq(const uint8_t *a, uint8_t v, int n)
{
    int c = 0;
    for (int i = 0; i < n; i++) c += a[i] == v;
    return c;
}
static NOINLINE uint32_t popcount_sum(const uint32_t *a, int n)
{
    uint32_t c = 0;
    for (int i = 0; i < n; i++) c += (uint32_t)__builtin_popcount(a[i]);
    return c;
}
static NOINLINE void fill_iota(int32_t *d, int32_t start, int32_t step, int n)
{
    for (int i = 0; i < n; i++) d[i] = start + i * step;
}
static NOINLINE void bswap_u32(uint32_t *restrict d, const uint32_t *restrict a, int n)
{
    for (int i = 0; i < n; i++) d[i] = __builtin_bswap32(a[i]) + (uint32_t)__builtin_clz(a[i] | 1);
}

#define HASH(name, arr, bits_expr)                                 \
    do {                                                           \
        uint64_t h = 0;                                            \
        for (int i = 0; i < N; i++) h = mix64(h, (uint64_t)(bits_expr)); \
        printf("%-14s %016lx\n", name, h);                         \
    } while (0)

static volatile int vn = N;

int main(void)
{
    uint64_t seed = 0x0123456789abcdefull;
    for (int i = 0; i < N; i++) {
        uint64_t r = rng_next(&seed), q = rng_next(&seed);
        fa[i] = (float)(int32_t)(r & 0xffff) / 256.0f - 100.0f;
        fb[i] = (float)(int32_t)((r >> 16) & 0xffff) / 512.0f - 50.0f;
        da[i] = (double)(int64_t)(r >> 11) / 1e12 - 4000.0;
        db[i] = (double)(int32_t)(q >> 40) / 1024.0;
        i8a[i] = (int8_t)r; i8b[i] = (int8_t)(r >> 8);
        u8a[i] = (uint8_t)(r >> 16); u8b[i] = (uint8_t)(r >> 24);
        i16a[i] = (int16_t)(r >> 32); i16b[i] = (int16_t)(r >> 48);
        u16a[i] = (uint16_t)q;
        i32a[i] = (int32_t)(q >> 16); i32b[i] = (int32_t)(q >> 32) >> (r & 15);
        u32a[i] = (uint32_t)(q * 2654435761u);
        i64a[i] = (int64_t)(r ^ q << 13); i64b[i] = (int64_t)(q * r);
    }
    i32a[5] = 0; i32a[900] = INT32_MIN; i32a[1026] = INT32_MAX; u8a[1024] = 255; u8a[3] = 255;
    int n = vn;

    puts("== float / double ==");
    memcpy(fc, fb, sizeof fc);
    saxpy(fc, fa, 1.25f, n);
    HASH("saxpy", fc, f32_bits(fc[i]));
    memcpy(dc, db, sizeof dc);
    daxpy(dc, da, -0.75, n);
    HASH("daxpy", dc, f64_bits(dc[i]));
    fmuladd3(fc, fa, fb, n);
    HASH("fmuladd3", fc, f32_bits(fc[i]));
    fsel(fc, fa, fb, n);
    HASH("fsel", fc, f32_bits(fc[i]));
    dsqrt_abs(dc, da, n);
    HASH("dsqrt_abs", dc, f64_bits(dc[i]));
    printf("dot_strict     %08x\n", f32_bits(dot_strict(fa, fb, n)));
    // Reassociated reductions: the result depends on the vector width the
    // compiler picked, so it legitimately differs between -O0 and -O2.
    printf("dot_fast       %08x\n", f32_bits(dot_fast(fa, fb, n)));
    printf("dsum_fast      %016lx\n", f64_bits(dsum_fast(da, n)));
    printf("max_f32        %08x\n", f32_bits(max_f32(fa, n)));

    puts("== conversions ==");
    i32_to_f32(fc, i32a, n);
    HASH("i32_to_f32", fc, f32_bits(fc[i]));
    f32_to_i32(i32c, fa, n);
    HASH("f32_to_i32", i32c, i32c[i]);
    f32_to_f64(dc, fa, n);
    HASH("f32_to_f64", dc, f64_bits(dc[i]));
    f64_to_f32(fc, da, n);
    HASH("f64_to_f32", fc, f32_bits(fc[i]));
    u8_to_f32(fc, u8a, n);
    HASH("u8_to_f32", fc, f32_bits(fc[i]));

    puts("== reductions ==");
    printf("dot_i16 %d sum_u8 %u sum_i8 %d sum_u32 %lu sum_i64 %ld\n", dot_i16(i16a, i16b, n), sum_u8(u8a, n),
           sum_i8(i8a, n), sum_u32_wide(u32a, n), sum_i64(i64a, n));
    printf("max_i32 %d min_i32 %d max_u8 %u min_i16 %d umin_u32 %u\n", max_i32(i32a, n), min_i32(i32a, n),
           max_u8(u8a, n - 30), min_i16(i16a, n), umin_u32(u32a, n));
    printf("max_i32(b) %d min_i32(b) %d count_eq %d popcount %u\n", max_i32(i32b, n), min_i32(i32b, n),
           count_eq(u8a, 255, n) * 1000 + count_eq(u8b, 7, n), popcount_sum(u32a, n));

    puts("== bytes and halfwords ==");
    add_i8(i8c, i8a, i8b, n);
    HASH("add_i8", i8c, i8c[i]);
    avg_u8(u8c, u8a, u8b, n);
    HASH("avg_u8", u8c, u8c[i]);
    sat_add_u8(u8c, u8a, u8b, n);
    HASH("sat_add_u8", u8c, u8c[i]);
    absdiff_u8(u8c, u8a, u8b, n);
    HASH("absdiff_u8", u8c, u8c[i]);
    mul_i16(i16c, i16a, i16b, n);
    HASH("mul_i16", i16c, i16c[i]);
    widen_u8_u16(u16c, u8a, u8b, n);
    HASH("widen_u8_u16", u16c, u16c[i]);
    narrow_i32_i16(i16c, i32a, n);
    HASH("narrow_i32", i16c, i16c[i]);
    clamp_i32_u8(u8c, i32a, n);
    HASH("clamp_i32_u8", u8c, u8c[i]);
    interleave_u16(u16c, u8a, u8b, n);
    HASH("interleave", u16c, u16c[i]);
    reverse_u8(u8c, u8a, n);
    HASH("reverse_u8", u8c, u8c[i]);
    memset(u8c, 0, sizeof u8c);
    rgb_to_gray(u8c, u8a, n / 3);
    HASH("rgb_to_gray", u8c, u8c[i]);

    puts("== words and doublewords ==");
    ops_i32(i32c, i32a, i32b, n);
    HASH("ops_i32", i32c, i32c[i]);
    shifts_u32(u32c, u32a, i32a, n);
    HASH("shifts_u32", u32c, u32c[i]);
    select_i32(i32c, i32a, i32b, n);
    HASH("select_i32", i32c, i32c[i]);
    abs_neg_i32(i32c, i32b, n);
    HASH("abs_neg_i32", i32c, i32c[i]);
    reverse_i32(i32c, i32a, n);
    HASH("reverse_i32", i32c, i32c[i]);
    memset(i32c, 0, sizeof i32c);
    stride2(i32c, i32b, n);
    HASH("stride2", i32c, i32c[i]);
    fill_iota(i32c, -500, 7, n);
    HASH("fill_iota", i32c, i32c[i]);
    bswap_u32(u32c, u32a, n);
    HASH("bswap_u32", u32c, u32c[i]);
    ops_i64(i64c, i64a, i64b, n);
    HASH("ops_i64", i64c, i64c[i]);

    puts("== short lengths (tail handling) ==");
    for (int len = 0; len <= 40; len += (len < 9 ? 1 : 7)) {
        memset(i32c, 0, 64 * sizeof(int32_t));
        memset(u8c, 0, 64);
        ops_i32(i32c, i32a + 1, i32b + 2, len + vn - N);
        sat_add_u8(u8c, u8a + 3, u8b + 1, len + vn - N);
        uint64_t h = 0;
        for (int i = 0; i < 64; i++) h = mix64(h, (uint64_t)i32c[i] + u8c[i]);
        printf("len %2d %016lx sum_u8 %u dot %d max %d\n", len, h, sum_u8(u8a + 1, len), dot_i16(i16a + 1, i16b, len),
               max_i32(i32a + 3, len));
    }
    return 0;
}
