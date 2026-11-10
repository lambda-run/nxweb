// Integer arithmetic torture. Every operation is folded into its own hash
// over a table of edge-case operands, so a wrong result shows up on the line
// that names the operation.
#include "rt.h"

static volatile uint64_t vals[] = {
    0, 1, 2, 3, 7, 10, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000,
    0x7fffffff, 0x80000000, 0xffffffff, 0x100000000, 1000000007,
    0x7fffffffffffffff, 0x8000000000000000, 0xffffffffffffffff, 0xfffffffffffffffe,
    0x123456789abcdef0, 0xdeadbeefcafebabe, 0x5555555555555555, 0xaaaaaaaaaaaaaaaa,
    0x0f0f0f0f0f0f0f0f, 0xffffffff80000000, 0xffffffffffffff80,
};
#define NV (int)(sizeof vals / sizeof vals[0])

#define BIN(name, T, expr)                                         \
    do {                                                           \
        uint64_t h = 0;                                            \
        for (int i = 0; i < NV; i++)                               \
            for (int j = 0; j < NV; j++) {                         \
                T a = (T)vals[i], b = (T)vals[j];                  \
                (void)b;                                           \
                h = mix64(h, (uint64_t)(expr));                    \
            }                                                      \
        printf("%-14s %016lx\n", name, h);                         \
    } while (0)

#define UN(name, T, expr)                                          \
    do {                                                           \
        uint64_t h = 0;                                            \
        for (int i = 0; i < NV; i++) {                             \
            T a = (T)vals[i];                                      \
            h = mix64(h, (uint64_t)(expr));                        \
        }                                                          \
        printf("%-14s %016lx\n", name, h);                         \
    } while (0)

typedef uint32_t u32;
typedef uint64_t u64;
typedef int32_t i32;
typedef int64_t i64;

// Division helpers. Division by zero and INT_MIN / -1 are undefined in C but
// well defined for the ARM64 instructions (0 and INT_MIN); go through
// noinline functions with opaque operands so that the instruction is what runs.
static __attribute__((noinline)) i32 sdiv32(i32 a, i32 b) { return a / b; }
static __attribute__((noinline)) i64 sdiv64(i64 a, i64 b) { return a / b; }
static __attribute__((noinline)) u32 udiv32(u32 a, u32 b) { return a / b; }
static __attribute__((noinline)) u64 udiv64(u64 a, u64 b) { return a / b; }
static __attribute__((noinline)) i32 smod32(i32 a, i32 b) { return a % b; }
static __attribute__((noinline)) i64 smod64(i64 a, i64 b) { return a % b; }
static __attribute__((noinline)) u32 umod32(u32 a, u32 b) { return a % b; }
static __attribute__((noinline)) u64 umod64(u64 a, u64 b) { return a % b; }

static inline u32 rol32(u32 x, unsigned s) { s &= 31; return (x << s) | (x >> ((32 - s) & 31)); }
static inline u32 ror32(u32 x, unsigned s) { s &= 31; return (x >> s) | (x << ((32 - s) & 31)); }
static inline u64 rol64(u64 x, unsigned s) { s &= 63; return (x << s) | (x >> ((64 - s) & 63)); }
static inline u64 ror64(u64 x, unsigned s) { s &= 63; return (x >> s) | (x << ((64 - s) & 63)); }

struct bits {
    u32 a : 3;
    u32 b : 7;
    i32 c : 11;
    u32 d : 5;
    i32 e : 6;
    u64 f : 37;
    i64 g : 20;
    u64 h : 7;
};

static __attribute__((noinline)) u64 select_chain(i64 a, i64 b)
{
    u64 ua = (u64)a, ub = (u64)b;
    u64 r = a > b ? ua - ub : ub - ua;
    r = (a & 1) ? r + 3 : r - 3;
    r = (ua < ub) ? r ^ ua : r ^ ub;
    r = a == b ? -r : r;
    r = (a >= 0 && b >= 0) ? r + 1 : (a < 0 && b < 0) ? r - 1 : ~r;
    r = (a <= b) ? (r | 16) : (r & ~16ull);
    r = ((u32)a >= (u32)b) ? r + (u64)(i32)a : r - (u64)(i32)b;
    return r;
}

static __attribute__((noinline)) int sign_of(i64 a) { return (a > 0) - (a < 0); }
static __attribute__((noinline)) i64 clamp(i64 v, i64 lo, i64 hi) { return v < lo ? lo : v > hi ? hi : v; }

int main(void)
{
    puts("== add/sub/mul ==");
    BIN("add32", u32, a + b);
    BIN("add64", u64, a + b);
    BIN("sub32", u32, a - b);
    BIN("sub64", u64, a - b);
    BIN("mul32", u32, a * b);
    BIN("mul64", u64, a * b);
    BIN("neg-madd", u64, a - b * 7 + (a * b + b));
    BIN("smull", i32, (i64)a * (i64)b);
    BIN("umull", u32, (u64)a * (u64)b);
    BIN("smaddl", i32, (i64)a * (i64)b + (i64)vals[5] - (i64)(i32)vals[24]);
    BIN("umulh", u64, (u64)(((unsigned __int128)a * b) >> 64));
    BIN("smulh", i64, (u64)(((__int128)a * b) >> 64));
    BIN("mul128lo", u64, (u64)((unsigned __int128)a * b));
    BIN("add128", u64, (u64)((((unsigned __int128)a << 64 | b) + (((unsigned __int128)b << 64) | a)) >> 64));
    BIN("sub128", u64, (u64)((((unsigned __int128)a << 64 | b) - (((unsigned __int128)b << 64) | a)) >> 64));

    puts("== div/mod ==");
    BIN("sdiv32", i32, (u32)sdiv32(a, b));
    BIN("sdiv64", i64, sdiv64(a, b));
    BIN("udiv32", u32, udiv32(a, b));
    BIN("udiv64", u64, udiv64(a, b));
    BIN("smod32", i32, (u32)smod32(a, b));
    BIN("smod64", i64, smod64(a, b));
    BIN("umod32", u32, umod32(a, b));
    BIN("umod64", u64, umod64(a, b));
    printf("sdiv32 min/-1 %d  7/0 %d  -7/2 %d  -7%%2 %d\n", sdiv32(INT32_MIN, -1), sdiv32(7, 0),
           sdiv32(-7, 2), smod32(-7, 2));
    printf("sdiv64 min/-1 %ld  7/0 %ld  udiv64 max/3 %lu\n", sdiv64(INT64_MIN, -1), sdiv64(7, 0),
           udiv64(UINT64_MAX, 3));

    puts("== by constants ==");
    UN("udiv3", u64, a / 3);
    UN("udiv7_32", u32, a / 7);
    UN("udiv10", u64, a / 10);
    UN("umod10", u64, a % 10);
    UN("udiv1e9+7", u64, a / 1000000007);
    UN("sdiv-5", i64, a / -5);
    UN("sdiv3_32", i32, (u32)(a / 3));
    UN("smod100", i64, a % 100);
    UN("sdiv_pow2", i64, a / 16);
    UN("smod_pow2", i32, (u32)(a % 8));
    UN("mul10", u64, a * 10);
    UN("mul_big", u64, a * 0x123456789abcdefull);
    UN("mul-3_32", u32, a * (u32)-3);
    UN("shl13", u64, a << 13);
    UN("shr7", u64, a >> 7);
    UN("asr9", i64, a >> 9);
    UN("asr3_32", i32, (u32)(a >> 3));
    UN("ror17", u64, ror64(a, 17));
    UN("ror5_32", u32, ror32(a, 5));
    UN("add_imm", u64, a + 0xfff000);
    UN("sub_imm", u64, a - 4095);
    UN("and_imm", u64, a & 0x00ffff0000ffff00ull);
    UN("orr_imm", u64, a | 0x8080808080808080ull);
    UN("eor_imm", u64, a ^ 0x5555555555555555ull);
    UN("movk", u64, a + 0x1234567887654321ull);

    puts("== shifts/rotates ==");
    BIN("lsl32", u32, a << (b & 31));
    BIN("lsl64", u64, a << (b & 63));
    BIN("lsr32", u32, a >> (b & 31));
    BIN("lsr64", u64, a >> (b & 63));
    BIN("asr32", i32, (u32)(a >> (b & 31)));
    BIN("asr64", i64, a >> (b & 63));
    BIN("rol32", u32, rol32(a, b));
    BIN("ror32", u32, ror32(a, b));
    BIN("rol64", u64, rol64(a, b));
    BIN("ror64", u64, ror64(a, b));
    BIN("shifted-op", u64, (a + (b << 3)) ^ (a - (b >> 5)) ^ (a & ~(b << 7)) ^ (a | ((i64)b >> 11)));
    BIN("ext-op", u64, a + (u64)(u32)b + ((u64)(i32)b << 2) + (u64)(int16_t)b + (u64)(uint8_t)b);

    puts("== logic ==");
    BIN("and", u64, a & b);
    BIN("orr", u64, a | b);
    BIN("eor", u64, a ^ b);
    BIN("bic", u64, a & ~b);
    BIN("orn", u64, a | ~b);
    BIN("eon", u64, a ^ ~b);
    BIN("tst", u64, (a & b) ? 11 : 22);
    BIN("tst32", u32, (a & b) == 0 ? 33 : 44);

    puts("== bitfields ==");
    UN("ubfx", u64, (a >> 5) & 0x3ff);
    UN("ubfx32", u32, (a >> 9) & 0x1f);
    UN("sbfx", i64, (i64)(a << 20) >> 40);
    UN("sbfx32", i32, (u32)((i32)(a << 7) >> 19));
    UN("sbfiz", i64, (i64)(int8_t)a << 9);
    UN("ubfiz", u64, (a & 0xfff) << 21);
    UN("bfi", u64, (a & ~(0xffull << 12)) | (((a >> 40) & 0xff) << 12));
    UN("bfxil", u64, (a & ~0xffffull) | ((a >> 32) & 0xffff));
    UN("sxtb", i64, (int8_t)a);
    UN("sxth", i64, (int16_t)a);
    UN("sxtw", i64, (i32)a);
    UN("uxtb", u64, (uint8_t)a);
    UN("uxth", u64, (uint16_t)a);
    {
        uint64_t h = 0;
        for (int i = 0; i < NV; i++) {
            volatile struct bits s;
            u64 v = vals[i];
            s.a = v; s.b = v >> 3; s.c = v >> 10; s.d = v >> 21;
            s.e = v >> 26; s.f = v >> 5; s.g = v >> 17; s.h = v >> 50;
            s.c += 3; s.g -= 5; s.f ^= 0x155555;
            h = mix64(h, s.a); h = mix64(h, s.b); h = mix64(h, (u64)(i64)s.c);
            h = mix64(h, s.d); h = mix64(h, (u64)(i64)s.e); h = mix64(h, s.f);
            h = mix64(h, (u64)(i64)s.g); h = mix64(h, s.h);
        }
        printf("%-14s %016lx\n", "struct-bits", h);
    }

    puts("== bit counting ==");
    UN("clz64", u64, a ? __builtin_clzll(a) : 64);
    UN("clz32", u32, a ? __builtin_clz(a) : 32);
    UN("ctz64", u64, a ? __builtin_ctzll(a) : 64);
    UN("ctz32", u32, a ? __builtin_ctz(a) : 32);
    UN("cls64", i64, __builtin_clrsbll(a));
    UN("cls32", i32, __builtin_clrsb(a));
    UN("popcnt64", u64, __builtin_popcountll(a));
    UN("popcnt32", u32, __builtin_popcount(a));
    UN("parity", u64, __builtin_parityll(a));
    UN("rbit64", u64, __builtin_bitreverse64(a));
    UN("rbit32", u32, __builtin_bitreverse32(a));
    UN("rbit8", uint8_t, __builtin_bitreverse8(a));
    UN("bswap64", u64, __builtin_bswap64(a));
    UN("bswap32", u32, __builtin_bswap32(a));
    UN("bswap16", uint16_t, __builtin_bswap16(a));
    UN("ffs", u64, __builtin_ffsll(a));

    puts("== overflow checks ==");
#define OVF(name, T, fn)                                           \
    do {                                                           \
        uint64_t h = 0;                                            \
        int n = 0;                                                 \
        for (int i = 0; i < NV; i++)                               \
            for (int j = 0; j < NV; j++) {                         \
                T a = (T)vals[i], b = (T)vals[j], r;               \
                int o = fn(a, b, &r);                              \
                n += o;                                            \
                h = mix64(h, (uint64_t)r + (uint64_t)o);           \
            }                                                      \
        printf("%-14s %016lx ovf=%d\n", name, h, n);               \
    } while (0)
    OVF("sadd32", i32, __builtin_add_overflow);
    OVF("sadd64", i64, __builtin_add_overflow);
    OVF("uadd32", u32, __builtin_add_overflow);
    OVF("uadd64", u64, __builtin_add_overflow);
    OVF("ssub32", i32, __builtin_sub_overflow);
    OVF("ssub64", i64, __builtin_sub_overflow);
    OVF("usub32", u32, __builtin_sub_overflow);
    OVF("usub64", u64, __builtin_sub_overflow);
    OVF("smul32", i32, __builtin_mul_overflow);
    OVF("smul64", i64, __builtin_mul_overflow);
    OVF("umul32", u32, __builtin_mul_overflow);
    OVF("umul64", u64, __builtin_mul_overflow);
    OVF("sadd16", int16_t, __builtin_add_overflow);
    OVF("umul8", uint8_t, __builtin_mul_overflow);

    puts("== compares and selects ==");
    BIN("cmp-s64", i64, (a < b) | (a <= b) << 1 | (a > b) << 2 | (a >= b) << 3 | (a == b) << 4 | (a != b) << 5);
    BIN("cmp-u64", u64, (a < b) | (a <= b) << 1 | (a > b) << 2 | (a >= b) << 3 | (a == b) << 4 | (a != b) << 5);
    BIN("cmp-s32", i32, (a < b) | (a <= b) << 1 | (a > b) << 2 | (a >= b) << 3 | (a == b) << 4 | (a != b) << 5);
    BIN("cmp-u32", u32, (a < b) | (a <= b) << 1 | (a > b) << 2 | (a >= b) << 3 | (a == b) << 4 | (a != b) << 5);
    BIN("min-max-s", i64, (u64)(a < b ? a : b) * 3 + (u64)(a > b ? a : b));
    BIN("min-max-u", u64, (a < b ? a : b) * 3 + (a > b ? a : b));
    BIN("select", i64, select_chain(a, b));
    BIN("cinc-cneg", i64, (u64)(a < b ? (u64)a + 1 : (u64)a) + (a > b ? -(u64)b : (u64)b) + (u64)(a == b ? ~a : a));
    BIN("ccmp", i64, (a > 3 && b < 100) + ((a < 0 || b == 7) << 1) + ((a != b && a != 0 && b != 0) << 2));
    UN("abs64", i64, a < 0 ? -(u64)a : (u64)a);
    UN("abs32", i32, (u32)(a < 0 ? -(u32)a : (u32)a));
    UN("sign", i64, sign_of(a));
    UN("clamp", i64, clamp(a, -1000, 1000));
    UN("bool", u64, !a + !!a * 2);

    puts("== long accumulators ==");
    {
        u64 s = 0x243f6a8885a308d3ull, acc = 0;
        u32 acc32 = 0;
        for (int i = 0; i < 20000; i++) {
            u64 r = rng_next(&s);
            acc += r * (acc | 1);
            acc = ror64(acc, (unsigned)(r & 63)) ^ (r >> 7);
            acc32 = acc32 * 1664525u + (u32)r;
            acc32 ^= rol32(acc32, 13) + (u32)(acc >> 32);
            if ((i % 4000) == 3999) printf("iter %5d acc %016lx acc32 %08x\n", i + 1, acc, acc32);
        }
    }
    return 0;
}
