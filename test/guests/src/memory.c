// Memory access patterns: loads of every width with sign/zero extension,
// unaligned access, struct copies and passing by value, memcpy/memmove/memset
// for every size 0..130 at several misalignments.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static volatile int vzero;

// ---- typed loads ----------------------------------------------------------

static int8_t s8[64];
static uint8_t u8[64];
static int16_t s16[64];
static uint16_t u16[64];
static int32_t s32[64];
static uint32_t u32[64];
static int64_t s64[64];

struct __attribute__((packed)) packed {
    uint8_t a;
    uint32_t b;
    int16_t c;
    uint64_t d;
    int8_t e;
    int32_t f;
    uint16_t g;
    double h;
    float i;
};

static NOINLINE uint64_t sum_loads(int n)
{
    uint64_t h = 0;
    for (int i = 0; i < n; i++) {
        int64_t a = s8[i], b = u8[i], c = s16[i], d = u16[i], e = s32[i], f = u32[i], g = s64[i];
        h = mix64(h, (uint64_t)(a + b * 3 + c * 5 + d * 7 + e * 11 + f * 13 + g * 17));
    }
    return h;
}

// Index computed at run time, in 32 and 64 bit, signed and unsigned.
static NOINLINE int64_t indexed(const int32_t *p32, const int16_t *p16, const int8_t *p8, int i, unsigned u, long l)
{
    return (int64_t)p32[i] + p32[u] + p32[l] + p16[i] + p16[u] + p16[l] + p8[i] + p8[u] + p8[l];
}

// ---- struct copies --------------------------------------------------------

struct small { int32_t a; int16_t b; int8_t c; };
struct pair { uint64_t x, y; };
struct medium { uint64_t q[5]; int32_t t; char name[11]; };
struct big { uint8_t bytes[200]; uint64_t tag; double d[4]; };
struct fpair { float a, b; };
struct hfa { double a, b, c, d; };

static NOINLINE struct small mk_small(int v) { struct small s = {v * 1000, (int16_t)(v * 7), (int8_t)-v}; return s; }
static NOINLINE struct pair swap_pair(struct pair p) { struct pair r = {p.y + 1, p.x - 1}; return r; }
static NOINLINE struct medium bump_medium(struct medium m, int k)
{
    for (int i = 0; i < 5; i++) m.q[i] += (uint64_t)(k * (i + 1));
    m.t -= k;
    m.name[k % 10] = (char)('A' + k);
    return m;
}
static NOINLINE struct big fill_big(uint64_t seed)
{
    struct big b;
    for (int i = 0; i < 200; i++) b.bytes[i] = (uint8_t)(rng_next(&seed) >> 56);
    b.tag = seed;
    for (int i = 0; i < 4; i++) b.d[i] = (double)(int64_t)(seed >> (i * 8) & 0xffff) / 16.0;
    return b;
}
static NOINLINE uint64_t hash_big(struct big b)
{
    uint64_t h = b.tag;
    for (int i = 0; i < 200; i++) h = mix64(h, b.bytes[i]);
    for (int i = 0; i < 4; i++) h = mix64(h, f64_bits(b.d[i]));
    return h;
}
static NOINLINE struct fpair fswap(struct fpair p) { struct fpair r = {p.b * 2.0f, p.a + 0.5f}; return r; }
static NOINLINE struct hfa hfa_rot(struct hfa v) { struct hfa r = {v.b, v.c, v.d, v.a + 1.0}; return r; }

// ---- memcpy / memmove / memset -------------------------------------------

static uint8_t src_buf[192], dst_buf[192], ref_buf[192];

static NOINLINE uint64_t buf_hash(const uint8_t *p, int n)
{
    uint64_t a = 1, b = 0;
    for (int i = 0; i < n; i++) {
        a += p[i];
        b += a;
    }
    return (b << 20) ^ a;
}

int main(void)
{
    uint64_t seed = 0x1234abcd9876ef01ull;
    for (int i = 0; i < 64; i++) {
        uint64_t r = rng_next(&seed);
        s8[i] = (int8_t)r; u8[i] = (uint8_t)(r >> 8); s16[i] = (int16_t)(r >> 16);
        u16[i] = (uint16_t)(r >> 24); s32[i] = (int32_t)(r >> 32); u32[i] = (uint32_t)(r >> 13);
        s64[i] = (int64_t)(r * 0x9e3779b97f4a7c15ull);
    }
    s8[0] = -128; s8[1] = 127; s16[0] = -32768; s16[1] = 32767; s32[0] = INT32_MIN; s32[1] = INT32_MAX;
    u8[0] = 255; u16[0] = 65535; u32[0] = 0xffffffff; s64[0] = INT64_MIN;

    puts("== typed loads ==");
    printf("sum_loads=%016lx\n", sum_loads(64 + vzero));
    for (int i = 0; i < 4; i++)
        printf("row %d: %d %u %d %u %d %u %ld\n", i, s8[i], u8[i], s16[i], u16[i], s32[i], u32[i], s64[i]);
    printf("indexed=%ld %ld\n", indexed(s32 + 8, s16 + 8, s8 + 8, -3 + vzero, 5u + (unsigned)vzero, -8L + vzero),
           indexed(s32, s16, s8, 63 + vzero, 0u, 31L));
    {
        // Narrow stores followed by wide loads and the reverse (store forwarding shapes).
        volatile union { uint64_t q; uint32_t d[2]; uint16_t w[4]; uint8_t b[8]; int8_t sb[8]; int16_t sw[4]; int32_t sd[2]; } u;
        u.q = 0x8899aabbccddeeffull;
        printf("union: %x %x %x %x %d %d %d\n", u.d[1], u.w[1], u.b[7], u.b[0], u.sb[3], u.sw[2], u.sd[0]);
        u.b[3] = 0x11; u.w[3] = 0x2233; u.d[0] ^= 0xf0f0f0f0;
        printf("union after: %016lx\n", u.q);
    }
    {
        uint8_t raw[64];
        for (int i = 0; i < 64; i++) raw[i] = (uint8_t)(i * 29 + 3);
        volatile struct packed *p = (volatile struct packed *)(raw + 1 + vzero);
        printf("packed: %u %u %d %lu %d %d %u %016lx %08x\n", p->a, p->b, p->c, p->d, p->e, p->f, p->g,
               f64_bits(p->h), f32_bits(p->i));
        p->b += 1; p->c = (int16_t)(p->c * 3); p->d = ~p->d; p->f = -p->f; p->h = 1.0; p->i = -2.0f;
        uint64_t h = 0;
        for (int i = 0; i < 64; i++) h = mix64(h, raw[i]);
        printf("packed after=%016lx\n", h);
        // Unaligned 2/4/8-byte access at every offset.
        uint64_t hu = 0;
        for (int off = 0; off < 9; off++) {
            uint64_t a; uint32_t b; uint16_t c;
            memcpy(&a, raw + off + vzero, 8);
            memcpy(&b, raw + off + 20 + vzero, 4);
            memcpy(&c, raw + off + 40 + vzero, 2);
            a += b; b ^= c; c++;
            memcpy(raw + off + 21, &b, 4);
            memcpy(raw + off + 41, &c, 2);
            hu = mix64(hu, a + b + c);
        }
        printf("unaligned=%016lx\n", hu);
    }

    puts("== struct copies ==");
    {
        struct small s = mk_small(7 + vzero), s2 = s;
        s2.b++;
        printf("small %d %d %d / %d\n", s.a, s.b, s.c, s2.b);
        struct pair p = {0x1111111111111111ull, 0x2222222222222222ull};
        for (int i = 0; i < 5; i++) p = swap_pair(p);
        printf("pair %lx %lx\n", p.x, p.y);
        struct medium m = {{1, 2, 3, 4, 5}, 100, "abcdefghij"};
        struct medium arr[4];
        for (int i = 0; i < 4; i++) {
            m = bump_medium(m, i + 1);
            arr[i] = m;
        }
        arr[0] = arr[3];
        for (int i = 0; i < 4; i++)
            printf("medium[%d] %lu %lu %d %s\n", i, arr[i].q[0], arr[i].q[4], arr[i].t, arr[i].name);
        struct big b = fill_big(42), b2;
        b2 = b;
        b2.bytes[199] ^= 1;
        printf("big %016lx %016lx\n", hash_big(b), hash_big(b2));
        struct fpair f = {1.5f, -2.0f};
        for (int i = 0; i < 3; i++) f = fswap(f);
        printf("fpair %.3f %.3f\n", f.a, f.b);
        struct hfa v = {1, 2, 3, 4};
        for (int i = 0; i < 6; i++) v = hfa_rot(v);
        printf("hfa %.1f %.1f %.1f %.1f\n", v.a, v.b, v.c, v.d);
    }

    puts("== memcpy, every size 0..130 ==");
    for (int i = 0; i < 192; i++) src_buf[i] = (uint8_t)(rng_next(&seed) >> 33);
    {
        uint64_t total = 0;
        int bad = 0;
        for (int sa = 0; sa < 3; sa++)
            for (int da = 0; da < 3; da++) {
                int smis = sa * 3 + 1, dmis = da * 5 + 2;   // 1,4,7 and 2,7,12
                uint64_t h = 0;
                for (int n = 0; n <= 130; n++) {
                    memset(dst_buf, 0xEE, sizeof dst_buf);
                    void *r = memcpy(dst_buf + 16 + dmis, src_buf + smis, (size_t)(n + vzero));
                    bad += r != dst_buf + 16 + dmis;
                    bad += memcmp(dst_buf + 16 + dmis, src_buf + smis, (size_t)n) != 0;
                    bad += dst_buf[16 + dmis - 1] != 0xEE || dst_buf[16 + dmis + n] != 0xEE;
                    h = mix64(h, buf_hash(dst_buf, 192));
                }
                printf("memcpy src+%d dst+%d %016lx\n", smis, dmis, h);
                total ^= h;
            }
        printf("memcpy total %016lx bad=%d\n", total, bad);
    }

    puts("== memmove, overlapping both ways ==");
    {
        int bad = 0;
        static const int shifts[] = {-17, -8, -1, 0, 1, 8, 17};
        for (int si = 0; si < 7; si++) {
            uint64_t h = 0;
            int shift = shifts[si];
            for (int n = 0; n <= 130; n++) {
                memcpy(dst_buf, src_buf, 192);
                memcpy(ref_buf, src_buf, 192);
                for (int i = 0; i < n; i++) ref_buf[30 + shift + i] = src_buf[30 + i];
                memmove(dst_buf + 30 + shift, dst_buf + 30, (size_t)(n + vzero));
                bad += memcmp(dst_buf, ref_buf, 192) != 0;
                if ((n & 7) == 5) h = mix64(h, buf_hash(dst_buf, 192));
            }
            printf("memmove shift %d %016lx\n", shift, h);
        }
        printf("memmove bad=%d\n", bad);
    }

    puts("== memset / memcmp / strlen ==");
    {
        uint64_t h = 0;
        for (int n = 0; n <= 130; n++) {
            int off = n % 9;
            memset(dst_buf + off, n, (size_t)(n + vzero));
            memset(dst_buf + off + n, 0, (size_t)(3 + vzero));
            h = mix64(h, buf_hash(dst_buf, 160));
        }
        printf("memset %016lx\n", h);
        int64_t c = 0;
        for (int n = 0; n < 60; n++) {
            memcpy(dst_buf, src_buf, 64);
            dst_buf[n] ^= (uint8_t)(n + 1);
            c = c * 3 + memcmp(dst_buf, src_buf, 64) + memcmp(dst_buf, src_buf, (size_t)n);
        }
        printf("memcmp %ld\n", c);
        static char str[140];
        uint64_t ls = 0;
        for (int n = 130; n >= 0; n--) {
            memset(str, 'x', 139);
            str[n] = 0;
            ls = ls * 7 + strlen(str + (n & 3));
        }
        printf("strlen %lu\n", ls);
    }

    puts("== stack arrays and pointer walks ==");
    {
        uint32_t table[97];
        for (int i = 0; i < 97; i++) table[i] = (uint32_t)(i * 2654435761u);
        uint32_t *p = table, *end = table + 97;
        uint64_t s = 0;
        while (p < end) s += *p++;
        while (p > table) s ^= (uint64_t)*--p << 7;
        for (int i = 0; i < 97; i += 3) table[i] = table[96 - i] + table[(i * 5) % 97];
        for (int i = 96; i >= 0; i--) s = mix64(s, table[i]);
        printf("walk %016lx\n", s);
        // 2-D array with run-time indices
        static int16_t grid[13][17];
        for (int y = 0; y < 13; y++)
            for (int x = 0; x < 17; x++) grid[y][x] = (int16_t)(y * 1000 - x * 37);
        int64_t g = 0;
        for (int k = 0; k < 200; k++) {
            int y = (k * 7 + vzero) % 13, x = (k * 11) % 17;
            g += grid[y][x] * (k & 1 ? -1 : 1);
            grid[x % 13][y] += (int16_t)k;
        }
        printf("grid %ld\n", g);
    }
    return 0;
}
