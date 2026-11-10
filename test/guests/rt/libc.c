// Minimal libc subset for the test guests. Written for this repo.
#include "rt.h"

typedef uint64_t __attribute__((may_alias, aligned(1))) u64u;
typedef uint32_t __attribute__((may_alias, aligned(1))) u32u;

void *memcpy(void *restrict dst, const void *restrict src, size_t n)
{
    unsigned char *d = dst;
    const unsigned char *s = src;
    while (n >= 16) {
        uint64_t a = *(const u64u *)s, b = *(const u64u *)(s + 8);
        *(u64u *)d = a;
        *(u64u *)(d + 8) = b;
        d += 16; s += 16; n -= 16;
    }
    if (n >= 8) {
        *(u64u *)d = *(const u64u *)s;
        d += 8; s += 8; n -= 8;
    }
    if (n >= 4) {
        *(u32u *)d = *(const u32u *)s;
        d += 4; s += 4; n -= 4;
    }
    while (n--) *d++ = *s++;
    return dst;
}

void *memmove(void *dst, const void *src, size_t n)
{
    unsigned char *d = dst;
    const unsigned char *s = src;
    if (d == s || n == 0) return dst;
    if (d < s || d >= s + n) {
        while (n >= 8) {
            *(u64u *)d = *(const u64u *)s;
            d += 8; s += 8; n -= 8;
        }
        while (n--) *d++ = *s++;
    } else {
        d += n; s += n;
        while (n >= 8) {
            d -= 8; s -= 8; n -= 8;
            *(u64u *)d = *(const u64u *)s;
        }
        while (n--) *--d = *--s;
    }
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    unsigned char *d = dst;
    uint64_t pat = (uint8_t)c * 0x0101010101010101ull;
    while (n >= 8) {
        *(u64u *)d = pat;
        d += 8; n -= 8;
    }
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const unsigned char *x = a, *y = b;
    for (size_t i = 0; i < n; i++) {
        if (x[i] != y[i]) return (int)x[i] - (int)y[i];
    }
    return 0;
}

size_t strlen(const char *s)
{
    size_t n = 0;
    while (s[n]) n++;
    return n;
}

_Noreturn void exit(int code)
{
    svc_exit(code);
}

// ---- output -------------------------------------------------------------

static char obuf[256];
static size_t olen;

static void oflush(void)
{
    if (olen) {
        svc_output(obuf, olen);
        olen = 0;
    }
}

static void oputc(char c)
{
    if (olen == sizeof obuf) oflush();
    obuf[olen++] = c;
}

static void opad(char c, int n)
{
    while (n-- > 0) oputc(c);
}

int putchar(int c)
{
    oputc((char)c);
    oflush();
    return c & 0xff;
}

int puts(const char *s)
{
    while (*s) oputc(*s++);
    oputc('\n');
    oflush();
    return 0;
}

// Emit `len` characters right or left justified in `width`. With zero padding
// the sign (if any, at buf[0]) stays in front of the zeros.
static void emit_field(const char *buf, int len, int width, int left, int zero, int has_sign)
{
    int pad = width - len;
    if (left) {
        for (int i = 0; i < len; i++) oputc(buf[i]);
        opad(' ', pad);
        return;
    }
    if (zero) {
        if (has_sign) { oputc(*buf++); len--; }
        opad('0', pad);
    } else {
        opad(' ', pad);
    }
    for (int i = 0; i < len; i++) oputc(buf[i]);
}

static int fmt_u64(char *out, uint64_t v, unsigned base, int upper)
{
    char tmp[24];
    int n = 0;
    const char *digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    do {
        tmp[n++] = digits[v % base];
        v /= base;
    } while (v);
    for (int i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    return n;
}

static int fmt_double(char *out, double x, int prec)
{
    static const uint64_t pow10[16] = {
        1ull, 10ull, 100ull, 1000ull, 10000ull, 100000ull, 1000000ull, 10000000ull,
        100000000ull, 1000000000ull, 10000000000ull, 100000000000ull,
        1000000000000ull, 10000000000000ull, 100000000000000ull, 1000000000000000ull};
    int n = 0;
    uint64_t bits = f64_bits(x);
    if (bits >> 63) {
        out[n++] = '-';
        x = -x;
    }
    if (x != x) {
        out[n++] = 'n'; out[n++] = 'a'; out[n++] = 'n';
        return n;
    }
    if (x > 1.7976931348623157e308) {
        out[n++] = 'i'; out[n++] = 'n'; out[n++] = 'f';
        return n;
    }
    if (x >= 1e18) {    // outside what this small printf prints exactly
        out[n++] = 'b'; out[n++] = 'i'; out[n++] = 'g';
        return n;
    }
    if (prec > 15) prec = 15;
    uint64_t ip = (uint64_t)x;
    double frac = x - (double)ip;
    uint64_t scale = pow10[prec];
    uint64_t fp = (uint64_t)(frac * (double)scale + 0.5);
    if (fp >= scale) {
        fp -= scale;
        ip++;
    }
    n += fmt_u64(out + n, ip, 10, 0);
    if (prec > 0) {
        out[n++] = '.';
        char tmp[24];
        int m = fmt_u64(tmp, fp, 10, 0);
        for (int i = m; i < prec; i++) out[n++] = '0';
        for (int i = 0; i < m; i++) out[n++] = tmp[i];
    }
    return n;
}

int vprintf(const char *fmt, va_list ap)
{
    char buf[64];
    for (; *fmt; fmt++) {
        if (*fmt != '%') {
            oputc(*fmt);
            continue;
        }
        fmt++;
        int left = 0, zero = 0, width = 0, prec = -1, lng = 0;
        for (;; fmt++) {
            if (*fmt == '-') left = 1;
            else if (*fmt == '0') zero = 1;
            else break;
        }
        while (*fmt >= '0' && *fmt <= '9') width = width * 10 + (*fmt++ - '0');
        if (*fmt == '.') {
            fmt++;
            prec = 0;
            while (*fmt >= '0' && *fmt <= '9') prec = prec * 10 + (*fmt++ - '0');
        }
        while (*fmt == 'l' || *fmt == 'z') {
            lng++;
            fmt++;
        }
        int n = 0, sign = 0;
        switch (*fmt) {
        case 'd':
        case 'i': {
            int64_t v = lng ? va_arg(ap, int64_t) : (int64_t)va_arg(ap, int);
            uint64_t u = (uint64_t)v;
            if (v < 0) {
                buf[n++] = '-';
                u = 0 - u;
                sign = 1;
            }
            n += fmt_u64(buf + n, u, 10, 0);
            break;
        }
        case 'u': {
            uint64_t v = lng ? va_arg(ap, uint64_t) : (uint64_t)va_arg(ap, unsigned);
            n = fmt_u64(buf, v, 10, 0);
            break;
        }
        case 'x':
        case 'X': {
            uint64_t v = lng ? va_arg(ap, uint64_t) : (uint64_t)va_arg(ap, unsigned);
            n = fmt_u64(buf, v, 16, *fmt == 'X');
            break;
        }
        case 'p': {
            uint64_t v = (uint64_t)va_arg(ap, void *);
            buf[n++] = '0';
            buf[n++] = 'x';
            n += fmt_u64(buf + n, v, 16, 0);
            break;
        }
        case 'c':
            buf[n++] = (char)va_arg(ap, int);
            break;
        case 's': {
            const char *s = va_arg(ap, const char *);
            if (!s) s = "(null)";
            int len = (int)strlen(s);
            if (prec >= 0 && len > prec) len = prec;
            emit_field(s, len, width, left, 0, 0);
            continue;
        }
        case 'f': {
            double v = va_arg(ap, double);
            n = fmt_double(buf, v, prec < 0 ? 6 : prec);
            sign = buf[0] == '-';
            if (buf[n - 1] > '9') zero = 0;   // nan / inf / big
            break;
        }
        case '%':
            buf[n++] = '%';
            break;
        case 0:
            oflush();
            return 0;
        default:
            buf[n++] = '%';
            buf[n++] = *fmt;
            break;
        }
        emit_field(buf, n, width, left, zero, sign);
    }
    oflush();
    return 0;
}

int printf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int r = vprintf(fmt, ap);
    va_end(ap);
    return r;
}
