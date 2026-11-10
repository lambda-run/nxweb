// NZCV flags, condition codes and conditional instructions, tested with
// inline assembly so that the exact instruction under test is known.
// Each line is a hash over a table of operands (and incoming flags).
#include "rt.h"

typedef uint64_t u64;
#define NOINLINE __attribute__((noinline))

static const u64 vals[] = {
    0, 1, 2, 0x7f, 0x80, 0xff, 0x7fffffff, 0x80000000, 0xffffffff, 0x100000000,
    0x7fffffffffffffff, 0x8000000000000000, 0xffffffffffffffff, 0xfffffffffffffffe,
    0x123456789abcdef0, 0xdeadbeefcafebabe, 0x8000000000000001, 0xffffffff7fffffff,
};
#define NV (int)(sizeof vals / sizeof vals[0])

// r = result register, f = NZCV after the instruction (bits 31..28).
// The incoming flags are set from c first.
#define FLAGOP(name, body)                                               \
    static NOINLINE u64 name(u64 a, u64 b, u64 c)                        \
    {                                                                    \
        u64 r, f;                                                        \
        __asm__ volatile("msr nzcv, %[c]\n mov %[r], #0\n" body          \
                         "\n mrs %[f], nzcv"                             \
                         : [r] "=&r"(r), [f] "=&r"(f)                    \
                         : [a] "r"(a), [b] "r"(b), [c] "r"(c)            \
                         : "cc");                                        \
        return mix64(r, f);                                              \
    }

FLAGOP(adds64, "adds %[r], %[a], %[b]")
FLAGOP(adds32, "adds %w[r], %w[a], %w[b]")
FLAGOP(subs64, "subs %[r], %[a], %[b]")
FLAGOP(subs32, "subs %w[r], %w[a], %w[b]")
FLAGOP(adcs64, "adcs %[r], %[a], %[b]")
FLAGOP(adcs32, "adcs %w[r], %w[a], %w[b]")
FLAGOP(sbcs64, "sbcs %[r], %[a], %[b]")
FLAGOP(sbcs32, "sbcs %w[r], %w[a], %w[b]")
FLAGOP(adc64, "adc %[r], %[a], %[b]")
FLAGOP(adc32, "adc %w[r], %w[a], %w[b]")
FLAGOP(sbc64, "sbc %[r], %[a], %[b]")
FLAGOP(sbc32, "sbc %w[r], %w[a], %w[b]")
FLAGOP(ngcs64, "ngcs %[r], %[b]")
FLAGOP(negs64, "negs %[r], %[b]")
FLAGOP(negs32, "negs %w[r], %w[b]")
FLAGOP(ands64, "ands %[r], %[a], %[b]")
FLAGOP(ands32, "ands %w[r], %w[a], %w[b]")
FLAGOP(bics64, "bics %[r], %[a], %[b]")
FLAGOP(bics32, "bics %w[r], %w[a], %w[b]")
FLAGOP(cmp64, "cmp %[a], %[b]")
FLAGOP(cmp32, "cmp %w[a], %w[b]")
FLAGOP(cmn64, "cmn %[a], %[b]")
FLAGOP(cmn32, "cmn %w[a], %w[b]")
FLAGOP(tst64, "tst %[a], %[b]")
FLAGOP(tst32, "tst %w[a], %w[b]")
FLAGOP(adds_imm, "adds %[r], %[a], #0xfff")
FLAGOP(adds_imm12, "adds %[r], %[a], #1, lsl #12")
FLAGOP(subs_imm, "subs %[r], %[a], #1")
FLAGOP(subs_imm32, "subs %w[r], %w[a], #0x80")
FLAGOP(cmp_imm0, "cmp %[a], #0")
FLAGOP(cmn_imm1, "cmn %w[a], #1")
FLAGOP(ands_imm, "ands %[r], %[a], #0xff00ff00ff00ff00")
FLAGOP(tst_imm32, "tst %w[a], #0x80000000")
FLAGOP(adds_lsl, "adds %[r], %[a], %[b], lsl #17")
FLAGOP(subs_lsr, "subs %[r], %[a], %[b], lsr #9")
FLAGOP(subs_asr, "subs %[r], %[a], %[b], asr #63")
FLAGOP(adds_asr32, "adds %w[r], %w[a], %w[b], asr #31")
FLAGOP(ands_ror, "ands %[r], %[a], %[b], ror #13")
FLAGOP(bics_lsl32, "bics %w[r], %w[a], %w[b], lsl #5")
FLAGOP(adds_uxtb, "adds %[r], %[a], %w[b], uxtb #2")
FLAGOP(adds_sxtw, "adds %[r], %[a], %w[b], sxtw")
FLAGOP(subs_sxth, "subs %[r], %[a], %w[b], sxth #1")
FLAGOP(subs_uxtw, "subs %[r], %[a], %w[b], uxtw #3")
FLAGOP(cmp_sxtb32, "cmp %w[a], %w[b], sxtb")
FLAGOP(cmn_uxth, "cmn %[a], %w[b], uxth")

static void run_flagop(const char *name, u64 (*fn)(u64, u64, u64))
{
    u64 h = 0;
    for (int i = 0; i < NV; i++)
        for (int j = 0; j < NV; j++) {
            h = mix64(h, fn(vals[i], vals[j], 0));
            h = mix64(h, fn(vals[i], vals[j], 0x20000000));   // carry in
            h = mix64(h, fn(vals[i], vals[j], 0xD0000000));   // N Z V in, no carry
        }
    printf("%-12s %016lx\n", name, h);
}

// One function per condition code: conditional selects, conditional compares
// and a conditional branch, for the incoming flags c.
struct cond_out { u64 v[8]; };

#define CONDFN(cc)                                                              \
    static NOINLINE void cond_##cc(u64 a, u64 b, u64 c, struct cond_out *o)     \
    {                                                                           \
        u64 t0, t1, t2, t3, t4, t5, t6, t7;                                     \
        __asm__ volatile(                                                       \
            "msr nzcv, %[c]\n"                                                  \
            "csel %[t0], %[a], %[b], " #cc "\n"                                 \
            "csinc %[t1], %[a], %[b], " #cc "\n"                                \
            "csinv %w[t2], %w[a], %w[b], " #cc "\n"                             \
            "csneg %[t3], %[a], %[b], " #cc "\n"                                \
            "ccmp %[a], %[b], #5, " #cc "\n"                                    \
            "mrs %[t4], nzcv\n"                                                 \
            "msr nzcv, %[c]\n"                                                  \
            "ccmn %w[a], #3, #10, " #cc "\n"                                    \
            "mrs %[t5], nzcv\n"                                                 \
            "msr nzcv, %[c]\n"                                                  \
            "ccmp %w[a], %w[b], #0, " #cc "\n"                                  \
            "mrs %[t6], nzcv\n"                                                 \
            "msr nzcv, %[c]\n"                                                  \
            "mov %[t7], #1\n"                                                   \
            "b." #cc " 1f\n"                                                    \
            "mov %[t7], #0\n"                                                   \
            "1:\n"                                                              \
            : [t0] "=&r"(t0), [t1] "=&r"(t1), [t2] "=&r"(t2), [t3] "=&r"(t3),   \
              [t4] "=&r"(t4), [t5] "=&r"(t5), [t6] "=&r"(t6), [t7] "=&r"(t7)    \
            : [a] "r"(a), [b] "r"(b), [c] "r"(c)                                \
            : "cc");                                                            \
        o->v[0] = t0; o->v[1] = t1; o->v[2] = t2; o->v[3] = t3;                 \
        o->v[4] = t4; o->v[5] = t5; o->v[6] = t6; o->v[7] = t7;                 \
    }

CONDFN(eq) CONDFN(ne) CONDFN(cs) CONDFN(cc) CONDFN(mi) CONDFN(pl) CONDFN(vs) CONDFN(vc)
CONDFN(hi) CONDFN(ls) CONDFN(ge) CONDFN(lt) CONDFN(gt) CONDFN(le) CONDFN(al)

static void run_cond(const char *name, void (*fn)(u64, u64, u64, struct cond_out *))
{
    static const u64 cv[] = {0, 1, 3, 0xfffffffffffffffd, 0x8000000000000000, 0x7fffffff, 0xffffffff};
    u64 h = 0;
    unsigned taken = 0;
    for (u64 c = 0; c < 16; c++) {
        struct cond_out o;
        for (int i = 0; i < 7; i++)
            for (int j = 0; j < 7; j++) {
                fn(cv[i], cv[j], c << 28, &o);
                for (int k = 0; k < 8; k++) h = mix64(h, o.v[k]);
            }
        taken |= (unsigned)o.v[7] << c;
    }
    // "taken" has bit c set when the condition holds for NZCV == c.
    printf("cond %s  taken-mask %04x  %016lx\n", name, taken, h);
}

// Floating point compares: flags from fcmp/fcmpe/fccmp and fcsel.
#define FPFLAG(name, body)                                               \
    static NOINLINE u64 name(u64 a, u64 b, u64 c)                        \
    {                                                                    \
        u64 r, f;                                                        \
        __asm__ volatile("fmov d0, %[a]\n fmov d1, %[b]\n fmov s2, %w[a]\n fmov s3, %w[b]\n" \
                         "msr nzcv, %[c]\n mov %[r], #0\n" body          \
                         "\n mrs %[f], nzcv"                             \
                         : [r] "=&r"(r), [f] "=&r"(f)                    \
                         : [a] "r"(a), [b] "r"(b), [c] "r"(c)            \
                         : "cc", "v0", "v1", "v2", "v3", "v4");          \
        return mix64(r, f);                                              \
    }

FPFLAG(fcmp_d, "fcmp d0, d1")
FPFLAG(fcmpe_d, "fcmpe d0, d1")
FPFLAG(fcmp_d0, "fcmp d0, #0.0")
FPFLAG(fcmp_s, "fcmp s2, s3")
FPFLAG(fcmp_s0, "fcmp s3, #0.0")
FPFLAG(fccmp_d_eq, "fccmp d0, d1, #2, eq")
FPFLAG(fccmp_d_cc, "fccmp d0, d1, #13, cc")
FPFLAG(fccmp_s_ge, "fccmp s2, s3, #4, ge")
FPFLAG(fcsel_d_gt, "fcsel d4, d0, d1, gt\n fmov %[r], d4")
FPFLAG(fcsel_s_ls, "fcsel s4, s2, s3, ls\n fmov %w[r], s4")
FPFLAG(fcmp_csel, "fcmp d0, d1\n cset %w[r], mi\n cinc %w[r], %w[r], gt\n csinc %[r], %[r], %[r], vc")

static const u64 dvals[] = {
    0x0000000000000000, 0x8000000000000000,     // +0 -0
    0x3ff0000000000000, 0xbff0000000000000,     // 1 -1
    0x3ff0000000000001, 0x4000000000000000,     // 1+ulp 2
    0x7ff0000000000000, 0xfff0000000000000,     // inf -inf
    0x7ff8000000000000, 0xfff8000000000001,     // qNaN -qNaN
    0x0000000000000001, 0x7fefffffffffffff,     // min subnormal, max
    0x3f8000007fc00000, 0xff8000003f800000,     // low word: float NaN / float 1.0
    0x40490fdb3fc00000, 0xc0000000c0490fdb,     // low words: 1.5f, -3.14159f
};
#define ND (int)(sizeof dvals / sizeof dvals[0])

static void run_fpflag(const char *name, u64 (*fn)(u64, u64, u64))
{
    u64 h = 0;
    for (int i = 0; i < ND; i++)
        for (int j = 0; j < ND; j++)
            for (u64 c = 0; c < 16; c += 5) h = mix64(h, fn(dvals[i], dvals[j], c << 28));
    printf("%-12s %016lx\n", name, h);
}

// Branch forms that test a register directly.
static NOINLINE u64 bit_branches(u64 a)
{
    u64 r;
    __asm__ volatile(
        "mov %[r], #0\n"
        "tbz %[a], #0, 1f\n orr %[r], %[r], #1\n 1:\n"
        "tbnz %[a], #63, 2f\n orr %[r], %[r], #2\n 2:\n"
        "tbz %w[a], #31, 3f\n orr %[r], %[r], #4\n 3:\n"
        "tbnz %[a], #32, 4f\n orr %[r], %[r], #8\n 4:\n"
        "cbz %[a], 5f\n orr %[r], %[r], #16\n 5:\n"
        "cbnz %w[a], 6f\n orr %[r], %[r], #32\n 6:\n"
        "cbz %w[a], 7f\n orr %[r], %[r], #64\n 7:\n"
        "cbnz %[a], 8f\n orr %[r], %[r], #128\n 8:\n"
        : [r] "=&r"(r) : [a] "r"(a) : "cc");
    return r;
}

#define RUN(fn) run_flagop(#fn, fn)
#define RUNC(cc) run_cond(#cc, cond_##cc)
#define RUNF(fn) run_fpflag(#fn, fn)

int main(void)
{
    puts("== flag setting arithmetic ==");
    RUN(adds64); RUN(adds32); RUN(subs64); RUN(subs32);
    RUN(adcs64); RUN(adcs32); RUN(sbcs64); RUN(sbcs32);
    RUN(adc64); RUN(adc32); RUN(sbc64); RUN(sbc32);
    RUN(ngcs64); RUN(negs64); RUN(negs32);
    RUN(ands64); RUN(ands32); RUN(bics64); RUN(bics32);
    RUN(cmp64); RUN(cmp32); RUN(cmn64); RUN(cmn32); RUN(tst64); RUN(tst32);
    puts("== immediates, shifted and extended operands ==");
    RUN(adds_imm); RUN(adds_imm12); RUN(subs_imm); RUN(subs_imm32);
    RUN(cmp_imm0); RUN(cmn_imm1); RUN(ands_imm); RUN(tst_imm32);
    RUN(adds_lsl); RUN(subs_lsr); RUN(subs_asr); RUN(adds_asr32);
    RUN(ands_ror); RUN(bics_lsl32);
    RUN(adds_uxtb); RUN(adds_sxtw); RUN(subs_sxth); RUN(subs_uxtw);
    RUN(cmp_sxtb32); RUN(cmn_uxth);

    puts("== a few raw flag values (NZCV in the top nibble) ==");
    static const u64 pairs[][2] = {
        {0, 0}, {1, 1}, {0, 1}, {0x7fffffffffffffff, 1}, {0x8000000000000000, 1},
        {0xffffffffffffffff, 1}, {0x8000000000000000, 0x8000000000000000}, {5, 0xfffffffffffffffb},
    };
    for (int i = 0; i < 8; i++) {
        u64 a = pairs[i][0], b = pairs[i][1], fa, fs, fc;
        __asm__ volatile("adds xzr, %[a], %[b]\n mrs %[fa], nzcv\n"
                         "subs xzr, %[a], %[b]\n mrs %[fs], nzcv\n"
                         "adds wzr, %w[a], %w[b]\n mrs %[fc], nzcv"
                         : [fa] "=&r"(fa), [fs] "=&r"(fs), [fc] "=&r"(fc)
                         : [a] "r"(a), [b] "r"(b) : "cc");
        printf("a=%016lx b=%016lx adds %lx subs %lx adds32 %lx\n", a, b, fa >> 28, fs >> 28, fc >> 28);
    }

    puts("== condition codes ==");
    RUNC(eq); RUNC(ne); RUNC(cs); RUNC(cc); RUNC(mi); RUNC(pl); RUNC(vs); RUNC(vc);
    RUNC(hi); RUNC(ls); RUNC(ge); RUNC(lt); RUNC(gt); RUNC(le); RUNC(al);

    puts("== floating point compares ==");
    RUNF(fcmp_d); RUNF(fcmpe_d); RUNF(fcmp_d0); RUNF(fcmp_s); RUNF(fcmp_s0);
    RUNF(fccmp_d_eq); RUNF(fccmp_d_cc); RUNF(fccmp_s_ge);
    RUNF(fcsel_d_gt); RUNF(fcsel_s_ls); RUNF(fcmp_csel);
    for (int i = 0; i < 10; i += 3)
        for (int j = 0; j < 10; j += 2) {
            u64 f;
            __asm__ volatile("fmov d0, %[a]\n fmov d1, %[b]\n fcmp d0, d1\n mrs %[f], nzcv"
                             : [f] "=&r"(f) : [a] "r"(dvals[i]), [b] "r"(dvals[j]) : "cc", "v0", "v1");
            printf("fcmp %016lx %016lx -> %lx\n", dvals[i], dvals[j], f >> 28);
        }

    puts("== test-bit and compare-zero branches ==");
    for (int i = 0; i < NV; i++) printf("%016lx -> %02lx\n", vals[i], bit_branches(vals[i]));
    return 0;
}
