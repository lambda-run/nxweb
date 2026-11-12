// nxem test: a made-up "host file" whose entries have the argument shapes that are rare in nxnative (arguments on
// the guest stack, doubles, mixed integer / floating-point order, narrow integers, bool, a function pointer, an
// array parameter) so that tools/gen_hle.py's marshalling can be checked on values, plus one entry of each kind
// that must be reported as needing a hand-written thunk. Written the way nxnative's files are, wrapper macro included.
#include "hle.h"
#include <stdbool.h>
#include <stdarg.h>

typedef struct { uint64_t a, b; } pair_t;
typedef enum { COL_R, COL_G = 7 } colour;
typedef uint16_t half_t;
typedef int (*cb_t)(int);

HLE_FORCE("t_sum10", "ten integers: two on the stack", uint64_t, t_sum10,
          uint64_t a, uint64_t b, uint64_t c, uint64_t d, uint64_t e,   // a comment, with (parentheses
          uint64_t f, uint64_t g, uint64_t h, uint64_t i, uint64_t j) {
    return a + 2 * b + 3 * c + 4 * d + 5 * e + 6 * f + 7 * g + 8 * h + 9 * i + 10 * j;
}
HLE_FORCE("t_mix", "integer and floating-point registers are counted separately", double, t_mix, int a, float x, void *p, double y, unsigned b) {
    return (double)a + (double)x + (double)(uintptr_t)p + y + (double)b;
}
HLE_FORCE("t_f9", "nine floats and an integer after them: one float and nothing else on the stack", float, t_f9,
          float a, float b, float c, float d, float e, float f, float g, float h, float i, int k) { return a + b + c + d + e + f + g + h + 100.0f * i + (float)k; }
HLE_FORCE("t_stackmix", "integers and a double past the registers share the stack in declaration order", double, t_stackmix,
          int a, int b, int c, int d, int e, int f, int g, int h, int s0, double d0, double d1, double d2, double d3, double d4, double d5, double d6, double d7, double s1, int s2) {
    (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; (void)d0; (void)d1; (void)d2; (void)d3; (void)d4; (void)d5; (void)d6; (void)d7;
    return (double)s0 * 1000.0 + s1 + (double)s2;
}
HLE_FORCE("t_narrow", "the caller leaves garbage above a narrow argument", uint32_t, t_narrow, uint8_t a, half_t b, bool c, int16_t d, colour e) {
    return (uint32_t)a + ((uint32_t)b << 8) + ((uint32_t)c << 24) + ((uint32_t)(d < 0) << 25) + ((uint32_t)(e == COL_G) << 26);
}
HLE_FORCE("t_neg", "a negative int", int, t_neg, void) { return -2; }
HLE_FORCE("t_u32", "an unsigned result", uint32_t, t_u32, void) { return 0xFFFFFFF0u; }
HLE_FORCE("t_bool", "a bool result", bool, t_bool, const char *s) { return s && s[0] == 'y'; }
HLE_FORCE("t_cb", "a function-pointer parameter, an array parameter and a typedef'd one", int, t_cb, int (*f)(int, int), const uint8_t key[16], cb_t g) {
    return (f != 0) + 2 * (key != 0) + 4 * (g != 0);
}
static int g_last;
#define T_SET(name, cname, ...) HLE_FORCE("t_set_" name, "made by a wrapper macro", void, cname, __VA_ARGS__)
T_SET("int", t_set_int, int v) { g_last = v; }
#define T_GET(N) HLE("t_get" #N, int, t_get_##N, void) { return g_last + N; }
T_GET(3)
// must be reported, not generated
HLE_FORCE("t_pair", "a 16-byte struct result (x0, x1)", pair_t, t_hand_pair, uint64_t a) { return (pair_t){a, a + 1}; }
HLE_FORCE("t_pairarg", "a struct by value", uint64_t, t_hand_pairarg, pair_t p) { return p.a + p.b; }
HLE_FORCE("t_va", "a va_list", int, t_hand_va, const char *fmt, va_list ap) { (void)fmt; (void)ap; return 0; }
HLE_FORCE("t_i128", "a 128-bit integer", __int128, t_hand_i128, void) { return 1; }
HLE_FORCE("t_ld", "a long double (128-bit on AArch64)", int, t_hand_ld, long double x) { return x > 0; }
