// A resource-name table, the libc string work a game's loader does: build paths (strcpy/strncat), hash and intern
// them (strlen, memcmp/strcmp on collisions), look names up, split extensions (strchr/memchr), sort (strcmp), compare
// prefixes (strncmp), copy records (memcpy/memset). Prints checksums.
#include "plat.h"
#define N 12000
#define NB 4096
static const char *dirs[] = { "Model", "Effect", "Sound/Stream", "Layout/Common", "Shader", "Actor/Pack", "UI/Font", "Map/Field/Hyrule" };
static const char *exts[] = { ".bfres", ".ptcl", ".bwav", ".blarc", ".bnsh", ".sbactorpack", ".bffnt", ".smubin.zs" };
static uint32_t rng = 12345;
static uint32_t rnd(void) { rng = rng * 1103515245u + 12345u; return rng >> 8; }
struct ent { char *name; uint32_t len, hash; struct ent *next; unsigned char rec[48]; };
static uint32_t hstr(const char *s, size_t n) { uint32_t h = 2166136261u; for (size_t i = 0; i < n; i++) h = (h ^ (unsigned char)s[i]) * 16777619u; return h; }
static struct ent *find(struct ent **tab, const char *s) {
  size_t n = strlen(s); uint32_t h = hstr(s, n);
  for (struct ent *e = tab[h & (NB - 1)]; e; e = e->next) if (e->len == n && memcmp(e->name, s, n) == 0) return e;
  return 0;
}
static void msort(char **a, char **t, int n) {
  if (n < 2) return;
  int m = n / 2; msort(a, t, m); msort(a + m, t, n - m);
  int i = 0, j = m, k = 0;
  while (i < m && j < n) t[k++] = strcmp(a[i], a[j]) <= 0 ? a[i++] : a[j++];
  while (i < m) t[k++] = a[i++];
  while (j < n) t[k++] = a[j++];
  memcpy(a, t, n * sizeof *a);
}
int main(void) {
  uint64_t h = 0xCBF29CE484222325ull; uint64_t found = 0, dots = 0, pre = 0;
  for (int round = 0; round < SROUNDS; round++) {
    bench_reset(); rng = 12345 + round;
    struct ent **tab = calloc(NB, sizeof *tab);
    char **names = malloc(N * sizeof *names), **tmp = malloc(N * sizeof *tmp);
    for (int i = 0; i < N; i++) {
      char buf[160]; uint32_t r = rnd();
      strcpy(buf, "rom:/"); strncat(buf, dirs[r % 8], 64); strncat(buf, "/", 2);
      int w = 4 + (r >> 4) % 18; char part[32];
      for (int k = 0; k < w; k++) part[k] = "abcdefghijklmnopqrstuvwxyz_0123456789"[rnd() % 37];
      part[w] = 0; strncat(buf, part, 31); strncat(buf, exts[(r >> 12) % 8], 16);
      size_t n = strlen(buf);
      if (find(tab, buf)) { names[i] = names[i - 1]; continue; }
      struct ent *e = malloc(sizeof *e); e->name = malloc(n + 1); memcpy(e->name, buf, n + 1);
      e->len = n; e->hash = hstr(buf, n); memset(e->rec, (int)n, sizeof e->rec);
      e->next = tab[e->hash & (NB - 1)]; tab[e->hash & (NB - 1)] = e; names[i] = e->name;
    }
    for (int q = 0; q < 4 * N; q++) { struct ent *e = find(tab, names[rnd() % N]); if (e) { found++; h = fnv(h, e->rec, 8); } }
    for (int i = 0; i < N; i++) {
      const char *d = strchr(names[i], '.'); if (d) dots += d - names[i];
      const char *s = memchr(names[i], '/', strlen(names[i])); if (s) dots += s - names[i];
      if (strncmp(names[i], "rom:/Map/", 9) == 0) pre++;
    }
    msort(names, tmp, N);
    for (int i = 0; i < N; i += 97) h = fnv(h, (const unsigned char *)names[i], strlen(names[i]));
  }
  put("str found "); put_dec(found); put("str dots "); put_dec(dots); put("str prefix "); put_dec(pre);
  put("str fnv "); put_hex(h);
  return 0;
}
