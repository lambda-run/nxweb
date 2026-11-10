// ISA: a78c
// LSE atomics and RCPC as the compiler emits them for C11 atomics and the __atomic builtins on a Cortex-A78C class
// core: LDADD, LDCLR, LDEOR, LDSET, SWP, CAS in every size, CASP for a 128-bit exchange, LDUMAX / LDUMIN / LDSMAX /
// LDSMIN, the ST* forms where the old value is not used, LDAPR for acquire loads.
// (Signed min / max only on 64 bits: the reference's QEMU compares the narrower ones wrongly; the fuzz gate covers them.)
#include "mini.h"
#include <stdatomic.h>
static _Atomic unsigned char a8;
static _Atomic unsigned short a16;
static _Atomic unsigned int a32;
static _Atomic u64 a64v;
static long s64;
static unsigned char m8;
static unsigned short m16;
static unsigned int m32;
static u64 m64;
static _Atomic __int128 wide;
static atomic_flag lock = ATOMIC_FLAG_INIT;
static volatile u64 guarded;

__attribute__((noinline)) static void locked_add(u64 v) {
  while (atomic_flag_test_and_set_explicit(&lock, memory_order_acquire)) { }
  guarded += v;
  atomic_flag_clear_explicit(&lock, memory_order_release);
}
__attribute__((noinline)) static u64 mix(u64 h, u64 v) { return (h ^ v) * 0x100000001B3ull + (h >> 29); }

int main(void) {
  u64 h = 0xCBF29CE484222325ull;
  for (int i = 0; i < 2000; i++) {
    h = mix(h, atomic_fetch_add(&a8, (unsigned char)(i * 7 + 1)));
    h = mix(h, atomic_fetch_sub(&a16, (unsigned short)(i * 3)));
    h = mix(h, atomic_fetch_or(&a32, 1u << (i & 31)));
    h = mix(h, atomic_fetch_and(&a32, ~(1u << ((i * 5) & 31))));
    h = mix(h, atomic_fetch_xor(&a64v, (u64)i * 0x9E3779B97F4A7C15ull));
    h = mix(h, atomic_exchange(&a16, (unsigned short)(i * 11)));
    h = mix(h, atomic_exchange(&a8, (unsigned char)i));
    unsigned e32 = (unsigned)i;
    h = mix(h, atomic_compare_exchange_strong(&a32, &e32, (unsigned)i * 3u) ? 1 : e32);
    u64 e64 = atomic_load(&a64v);
    h = mix(h, atomic_compare_exchange_strong(&a64v, &e64, e64 + (u64)i));
    unsigned char e8 = (unsigned char)(i * 13);
    h = mix(h, atomic_compare_exchange_strong(&a8, &e8, (unsigned char)(i + 1)) ? 0x100 : e8);
    unsigned short e16 = atomic_load_explicit(&a16, memory_order_acquire);
    h = mix(h, atomic_compare_exchange_strong(&a16, &e16, (unsigned short)(e16 ^ 0x5A5A)));
    h = mix(h, (u64)__atomic_fetch_max(&s64, (long)(i * 37 - 30000) * ((i & 1) ? 1 : -1), __ATOMIC_SEQ_CST));
    h = mix(h, (u64)__atomic_fetch_min(&s64, (long)(20000 - i * 41), __ATOMIC_SEQ_CST));
    h = mix(h, __atomic_fetch_max(&m8, (unsigned char)(i * 3), __ATOMIC_SEQ_CST));
    h = mix(h, __atomic_fetch_min(&m16, (unsigned short)(60000 - i * 17), __ATOMIC_SEQ_CST));
    h = mix(h, __atomic_fetch_max(&m32, (unsigned)i * 2654435761u, __ATOMIC_SEQ_CST));
    h = mix(h, __atomic_fetch_min(&m64, ~((u64)i * 0x9E3779B97F4A7C15ull), __ATOMIC_SEQ_CST));
    atomic_fetch_add(&a32, 5);                      // result unused: STADD
    atomic_fetch_or(&a64v, 0x100);                  // STSET
    atomic_fetch_and(&a16, 0xFFF0);                 // STCLR
    atomic_fetch_xor(&a8, 0x81);                    // STEOR
    __int128 ew = atomic_load(&wide);
    __int128 nw = ew * 3 + (((__int128)i) << 70) + 1;
    h = mix(h, atomic_compare_exchange_strong(&wide, &ew, nw));
    __int128 bad = nw + 1;
    h = mix(h, atomic_compare_exchange_strong(&wide, &bad, 0) ? 99 : (u64)(bad >> 64) ^ (u64)bad);
    locked_add(h & 0xFF);
    h = mix(h, atomic_load_explicit(&a32, memory_order_acquire) + atomic_load_explicit(&a64v, memory_order_acquire) + atomic_load_explicit(&a8, memory_order_acquire));
    if (i == 0) __atomic_store_n(&m16, 0xFFFF, __ATOMIC_RELEASE), __atomic_store_n(&m64, ~0ull, __ATOMIC_SEQ_CST);
  }
  put("hash "); put_hex(h);
  put("a8 "); put_hex(a8); put("a16 "); put_hex(a16); put("a32 "); put_hex(a32); put("a64 "); put_hex(a64v);
  put("s64 "); put_dec(s64); put("m "); put_hex(m8); put_hex(m16); put_hex(m32); put_hex(m64);
  put("wide "); put_hex((u64)(wide >> 64)); put_hex((u64)wide);
  put("guarded "); put_hex(guarded);
  return (int)(h & 0x7F);
}
