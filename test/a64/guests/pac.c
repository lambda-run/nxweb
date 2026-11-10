// ISA: a78c
// Pointer authentication as real compiler output and by hand: every function here signs its return address with the
// B key (PACIBSP) and returns with RETAB; calls through pointers, deep recursion, a non-local exit over signed frames;
// then the explicit forms: PACIA/AUTIA and friends, XPAC, BLRAA/BLRABZ/BRAB/BRAAZ, LDRAA/LDRAB with and without writeback.
#include "mini.h"
typedef u64 jbuf[24];
int sj(jbuf b) __attribute__((returns_twice));
void lj(jbuf b, int v) __attribute__((noreturn));
__asm__(".text\n.globl sj\nsj:\n stp x19,x20,[x0,#0]\n stp x21,x22,[x0,#16]\n stp x23,x24,[x0,#32]\n stp x25,x26,[x0,#48]\n"
        " stp x27,x28,[x0,#64]\n stp x29,x30,[x0,#80]\n mov x2,sp\n str x2,[x0,#96]\n mov w0,#0\n ret\n"
        ".globl lj\nlj:\n ldp x19,x20,[x0,#0]\n ldp x21,x22,[x0,#16]\n ldp x23,x24,[x0,#32]\n ldp x25,x26,[x0,#48]\n"
        " ldp x27,x28,[x0,#64]\n ldp x29,x30,[x0,#80]\n ldr x2,[x0,#96]\n mov sp,x2\n cmp w1,#0\n csinc w0,w1,wzr,ne\n br x30\n");
// u64 pcall(u64 (*f)(u64), u64 arg, u64 modifier): signs f with the A key and the modifier, calls it with BLRAA
u64 pcall(u64 (*f)(u64), u64 a, u64 m);
u64 pcallz(u64 (*f)(u64), u64 a);
u64 ptail(u64 (*f)(u64), u64 a, u64 m);
u64 ptailz(u64 (*f)(u64), u64 a);
u64 pload(u64 *p, u64 *out2);
u64 round_trip(u64 p, u64 m);
__asm__(".text\n"
        ".globl pcall\npcall:\n pacibsp\n stp x29,x30,[sp,#-16]!\n mov x9,x0\n mov x0,x1\n pacia x9,x2\n blraa x9,x2\n ldp x29,x30,[sp],#16\n retab\n"
        ".globl pcallz\npcallz:\n paciasp\n stp x29,x30,[sp,#-16]!\n mov x9,x0\n mov x0,x1\n pacizb x9\n blrabz x9\n ldp x29,x30,[sp],#16\n retaa\n"
        ".globl ptail\nptail:\n mov x9,x0\n mov x0,x1\n pacib x9,x2\n brab x9,x2\n"
        ".globl ptailz\nptailz:\n mov x9,x0\n mov x0,x1\n paciza x9\n braaz x9\n"
        // x0 = pointer to four words: ldraa [x0,#8]; ldrab [x0,#16]!; ldraa [x0,#-16]!; ldrab [x0,#24]; the final base goes to *x1
        ".globl pload\npload:\n pacibsp\n mov x9,x0\n pacdza x9\n ldraa x2,[x9,#8]\n mov x10,x0\n pacdzb x10\n ldrab x3,[x10,#16]!\n"
        " ldraa x4,[x10,#-16]!\n ldrab x5,[x10,#24]\n str x10,[x1]\n eor x0,x2,x3,lsl #1\n eor x0,x0,x4,lsl #2\n eor x0,x0,x5,lsl #3\n retab\n"
        // sign and authenticate with every key, strip: the pointer must come back as it went in
        ".globl round_trip\nround_trip:\n paciasp\n mov x9,x0\n pacia x9,x1\n autia x9,x1\n pacib x9,sp\n autib x9,sp\n pacda x9,x1\n autda x9,x1\n"
        " pacdb x9,x1\n autdb x9,x1\n paciza x9\n autiza x9\n pacizb x9\n autizb x9\n pacdza x9\n autdza x9\n pacdzb x9\n autdzb x9\n"
        " mov x17,x9\n mov x16,x1\n pacia1716\n autia1716\n pacib1716\n autib1716\n mov x9,x17\n xpaci x9\n xpacd x9\n mov x0,x9\n"
        " mov x10,x30\n xpaclri\n cmp x10,x30\n cinc x0,x0,ne\n autiasp\n ret\n");

static jbuf jb;
static volatile u64 trail;
__attribute__((noinline)) static u64 twice(u64 x) { return x * 2 + 1; }
__attribute__((noinline)) static u64 sq(u64 x) { return x * x + 3; }
__attribute__((noinline)) static u64 fib(u64 n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
__attribute__((noinline)) static void dive(int n, int v) { volatile char pad[40]; pad[n % 40] = (char)n; trail = trail * 3 + (u64)n; if (n == 0) lj(jb, v); dive(n - 1, v); trail += pad[0]; }
typedef u64 (*fn)(u64);
static fn table[4] = { twice, sq, fib, twice };
static u64 words[4] = { 0x1111, 0x2222, 0x3333, 0x4444 };
int main(void) {
  u64 acc = 0;
  for (volatile int i = 0; i < 200; i++) acc = acc * 31 + table[i & 3]((u64)(i % 20));
  put("calls "); put_hex(acc);
  u64 sum = 0;
  for (volatile int i = 0; i < 300; i++) { int r = sj(jb); if (r == 0) dive(i % 40, i + 1); else sum += (u64)r; }
  put("unwound "); put_dec((i64)sum); put_hex(trail);
  u64 a = 0;
  for (volatile int i = 0; i < 100; i++) {
    a += pcall(table[i & 1], (u64)i, 0x1234 + (u64)i) + pcallz(sq, (u64)i) + ptail(twice, (u64)i, (u64)&a) + ptailz(fib, (u64)(i % 15));
  }
  put("auth calls "); put_hex(a);
  u64 base2 = 0;
  u64 l = pload(words, &base2);
  put("ldraa "); put_hex(l); put_dec((i64)(base2 - (u64)words));
  put("round trip "); put_hex(round_trip((u64)words, 77) - (u64)words); put_hex(round_trip(0x7fffffffffull, (u64)-1));
  return (int)(acc & 0x3f);
}
