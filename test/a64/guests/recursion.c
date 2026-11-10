#include "mini.h"
__attribute__((noinline)) static u64 fib(u32 n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
__attribute__((noinline)) static u64 ack(u64 m, u64 n) { return m == 0 ? n + 1 : n == 0 ? ack(m - 1, 1) : ack(m - 1, ack(m, n - 1)); }
__attribute__((noinline)) static u64 deep(u64 n, volatile u64 *sink) { volatile u64 pad[4]; pad[n & 3] = n; if (n == 0) return 1; u64 r = deep(n - 1, sink) + pad[n & 3]; *sink += r; return r; }
__attribute__((noinline)) static int is_even(u32 n);
__attribute__((noinline)) static int is_odd(u32 n) { return n == 0 ? 0 : is_even(n - 1); }
__attribute__((noinline)) static int is_even(u32 n) { return n == 0 ? 1 : is_odd(n - 1); }
int main(void) {
  volatile u64 sink = 0;
  put("fib "); put_dec(fib(24));
  put("ack "); put_dec(ack(2, 300)); put_dec(ack(3, 5));
  put("deep "); put_dec(deep(3000, &sink)); put_hex(sink);
  put("even "); put_dec(is_even(9001) * 10 + is_odd(7777));
  return 3;
}
