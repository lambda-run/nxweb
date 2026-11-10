#include "mini.h"
static u32 a[3000];
static u32 seed = 12345;
static u32 rnd(void) { seed = seed * 1664525u + 1013904223u; return seed >> 4; }
static void qs(u32 *v, int lo, int hi) {
  while (lo < hi) {
    u32 p = v[(lo + hi) >> 1]; int i = lo, j = hi;
    while (i <= j) { while (v[i] < p) i++; while (v[j] > p) j--; if (i <= j) { u32 t = v[i]; v[i] = v[j]; v[j] = t; i++; j--; } }
    if (j - lo < hi - i) { qs(v, lo, j); lo = i; } else { qs(v, i, hi); hi = j; }
  }
}
static int cmp_desc(const void *x, const void *y) { u32 a = *(const u32 *)x, b = *(const u32 *)y; return a < b ? 1 : a > b ? -1 : 0; }
static void isort(u32 *v, int n, int (*cmp)(const void *, const void *)) {
  for (int i = 1; i < n; i++) { u32 k = v[i]; int j = i - 1; while (j >= 0 && cmp(&v[j], &k) > 0) { v[j + 1] = v[j]; j--; } v[j + 1] = k; }
}
int main(void) {
  for (int i = 0; i < 3000; i++) a[i] = rnd() % 100000;
  qs(a, 0, 2999);
  u64 h = 0; int ok = 1;
  for (int i = 0; i < 3000; i++) { h = h * 31 + a[i]; if (i && a[i - 1] > a[i]) ok = 0; }
  put("sorted "); put_dec(ok); put_hex(h);
  isort(a, 400, cmp_desc);
  h = 0; for (int i = 0; i < 400; i++) h = h * 131 + a[i];
  put("desc "); put_hex(h); put_dec(a[0]); put_dec(a[399]);
  return 0;
}
