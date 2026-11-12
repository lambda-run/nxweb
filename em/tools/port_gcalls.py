#!/usr/bin/env python3
"""Calls through function pointers in nxnative's HLE files, for a host where guest code is not native code.

On the Mac a guest function is a C function: nxnative calls what guest_sym() returns, and the callbacks games hand to
the host, directly. Here a guest function is an address that the calling thread's translated code has to run
(nx_guest_calln), while a host function pointer is still a C function pointer. Which of the two a pointer is can only
be told when it is called, so every call through a function-pointer variable, parameter or field declared in the
file, `f(a, b)`, becomes `NXG(f, a, b)` (hle/nx_hle.h): a guest address goes through nx_guest_calln, anything else is
called as before. Declarations are found as `(*name)(`; calls as `name(` or `x->name(` / `x.name(`.
Not covered, and reported: calls through a cast expression, `((type)p)(args)`.

Usage: port_gcalls.py <in.c> <out.c>   (build.py imports rewrite())
"""
import re, sys

DECL = re.compile(r'\(\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)\s*\(')
KEYWORDS = {"sizeof", "if", "while", "for", "switch", "return"}

def rewrite(text):
    names = {m.group(1) for m in DECL.finditer(text)} - KEYWORDS
    if not names: return text, 0, 0
    alt = "|".join(sorted(map(re.escape, names), key=len, reverse=True))
    # the callee: an optional chain of members / indexed names, ending in one of the names
    call = re.compile(r'(?<![\w.>*])((?:[A-Za-z_]\w*(?:\[[^\]\n]*\])?(?:->|\.))*(?:' + alt + r'))(\[[^\]\n]*\])?\s*\((\s*\))?')
    n = 0
    def sub(m):
        nonlocal n
        before = text[max(0, m.start() - 40):m.start()]
        if re.search(r'\(\s*\*\s*$', before): return m.group(0)                       # the declarator itself
        if re.search(r'(?:^|[;{}])\s*(?:static\s+)?(?:\w+[\s*]+)+$', before) and m.group(1) in names and "(" not in before.split(";")[-1].split("{")[-1]:
            pass                                                                       # (a prototype would look like this; fp names are not function names in these files)
        n += 1
        callee = m.group(1) + (m.group(2) or "")
        return f"NXG0({callee})" if m.group(3) else f"NXG({callee}, "
    out = call.sub(sub, text)
    casts = len(re.findall(r'\)\s*\)\s*\(', out))
    return out, n, casts

if __name__ == "__main__":
    t, n, c = rewrite(open(sys.argv[1], encoding="utf-8").read())
    open(sys.argv[2], "w", encoding="utf-8").write(t)
    print(f"port_gcalls: {n} calls through function pointers rewritten; {c} places look like a call through a cast (not covered)")
