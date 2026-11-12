// nxem: the few Darwin C library functions nxnative's HLE files call that Emscripten's libc (musl) does not have.
// They live in headers that exist on both systems (<time.h>, <stdlib.h>), so no header shim can add them: this
// file is included before the source (nx_hle.h includes it; tools/hle_inventory.py passes -include nx_darwin.h).
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static inline uint64_t clock_gettime_nsec_np(clockid_t id) {
    struct timespec t; if (clock_gettime(id, &t)) return 0;
    return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec;
}
int getentropy(void *buf, size_t len);
static inline void arc4random_buf(void *p, size_t n) {
    uint8_t *b = (uint8_t *)p;
    while (n) { size_t k = n > 256 ? 256 : n; if (getentropy(b, k)) abort(); b += k; n -= k; }
}
static inline uint32_t arc4random(void) { uint32_t v; arc4random_buf(&v, sizeof v); return v; }

// BSD mergesort: stable, O(n log n); returns 0, or -1 when out of memory
static inline int mergesort(void *base, size_t n, size_t w, int (*cmp)(const void *, const void *)) {
    if (n < 2) return 0;
    char *a = (char *)base, *t = (char *)malloc(n * w); if (!t) return -1;
    for (size_t run = 1; run < n; run *= 2) {
        for (size_t lo = 0; lo < n; lo += 2 * run) {
            size_t mid = lo + run < n ? lo + run : n, hi = lo + 2 * run < n ? lo + 2 * run : n, i = lo, j = mid, k = lo;
            while (i < mid && j < hi) { if (cmp(a + j * w, a + i * w) < 0) memcpy(t + k++ * w, a + j++ * w, w); else memcpy(t + k++ * w, a + i++ * w, w); }
            while (i < mid) memcpy(t + k++ * w, a + i++ * w, w);
            while (j < hi) memcpy(t + k++ * w, a + j++ * w, w);
        }
        memcpy(a, t, n * w);
    }
    free(t); return 0;
}
