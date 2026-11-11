// The benchmark programs' platform: one source, three builds (test/a64/bench/build.py).
//   BENCH_GUEST  aarch64 flat image for the translator (contract test ABI: svc 0x27 output, svc 0x07 exit)
//   BENCH_NATIVE the host's own compiler and C library (the reference output, and native time)
//   BENCH_WASM   wasm32 module compiled by clang (wasm-native time: the same C on the same engine)
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#if defined(BENCH_NATIVE)
#include <unistd.h>
#include <time.h>
static void out(const char *p, size_t n) { write(1, p, n); }
#elif defined(BENCH_GUEST)
static void out(const char *p, size_t n) {
  register uint64_t x0 __asm__("x0") = (uint64_t)p; register uint64_t x1 __asm__("x1") = n;
  __asm__ volatile("svc #0x27" : "+r"(x0) : "r"(x1) : "memory");
}
int main(void);
__asm__(".section .text.start,\"ax\"\n.globl _start\n_start:\n bl main\n svc #0x07\n b .\n");
#else
__attribute__((import_module("env"), import_name("out"))) void out(const char *p, size_t n);
#endif
#if !defined(BENCH_NATIVE)
// one bump heap: free() does nothing (each program frees everything at the end of a round: bench_reset)
static unsigned char heap[48 << 20] __attribute__((aligned(64)));
static size_t heapTop;
void *malloc(size_t n) { size_t a = (heapTop + 63) & ~(size_t)63; if (a + n > sizeof heap) return 0; heapTop = a + n; return heap + a; }
void *calloc(size_t n, size_t s) { void *p = malloc(n * s); if (p) memset(p, 0, n * s); return p; }
void free(void *p) { (void)p; }
static void bench_reset(void) { heapTop = 0; }
#else
static void bench_reset(void) {}
#endif
#if defined(BENCH_WASM)
// wasm-native: the C library functions the aarch64 image takes from optimized-routines, as plain C (memory.copy /
// memory.fill for the copies, clang -O2 for the loops)
void *memcpy(void *d, const void *s, size_t n) { __builtin_memcpy(d, s, n); return d; }
void *memmove(void *d, const void *s, size_t n) { __builtin_memmove(d, s, n); return d; }
void *memset(void *d, int c, size_t n) { __builtin_memset(d, c, n); return d; }
int memcmp(const void *a, const void *b, size_t n) { const unsigned char *p = a, *q = b; for (size_t i = 0; i < n; i++) if (p[i] != q[i]) return p[i] - q[i]; return 0; }
void *memchr(const void *s, int c, size_t n) { const unsigned char *p = s; for (size_t i = 0; i < n; i++) if (p[i] == (unsigned char)c) return (void *)(p + i); return 0; }
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
size_t strnlen(const char *s, size_t m) { size_t n = 0; while (n < m && s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return (unsigned char)*a - (unsigned char)*b; }
int strncmp(const char *a, const char *b, size_t n) { for (; n; n--, a++, b++) { if (*a != *b || !*a) return (unsigned char)*a - (unsigned char)*b; } return 0; }
char *strchr(const char *s, int c) { for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)) {} return r; }
#endif
#if !defined(BENCH_NATIVE)
char *strncat(char *d, const char *s, size_t n) { char *e = d + strlen(d); size_t i = 0; for (; i < n && s[i]; i++) e[i] = s[i]; e[i] = 0; return d; }
#endif
static void put(const char *s) { out(s, strlen(s)); }
static void put_hex(uint64_t v) {
  char b[17]; for (int i = 0; i < 16; i++) { unsigned d = (v >> (60 - 4 * i)) & 15; b[i] = d < 10 ? '0' + d : 'a' + d - 10; }
  b[16] = '\n'; out(b, 17);
}
static void put_dec(uint64_t u) { char b[24]; int i = 23; b[i--] = '\n'; do { b[i--] = '0' + u % 10; u /= 10; } while (u); out(b + i + 1, 23 - i); }
static uint64_t fnv(uint64_t h, const unsigned char *p, size_t n) { for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 0x100000001B3ull; return h; }
