// Tiny freestanding runtime for nxweb test guests.
#ifndef NXWEB_GUEST_RT_H
#define NXWEB_GUEST_RT_H
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

// SVC wrappers (svc.S)
void svc_output(const char *p, size_t n);   // svc 0x27
_Noreturn void svc_exit(int code);          // svc 0x07
uint64_t svc_tick(void);                    // svc 0x1E

// libc subset (libc.c)
void *memcpy(void *restrict d, const void *restrict s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
int putchar(int c);
int puts(const char *s);
// Supports %d %i %u %x %X %c %s %p %f %%, length modifiers l/ll/z, flags '-' and
// '0', a decimal width, and ".N" precision for %f (default 6, max 15) and %s.
int printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
int vprintf(const char *fmt, va_list ap);
_Noreturn void exit(int code);

// setjmp.S
typedef uint64_t jmp_buf[22];
int setjmp(jmp_buf env) __attribute__((returns_twice));
_Noreturn void longjmp(jmp_buf env, int val);

// Helpers shared by the test programs.
static inline uint64_t mix64(uint64_t h, uint64_t v)
{
    h = (h ^ v) * 0x9E3779B97F4A7C15ull;
    return h ^ (h >> 29);
}

static inline uint64_t rng_next(uint64_t *s)
{
    uint64_t x = *s;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *s = x;
    return x * 0x2545F4914F6CDD1Dull;
}

static inline uint64_t f64_bits(double d)
{
    union { double d; uint64_t u; } c;
    c.d = d;
    return c.u;
}

static inline uint32_t f32_bits(float f)
{
    union { float f; uint32_t u; } c;
    c.f = f;
    return c.u;
}

static inline double f64_from_bits(uint64_t u)
{
    union { double d; uint64_t u; } c;
    c.u = u;
    return c.d;
}

static inline float f32_from_bits(uint32_t u)
{
    union { float f; uint32_t u; } c;
    c.u = u;
    return c.f;
}

#endif
