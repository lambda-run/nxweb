// LZ77-style compressor and decompressor over generated data: hash chains,
// match search, variable-length token encoding, overlapping copies. The
// round trip is verified in the guest and checksums are printed.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

#define IN_MAX 8000
#define HASH_BITS 12
#define WINDOW 4095
#define MIN_MATCH 4
#define MAX_MATCH 255

static uint8_t input[IN_MAX], packed[IN_MAX + IN_MAX / 8 + 64], unpacked[IN_MAX];
static int32_t head[1 << HASH_BITS], prev_pos[IN_MAX];

static inline uint32_t hash4(const uint8_t *p)
{
    uint32_t v;
    memcpy(&v, p, 4);
    return (v * 2654435761u) >> (32 - HASH_BITS);
}

// Format: control byte with 8 flags (LSB first); flag 0 = literal byte,
// flag 1 = match: 12-bit distance, then length-MIN_MATCH (4 bits; 15 = another byte follows).
static NOINLINE size_t compress(const uint8_t *in, size_t n, uint8_t *out, unsigned max_chain, unsigned *matches)
{
    size_t ip = 0, op = 0, ctrl_at = 0;
    unsigned bit = 8;
    for (int i = 0; i < (1 << HASH_BITS); i++) head[i] = -1;
    *matches = 0;
    while (ip < n) {
        if (bit == 8) {
            ctrl_at = op++;
            out[ctrl_at] = 0;
            bit = 0;
        }
        size_t best_len = 0, best_dist = 0;
        if (ip + MIN_MATCH <= n) {
            uint32_t h = hash4(in + ip);
            int32_t cand = head[h];
            unsigned chain = max_chain;
            size_t limit = n - ip < MAX_MATCH + MIN_MATCH + 14 ? n - ip : MAX_MATCH + MIN_MATCH + 14;
            while (cand >= 0 && ip - (size_t)cand <= WINDOW && chain--) {
                size_t len = 0;
                while (len < limit && in[(size_t)cand + len] == in[ip + len]) len++;
                if (len > best_len) {
                    best_len = len;
                    best_dist = ip - (size_t)cand;
                }
                cand = prev_pos[cand];
            }
            prev_pos[ip] = head[h];
            head[h] = (int32_t)ip;
        }
        if (best_len >= MIN_MATCH) {
            out[ctrl_at] |= (uint8_t)(1u << bit);
            size_t code = best_len - MIN_MATCH;
            out[op++] = (uint8_t)(best_dist & 0xff);
            out[op++] = (uint8_t)((best_dist >> 8) << 4 | (code < 15 ? code : 15));
            if (code >= 15) out[op++] = (uint8_t)(code - 15);
            // Insert the skipped positions into the hash chains as well.
            for (size_t k = 1; k < best_len && ip + k + MIN_MATCH <= n; k++) {
                uint32_t h = hash4(in + ip + k);
                prev_pos[ip + k] = head[h];
                head[h] = (int32_t)(ip + k);
            }
            ip += best_len;
            ++*matches;
        } else {
            out[op++] = in[ip++];
        }
        bit++;
    }
    return op;
}

static NOINLINE size_t decompress(const uint8_t *in, size_t n, uint8_t *out, size_t cap)
{
    size_t ip = 0, op = 0;
    while (ip < n) {
        unsigned ctrl = in[ip++];
        for (int bit = 0; bit < 8 && ip < n; bit++, ctrl >>= 1) {
            if (ctrl & 1) {
                size_t dist = in[ip] | (size_t)(in[ip + 1] >> 4) << 8;
                size_t len = in[ip + 1] & 15;
                ip += 2;
                if (len == 15) len += in[ip++];
                len += MIN_MATCH;
                if (dist == 0 || dist > op || op + len > cap) return 0;
                const uint8_t *src = out + op - dist;
                for (size_t k = 0; k < len; k++) out[op + k] = src[k];   // may overlap
                op += len;
            } else {
                if (op >= cap) return 0;
                out[op++] = in[ip++];
            }
        }
    }
    return op;
}

static NOINLINE uint32_t adler32(const uint8_t *p, size_t n)
{
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < n; i++) {
        a = (a + p[i]) % 65521;
        b = (b + a) % 65521;
    }
    return b << 16 | a;
}

static NOINLINE size_t gen_text(uint8_t *out, size_t n, uint64_t seed)
{
    static const char *const words[] = {"the", "switch", "translator", "wasm", "arm64", "block", "register", "guest",
                                        "memory", "branch", "vector", "and", "of", "to", "instruction", "flags"};
    size_t o = 0;
    while (o < n) {
        const char *w = words[rng_next(&seed) >> 60];
        while (*w && o < n) out[o++] = (uint8_t)*w++;
        if (o < n) out[o++] = (rng_next(&seed) & 15) ? ' ' : '\n';
    }
    return n;
}

static void run_case(const char *name, size_t n, unsigned chain)
{
    unsigned matches;
    size_t c = compress(input, n, packed, chain, &matches);
    memset(unpacked, 0xAA, sizeof unpacked);
    size_t d = decompress(packed, c, unpacked, sizeof unpacked);
    int ok = d == n && memcmp(input, unpacked, n) == 0;
    printf("%-10s in=%5lu packed=%5lu matches=%5u adler(in)=%08x adler(packed)=%08x roundtrip=%s\n", name, n, c,
           matches, adler32(input, n), adler32(packed, c), ok ? "ok" : "FAILED");
}

int main(void)
{
    uint64_t seed = 0x1a2b3c4d5e6f7788ull;

    gen_text(input, 7000, 1);
    run_case("text", 7000, 16);
    run_case("text-fast", 7000, 1);

    for (size_t i = 0; i < 3000; i++) input[i] = (uint8_t)(rng_next(&seed) >> 32);
    run_case("random", 3000, 8);

    for (size_t i = 0; i < IN_MAX; i++) input[i] = (uint8_t)"abcabcabd"[i % 9];
    run_case("periodic", IN_MAX, 8);

    memset(input, 0, 5000);
    run_case("zeros", 5000, 4);

    for (size_t i = 0; i < 5000; i++) {
        uint64_t r = rng_next(&seed);
        input[i] = (uint8_t)((i >> 6) * 7 + ((r >> 40) % 3 == 0 ? (r & 3) : 0));
    }
    run_case("gradient", 5000, 12);

    // Structured binary records with small deltas.
    for (size_t i = 0; i + 8 <= 6000; i += 8) {
        uint32_t id = (uint32_t)(i / 8), val = (uint32_t)(rng_next(&seed) >> 58) + id * 3;
        memcpy(input + i, &id, 4);
        memcpy(input + i + 4, &val, 4);
    }
    run_case("records", 6000, 16);

    static const size_t tiny[] = {0, 1, 3, 4, 5, 9, 17};
    for (unsigned i = 0; i < sizeof tiny / sizeof tiny[0]; i++) {
        gen_text(input, tiny[i], 7 + i);
        run_case("tiny", tiny[i], 4);
    }
    return 0;
}
