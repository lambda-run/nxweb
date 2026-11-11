// The C library intrinsics against their definitions (npm run a64:libc): every length 0..80 at every alignment pair
// mod 16, a difference at every position (signs: bytes above 0x7F compare unsigned), terminators anywhere, memchr of
// every byte value. The aarch64 image runs the optimized-routines definitions translated, then again with them as
// intrinsics; both must print what the native build (the host's libc) prints.
#include "plat.h"
static unsigned char A[512] __attribute__((aligned(16))), B[512] __attribute__((aligned(16)));
static uint64_t h = 0xCBF29CE484222325ull;
static void mix(uint64_t v) { h = (h ^ v) * 0x100000001B3ull; }
static int sgn(int v) { return v < 0 ? -1 : v > 0; }
int main(void) {
  for (int i = 0; i < 512; i++) { A[i] = (unsigned char)(i * 37 + 11) | 1; B[i] = A[i]; }
  for (int pa = 0; pa < 16; pa++) for (int pb = 0; pb < 16; pb++) for (int n = 0; n <= 80; n++) {
    const unsigned char *p = A + 64 + pa, *q = B + 64 + pb;
    memcpy(B + 64 + pb, A + 64 + pa, n);
    mix(sgn(memcmp(p, q, n)));
    if (n) { for (int k = 0; k < n; k += 7) { unsigned char o = B[64 + pb + k]; B[64 + pb + k] = o ^ 0x80; mix(sgn(memcmp(p, q, n)) * 3 + k); mix(sgn(memcmp(q, p, n))); B[64 + pb + k] = o; } }
    unsigned char sa = A[64 + pa + n], sb = B[64 + pb + n];
    A[64 + pa + n] = 0; B[64 + pb + n] = 0;
    mix(strlen((const char *)p)); mix(strnlen((const char *)p, n / 2)); mix(strnlen((const char *)p, n + 5));
    mix(sgn(strcmp((const char *)p, (const char *)q))); mix(sgn(strncmp((const char *)p, (const char *)q, n / 2 + 1)));
    if (n) { B[64 + pb + n - 1] ^= 0xC0; mix(sgn(strcmp((const char *)p, (const char *)q))); mix(sgn(strncmp((const char *)p, (const char *)q, n))); mix(sgn(strncmp((const char *)p, (const char *)q, n - 1))); B[64 + pb + n - 1] ^= 0xC0; }
    A[64 + pa + n] = sa; B[64 + pb + n] = sb;
    const unsigned char *f = memchr(p, A[64 + pa + n / 2], n); mix(f ? (uint64_t)(f - p) : 999);
    f = memchr(p, 0x100 | 2, n); mix(f ? (uint64_t)(f - p) : 999);
    memset(B + 64 + pb, n, n); mix(fnv(0, B + 60, 100));
    memmove(B + 64 + pb + 3, B + 64 + pb, n); mix(fnv(0, B + 60, 100));
    memmove(B + 64 + pb, B + 64 + pb + 5, n); mix(fnv(0, B + 60, 100));
    for (int i = 0; i < 512; i++) B[i] = A[i];
  }
  for (int c = 0; c < 256; c++) { const unsigned char *f = memchr(A, c, 512); mix(f ? (uint64_t)(f - A) : 999); }
  put("libc fnv "); put_hex(h);
  return 0;
}
