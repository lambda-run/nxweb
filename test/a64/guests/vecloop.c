#include "mini.h"
#define N 1024
static u8 b8[N]; static short s16[N]; static int i32[N], j32[N]; static float f32[N], g32[N]; static double d64[N]; static u64 q64[N];
int main(void) {
  for (int i = 0; i < N; i++) { b8[i] = (u8)(i * 7 + 3); s16[i] = (short)(i * 37 - 9000); i32[i] = i * 2654435 - 77777; j32[i] = (i ^ 0x155) * 3; f32[i] = (float)i * 0.25f - 60.0f; g32[i] = 1.0f / (float)(i + 1); d64[i] = (double)i * 1.5 - 300.0; q64[i] = (u64)i * 0x9E3779B97F4A7C15ull; }
  u32 sb = 0; for (int i = 0; i < N; i++) sb += b8[i];
  int ss = 0; for (int i = 0; i < N; i++) ss += s16[i] * 3;
  for (int i = 0; i < N; i++) i32[i] = i32[i] * j32[i] + (i32[i] >> 3);
  u64 si = 0; for (int i = 0; i < N; i++) si += (u32)i32[i];
  int mx = -2147483647; for (int i = 0; i < N; i++) if (i32[i] > mx) mx = i32[i];
  for (int i = 0; i < N; i++) f32[i] = f32[i] * g32[i] + f32[i];
  float sf = 0; for (int i = 0; i < N; i++) sf += f32[i];
  for (int i = 0; i < N; i++) d64[i] = d64[i] * d64[i] - (double)i;
  double sd = 0; for (int i = 0; i < N; i++) sd += d64[i];
  for (int i = 0; i < N; i++) q64[i] = (q64[i] >> 7) ^ (q64[i] << 3);
  u64 sq = 0; for (int i = 0; i < N; i++) sq += q64[i];
  for (int i = 0; i < N; i++) b8[i] = b8[i] > 128 ? (u8)(b8[i] - 128) : (u8)(b8[i] + s16[i]);
  u32 sb2 = 0; for (int i = 0; i < N; i++) sb2 += b8[i];
  int cnt = 0; for (int i = 0; i < N; i++) cnt += f32[i] > 0.5f;
  put_dec(sb); put_dec(ss); put_hex(si); put_dec(mx); put_dec((i64)(sf * 16)); put_dec((i64)sd); put_hex(sq); put_dec(sb2); put_dec(cnt);
  double dd; memcpy(&dd, &sd, 8); u64 u; memcpy(&u, &dd, 8); put_hex(u);
  return 9;
}
