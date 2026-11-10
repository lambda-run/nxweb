// CFLAGS: -march=armv8-a+crc -mtune=cortex-a57
// CRC32 and CRC32C instructions (crc32b/h/w/x, crc32cb/ch/cw/cx) checked
// against bitwise software implementations running in the same guest.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static NOINLINE uint32_t soft_crc(uint32_t crc, const uint8_t *p, size_t n, uint32_t poly)
{
    while (n--) {
        crc ^= *p++;
        for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (poly & (0u - (crc & 1)));
    }
    return crc;
}

static uint32_t table[256];
static NOINLINE uint32_t table_crc(uint32_t crc, const uint8_t *p, size_t n)
{
    while (n--) crc = table[(crc ^ *p++) & 0xff] ^ (crc >> 8);
    return crc;
}

// Hardware CRC over a buffer the way a real implementation does it:
// 8 bytes at a time, then 4/2/1.
static NOINLINE uint32_t hw_crc32(uint32_t crc, const uint8_t *p, size_t n)
{
    while (n >= 8) {
        uint64_t v;
        memcpy(&v, p, 8);
        crc = __builtin_arm_crc32d(crc, v);
        p += 8; n -= 8;
    }
    if (n >= 4) {
        uint32_t v;
        memcpy(&v, p, 4);
        crc = __builtin_arm_crc32w(crc, v);
        p += 4; n -= 4;
    }
    if (n >= 2) {
        uint16_t v;
        memcpy(&v, p, 2);
        crc = __builtin_arm_crc32h(crc, v);
        p += 2; n -= 2;
    }
    if (n) crc = __builtin_arm_crc32b(crc, *p);
    return crc;
}

static NOINLINE uint32_t hw_crc32c(uint32_t crc, const uint8_t *p, size_t n)
{
    while (n >= 8) {
        uint64_t v;
        memcpy(&v, p, 8);
        crc = __builtin_arm_crc32cd(crc, v);
        p += 8; n -= 8;
    }
    if (n >= 4) {
        uint32_t v;
        memcpy(&v, p, 4);
        crc = __builtin_arm_crc32cw(crc, v);
        p += 4; n -= 4;
    }
    if (n >= 2) {
        uint16_t v;
        memcpy(&v, p, 2);
        crc = __builtin_arm_crc32ch(crc, v);
        p += 2; n -= 2;
    }
    if (n) crc = __builtin_arm_crc32cb(crc, *p);
    return crc;
}

static uint8_t data[4096];
static volatile uint32_t vinit = 0xffffffffu;

int main(void)
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1)));
        table[i] = c;
    }
    uint64_t seed = 0xc0ffee;
    for (int i = 0; i < 4096; i++) data[i] = (uint8_t)(rng_next(&seed) >> 29);

    puts("== known vectors ==");
    {
        static const char check[] = "123456789";
        uint32_t init = vinit;
        printf("crc32(\"123456789\")  hw %08x soft %08x table %08x (want cbf43926)\n",
               ~hw_crc32(init, (const uint8_t *)check, 9), ~soft_crc(init, (const uint8_t *)check, 9, 0xEDB88320u),
               ~table_crc(init, (const uint8_t *)check, 9));
        printf("crc32c(\"123456789\") hw %08x soft %08x (want e3069283)\n",
               ~hw_crc32c(init, (const uint8_t *)check, 9), ~soft_crc(init, (const uint8_t *)check, 9, 0x82F63B78u));
    }

    puts("== single instructions ==");
    {
        static volatile uint64_t in[] = {0, 1, 0xff, 0x8000, 0xdeadbeef, 0x0123456789abcdefull, 0xffffffffffffffffull};
        static volatile uint32_t acc[] = {0, 0xffffffffu, 0x12345678u};
        for (int a = 0; a < 3; a++)
            for (int i = 0; i < 7; i++) {
                uint32_t c = acc[a];
                uint64_t v = in[i];
                printf("%08x,%016lx: b %08x h %08x w %08x x %08x | cb %08x ch %08x cw %08x cx %08x\n", c, v,
                       __builtin_arm_crc32b(c, (uint8_t)v), __builtin_arm_crc32h(c, (uint16_t)v),
                       __builtin_arm_crc32w(c, (uint32_t)v), __builtin_arm_crc32d(c, v),
                       __builtin_arm_crc32cb(c, (uint8_t)v), __builtin_arm_crc32ch(c, (uint16_t)v),
                       __builtin_arm_crc32cw(c, (uint32_t)v), __builtin_arm_crc32cd(c, v));
            }
    }

    puts("== buffers, every length 0..70 at 3 alignments ==");
    {
        int mismatches = 0;
        uint64_t h = 0;
        for (int off = 0; off < 3; off++)
            for (size_t n = 0; n <= 70; n++) {
                uint32_t hw = hw_crc32(vinit, data + off, n), sw = table_crc(vinit, data + off, n);
                uint32_t hwc = hw_crc32c(vinit, data + off, n), swc = soft_crc(vinit, data + off, n, 0x82F63B78u);
                mismatches += (hw != sw) + (hwc != swc);
                h = mix64(h, (uint64_t)hw << 32 | hwc);
            }
        printf("hash %016lx mismatches %d\n", h, mismatches);
    }

    puts("== whole buffer, chained ==");
    {
        uint32_t c = vinit, cc = vinit;
        for (int i = 0; i < 4; i++) {
            c = hw_crc32(c, data + i * 1024, 1024);
            cc = hw_crc32c(cc, data + i * 1024, 1024);
            printf("after %d bytes: crc32 %08x crc32c %08x\n", (i + 1) * 1024, ~c, ~cc);
        }
        printf("soft: crc32 %08x crc32c %08x\n", ~table_crc(vinit, data, 4096), ~soft_crc(vinit, data, 4096, 0x82F63B78u));
    }
    return 0;
}
