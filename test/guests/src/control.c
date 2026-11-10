// Control flow: recursion, jump tables, indirect and tail calls, deep call
// chains, variadic calls, setjmp/longjmp.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static volatile int vzero;

// ---- recursion ------------------------------------------------------------

static NOINLINE unsigned fib(unsigned n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

static unsigned ack_calls;
static NOINLINE unsigned ack(unsigned m, unsigned n)
{
    ack_calls++;
    if (m == 0) return n + 1;
    if (n == 0) return ack(m - 1, 1);
    return ack(m - 1, ack(m, n - 1));
}

static NOINLINE uint64_t gcd(uint64_t a, uint64_t b) { return b ? gcd(b, a % b) : a; }

static NOINLINE void hanoi(int n, int from, int to, int via, uint64_t *h, unsigned *moves)
{
    if (n == 0) return;
    hanoi(n - 1, from, via, to, h, moves);
    *h = mix64(*h, (uint64_t)(n << 8 | from << 4 | to));
    ++*moves;
    hanoi(n - 1, via, to, from, h, moves);
}

// Deep, non-tail recursion with a real frame.
static NOINLINE uint64_t deep(unsigned n, uint64_t acc)
{
    volatile uint64_t local[3];
    local[0] = acc + n;
    local[1] = acc ^ n;
    local[2] = n;
    if (n == 0) return acc;
    uint64_t r = deep(n - 1, mix64(acc, n));
    return r + local[0] - local[1] + local[2];
}

// ---- tail calls (mutual recursion; a real tail call at -O2/-Os) ------------

static NOINLINE int is_odd(unsigned n);
static NOINLINE int is_even(unsigned n) { return n == 0 ? 1 : is_odd(n - 1); }
static NOINLINE int is_odd(unsigned n) { return n == 0 ? 0 : is_even(n - 1); }

static NOINLINE uint64_t tail_sum(uint64_t n, uint64_t acc) { return n == 0 ? acc : tail_sum(n - 1, acc + n * n); }

// ---- switch statements ----------------------------------------------------

static NOINLINE int dense_switch(int x)
{
    switch (x) {
    case 0: return 17;
    case 1: return x * 3 + 1;
    case 2: return 99;
    case 3: return -4;
    case 4: return x << 5;
    case 5: return 1234;
    case 6: return x ^ 0x55;
    case 7: return 7;
    case 8: return -88;
    case 9: return 900 + x;
    case 10: return 10101;
    case 11: return x * x;
    case 12: return 0;
    case 13: return 1313;
    case 14: return -x;
    case 15: return 15000;
    case 16: return 61;
    case 17: return x + 71;
    case 18: return 0x1818;
    case 19: return 91;
    case 20: return 2;
    case 21: return 12 - x;
    case 22: return 2222;
    case 23: return 32;
    case 24: return x / 5;
    case 25: return 5225;
    case 26: return x % 7;
    case 27: return 72;
    case 28: return -2828;
    case 29: return 92;
    case 30: return 3;
    case 31: return 13 * x;
    default: return -1;
    }
}

static NOINLINE int sparse_switch(int x)
{
    switch (x) {
    case -1000: return 1;
    case -7: return 2;
    case 0: return 3;
    case 3: return 4;
    case 64: return 5;
    case 100: return 6;
    case 1000: return 7;
    case 4096: return 8;
    case 65536: return 9;
    case 1000000: return 10;
    case 0x7fffffff: return 11;
    default: return 0;
    }
}

// Switch with fallthrough and a shared tail, driven as a small state machine.
static NOINLINE uint64_t state_machine(uint64_t seed, int steps)
{
    int state = 0;
    uint64_t acc = seed;
    while (steps-- > 0) {
        switch (state) {
        case 0: acc += 3; state = (acc & 1) ? 3 : 1; break;
        case 1: acc ^= acc << 7; state = 2;
            /* fallthrough */
        case 2: acc += 0x9e37; state = (acc & 6) ? 4 : 5; break;
        case 3: acc = acc * 5 + 1; state = 6; break;
        case 4: acc ^= acc >> 11; state = (int)(acc % 7); break;
        case 5: acc -= 12345; state = 0; break;
        case 6: acc = (acc << 3) | (acc >> 61); state = (acc & 16) ? 1 : 4; break;
        default: state = 0; break;
        }
    }
    return acc ^ (uint64_t)state;
}

// ---- indirect calls -------------------------------------------------------

typedef int64_t (*binop)(int64_t, int64_t);
static NOINLINE int64_t op_add(int64_t a, int64_t b) { return a + b; }
static NOINLINE int64_t op_sub(int64_t a, int64_t b) { return a - b; }
static NOINLINE int64_t op_mul(int64_t a, int64_t b) { return a * b; }
static NOINLINE int64_t op_xor(int64_t a, int64_t b) { return a ^ b; }
static NOINLINE int64_t op_min(int64_t a, int64_t b) { return a < b ? a : b; }
static NOINLINE int64_t op_shl(int64_t a, int64_t b) { return (int64_t)((uint64_t)a << (b & 15)); }
static binop volatile ops[] = {op_add, op_sub, op_mul, op_xor, op_min, op_shl};

struct shape {
    const char *name;
    int64_t (*area)(const struct shape *);
    int64_t (*scale)(struct shape *, int64_t);
    int64_t w, h;
};
static int64_t rect_area(const struct shape *s) { return s->w * s->h; }
static int64_t tri_area(const struct shape *s) { return s->w * s->h / 2; }
static int64_t sq_area(const struct shape *s) { return s->w * s->w; }
static int64_t scale_both(struct shape *s, int64_t k) { s->w *= k; s->h *= k; return s->w + s->h; }
static int64_t scale_w(struct shape *s, int64_t k) { s->w *= k; return s->w; }

static NOINLINE int64_t apply_n(binop f, int64_t x, int n)
{
    for (int i = 1; i <= n; i++) x = f(x, i);
    return x;
}

// A function returning a function pointer, called through a pointer.
typedef binop (*chooser)(int);
static NOINLINE binop choose(int i) { return ops[(unsigned)i % 6]; }

// ---- variadic -------------------------------------------------------------

static NOINLINE int64_t vsum(int n, ...)
{
    va_list ap;
    va_start(ap, n);
    int64_t s = 0;
    for (int i = 0; i < n; i++) s += (i & 1) ? va_arg(ap, int64_t) : (int64_t)va_arg(ap, int);
    va_end(ap);
    return s;
}

static NOINLINE double vmixed(const char *kinds, ...)
{
    va_list ap;
    va_start(ap, kinds);
    double s = 0;
    for (; *kinds; kinds++) {
        if (*kinds == 'd') s += va_arg(ap, double);
        else if (*kinds == 'i') s += va_arg(ap, int);
        else s += (double)va_arg(ap, int64_t);
    }
    va_end(ap);
    return s;
}

// Many arguments: the 9th and later go on the stack.
static NOINLINE int64_t many_args(int64_t a, int64_t b, int64_t c, int64_t d, int64_t e, int64_t f,
                                  int64_t g, int64_t h, int64_t i, int8_t j, int64_t k, int16_t l)
{
    return a - b * 2 + c * 3 - d * 4 + e * 5 - f * 6 + g * 7 - h * 8 + i * 9 - j * 10 + k * 11 - l * 12;
}

// ---- setjmp / longjmp -----------------------------------------------------

static jmp_buf jb, jb2;

static NOINLINE void thrower(int depth, int code)
{
    volatile char pad[40];
    pad[0] = (char)depth;
    if (depth == 0) longjmp(jb, code);
    thrower(depth - 1, code);
    printf("[unreachable] thrower %d %d\n", depth, pad[0]);
}

static NOINLINE int try_depth(int depth, int code)
{
    volatile int before = depth * 100;
    int r = setjmp(jb);
    if (r == 0) {
        before += 1;
        thrower(depth, code);
        return -1;
    }
    return r * 1000 + before;
}

// Callee-saved registers (integer and FP) must be restored by longjmp.
static NOINLINE uint64_t callee_saved_check(uint64_t seed)
{
    uint64_t a = seed + 1, b = seed * 3, c = seed ^ 0x55, d = seed << 7, e = seed + 99;
    double x = (double)seed * 1.5, y = (double)seed - 0.25;
    if (setjmp(jb2) == 0) {
        // Clobber as many registers as possible, then jump back.
        volatile uint64_t junk[12];
        for (int i = 0; i < 12; i++) junk[i] = (uint64_t)i * 0x1111111111111111ull;
        uint64_t s = 0;
        for (int i = 0; i < 12; i++) s += junk[i] * (uint64_t)(i + 1);
        if (s != 0 || vzero == 0) longjmp(jb2, 5);
    }
    return mix64(mix64(mix64(a, b), mix64(c, d)), e) ^ f64_bits(x) ^ (f64_bits(y) << 1);
}

int main(void)
{
    puts("== recursion ==");
    for (unsigned n = 0; n <= 20; n += 5) printf("fib(%u)=%u\n", n, fib(n));
    printf("fib(22)=%u\n", fib(22));
    for (unsigned m = 0; m <= 2; m++) {
        ack_calls = 0;
        unsigned r = ack(m, 3);
        printf("ack(%u,3)=%u calls=%u\n", m, r, ack_calls);
    }
    ack_calls = 0;
    printf("ack(3,3)=%u", ack(3, 3));
    printf(" calls=%u\n", ack_calls);
    printf("gcd=%lu %lu %lu\n", gcd(1071, 462), gcd(0xfffffffffffffffful, 0x100000001ul),
           gcd(12345678901234567ul, 987654321987ul));
    {
        uint64_t h = 0;
        unsigned moves = 0;
        hanoi(10, 0, 2, 1, &h, &moves);
        printf("hanoi(10) moves=%u hash=%016lx\n", moves, h);
    }
    printf("deep(3000)=%016lx\n", deep(3000, 7));

    puts("== tail calls ==");
    printf("is_even(1000)=%d is_even(777)=%d is_odd(2001)=%d\n", is_even(1000), is_even(777), is_odd(2001));
    printf("tail_sum(5000)=%lu\n", tail_sum(5000, 0));

    puts("== switches ==");
    {
        int64_t s = 0;
        for (int i = -3; i < 40; i++) {
            int v = dense_switch(i + vzero);
            s = s * 31 + v;
            if (i % 6 == 0) printf("dense(%d)=%d\n", i, v);
        }
        printf("dense sum=%ld\n", s);
        static const int probes[] = {-1000, -999, -7, 0, 1, 3, 64, 65, 100, 1000, 4096, 65536,
                                     65537, 1000000, 0x7fffffff, -0x7fffffff - 1};
        printf("sparse:");
        for (unsigned i = 0; i < sizeof probes / sizeof probes[0]; i++) printf(" %d", sparse_switch(probes[i] + vzero));
        printf("\n");
        for (uint64_t seed = 1; seed <= 3; seed++)
            printf("state_machine(%lu)=%016lx\n", seed, state_machine(seed, 5000));
    }

    puts("== indirect calls ==");
    {
        int64_t acc = 1;
        for (int i = 0; i < 600; i++) acc = ops[i % 6](acc, i + 1) + ops[(i * 5 + 1) % 6](i, acc);
        printf("ops chain=%ld\n", acc);
        for (int i = 0; i < 6; i++) printf("apply_n(op%d)=%ld\n", i, apply_n(ops[i], 3, 12));
        volatile chooser ch = choose;
        int64_t r = 0;
        for (int i = 0; i < 12; i++) r += ch(i)(r + 2, i + 3);
        printf("chooser=%ld\n", r);
        struct shape shapes[] = {
            {"rect", rect_area, scale_both, 3, 4},
            {"tri", tri_area, scale_w, 6, 5},
            {"square", sq_area, scale_both, 7, 0},
        };
        for (int round = 0; round < 3; round++)
            for (int i = 0; i < 3; i++) {
                struct shape *s = &shapes[(i + vzero) % 3];
                int64_t a = s->area(s);
                int64_t k = s->scale(s, round + 2);
                printf("%s area=%ld scaled=%ld\n", s->name, a, k);
            }
    }

    puts("== argument passing ==");
    printf("vsum=%ld\n", vsum(9, 1, 20000000000L, -3, 4L, 5, -60000000000L, 7, 8L, 9));
    printf("vmixed=%.3f\n", vmixed("didldiddddddl", 1.5, 2, 2.25, 30000000000L, -0.125, 7, 1.0, 2.0, 3.0,
                                   4.0, 5.0, 6.0, -5L));
    printf("many_args=%ld\n", many_args(1, 2, 3, 4, 5, 6, 7, 8, 9, (int8_t)(-10 + vzero), 11, (int16_t)(-12 + vzero)));

    puts("== setjmp/longjmp ==");
    printf("direct: ");
    {
        volatile int count = 0;
        int r = setjmp(jb);
        printf("r=%d ", r);
        if (count < 3) {
            count = count + 1;
            longjmp(jb, count * 10);
        }
        printf("\n");
    }
    for (int d = 0; d <= 24; d += 6) printf("across %d frames: %d\n", d, try_depth(d, d + 1));
    printf("longjmp(buf,0) gives %d\n", try_depth(3, 0));
    {
        uint64_t h = 0;
        for (int i = 0; i < 200; i++) h = mix64(h, (uint64_t)try_depth(i % 9, i + 1));
        printf("200 jumps hash=%016lx\n", h);
    }
    printf("callee-saved=%016lx\n", callee_saved_check(0x1234567));
    return 0;
}
