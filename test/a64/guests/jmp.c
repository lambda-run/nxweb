#include "mini.h"
typedef u64 jbuf[24];
int sj(jbuf b) __attribute__((returns_twice));
void lj(jbuf b, int v) __attribute__((noreturn));
__asm__(".text\n.globl sj\nsj:\n stp x19,x20,[x0,#0]\n stp x21,x22,[x0,#16]\n stp x23,x24,[x0,#32]\n stp x25,x26,[x0,#48]\n"
        " stp x27,x28,[x0,#64]\n stp x29,x30,[x0,#80]\n mov x2,sp\n str x2,[x0,#96]\n stp d8,d9,[x0,#104]\n stp d10,d11,[x0,#120]\n"
        " stp d12,d13,[x0,#136]\n stp d14,d15,[x0,#152]\n mov w0,#0\n ret\n"
        ".globl lj\nlj:\n ldp x19,x20,[x0,#0]\n ldp x21,x22,[x0,#16]\n ldp x23,x24,[x0,#32]\n ldp x25,x26,[x0,#48]\n"
        " ldp x27,x28,[x0,#64]\n ldp x29,x30,[x0,#80]\n ldr x2,[x0,#96]\n mov sp,x2\n ldp d8,d9,[x0,#104]\n ldp d10,d11,[x0,#120]\n"
        " ldp d12,d13,[x0,#136]\n ldp d14,d15,[x0,#152]\n cmp w1,#0\n csinc w0,w1,wzr,ne\n br x30\n");
static jbuf jb, jb2;
static volatile u64 trail;
__attribute__((noinline)) static void dive(int n, int v) { volatile char pad[40]; pad[n % 40] = (char)n; trail = trail * 3 + (u64)n; if (n == 0) lj(jb, v); dive(n - 1, v); trail += pad[0]; }
__attribute__((noinline)) static int inner(int k) { if (sj(jb2) == 0) { dive(k % 7, k + 1); } return 5; }
int main(void) {
  u64 sum = 0;
  for (volatile int i = 0; i < 500; i++) {
    int r = sj(jb);
    if (r == 0) dive(i % 50, i + 1); else sum += (u64)r;
  }
  put("sum "); put_dec((i64)sum); put_hex(trail);
  volatile int n = 0;
  int r = sj(jb);
  if (r < 20) { n++; inner(r); }
  put("nested "); put_dec(n); put_dec(r);
  return (int)(sum & 0x7f);
}
