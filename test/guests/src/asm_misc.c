// Individual instructions through inline assembly: multiply/divide forms,
// variable shifts with out-of-range counts, bitfield moves, wide moves,
// every load/store addressing mode, system registers and hint instructions.
#include "rt.h"

typedef uint64_t u64;
#define NOINLINE __attribute__((noinline))

static const u64 vals[] = {
    0, 1, 2, 3, 0x3f, 0x40, 0x41, 0x7f, 0xff, 0x7fffffff, 0x80000000, 0xffffffff,
    0x7fffffffffffffff, 0x8000000000000000, 0xffffffffffffffff,
    0x123456789abcdef0, 0xdeadbeefcafebabe, 0x00ff00ff00ff00ff,
};
#define NV (int)(sizeof vals / sizeof vals[0])

#define OP(name, body)                                                   \
    static NOINLINE u64 name(u64 a, u64 b, u64 c)                        \
    {                                                                    \
        u64 r;                                                           \
        __asm__ volatile("mov %[r], %[c]\n" body                         \
                         : [r] "=&r"(r)                                  \
                         : [a] "r"(a), [b] "r"(b), [c] "r"(c)            \
                         : "cc", "x9");                                  \
        return r;                                                        \
    }

OP(madd64, "madd %[r], %[a], %[b], %[c]")
OP(madd32, "madd %w[r], %w[a], %w[b], %w[c]")
OP(msub64, "msub %[r], %[a], %[b], %[c]")
OP(msub32, "msub %w[r], %w[a], %w[b], %w[c]")
OP(mneg64, "mneg %[r], %[a], %[b]")
OP(smaddl, "smaddl %[r], %w[a], %w[b], %[c]")
OP(smsubl, "smsubl %[r], %w[a], %w[b], %[c]")
OP(umaddl, "umaddl %[r], %w[a], %w[b], %[c]")
OP(umsubl, "umsubl %[r], %w[a], %w[b], %[c]")
OP(smnegl, "smnegl %[r], %w[a], %w[b]")
OP(smulh, "smulh %[r], %[a], %[b]")
OP(umulh, "umulh %[r], %[a], %[b]")
OP(udiv64, "udiv %[r], %[a], %[b]")
OP(udiv32, "udiv %w[r], %w[a], %w[b]")
OP(sdiv64, "sdiv %[r], %[a], %[b]")
OP(sdiv32, "sdiv %w[r], %w[a], %w[b]")
OP(lslv64, "lsl %[r], %[a], %[b]")
OP(lslv32, "lsl %w[r], %w[a], %w[b]")
OP(lsrv64, "lsr %[r], %[a], %[b]")
OP(lsrv32, "lsr %w[r], %w[a], %w[b]")
OP(asrv64, "asr %[r], %[a], %[b]")
OP(asrv32, "asr %w[r], %w[a], %w[b]")
OP(rorv64, "ror %[r], %[a], %[b]")
OP(rorv32, "ror %w[r], %w[a], %w[b]")
OP(extr64, "extr %[r], %[a], %[b], #23")
OP(extr32, "extr %w[r], %w[a], %w[b], #9")
OP(ror_imm, "ror %[r], %[a], #61")
OP(bfi64, "bfi %[r], %[a], #12, #20")
OP(bfi32, "bfi %w[r], %w[a], #27, #5")
OP(bfxil64, "bfxil %[r], %[a], #40, #13")
OP(bfc_like, "bfi %[r], xzr, #7, #33")
OP(ubfx64, "ubfx %[r], %[a], #31, #11")
OP(ubfx32, "ubfx %w[r], %w[a], #3, #29")
OP(sbfx64, "sbfx %[r], %[a], #17, #40")
OP(sbfx32, "sbfx %w[r], %w[a], #30, #2")
OP(ubfiz64, "ubfiz %[r], %[a], #50, #9")
OP(sbfiz64, "sbfiz %[r], %[a], #4, #31")
OP(sbfiz32, "sbfiz %w[r], %w[a], #24, #8")
OP(lsl_imm, "lsl %[r], %[a], #63")
OP(lsr_imm32, "lsr %w[r], %w[a], #31")
OP(asr_imm, "asr %[r], %[a], #1")
OP(sxtb_w, "sxtb %w[r], %w[a]")
OP(sxth_x, "sxth %[r], %w[a]")
OP(sxtw_x, "sxtw %[r], %w[a]")
OP(clz64, "clz %[r], %[a]")
OP(clz32, "clz %w[r], %w[a]")
OP(cls64, "cls %[r], %[a]")
OP(cls32, "cls %w[r], %w[a]")
OP(rbit64, "rbit %[r], %[a]")
OP(rbit32, "rbit %w[r], %w[a]")
OP(rev64, "rev %[r], %[a]")
OP(rev32w, "rev %w[r], %w[a]")
OP(rev16x, "rev16 %[r], %[a]")
OP(rev16w, "rev16 %w[r], %w[a]")
OP(rev32x, "rev32 %[r], %[a]")
OP(movk, "movk %[r], #0xbeef, lsl #32")
OP(movk32, "movk %w[r], #0x1234, lsl #16")
OP(movn, "movn %[r], #0x55aa, lsl #48")
OP(movz32, "movz %w[r], #0xffff, lsl #16")
OP(orr_imm, "orr %[r], %[a], #0x7ffffffffffffffe")
OP(and_imm32, "and %w[r], %w[a], #0xf000000f")
OP(eor_imm, "eor %[r], %[a], #0xaaaaaaaaaaaaaaaa")
OP(orn_ror, "orn %[r], %[a], %[b], ror #7")
OP(eon_asr, "eon %[r], %[a], %[b], asr #33")
OP(bic_lsr, "bic %w[r], %w[a], %w[b], lsr #3")
OP(add_ext, "add %[r], %[a], %w[b], sxtb #3")
OP(sub_ext, "sub %w[r], %w[a], %w[b], uxth #1")
OP(add_sp, "mov %[r], sp\n sub sp, sp, #32\n add sp, sp, %[a], uxtx\n sub sp, sp, %[a]\n"
           "add sp, sp, #32\n mov x9, sp\n sub %[r], %[r], x9")
OP(adr_delta, "adr %[r], 1f\n adr x9, 2f\n sub %[r], x9, %[r]\n b 2f\n 1: nop\n nop\n 2:")
OP(adrp_add, "adrp %[r], 1f\n add %[r], %[r], :lo12:1f\n adr x9, 1f\n sub %[r], %[r], x9\n add %[r], %[r], %[a]\n 1:")
OP(zr_ops, "add %[r], %[a], xzr\n orr x9, xzr, %[b]\n add %[r], %[r], x9\n ands xzr, %[a], %[b]\n"
           "csel %[r], %[r], xzr, ne\n sub %[r], xzr, %[r]")

static void run(const char *name, u64 (*fn)(u64, u64, u64))
{
    u64 h = 0;
    for (int i = 0; i < NV; i++)
        for (int j = 0; j < NV; j++) h = mix64(h, fn(vals[i], vals[j], vals[(i * 7 + j * 3 + 5) % NV]));
    printf("%-10s %016lx  f(0x%lx,0x%lx,0x%lx)=%016lx\n", name, h, vals[16], vals[6], vals[15],
           fn(vals[16], vals[6], vals[15]));
}
#define RUN(fn) run(#fn, fn)

// ---- addressing modes -----------------------------------------------------

static uint8_t pool[320] __attribute__((aligned(16)));
static u64 results[128];

static NOINLINE int addressing_modes(void)
{
    u64 *out = results;
    u64 *end;
    uint8_t *p = pool + 64;
    for (int i = 0; i < 320; i++) pool[i] = (uint8_t)(i * 37 + 11) ^ (uint8_t)(i >> 1 | 0x80);
    __asm__ volatile(
        "mov x9, %[p]\n"
        "mov x15, %[out]\n"
        "mov x12, #5\n"
        "mov x13, #-3\n"
        // unsigned scaled offset, all sizes, zero and sign extending
        "ldr x10, [x9, #8]\n str x10, [x15], #8\n"
        "ldr w10, [x9, #20]\n str x10, [x15], #8\n"
        "ldrh w10, [x9, #6]\n str x10, [x15], #8\n"
        "ldrb w10, [x9, #3]\n str x10, [x15], #8\n"
        "ldrsb w10, [x9, #1]\n str x10, [x15], #8\n"
        "ldrsb x10, [x9, #1]\n str x10, [x15], #8\n"
        "ldrsh w10, [x9, #2]\n str x10, [x15], #8\n"
        "ldrsh x10, [x9, #2]\n str x10, [x15], #8\n"
        "ldrsw x10, [x9, #4]\n str x10, [x15], #8\n"
        // unscaled
        "ldur x10, [x9, #-3]\n str x10, [x15], #8\n"
        "ldur w10, [x9, #7]\n str x10, [x15], #8\n"
        "ldurh w10, [x9, #-1]\n str x10, [x15], #8\n"
        "ldurb w10, [x9, #-64]\n str x10, [x15], #8\n"
        "ldursb x10, [x9, #-5]\n str x10, [x15], #8\n"
        "ldursh x10, [x9, #-7]\n str x10, [x15], #8\n"
        "ldursw x10, [x9, #-9]\n str x10, [x15], #8\n"
        // register offset
        "ldr x10, [x9, x12]\n str x10, [x15], #8\n"
        "ldr x10, [x9, x12, lsl #3]\n str x10, [x15], #8\n"
        "ldr w10, [x9, w12, uxtw #2]\n str x10, [x15], #8\n"
        "ldr x10, [x9, w13, sxtw]\n str x10, [x15], #8\n"
        "ldr x10, [x9, w13, sxtw #3]\n str x10, [x15], #8\n"
        "ldrb w10, [x9, x13]\n str x10, [x15], #8\n"
        "ldrsh x10, [x9, x12, lsl #1]\n str x10, [x15], #8\n"
        "ldrsw x10, [x9, w13, sxtw #2]\n str x10, [x15], #8\n"
        "ldrsb w10, [x9, w12, uxtw]\n str x10, [x15], #8\n"
        // pre and post index; record the updated base (as an offset) too
        "mov x11, x9\n"
        "ldr x10, [x11, #16]!\n str x10, [x15], #8\n sub x10, x11, x9\n str x10, [x15], #8\n"
        "ldr x10, [x11], #-24\n str x10, [x15], #8\n sub x10, x11, x9\n str x10, [x15], #8\n"
        "ldrb w10, [x11, #1]!\n str x10, [x15], #8\n"
        "ldrsh x10, [x11], #3\n str x10, [x15], #8\n"
        "ldrsw x10, [x11, #-4]!\n str x10, [x15], #8\n sub x10, x11, x9\n str x10, [x15], #8\n"
        // pairs
        "ldp x10, x14, [x9, #16]\n stp x10, x14, [x15], #16\n"
        "ldp w10, w14, [x9, #-8]\n stp x10, x14, [x15], #16\n"
        "ldpsw x10, x14, [x9, #4]\n stp x10, x14, [x15], #16\n"
        "mov x11, x9\n"
        "ldp x10, x14, [x11, #32]!\n stp x10, x14, [x15], #16\n"
        "ldp x10, x14, [x11], #-48\n stp x10, x14, [x15], #16\n"
        "sub x10, x11, x9\n str x10, [x15], #8\n"
        // literal loads
        "ldr x10, 1f\n str x10, [x15], #8\n"
        "ldr w10, 1f\n str x10, [x15], #8\n"
        "ldrsw x10, 2f\n str x10, [x15], #8\n"
        "b 3f\n"
        ".balign 8\n"
        "1: .quad 0x1122334455667788\n"
        "2: .word 0x80000001\n .word 0\n"
        "3:\n"
        // stores: every size and mode, then read the area back as words
        "add x11, x9, #96\n"
        "mov x10, #0x0807\n movk x10, #0x0a09, lsl #16\n movk x10, #0x0c0b, lsl #32\n movk x10, #0x0e0d, lsl #48\n"
        "str x10, [x11]\n"
        "str w10, [x11, #12]\n"
        "strh w10, [x11, #18]\n"
        "strb w10, [x11, #21]\n"
        "stur x10, [x11, #23]\n"
        "sturh w10, [x11, #33]\n"
        "sturb w10, [x11, #-1]\n"
        "stur w10, [x11, #37]\n"
        "str x10, [x11, x12, lsl #3]\n"         // +40
        "strb w10, [x11, w13, sxtw]\n"          // -3
        "strh w10, [x11, x12, lsl #1]\n"        // +10
        "str w10, [x11, #48]!\n"                // x11 = +48
        "str x10, [x11], #9\n"                  // x11 = +57
        "strb w10, [x11], #1\n"                 // +58
        "strh w10, [x11, #2]!\n"                // +60
        "stp w10, w12, [x11, #4]\n"             // +64, +68
        "stp x12, x13, [x11, #16]!\n"           // x11 = +76
        "stp x13, x10, [x11], #16\n"            // overwrites, x11 = +92
        "str xzr, [x11]\n strb wzr, [x11, #-87]\n"
        "sub x10, x11, x9\n str x10, [x15], #8\n"
        "add x11, x9, #88\n"
        "4: ldr x10, [x11], #8\n str x10, [x15], #8\n"
        "sub x14, x11, x9\n cmp x14, #208\n b.lo 4b\n"
        // FP/SIMD register loads and stores
        "ldr q0, [x9]\n ldr d1, [x9, #24]\n ldr s2, [x9, #36]\n ldr h3, [x9, #2]\n ldr b4, [x9, #1]\n"
        "ldur q5, [x9, #-7]\n ldp d6, d7, [x9, #40]\n ldp q16, q17, [x9, #-32]\n"
        "str q0, [x15], #16\n str d1, [x15], #8\n str s2, [x15], #4\n str s2, [x15], #4\n"
        "fmov x10, d3\n str x10, [x15], #8\n fmov x10, d4\n str x10, [x15], #8\n"
        "stur q5, [x15]\n add x15, x15, #16\n stp d6, d7, [x15], #16\n stp q16, q17, [x15], #32\n"
        "mov %[end], x15\n"
        : [end] "=&r"(end)
        : [p] "r"(p), [out] "r"(out)
        : "cc", "memory", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
          "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v16", "v17");
    return (int)(end - results);
}

int main(void)
{
    puts("== multiply / divide ==");
    RUN(madd64); RUN(madd32); RUN(msub64); RUN(msub32); RUN(mneg64);
    RUN(smaddl); RUN(smsubl); RUN(umaddl); RUN(umsubl); RUN(smnegl);
    RUN(smulh); RUN(umulh); RUN(udiv64); RUN(udiv32); RUN(sdiv64); RUN(sdiv32);
    printf("udiv 7/0=%lu sdiv -7/0=%lu sdiv min/-1=%016lx sdiv32 min/-1=%016lx\n",
           udiv64(7, 0, 9), sdiv64((u64)-7, 0, 9), sdiv64(1ull << 63, (u64)-1, 9),
           sdiv32(0x80000000, 0xffffffff, 9));
    puts("== variable shifts (count is taken modulo the register size) ==");
    RUN(lslv64); RUN(lslv32); RUN(lsrv64); RUN(lsrv32);
    RUN(asrv64); RUN(asrv32); RUN(rorv64); RUN(rorv32);
    printf("lsl 1<<64=%lx 1<<65=%lx w:1<<32=%lx w:1<<33=%lx asr min>>127=%lx\n",
           lslv64(1, 64, 0), lslv64(1, 65, 0), lslv32(1, 32, 0), lslv32(1, 33, 0),
           asrv64(1ull << 63, 127, 0));
    puts("== bitfield and extract ==");
    RUN(extr64); RUN(extr32); RUN(ror_imm);
    RUN(bfi64); RUN(bfi32); RUN(bfxil64); RUN(bfc_like);
    RUN(ubfx64); RUN(ubfx32); RUN(sbfx64); RUN(sbfx32);
    RUN(ubfiz64); RUN(sbfiz64); RUN(sbfiz32);
    RUN(lsl_imm); RUN(lsr_imm32); RUN(asr_imm);
    RUN(sxtb_w); RUN(sxth_x); RUN(sxtw_x);
    puts("== bit manipulation ==");
    RUN(clz64); RUN(clz32); RUN(cls64); RUN(cls32); RUN(rbit64); RUN(rbit32);
    RUN(rev64); RUN(rev32w); RUN(rev16x); RUN(rev16w); RUN(rev32x);
    puts("== wide moves, logical immediates, shifted/extended operands ==");
    RUN(movk); RUN(movk32); RUN(movn); RUN(movz32);
    RUN(orr_imm); RUN(and_imm32); RUN(eor_imm);
    RUN(orn_ror); RUN(eon_asr); RUN(bic_lsr); RUN(add_ext); RUN(sub_ext);
    RUN(add_sp); RUN(adr_delta); RUN(adrp_add); RUN(zr_ops);

    puts("== addressing modes ==");
    int n = addressing_modes();
    for (int i = 0; i < n; i++) printf("am[%2d] %016lx\n", i, results[i]);
    {
        u64 h = 0;
        for (int i = 0; i < 320; i++) h = mix64(h, pool[i]);
        printf("pool hash %016lx\n", h);
    }

    puts("== system registers ==");
    {
        u64 a, b, c;
        __asm__ volatile("mrs %[a], tpidr_el0\n mrs %[b], tpidrro_el0"
                         : [a] "=&r"(a), [b] "=&r"(b));
        printf("initial tpidr_el0=%lx tpidrro_el0=%lx\n", a, b);
        a = 0x1122334455667788;
        __asm__ volatile("msr tpidr_el0, %[a]\n mrs %[b], tpidr_el0" : [b] "=&r"(b) : [a] "r"(a));
        printf("tpidr_el0 after write=%lx\n", b);
        u64 h = 0;
        for (u64 f = 0; f < 16; f++) {
            a = f << 28 | 0x0fffffff;       // only bits 31..28 exist
            __asm__ volatile("msr nzcv, %[a]\n mrs %[b], nzcv\n cset %w[c], hi"
                             : [b] "=&r"(b), [c] "=&r"(c) : [a] "r"(a) : "cc");
            h = mix64(h, b + c);
            if (f == 6 || f == 15) printf("nzcv write %lx read %lx\n", a, b);
        }
        printf("nzcv roundtrip %016lx\n", h);
        __asm__ volatile("mrs %[a], fpcr\n mrs %[b], fpsr" : [a] "=&r"(a), [b] "=&r"(b));
        printf("initial fpcr=%lx fpsr=%lx\n", a, b);
        a = 0x00c00000;                     // RMode = round toward zero
        __asm__ volatile("mrs x9, fpcr\n msr fpcr, %[a]\n mrs %[b], fpcr\n msr fpcr, x9\n mrs %[c], fpcr"
                         : [b] "=&r"(b), [c] "=&r"(c) : [a] "r"(a) : "x9");
        printf("fpcr written %lx read %lx restored %lx\n", a, b, c);
        a = 0x08000001;                     // QC | IOC: sticky status bits are writable
        __asm__ volatile("msr fpsr, %[a]\n mrs %[b], fpsr\n msr fpsr, xzr\n mrs %[c], fpsr"
                         : [b] "=&r"(b), [c] "=&r"(c) : [a] "r"(a));
        printf("fpsr written %lx read %lx cleared %lx\n", a, b, c);
    }

    puts("== hints and barriers (must behave as no-ops) ==");
    {
        u64 a = 5;
        __asm__ volatile("nop\n yield\n hint #34\n dmb ish\n dsb sy\n isb\n clrex\n"
                         "prfm pldl1keep, [%[p]]\n prfm pstl2strm, [%[p], #64]\n add %[a], %[a], #1"
                         : [a] "+r"(a) : [p] "r"(pool));
        printf("after hints a=%lu\n", a);
    }
    return 0;
}
