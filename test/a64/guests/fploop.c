#include "mini.h"
static u64 bits(double d) { u64 u; memcpy(&u, &d, 8); return u; }
__attribute__((noinline)) static double horner(const double *c, int n, double x) { double r = 0; for (int i = n - 1; i >= 0; i--) r = r * x + c[i]; return r; }
__attribute__((noinline)) static int mandel(double cr, double ci) { double x = 0, y = 0; int i = 0; while (i < 200 && x * x + y * y < 4.0) { double t = x * x - y * y + cr; y = 2 * x * y + ci; x = t; i++; } return i; }
__attribute__((noinline)) static float fsum(const float *v, int n) { float s = 0; for (int i = 0; i < n; i++) s += v[i] * 0.5f - (float)i / 3.0f; return s; }
int main(void) {
  static const double c[6] = {1.0, -0.5, 0.333333333333, -0.25, 0.2, -0.1666666};
  double acc = 0;
  for (int i = 0; i < 2000; i++) acc += horner(c, 6, (double)i * 0.001 - 1.0);
  put("horner "); put_hex(bits(acc));
  u64 m = 0;
  for (int y = -12; y <= 12; y++) for (int x = -30; x <= 10; x++) m = m * 7 + (u64)mandel(x * 0.07, y * 0.09);
  put("mandel "); put_hex(m);
  double pi = 0, sgn = 1;
  for (int k = 0; k < 20000; k++) { pi += sgn / (2.0 * k + 1.0); sgn = -sgn; }
  put("pi "); put_hex(bits(pi * 4)); put_dec((i64)(pi * 4e9));
  static float v[500];
  for (int i = 0; i < 500; i++) v[i] = (float)(i * i % 97) / 7.0f;
  double fs = fsum(v, 500);
  put("fsum "); put_hex(bits(fs)); put_dec((i64)__builtin_sqrt(1e12 + fs)); volatile float big = -2.5e9f; volatile double ubig = 3.9e9; put_dec((int)big); put_dec((u32)ubig);
  return 0;
}
