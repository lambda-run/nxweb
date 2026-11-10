#!/usr/bin/env python3
"""Generate a large synthetic C guest (thousands of distinct compiled functions) for the
larger-code check. Deterministic. Usage: big_gen.py OUT.c [nfuncs]"""
import random, sys
rng = random.Random(20261110)
n = int(sys.argv[2]) if len(sys.argv) > 2 else 2600
out = ['#include "../mini.h"', "static u64 g_arr[64];", "static double g_d[16];"]


def expr(depth=0):
    k = rng.random()
    if depth > 2 or k < 0.3:
        return rng.choice(["x", "y", "z", "a", "b", "g_arr[(x ^ %d) & 63]" % rng.randrange(64), str(rng.randrange(1, 1 << rng.randrange(1, 40))) + "ull"])
    op = rng.choice(["+", "-", "*", "^", "&", "|"])
    if k < 0.45:
        return "(%s %s %d)" % (expr(depth + 1), rng.choice(["<<", ">>"]), rng.randrange(1, 31))
    if k < 0.52:
        return "(%s / (%s | 1))" % (expr(depth + 1), expr(depth + 1))
    if k < 0.58:
        return "(u64)__builtin_clzll(%s | 1)" % expr(depth + 1)
    if k < 0.64:
        return "(%s < %s ? %s : %s)" % (expr(depth + 1), expr(depth + 1), expr(depth + 1), expr(depth + 1))
    return "(%s %s %s)" % (expr(depth + 1), op, expr(depth + 1))


def stmt(i, depth=0):
    k = rng.random()
    v = rng.choice("xyz")
    if k < 0.40 or depth > 1:
        return "%s = %s;" % (v, expr())
    if k < 0.52:
        return "if (%s & %d) { %s } else { %s }" % (expr(1), 1 << rng.randrange(8), stmt(i, depth + 1), stmt(i, depth + 1))
    if k < 0.64:
        return "for (int i = 0; i < %d; i++) { %s g_arr[(i + %d) & 63] += %s; }" % (rng.randrange(2, 9), stmt(i, depth + 1), rng.randrange(64), v)
    if k < 0.74:
        cases = " ".join("case %d: %s break;" % (c, stmt(i, depth + 1)) for c in range(4))
        return "switch (%s & 3) { %s }" % (v, cases)
    if k < 0.86:
        return "d = d * %s + (double)(%s & 0xffff) / %s; g_d[%d] += d; %s ^= (u64)(long)(d * 0.001);" % (
            rng.choice(["1.5", "0.25", "g_d[%d]" % rng.randrange(16), "-0.75"]), v, rng.choice(["3.0", "7.5", "(g_d[1] + 2.0)"]), rng.randrange(16), v)
    if k < 0.93 and i % 10:
        return "%s += f%d(%s, %s);" % (v, i - 1 - rng.randrange(i % 10), rng.choice("xyzab"), rng.choice("xyzab"))
    return "{ float fl = (float)(%s & 1023) * 0.5f; fl = fl * fl - (float)%d; %s += (u64)(int)fl; }" % (v, rng.randrange(100), v)


for i in range(n):
    body = " ".join(stmt(i) for _ in range(rng.randrange(6, 16)))
    out.append("__attribute__((noinline)) static u64 f%d(u64 a, u64 b) { u64 x = a + %d, y = b ^ %dull, z = %d; double d = (double)(a & 255); %s return x ^ (y << 1) ^ (z >> 1) ^ (u64)(long)d; }"
               % (i, rng.randrange(1000), rng.getrandbits(40), rng.randrange(1 << 20), body))
out.append("typedef u64 (*fn)(u64, u64);")
out.append("static const fn all[%d] = {%s};" % (n, ",".join("f%d" % i for i in range(n))))
out.append("int main(void) { u64 h = 1; for (int i = 0; i < 64; i++) g_arr[i] = i * 0x9E3779B97F4A7C15ull; for (int i = 0; i < 16; i++) g_d[i] = i * 0.5 + 1.0;"
           " for (int r = 0; r < 3; r++) for (int i = 0; i < %d; i++) { h = h * 31 + all[i](h, (u64)i + r); if (g_d[i & 15] > 1e9 || g_d[i & 15] < -1e9 || g_d[i & 15] != g_d[i & 15]) g_d[i & 15] = 1.0; }"
           " put(\"big \"); put_hex(h); u64 s = 0; for (int i = 0; i < 64; i++) s += g_arr[i]; put_hex(s); return 0; }" % n)
open(sys.argv[1], "w").write("\n".join(out) + "\n")
