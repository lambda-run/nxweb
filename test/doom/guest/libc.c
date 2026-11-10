// The small C library of the Doom guest: exactly what the engine's objects leave undefined (found by linking them),
// written for a freestanding Switch module. Memory comes from one svcSetHeapSize block, output goes to the debug
// output a line at a time, files are nn::fs files reached through the take-over table by the SDK's mangled names:
// "rom:/..." is the RomFS (read only), every other path is a file of the save data ("save:/", flattened to one
// directory), written as a whole when it is closed and committed at once.
#include "rt.h"
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <sys/stat.h>

int errno;
u32 mutex_slow;

// ---------------------------------------------------------------------------------------------- memory and strings
void *memcpy(void *d, const void *s, size_t n) {
  u8 *a = d; const u8 *b = s;
  if ((((u64)a ^ (u64)b) & 7) == 0) {
    while (n && ((u64)a & 7)) { *a++ = *b++; n--; }
    for (; n >= 32; n -= 32, a += 32, b += 32) { u64 w0 = ((const u64 *)b)[0], w1 = ((const u64 *)b)[1], w2 = ((const u64 *)b)[2], w3 = ((const u64 *)b)[3]; ((u64 *)a)[0] = w0; ((u64 *)a)[1] = w1; ((u64 *)a)[2] = w2; ((u64 *)a)[3] = w3; }
    for (; n >= 8; n -= 8, a += 8, b += 8) *(u64 *)a = *(const u64 *)b;
  }
  while (n--) *a++ = *b++;
  return d;
}
void *memmove(void *d, const void *s, size_t n) {
  u8 *a = d; const u8 *b = s;
  if (a <= b || a >= b + n) return memcpy(d, s, n);
  while (n--) a[n] = b[n];
  return d;
}
void *memset(void *d, int c, size_t n) {
  u8 *a = d; u64 w = (u8)c * 0x0101010101010101ul;
  while (n && ((u64)a & 7)) { *a++ = (u8)c; n--; }
  for (; n >= 32; n -= 32, a += 32) { ((u64 *)a)[0] = w; ((u64 *)a)[1] = w; ((u64 *)a)[2] = w; ((u64 *)a)[3] = w; }
  for (; n >= 8; n -= 8, a += 8) *(u64 *)a = w;
  while (n--) *a++ = (u8)c;
  return d;
}
int memcmp(const void *x, const void *y, size_t n) {
  const u8 *a = x, *b = y;
  for (; n; n--, a++, b++) if (*a != *b) return *a - *b;
  return 0;
}
int bcmp(const void *x, const void *y, size_t n) { return memcmp(x, y, n); }
size_t strlen(const char *s) { const char *p = s; while (*p) p++; return (size_t)(p - s); }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return (u8)*a - (u8)*b; }
int strncmp(const char *a, const char *b, size_t n) { for (; n; n--, a++, b++) { if (*a != *b || !*a) return (u8)*a - (u8)*b; } return 0; }
int toupper(int c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }
int isspace(int c) { return c == 32 || (c >= 9 && c <= 13); }
static int lower(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }
int strcasecmp(const char *a, const char *b) { while (*a && lower((u8)*a) == lower((u8)*b)) { a++; b++; } return lower((u8)*a) - lower((u8)*b); }
int strncasecmp(const char *a, const char *b, size_t n) { for (; n; n--, a++, b++) { int x = lower((u8)*a), y = lower((u8)*b); if (x != y || !x) return x - y; } return 0; }
char *strncpy(char *d, const char *s, size_t n) { size_t i = 0; for (; i < n && s[i]; i++) d[i] = s[i]; for (; i < n; i++) d[i] = 0; return d; }
char *strchr(const char *s, int c) { for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
char *strrchr(const char *s, int c) { const char *r = 0; for (;; s++) { if (*s == (char)c) r = s; if (!*s) return (char *)r; } }
char *strstr(const char *h, const char *n) {
  size_t l = strlen(n);
  if (!l) return (char *)h;
  for (; *h; h++) if (*h == *n && !strncmp(h, n, l)) return (char *)h;
  return 0;
}
char *strdup(const char *s) { size_t n = strlen(s) + 1; char *d = malloc(n); if (d) memcpy(d, s, n); return d; }
int abs(int v) { return v < 0 ? -v : v; }
double fabs(double x) { return __builtin_fabs(x); }

// ---------------------------------------------------------------------------------------------- malloc
// One heap block from the kernel. A block has a 16-byte header: its size (a multiple of 16, bit 0 = in use) and the
// size of the block before it; free blocks are in one doubly linked list (first fit), neighbours are joined on free.
#ifndef LIBC_HEAP_MB
#define LIBC_HEAP_MB 32
#endif
typedef struct Blk { size_t size, prev; struct Blk *fnext, *fprev; } Blk;
#define HDR 16
#define BSIZE(b) ((b)->size & ~(size_t)15)
static u8 *heap_lo, *heap_hi;
static Blk free_head;
static void fl_add(Blk *b) { b->fnext = free_head.fnext; b->fprev = &free_head; if (free_head.fnext) free_head.fnext->fprev = b; free_head.fnext = b; }
static void fl_del(Blk *b) { b->fprev->fnext = b->fnext; if (b->fnext) b->fnext->fprev = b->fprev; }
static Blk *next_of(Blk *b) { u8 *n = (u8 *)b + BSIZE(b); return n < heap_hi ? (Blk *)n : 0; }
static int heap_init(void) {
  void *base = 0;
  if (svcSetHeapSize(&base, (u64)LIBC_HEAP_MB << 20) || !base) return 0;
  heap_lo = base; heap_hi = heap_lo + ((u64)LIBC_HEAP_MB << 20);
  Blk *b = (Blk *)heap_lo; b->size = (size_t)(heap_hi - heap_lo); b->prev = 0;
  fl_add(b);
  return 1;
}
void *malloc(size_t n) {
  if (!heap_lo && !heap_init()) { errno = ENOMEM; return 0; }
  size_t need = ((n + 15) & ~(size_t)15) + HDR;
  if (need < sizeof(Blk)) need = sizeof(Blk);
  for (Blk *b = free_head.fnext; b; b = b->fnext) {
    size_t sz = BSIZE(b);
    if (sz < need) continue;
    fl_del(b);
    if (sz - need >= 64) {   // split: the tail stays free
      Blk *t = (Blk *)((u8 *)b + need), *after;
      t->size = sz - need; t->prev = need;
      b->size = need;
      if ((after = next_of(t))) after->prev = t->size;
      fl_add(t);
    }
    b->size |= 1;
    return (u8 *)b + HDR;
  }
  errno = ENOMEM;
  return 0;
}
void free(void *p) {
  if (!p) return;
  Blk *b = (Blk *)((u8 *)p - HDR), *n, *after;
  b->size &= ~(size_t)1;
  if ((n = next_of(b)) && !(n->size & 1)) { fl_del(n); b->size += n->size; }
  if (b->prev) {
    Blk *q = (Blk *)((u8 *)b - b->prev);
    if (!(q->size & 1)) { fl_del(q); q->size += b->size; b = q; }
  }
  if ((after = next_of(b))) after->prev = b->size;
  fl_add(b);
}
void *calloc(size_t n, size_t size) { size_t t = n * size; void *p = malloc(t); if (p) memset(p, 0, t); return p; }
void *realloc(void *p, size_t n) {
  if (!p) return malloc(n);
  size_t have = BSIZE((Blk *)((u8 *)p - HDR)) - HDR;
  if (n <= have) return p;
  void *q = malloc(n < have * 2 ? have * 2 : n);
  if (!q) return 0;
  memcpy(q, p, have);
  free(p);
  return q;
}

// ---------------------------------------------------------------------------------------------- formatted output
typedef struct { char *s; size_t cap, n; } Out;
static void o_c(Out *o, char c) { if (o->n + 1 < o->cap) o->s[o->n] = c; o->n++; }
static void o_pad(Out *o, char c, int n) { while (n-- > 0) o_c(o, c); }
static void o_num(Out *o, u64 v, int neg, unsigned base, int upper, int width, int prec, int left, int zero) {
  char t[24]; int n = 0;
  const char *dig = upper ? "0123456789ABCDEF" : "0123456789abcdef";
  do { t[n++] = dig[v % base]; v /= base; } while (v);
  int digits = n > prec ? n : prec, total = digits + neg;
  if (!left && !(zero && prec < 0)) o_pad(o, ' ', width - total);
  if (neg) o_c(o, '-');
  if (!left && zero && prec < 0) o_pad(o, '0', width - total);
  o_pad(o, '0', digits - n);
  while (n) o_c(o, t[--n]);
  if (left) o_pad(o, ' ', width - total);
}
int vsnprintf(char *s, size_t cap, const char *f, va_list ap) {
  Out o = { s, cap, 0 };
  for (; *f; f++) {
    if (*f != '%') { o_c(&o, *f); continue; }
    int left = 0, zero = 0, width = 0, prec = -1, lng = 0;
    for (f++; *f == '-' || *f == '0' || *f == ' ' || *f == '+' || *f == '#'; f++) { if (*f == '-') left = 1; if (*f == '0') zero = 1; }
    if (*f == '*') { width = va_arg(ap, int); f++; } else while (*f >= '0' && *f <= '9') width = width * 10 + (*f++ - '0');
    if (*f == '.') { f++; prec = 0; if (*f == '*') { prec = va_arg(ap, int); f++; } else while (*f >= '0' && *f <= '9') prec = prec * 10 + (*f++ - '0'); }
    while (*f == 'l' || *f == 'z' || *f == 'h' || *f == 'j' || *f == 't') { if (*f != 'h') lng = 1; f++; }
    switch (*f) {
      case 'd': case 'i': { s64 v = lng ? va_arg(ap, s64) : va_arg(ap, int); o_num(&o, v < 0 ? 0 - (u64)v : (u64)v, v < 0, 10, 0, width, prec, left, zero); break; }
      case 'u': o_num(&o, lng ? va_arg(ap, u64) : va_arg(ap, unsigned), 0, 10, 0, width, prec, left, zero); break;
      case 'o': o_num(&o, lng ? va_arg(ap, u64) : va_arg(ap, unsigned), 0, 8, 0, width, prec, left, zero); break;
      case 'x': case 'X': o_num(&o, lng ? va_arg(ap, u64) : va_arg(ap, unsigned), 0, 16, *f == 'X', width, prec, left, zero); break;
      case 'p': o_c(&o, '0'); o_c(&o, 'x'); o_num(&o, (u64)va_arg(ap, void *), 0, 16, 0, 0, -1, 0, 0); break;
      case 'c': if (!left) o_pad(&o, ' ', width - 1); o_c(&o, (char)va_arg(ap, int)); if (left) o_pad(&o, ' ', width - 1); break;
      case 's': {
        const char *v = va_arg(ap, const char *); if (!v) v = "(null)";
        int n = 0; while (v[n] && (prec < 0 || n < prec)) n++;
        if (!left) o_pad(&o, ' ', width - n);
        for (int i = 0; i < n; i++) o_c(&o, v[i]);
        if (left) o_pad(&o, ' ', width - n);
        break;
      }
      case 'f': {   // fixed notation, rounded at the last digit
        double v = va_arg(ap, double); int neg = v < 0; if (neg) v = -v;
        if (prec < 0) prec = 6;
        double r = 0.5; for (int i = 0; i < prec; i++) r /= 10;
        v += r;
        u64 ip = (u64)v; double fr = v - (double)ip;
        o_num(&o, ip, neg, 10, 0, width - (prec ? prec + 1 : 0), -1, 0, zero);
        if (prec) o_c(&o, '.');
        for (int i = 0; i < prec; i++) { fr *= 10; int d = (int)fr; o_c(&o, (char)('0' + d)); fr -= d; }
        break;
      }
      case '%': o_c(&o, '%'); break;
      case 0: f--; break;
      default: o_c(&o, '%'); o_c(&o, *f);
    }
  }
  if (cap) s[o.n < cap ? o.n : cap - 1] = 0;
  return (int)o.n;
}
int snprintf(char *s, size_t n, const char *f, ...) { va_list ap; va_start(ap, f); int r = vsnprintf(s, n, f, ap); va_end(ap); return r; }

// ---------------------------------------------------------------------------------------------- formatted input
// What the engine's configuration reader asks for: white space, literal characters, %d %i %x %o (into an int)
int sscanf(const char *s, const char *f, ...) {
  va_list ap; int got = 0;
  va_start(ap, f);
  for (; *f; f++) {
    if (*f == ' ') { while (*s == ' ' || (*s >= 9 && *s <= 13)) s++; continue; }
    if (*f != '%') { if (*s != *f) break; s++; continue; }
    char conv = *++f; unsigned base = conv == 'x' ? 16 : conv == 'o' ? 8 : 10; int neg = 0, any = 0; unsigned v = 0;
    if (conv != 'd' && conv != 'i' && conv != 'x' && conv != 'o') break;
    while (*s == ' ' || (*s >= 9 && *s <= 13)) s++;
    if (*s == '-' || *s == '+') neg = *s++ == '-';
    if ((conv == 'i' || conv == 'x') && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) { s += 2; base = 16; }
    else if (conv == 'i' && s[0] == '0') base = 8;
    for (;; s++) {
      int c = toupper((u8)*s), d = c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 99;
      if (d >= (int)base) break;
      v = v * base + (unsigned)d; any = 1;
    }
    if (!any) break;
    *va_arg(ap, int *) = neg ? -(int)v : (int)v;
    got++;
  }
  va_end(ap);
  return got;
}
int atoi(const char *s) { int v = 0; sscanf(s, "%d", &v); return v; }
double atof(const char *s) {
  double v = 0, scale = 1; int neg = 0;
  while (*s == ' ') s++;
  if (*s == '-' || *s == '+') neg = *s++ == '-';
  for (; *s >= '0' && *s <= '9'; s++) v = v * 10 + (*s - '0');
  if (*s == '.') for (s++; *s >= '0' && *s <= '9'; s++) { scale /= 10; v += (*s - '0') * scale; }
  return neg ? -v : v;
}

// ---------------------------------------------------------------------------------------------- files
typedef struct { u64 h; } FileHandle;
typedef struct { u64 id[2]; } Uid;
typedef struct { int flags; } WriteOption;
IMPORT Result fs_QueryMountRomCacheSize(u64 *out) __asm__("_ZN2nn2fs22QueryMountRomCacheSizeEPm");
IMPORT Result fs_MountRom(const char *name, void *cache, u64 size) __asm__("_ZN2nn2fs8MountRomEPKcPvm");
IMPORT Result fs_EnsureSaveData(const Uid *u) __asm__("_ZN2nn2fs14EnsureSaveDataERKNS_7account3UidE");
IMPORT Result fs_MountSaveData(const char *name, const Uid *u) __asm__("_ZN2nn2fs13MountSaveDataEPKcRKNS_7account3UidE");
IMPORT Result fs_OpenFile(FileHandle *out, const char *path, int mode) __asm__("_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKci");
IMPORT Result fs_ReadFile(u64 *got, FileHandle h, s64 off, void *buf, u64 n) __asm__("_ZN2nn2fs8ReadFileEPmNS0_10FileHandleElPvm");
IMPORT Result fs_WriteFile(FileHandle h, s64 off, const void *buf, u64 n, const WriteOption *o) __asm__("_ZN2nn2fs9WriteFileENS0_10FileHandleElPKvmRKNS0_11WriteOptionE");
IMPORT Result fs_GetFileSize(s64 *out, FileHandle h) __asm__("_ZN2nn2fs11GetFileSizeEPlNS0_10FileHandleE");
IMPORT void fs_CloseFile(FileHandle h) __asm__("_ZN2nn2fs9CloseFileENS0_10FileHandleE");
IMPORT Result fs_CreateFile(const char *path, s64 size) __asm__("_ZN2nn2fs10CreateFileEPKcl");
IMPORT Result fs_DeleteFile(const char *path) __asm__("_ZN2nn2fs10DeleteFileEPKc");
IMPORT Result fs_RenameFile(const char *from, const char *to) __asm__("_ZN2nn2fs10RenameFileEPKcS2_");
IMPORT Result fs_Commit(const char *name) __asm__("_ZN2nn2fs6CommitEPKc");

// A file open for reading keeps a window of RBUF bytes for small reads (the engine reads a saved game a byte at a
// time; every nn::fs call is a trip to the host); a file open for writing is a buffer until it is closed.
#define RBUF 4096
struct FILE_ { int console, writing, eof; FileHandle h; s64 pos, size, win; size_t win_n; u8 *buf; size_t cap; char path[96]; };
static FILE std_out = { 1 }, std_err = { 1 };
FILE *stdout = &std_out, *stderr = &std_err;

// The console: bytes are gathered into lines; a line is one svcOutputDebugString
static char con[240]; static u32 con_n;
static void con_flush(void) { if (con_n) svcOutputDebugString(con, con_n); con_n = 0; }
static void con_write(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) { con[con_n++] = s[i]; if (s[i] == '\n' || con_n == sizeof con) con_flush(); }
}
int vfprintf(FILE *f, const char *fmt, va_list ap) {
  char t[1024];
  int n = vsnprintf(t, sizeof t, fmt, ap), m = n < (int)sizeof t ? n : (int)sizeof t - 1;
  fwrite(t, 1, (size_t)m, f);
  return n;
}
int fprintf(FILE *f, const char *fmt, ...) { va_list ap; va_start(ap, fmt); int r = vfprintf(f, fmt, ap); va_end(ap); return r; }
int printf(const char *fmt, ...) { va_list ap; va_start(ap, fmt); int r = vfprintf(stdout, fmt, ap); va_end(ap); return r; }
int puts(const char *s) { con_write(s, strlen(s)); con_write("\n", 1); return 0; }
int putchar(int c) { char ch = (char)c; con_write(&ch, 1); return c; }
int fflush(FILE *f) { return 0; }

// Mounts: the RomFS when the embedder gave one, and the save data; made at the first file call
static int fs_up, rom_ok, save_ok;
static void fs_start(void) {
  if (fs_up) return;
  fs_up = 1;
  u64 n = 0; static const Uid uid = { { 0x444f4f4d, 1 } };
  fs_QueryMountRomCacheSize(&n);
  rom_ok = fs_MountRom("rom", malloc(n ? n : 16), n) == 0;
  save_ok = fs_EnsureSaveData(&uid) == 0 && fs_MountSaveData("save", &uid) == 0;
}
// "rom:/x" stays; anything else is save:/ with the directories folded into the name ("./.savegame/a" -> "save:/.savegame_a")
static int fs_path(char *out, size_t cap, const char *path) {
  fs_start();
  if (!strncmp(path, "rom:/", 5)) { if (!rom_ok || strlen(path) >= cap) return 0; memcpy(out, path, strlen(path) + 1); return 1; }
  if (!save_ok) return 0;
  while (path[0] == '.' && path[1] == '/') path += 2;
  size_t n = 6;
  memcpy(out, "save:/", 6);
  for (; *path && n + 1 < cap; path++) out[n++] = *path == '/' || *path == '\\' || *path == ':' ? '_' : *path;
  out[n] = 0;
  return !*path && n > 6;
}
FILE *fopen(const char *path, const char *mode) {
  char full[96];
  if (!fs_path(full, sizeof full, path)) { errno = ENOENT; return 0; }
  FILE *f = calloc(1, sizeof *f);
  if (!f) return 0;
  memcpy(f->path, full, sizeof full);
  if (mode[0] == 'w' && strncmp(full, "rom:/", 5)) { f->writing = 1; return f; }
  if (mode[0] != 'r' || fs_OpenFile(&f->h, full, 1) || fs_GetFileSize(&f->size, f->h)) { free(f); errno = mode[0] == 'r' ? ENOENT : EACCES; return 0; }
  return f;
}
size_t fread(void *p, size_t size, size_t n, FILE *f) {
  u64 got = 0, want = size * n;
  if (f->console || f->writing || !want) return 0;
  if (f->pos + (s64)want > f->size) want = f->pos < f->size ? (u64)(f->size - f->pos) : 0;
  if (want >= RBUF) { if (fs_ReadFile(&got, f->h, f->pos, p, want)) got = 0; }
  else if (want) {
    if (f->pos < f->win || f->pos + (s64)want > f->win + (s64)f->win_n) {   // move the window to the read position
      u64 n = 0, fill = (u64)(f->size - f->pos) < RBUF ? (u64)(f->size - f->pos) : RBUF;
      if (!f->buf) f->buf = malloc(RBUF);
      if (!f->buf || fs_ReadFile(&n, f->h, f->pos, f->buf, fill)) n = 0;
      f->win = f->pos; f->win_n = n;
      if (want > n) want = n;
    }
    memcpy(p, f->buf + (f->pos - f->win), want);
    got = want;
  }
  f->pos += (s64)got;
  if (got < size * n) f->eof = 1;
  return got / size;
}
size_t fwrite(const void *p, size_t size, size_t n, FILE *f) {
  size_t bytes = size * n;
  if (f->console) { con_write(p, bytes); return n; }
  if (!f->writing || !size) return 0;
  if ((size_t)f->pos + bytes > f->cap) {
    size_t cap = ((size_t)f->pos + bytes) * 2 + 4096; u8 *b = realloc(f->buf, cap);
    if (!b) return 0;
    f->buf = b; f->cap = cap;
  }
  memcpy(f->buf + f->pos, p, bytes);
  f->pos += (s64)bytes;
  if (f->pos > f->size) f->size = f->pos;
  return n;
}
int fseek(FILE *f, long off, int whence) {
  s64 to = whence == SEEK_SET ? off : whence == SEEK_CUR ? f->pos + off : f->size + off;
  if (f->console || to < 0 || (f->writing && to > f->size)) return -1;
  f->pos = to; f->eof = 0;
  return 0;
}
long ftell(FILE *f) { return f->console ? -1 : f->pos; }
int fclose(FILE *f) {
  int rc = 0;
  if (f->console) return 0;
  if (f->writing) {   // the whole file replaces what was there, and the save data is committed
    static const WriteOption flush = { 1 };
    fs_DeleteFile(f->path);
    rc = fs_CreateFile(f->path, f->size) || fs_OpenFile(&f->h, f->path, 2) ? EOF : 0;
    if (!rc) { if (f->size && fs_WriteFile(f->h, 0, f->buf, (u64)f->size, &flush)) rc = EOF; fs_CloseFile(f->h); }
    if (fs_Commit("save")) rc = EOF;
    free(f->buf);
  } else { fs_CloseFile(f->h); free(f->buf); }
  free(f);
  return rc;
}
int remove(const char *path) {
  char full[96];
  if (!fs_path(full, sizeof full, path) || !strncmp(full, "rom:/", 5) || fs_DeleteFile(full)) { errno = ENOENT; return -1; }
  fs_Commit("save");
  return 0;
}
int rename(const char *from, const char *to) {
  char a[96], b[96];
  if (!fs_path(a, sizeof a, from) || !fs_path(b, sizeof b, to) || !strncmp(a, "rom:/", 5) || !strncmp(b, "rom:/", 5) || fs_RenameFile(a, b)) { errno = ENOENT; return -1; }
  fs_Commit("save");
  return 0;
}
int mkdir(const char *path, mode_t mode) { return 0; }   // directories are folded into the file names
int system(const char *cmd) { return -1; }               // there is no command processor

void exit(int code) { con_flush(); svcExitProcess(code); }
