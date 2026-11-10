// longjmp implemented with `br x9` (not `br x30`/`ret`) in a long loop, plus a long chain of
// indirect tail jumps: neither may grow the wasm stack without bound.
#include "mini.h"
typedef u64 jbuf[24];
int sj(jbuf b) __attribute__((returns_twice));
void lj(jbuf b, int v) __attribute__((noreturn));
__asm__(".text\n.globl sj\nsj:\n stp x19,x20,[x0,#0]\n stp x21,x22,[x0,#16]\n stp x23,x24,[x0,#32]\n stp x25,x26,[x0,#48]\n"
        " stp x27,x28,[x0,#64]\n stp x29,x30,[x0,#80]\n mov x2,sp\n str x2,[x0,#96]\n mov w0,#0\n ret\n"
        ".globl lj\nlj:\n ldp x19,x20,[x0,#0]\n ldp x21,x22,[x0,#16]\n ldp x23,x24,[x0,#32]\n ldp x25,x26,[x0,#48]\n"
        " ldp x27,x28,[x0,#64]\n ldp x29,x9,[x0,#80]\n mov x30,x9\n ldr x2,[x0,#96]\n mov sp,x2\n cmp w1,#0\n csinc w0,w1,wzr,ne\n br x9\n");
static jbuf jb;
static volatile u64 trail;
__attribute__((noinline)) static void dive(int n, int v) { volatile char pad[24]; pad[n % 24] = (char)n; trail = trail * 3 + (u64)n; if (n == 0) lj(jb, v); dive(n - 1, v); trail += pad[0]; }
typedef u64 (*step_fn)(u64, u64);
static step_fn table[4];
__attribute__((noinline)) static u64 s0(u64 n, u64 acc) { if (n == 0) return acc; __attribute__((musttail)) return table[n & 3](n - 1, acc * 3 + 1); }
__attribute__((noinline)) static u64 s1(u64 n, u64 acc) { if (n == 0) return acc; __attribute__((musttail)) return table[(n >> 1) & 3](n - 1, acc ^ (acc >> 7)); }
__attribute__((noinline)) static u64 s2(u64 n, u64 acc) { if (n == 0) return acc; __attribute__((musttail)) return table[(n * 7) & 3](n - 1, acc + n); }
__attribute__((noinline)) static u64 s3(u64 n, u64 acc) { if (n == 0) return acc; __attribute__((musttail)) return table[(n ^ acc) & 3](n - 1, acc * 5); }
int main(void) {
  u64 sum = 0;
  for (volatile int i = 0; i < 30000; i++) {
    int r = sj(jb);
    if (r == 0) dive(i % 40, i + 1); else sum += (u64)r;
  }
  put("sum "); put_dec((i64)sum); put_hex(trail);
  table[0] = s0; table[1] = s1; table[2] = s2; table[3] = s3;
  put("chain "); put_hex(table[0](2000000, 1));
  return 0;
}
