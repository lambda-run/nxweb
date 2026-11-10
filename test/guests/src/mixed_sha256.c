// SHA-256 over known vectors and generated data. The known digests make this
// program a check of the reference runner itself, not only of determinism.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

struct sha256 { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t fill; };

static inline uint32_t rotr(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }

static NOINLINE void sha256_block(struct sha256 *s, const uint8_t *p)
{
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3], e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
        uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void sha256_init(struct sha256 *s)
{
    static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(s->h, iv, sizeof iv);
    s->len = 0;
    s->fill = 0;
}

static NOINLINE void sha256_update(struct sha256 *s, const void *data, size_t n)
{
    const uint8_t *p = data;
    s->len += n;
    if (s->fill) {
        size_t take = 64 - s->fill < n ? 64 - s->fill : n;
        memcpy(s->buf + s->fill, p, take);
        s->fill += take; p += take; n -= take;
        if (s->fill < 64) return;
        sha256_block(s, s->buf);
        s->fill = 0;
    }
    for (; n >= 64; p += 64, n -= 64) sha256_block(s, p);
    memcpy(s->buf, p, n);
    s->fill = n;
}

static NOINLINE void sha256_final(struct sha256 *s, uint8_t out[32])
{
    uint64_t bits = s->len * 8;
    uint8_t pad[72] = {0x80};
    size_t padlen = (s->fill < 56 ? 56 : 120) - s->fill;
    for (int i = 0; i < 8; i++) pad[padlen + (size_t)i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_update(s, pad, padlen + 8);
    for (int i = 0; i < 8; i++) {
        out[4 * i] = (uint8_t)(s->h[i] >> 24); out[4 * i + 1] = (uint8_t)(s->h[i] >> 16);
        out[4 * i + 2] = (uint8_t)(s->h[i] >> 8); out[4 * i + 3] = (uint8_t)s->h[i];
    }
}

static void print_digest(const char *label, const uint8_t d[32])
{
    printf("%s ", label);
    for (int i = 0; i < 32; i++) printf("%02x", d[i]);
    printf("\n");
}

static uint8_t data[9000];

int main(void)
{
    struct sha256 s;
    uint8_t d[32];

    sha256_init(&s);
    sha256_final(&s, d);
    print_digest("sha256(\"\")   ", d);
    puts("want          e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    sha256_init(&s);
    sha256_update(&s, "abc", 3);
    sha256_final(&s, d);
    print_digest("sha256(\"abc\")", d);
    puts("want          ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    sha256_init(&s);
    sha256_update(&s, "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 56);
    sha256_final(&s, d);
    print_digest("sha256(448b) ", d);
    puts("want          248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");

    uint64_t seed = 0x736861323536ull;
    for (size_t i = 0; i < sizeof data; i++) data[i] = (uint8_t)(rng_next(&seed) >> 24);
    static const size_t lens[] = {1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4096, 9000};
    for (unsigned i = 0; i < sizeof lens / sizeof lens[0]; i++) {
        sha256_init(&s);
        sha256_update(&s, data, lens[i]);
        sha256_final(&s, d);
        printf("len %5lu ", lens[i]);
        print_digest("", d);
    }
    // Same data fed in uneven pieces must give the same digest as one call.
    sha256_init(&s);
    size_t pos = 0, step = 1;
    while (pos < sizeof data) {
        size_t n = step < sizeof data - pos ? step : sizeof data - pos;
        sha256_update(&s, data + pos, n);
        pos += n;
        step = step * 3 % 211 + 1;
    }
    sha256_final(&s, d);
    print_digest("pieces    ", d);
    // Hash chain: digest of digest, 60 times.
    for (int i = 0; i < 60; i++) {
        sha256_init(&s);
        sha256_update(&s, d, 32);
        sha256_final(&s, d);
    }
    print_digest("chain(60) ", d);
    return 0;
}
