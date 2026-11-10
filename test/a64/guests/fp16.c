// ISA: a78c
// Half-precision floating point (FP16) as the compiler emits it for _Float16 on a Cortex-A78C class core: scalar
// H-register arithmetic, fused multiply-add, compares, conversions to and from integers, and the vectorised .8H loops.
#include "mini.h"
typedef _Float16 h16;
static u64 hb(h16 h) { unsigned short u; memcpy(&u, &h, 2); return u; }
__attribute__((noinline)) static h16 poly(h16 x) { return ((x * (h16)0.25 - (h16)1.5) * x + (h16)3.0) * x - (h16)0.125; }
__attribute__((noinline)) static h16 fma16(h16 a, h16 b, h16 c) { return __builtin_fmaf16(a, b, c); }
__attribute__((noinline)) static h16 dot(const h16 *a, const h16 *b, int n) { h16 s = 0; for (int i = 0; i < n; i++) s += a[i] * b[i]; return s; }
__attribute__((noinline)) static void axpy(h16 *y, const h16 *x, h16 a, int n) { for (int i = 0; i < n; i++) y[i] = a * x[i] + y[i]; }
__attribute__((noinline)) static void scale(h16 *y, int n) { for (int i = 0; i < n; i++) y[i] = y[i] / (h16)3.0 - (y[i] > (h16)2.0 ? (h16)1.0 : (h16)0.5); }
static h16 xs[256], ys[256];
int main(void) {
  u64 acc = 0;
  for (int i = -200; i <= 200; i++) acc = acc * 31 + hb(poly((h16)i * (h16)0.0625));
  put("poly "); put_hex(acc);
  acc = 0;
  for (int i = 0; i < 300; i++) acc = acc * 31 + hb(fma16((h16)(i % 17) * (h16)0.37, (h16)(i % 23) - (h16)11.0, (h16)(i % 5) * (h16)0.01));
  put("fma "); put_hex(acc);
  for (int i = 0; i < 256; i++) { xs[i] = (h16)((i * 37) % 101) / (h16)16.0; ys[i] = (h16)(i % 13) - (h16)6.0; }
  put("dot "); put_hex(hb(dot(xs, ys, 256)));
  axpy(ys, xs, (h16)0.75, 256); scale(ys, 256);
  acc = 0;
  for (int i = 0; i < 256; i++) acc = acc * 31 + hb(ys[i]);
  put("vec "); put_hex(acc);
  i64 is = 0; u64 iu = 0;
  for (int i = 0; i < 256; i++) { is += (int)(ys[i] * (h16)100.0); iu += (unsigned)(xs[i] * (h16)9.0); }
  put("int "); put_dec(is); put_dec((i64)iu);
  int lt = 0; h16 m = xs[0];
  for (int i = 0; i < 256; i++) { lt += xs[i] < ys[i]; if (ys[i] > m) m = ys[i]; }
  put("cmp "); put_dec(lt); put_hex(hb(m));
  volatile h16 big = (h16)60000.0, tiny = (h16)0.0001;
  put("edge "); put_hex(hb(big * (h16)2.0)); put_hex(hb(tiny * tiny)); put_hex(hb(tiny / (h16)7.0)); put_hex(hb((h16)(float)(i64)123456));
  return 0;
}
