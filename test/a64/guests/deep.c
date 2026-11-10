// very deep guest recursion: bounded only by the guest stack (about 900 KB used here)
#include "mini.h"
__attribute__((noinline)) static u64 down(u64 n, u64 a) { volatile u64 k = n ^ a; if (n == 0) return a; return down(n - 1, a * 31 + k) + (k & 1); }
__attribute__((noinline)) static int odd(u32 n);
__attribute__((noinline)) static int even(u32 n) { return n == 0 ? 1 : odd(n - 1); }
__attribute__((noinline)) static int odd(u32 n) { return n == 0 ? 0 : even(n - 1); }
int main(void) {
  put("down "); put_hex(down(14000, 7));
  put("even "); put_dec(even(20000));
  u64 s = 0;
  for (int i = 0; i < 200; i++) s += down(300 + i, i);   // repeatedly crossing the depth limit
  put("loop "); put_hex(s);
  return 0;
}
