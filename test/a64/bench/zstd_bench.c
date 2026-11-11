// Decompress a set of dictionary-compressed zstd frames (the shape of a Switch RomFS of small zstd files with a shared
// dictionary) a few rounds, and print the output's checksum. zstd's single-file decoder is fetched by build.py.
#include "plat.h"
#define ZSTD_STATIC_LINKING_ONLY
#include "zstddeclib.c"
#include "zdata.h"
int main(void) {
  uint64_t h = 0xCBF29CE484222325ull, total = 0;
  for (int r = 0; r < ZROUNDS; r++) {
    bench_reset();
    ZSTD_DCtx *dc = ZSTD_createDCtx();
    ZSTD_DDict *dd = ZSTD_createDDict_byReference(zdict, sizeof zdict);
    unsigned char *dst = malloc(ZMAXOUT);
    if (!dc || !dd || !dst) { put("alloc failed\n"); return 1; }
    for (int i = 0; i < ZFILES; i++) {
      size_t n = ZSTD_decompress_usingDDict(dc, dst, ZMAXOUT, zblob + zoff[i], zlen[i], dd);
      if (ZSTD_isError(n) || n != zout[i]) { put("decompress failed at file "); put_dec(i); return 2; }
      h = fnv(h, dst, n); total += n;
    }
  }
  put("zstd bytes "); put_dec(total);
  put("zstd fnv "); put_hex(h);
  return 0;
}
