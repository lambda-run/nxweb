// Exact NaN bit patterns, as ARM64 produces them with FPCR.DN = 0:
// generated NaNs are the default NaN (positive, quiet, zero payload) and an
// input NaN is propagated with its payload, quieted. A translator that lets
// the host canonicalise NaNs fails here and nowhere else in the corpus.
// The compiler may commute or merge operations (for example at -O2 "qb+qa"
// reuses "qa+qb"), so a few lines differ between the variants; each variant
// has its own expected output.
#include "rt.h"

static volatile double zero = 0.0, one = 1.0, inf = __builtin_inf(), minus_one = -1.0;
static volatile float zerof = 0.0f, onef = 1.0f, inff = __builtin_inff();
static volatile uint64_t qnan_a = 0x7ff8000000001234ull, qnan_b = 0xfff80000000abcdeull,
                         snan_a = 0x7ff0000000005555ull, snan_b = 0xfff4000000000001ull;
static volatile uint32_t qnanf_a = 0x7fc01234u, snanf_a = 0xff800055u;

#define P(name, expr) printf("%-22s %016lx\n", name, f64_bits(expr))
#define PF(name, expr) printf("%-22s %08x\n", name, f32_bits(expr))

int main(void)
{
    double qa = f64_from_bits(qnan_a), qb = f64_from_bits(qnan_b);
    double sa = f64_from_bits(snan_a), sb = f64_from_bits(snan_b);
    float fqa = f32_from_bits(qnanf_a), fsa = f32_from_bits(snanf_a);

    puts("== generated NaNs (default NaN) ==");
    P("0/0", zero / zero);
    P("inf-inf", inf - inf);
    P("inf*0", inf * zero);
    P("inf/inf", inf / inf);
    P("sqrt(-1)", __builtin_sqrt(minus_one));
    P("-(0/0)", -(zero / zero));
    PF("0f/0f", zerof / zerof);
    PF("inff-inff", inff - inff);
    PF("sqrtf(-1)", __builtin_sqrtf(-onef));
    P("fma(inf,0,1)", __builtin_fma(inf, zero, one));

    puts("== propagation ==");
    P("qa+1", qa + one);
    P("1+qa", one + qa);
    P("qa+qb", qa + qb);
    P("qb+qa", qb + qa);
    P("qa*qb", qa * qb);
    P("qb/qa", qb / qa);
    P("sa+1", sa + one);
    P("qa+sb", qa + sb);
    P("sb+qa", sb + qa);
    P("sa-sb", sa - sb);
    P("sqrt(qb)", __builtin_sqrt(qb));
    P("sqrt(sa)", __builtin_sqrt(sa));
    P("fma(qa,1,qb)", __builtin_fma(qa, one, qb));
    P("fma(1,qa,qb)", __builtin_fma(one, qa, qb));
    P("fma(1,1,sb)", __builtin_fma(one, one, sb));
    P("floor(sa)", __builtin_floor(sa));
    P("rint(qb)", __builtin_rint(qb));
    PF("fqa*1", fqa * onef);
    PF("fsa+1", fsa + onef);
    PF("fsa+fqa", fsa + fqa);

    puts("== sign operations keep the payload and do not quiet ==");
    P("-qa", -qa);
    P("fabs(qb)", __builtin_fabs(qb));
    P("-sa", -sa);
    P("fabs(sb)", __builtin_fabs(sb));
    P("copysign(sa,-1)", __builtin_copysign(sa, minus_one));
    PF("-fsa", -fsa);

    puts("== min/max (fminnm/fmaxnm: a quiet NaN loses against a number) ==");
    P("fmin(qa,1)", __builtin_fmin(qa, one));
    P("fmax(1,qb)", __builtin_fmax(one, qb));
    P("fmin(qa,qb)", __builtin_fmin(qa, qb));
    P("fmin(sa,1)", __builtin_fmin(sa, one));
    PF("fmaxf(fqa,1)", __builtin_fmaxf(fqa, onef));

    puts("== precision conversion keeps the top payload bits ==");
    PF("(float)qa", (float)qa);
    PF("(float)qb", (float)qb);
    PF("(float)sa", (float)sa);
    P("(double)fqa", (double)fqa);
    P("(double)fsa", (double)fsa);

    puts("== NaN to integer is 0 ==");
    {
        volatile double q = qa;
        volatile float fq = fsa;
        printf("%d %ld %u %lu %d\n", (int)q, (long)q, (unsigned)q, (unsigned long)q, (int)fq);
    }
    return 0;
}
