// Atomics and exclusive access. On cortex-a57 (no LSE) every atomic
// read-modify-write is an ldxr/stxr (or ldaxr/stlxr) loop. Single threaded,
// so every exclusive store must succeed unless the monitor was cleared.
#include <stdatomic.h>
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static uint8_t g8;
static uint16_t g16;
static uint32_t g32;
static uint64_t g64;
static _Atomic uint32_t a32;
static _Atomic uint64_t a64;
static _Atomic int64_t counter;
static atomic_flag flag = ATOMIC_FLAG_INIT;
static _Atomic(void *) aptr;

struct spinlock { _Atomic uint32_t locked; uint32_t acquisitions, contended; };
static struct spinlock lock;

static NOINLINE int spin_trylock(struct spinlock *l)
{
    uint32_t expected = 0;
    return atomic_compare_exchange_strong_explicit(&l->locked, &expected, 1, memory_order_acquire,
                                                   memory_order_relaxed);
}
static NOINLINE void spin_lock(struct spinlock *l)
{
    while (!spin_trylock(l)) l->contended++;
    l->acquisitions++;
}
static NOINLINE void spin_unlock(struct spinlock *l) { atomic_store_explicit(&l->locked, 0, memory_order_release); }

// Lock-free stack (Treiber) pushed and popped from one thread.
struct lnode { struct lnode *next; uint64_t v; };
static _Atomic(struct lnode *) top;
static struct lnode nodes[64];

static NOINLINE void push(struct lnode *n)
{
    struct lnode *old = atomic_load(&top);
    do {
        n->next = old;
    } while (!atomic_compare_exchange_weak(&top, &old, n));
}
static NOINLINE struct lnode *pop(void)
{
    struct lnode *old = atomic_load(&top);
    while (old && !atomic_compare_exchange_weak(&top, &old, old->next)) {
    }
    return old;
}

// Atomic maximum through a compare-exchange loop.
static NOINLINE void atomic_max(_Atomic uint64_t *p, uint64_t v)
{
    uint64_t cur = atomic_load_explicit(p, memory_order_relaxed);
    while (cur < v && !atomic_compare_exchange_weak_explicit(p, &cur, v, memory_order_seq_cst, memory_order_relaxed)) {
    }
}

// Raw exclusive instructions, including the cases where the store must fail.
static NOINLINE void raw_exclusives(void)
{
    static uint64_t cell[4] = {0x1111111111111111ull, 0x2222222222222222ull, 0x3333333333333333ull, 0x4444444444444444ull};
    uint64_t v, st1, st2, st3, st4, lo, hi, st5, b, st6, st7;
    __asm__ volatile(
        // plain success
        "ldxr %[v], [%[p]]\n add x9, %[v], #1\n stxr %w[st1], x9, [%[p]]\n"
        // a second store without a new load must fail and must not write
        "mov x9, #-1\n stxr %w[st2], x9, [%[p]]\n"
        // clrex between load and store: must fail
        "ldxr x9, [%[p]]\n clrex\n mov x9, #-1\n stxr %w[st3], x9, [%[p]]\n"
        // acquire/release forms
        "ldaxr x9, [%[p], #0]\n add x9, x9, #0x100\n stlxr %w[st4], x9, [%[p]]\n"
        // pair
        "add x10, %[p], #16\n ldxp %[lo], %[hi], [x10]\n add x9, %[lo], %[hi]\n stxp %w[st5], %[hi], x9, [x10]\n"
        // byte, halfword and word
        "add x10, %[p], #8\n ldxrb %w[b], [x10]\n add w9, %w[b], #0x7f\n stxrb %w[st6], w9, [x10]\n"
        "ldxrh w9, [x10, #0]\n eor w9, w9, #0xff00\n stxrh %w[st7], w9, [x10]\n"
        "add x10, x10, #4\n ldaxr w9, [x10]\n add w9, w9, w9\n stlxr w11, w9, [x10]\n"
        "add %w[st7], %w[st7], w11, lsl #4\n"
        // load-acquire / store-release without exclusivity
        "ldar x9, [%[p]]\n add x9, x9, #2\n stlr x9, [%[p]]\n"
        "ldarb w9, [%[p], #0]\n stlrb w9, [%[p]]\n ldarh w9, [%[p]]\n stlrh w9, [%[p]]\n"
        : [v] "=&r"(v), [st1] "=&r"(st1), [st2] "=&r"(st2), [st3] "=&r"(st3), [st4] "=&r"(st4), [lo] "=&r"(lo),
          [hi] "=&r"(hi), [st5] "=&r"(st5), [b] "=&r"(b), [st6] "=&r"(st6), [st7] "=&r"(st7)
        : [p] "r"(cell)
        : "cc", "memory", "x9", "x10", "x11");
    printf("ldxr %lx stxr %lu  stxr-without-ldxr %lu  after-clrex %lu  stlxr %lu\n", v, st1, st2, st3, st4);
    printf("ldxp %lx %lx stxp %lu  ldxrb %lx stxrb %lu  stxrh/stlxr %lu\n", lo, hi, st5, b, st6, st7);
    printf("cells %016lx %016lx %016lx %016lx\n", cell[0], cell[1], cell[2], cell[3]);
}

int main(void)
{
    uint64_t seed = 0x5eed;

    puts("== __atomic builtins, every width ==");
    {
        uint64_t h = 0;
        for (int i = 0; i < 200; i++) {
            uint64_t r = rng_next(&seed);
            h = mix64(h, __atomic_fetch_add(&g8, (uint8_t)r, __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_fetch_sub(&g16, (uint16_t)(r >> 8), __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_fetch_xor(&g32, (uint32_t)(r >> 16), __ATOMIC_RELAXED));
            h = mix64(h, __atomic_fetch_or(&g64, r & 0x0101010101010101ull, __ATOMIC_ACQ_REL));
            h = mix64(h, __atomic_fetch_and(&g64, ~(r >> 3 & 0x1010), __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_add_fetch(&g64, r >> 40, __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_sub_fetch(&g32, 3, __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_fetch_nand(&g16, (uint16_t)r, __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_exchange_n(&g8, (uint8_t)(r >> 50), __ATOMIC_SEQ_CST));
            h = mix64(h, __atomic_exchange_n(&g64, g64 ^ r, __ATOMIC_ACQUIRE));
            uint32_t exp32 = (i & 1) ? g32 : g32 + 1;       // succeeds on odd rounds only
            int ok = __atomic_compare_exchange_n(&g32, &exp32, (uint32_t)r, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
            h = mix64(h, (uint64_t)ok << 32 | exp32);
            uint8_t exp8 = (uint8_t)(g8 + (i % 3 == 0));
            ok = __atomic_compare_exchange_n(&g8, &exp8, (uint8_t)i, 1, __ATOMIC_RELEASE, __ATOMIC_RELAXED);
            h = mix64(h, (uint64_t)ok << 8 | exp8);
            uint16_t exp16 = g16;
            ok = __atomic_compare_exchange_n(&g16, &exp16, (uint16_t)(r >> 21), 0, __ATOMIC_SEQ_CST, __ATOMIC_RELAXED);
            h = mix64(h, (uint64_t)ok << 16 | exp16);
        }
        printf("hash %016lx g8=%x g16=%x g32=%x g64=%lx\n", h, __atomic_load_n(&g8, __ATOMIC_SEQ_CST),
               __atomic_load_n(&g16, __ATOMIC_ACQUIRE), __atomic_load_n(&g32, __ATOMIC_RELAXED),
               __atomic_load_n(&g64, __ATOMIC_SEQ_CST));
    }

    puts("== stdatomic ==");
    {
        atomic_store(&a32, 5);
        atomic_init(&a64, 1);
        for (int i = 0; i < 300; i++) {
            atomic_fetch_add(&counter, i);
            atomic_fetch_sub_explicit(&counter, 1, memory_order_relaxed);
            a32 += 3;       // seq_cst read-modify-write
            a32 ^= (uint32_t)i << 4;
            a64 *= 3;       // compare-exchange loop generated by the compiler
            a64 |= 1;
            counter++;
            --counter;
            atomic_max(&a64, (uint64_t)i * 0x100000001ull);
        }
        printf("counter=%ld a32=%x a64=%lx\n", atomic_load(&counter), atomic_load(&a32), atomic_load(&a64));
        uint64_t expected = 0;
        int n_fail = 0;
        for (int i = 0; i < 10; i++) {
            if (!atomic_compare_exchange_strong(&a64, &expected, expected + 10)) n_fail++;
        }
        printf("cas loop: fails=%d a64=%lx expected=%lx\n", n_fail, atomic_load(&a64), expected);
        int x = 0;
        void *old = atomic_exchange(&aptr, &x);
        void *exp = &x;
        int ok = atomic_compare_exchange_strong(&aptr, &exp, (void *)0);
        printf("pointer: old=%d ok=%d now-null=%d\n", old != 0, ok, atomic_load(&aptr) == 0);
        printf("flag: %d %d", atomic_flag_test_and_set(&flag), atomic_flag_test_and_set(&flag));
        atomic_flag_clear(&flag);
        printf(" %d\n", atomic_flag_test_and_set_explicit(&flag, memory_order_acquire));
    }

    puts("== spinlock ==");
    {
        uint64_t shared = 0;
        for (int i = 0; i < 500; i++) {
            spin_lock(&lock);
            int nested = spin_trylock(&lock);   // already held: must fail
            shared = shared * 31 + (uint64_t)i + (uint64_t)nested;
            spin_unlock(&lock);
        }
        printf("shared=%lx acquisitions=%u contended=%u locked=%u\n", shared, lock.acquisitions, lock.contended,
               atomic_load(&lock.locked));
    }

    puts("== lock-free stack ==");
    {
        uint64_t h = 0;
        int pops = 0;
        for (int round = 0; round < 20; round++) {
            for (int i = 0; i < 64; i++) {
                nodes[i].v = (uint64_t)(round * 100 + i);
                push(&nodes[i]);
                if (i % 5 == 4) {
                    struct lnode *n = pop();
                    h = mix64(h, n->v);
                    pops++;
                    push(n);
                }
            }
            struct lnode *n;
            while ((n = pop()) != 0) {
                h = mix64(h, n->v);
                pops++;
            }
        }
        printf("pops=%d hash=%016lx empty=%d\n", pops, h, atomic_load(&top) == 0);
    }

    puts("== raw exclusive instructions ==");
    raw_exclusives();
    return 0;
}
