// Minimal freestanding runtime for the a64 translator's own test guests (contract test ABI).
typedef unsigned long u64; typedef unsigned int u32; typedef long i64; typedef unsigned char u8;
static inline long svc_out(const char *p, u64 n) {
  register u64 x0 __asm__("x0") = (u64)p; register u64 x1 __asm__("x1") = n;
  __asm__ volatile("svc #0x27" : "+r"(x0) : "r"(x1) : "memory");
  return x0;
}
static u64 slen(const char *s) { u64 n = 0; while (s[n]) n++; return n; }
static void put(const char *s) { svc_out(s, slen(s)); }
static void put_hex(u64 v) {
  char b[17]; for (int i = 0; i < 16; i++) { u32 d = (v >> (60 - 4 * i)) & 15; b[i] = d < 10 ? '0' + d : 'a' + d - 10; }
  b[16] = '\n'; svc_out(b, 17);
}
static void put_dec(i64 v) {
  char b[24]; int i = 23; u64 u = v < 0 ? -(u64)v : (u64)v; b[i--] = '\n';
  do { b[i--] = '0' + u % 10; u /= 10; } while (u);
  if (v < 0) b[i--] = '-';
  svc_out(b + i + 1, 23 - i);
}
int main(void);
__asm__(".section .text.start,\"ax\"\n.globl _start\n_start:\n bl main\n svc #0x07\n b .\n");
void *memset(void *d, int c, u64 n) { u8 *p = d; while (n--) *p++ = (u8)c; return d; }
void *memcpy(void *d, const void *s, u64 n) { u8 *p = d; const u8 *q = s; while (n--) *p++ = *q++; return d; }
