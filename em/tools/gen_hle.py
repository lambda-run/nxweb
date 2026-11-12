#!/usr/bin/env python3
"""Generate the HLE argument-marshalling thunks and the name table for nxem (run in the VM; needs emcc for -E).

  python3 gen_hle.py [--out DIR] [--nx /ctl/repos/nxnative/dm] [--hand DIR] [--cflags "..."] [-j N] [--no-gen] FILE.c ...

FILE is an nxnative source (or its ported copy under build/host/). Nothing is edited. For every file:

  1. The file is PREPROCESSED with nxnative's own hle.h (emcc -E -P, the flags of the real compile). The macro
     invocations are therefore parsed by the C preprocessor itself: multi-line argument lists, comments, wrapper
     macros (SKF, PALMA_FAIL, DEC(tag) ...), token pasting and stringification all arrive expanded. What is searched
     in the output is what the macros expand to: the table entry
         static const hle_ent|hle_force_ent|nvn_impl <var> = { "name", (void *)<fn>[, "why"] };
     with its section (swhle / swforce / swnvn), and then the prototype `static <ret> <fn>(<params>);` (for the libc
     passthrough table of hle_table.c: the C library's declaration). Entries written without the macros (the naked
     h_prepo_Send of hle_offline.c) are found the same way.
     A file that cannot be preprocessed because headers are missing is scanned with EMPTY stand-ins for exactly those
     headers (said on stderr); types that came from them are then unknown and the entry is flagged, not guessed.
  2. Every parameter and the return type is classified from its text: i (integer of at most 64 bits, enum, bool),
     p (pointer, array parameter, function pointer), f (float), d (double), v (void). Typedef names are resolved
     through the typedefs found in the preprocessed text (so through nxnative's headers and the C library's).
     Struct / union by value, va_list, `...`, 128-bit and long double, and any name that does not resolve: the entry
     NEEDS A HAND-WRITTEN THUNK and the reason is reported.
  3. Output (unless --no-gen), in --out (default /ctl/nxweb-em/em/build/hle/gen):
       <stem>.thunks.inc   `void nxt_<stem>_<fn>(uint64_t *ctx)` per entry, with compile-time checks of step 2
       <stem>.tu.c         the translation unit to compile: nx_hle.h, the source file, hand thunks, the thunks
       hle_table.c         {name, thunk, flags, why} sorted by name (strcmp order), nx_hle_find()
     Hand-written thunks go to <hand>/<stem>.inc (default hle/hand/): for an entry it handles the file defines
     `void nxt_<stem>_<fn>(uint64_t *ctx)` and `#define NXT_HAVE_<fn> 1`. Without that an entry that needs a hand
     thunk gets one that reports the name and aborts when called.
  4. Report on stdout, tab-separated, one line per entry:
       file  kind  name  cname  return type  parameter types  signature  classification
     and a summary on stderr.

Marshalling (AAPCS64 as the Switch uses it): integer / pointer arguments from x0..x7 in order, float / double from the
low bytes of v0..v7 in order, each class counted separately; arguments past the eighth of a class from the guest stack,
one 8-byte slot each in declaration order. bool takes the low 8 bits, other integers are converted from the 64-bit
register by a C cast (the callee's type truncates: Switch callers do not extend narrow arguments, hle.h). The result
goes to x0 as the 64-bit conversion of the C value, or to v0 (float / double; the rest of v0 is cleared).
"""
import argparse, os, re, subprocess, sys, collections
from concurrent.futures import ThreadPoolExecutor

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--out", default=f"{R}/build/hle/gen")
ap.add_argument("--nx", default="/ctl/repos/nxnative/dm")
ap.add_argument("--hand", default=f"{R}/hle/hand")
ap.add_argument("--cc", default="/ctl/emsdk/emscripten/emcc")
ap.add_argument("--cflags", default=None, help="flags of the real compile (default: build.py's, plus hle/, hle/shim and nxnative's include directories)")
ap.add_argument("-j", type=int, default=4)
ap.add_argument("--no-gen", action="store_true", help="report only")
ap.add_argument("files", nargs="+")
A = ap.parse_args()
NX = A.nx
os.environ.setdefault("EM_CONFIG", "/ctl/emsdk/emscripten.cfg")
CFLAGS = A.cflags.split() if A.cflags is not None else [
    "-pthread", "-D_GNU_SOURCE", "-sMEMORY64=1", f"-I{R}/hle", f"-I{R}/kernel", f"-I{R}/kernel/shim", f"-I{R}/hle/shim", f"-I{NX}/host", f"-I{R}/build/gen",
    f"-I{NX}/gfx/nvn/include", f"-I{NX}/third_party/libvpx", f"-I{NX}/third_party/dav1d/include", f"-I{NX}/third_party/stb_vorbis"]

# ---------------------------------------------------------------- text helpers
STR = re.compile(r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'')
def mask(text):
    """The text with the inside of string / character literals blanked (same length): safe for bracket counting."""
    return STR.sub(lambda m: m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[-1], text)

OPEN, CLOSE = "([{", ")]}"
def match_close(m, i):
    """m[i] is an opening bracket: the index of its closing bracket."""
    d = 0
    for j in range(i, len(m)):
        c = m[j]
        if c in OPEN: d += 1
        elif c in CLOSE:
            d -= 1
            if d == 0: return j
    raise ValueError("unbalanced bracket")

def split_top(s, sep=","):
    out, d, a = [], 0, 0
    for j, c in enumerate(s):
        if c in OPEN: d += 1
        elif c in CLOSE: d -= 1
        elif c == sep and d == 0: out.append(s[a:j]); a = j + 1
    out.append(s[a:])
    return out

def strip_attrs(s):
    while True:
        m = re.search(r"\b(__attribute__|__asm__|__asm|asm|_Alignas|__declspec)\s*\(", s)
        if not m: break
        s = s[:m.start()] + " " + s[match_close(s, m.end() - 1) + 1:]
    return re.sub(r"\b(__extension__|__restrict|__restrict__|restrict|_Nonnull|_Nullable|_Null_unspecified|__inline|__inline__|inline|_Noreturn|__noreturn__)\b", " ", s)

def norm(s): return re.sub(r"\s+", " ", s).strip().replace(" *", " *").replace("* ", "*").replace("( ", "(").replace(" )", ")")

# ---------------------------------------------------------------- types
QUAL = {"const", "volatile", "register", "_Atomic", "static", "extern"}
INTKW = {"char", "short", "int", "long", "unsigned", "signed", "_Bool", "bool", "__int8", "__int16", "__int32", "__int64", "wchar_t", "char16_t", "char32_t"}
# Fixed-width and size names: resolved through the typedefs when the C library's headers were seen; this is the
# fallback for a scan with stand-in headers.
INTNAMES = {f"{u}int{n}_t" for u in ("", "u") for n in (8, 16, 32, 64)} | {"size_t", "ssize_t", "ptrdiff_t", "intptr_t", "uintptr_t", "off_t", "time_t", "uintmax_t", "intmax_t"}
KW = INTKW | QUAL | {"float", "double", "void", "struct", "union", "enum"}

def base_class(tokens, tdefs, depth=0):
    """Class of a declaration-specifier token list: (class, detail). Classes: i b p f d v and the hand classes
    S (struct/union by value) Q (128-bit / long double) V (va_list) U (unknown)."""
    t = [x for x in tokens if x not in QUAL]
    if not t: return ("U", "no type")
    if t[0] in ("struct", "union"): return ("S", " ".join(t[:2]))
    if t[0] == "enum": return ("i", "enum")
    if "__int128" in t or "__int128_t" in t or "__uint128_t" in t: return ("Q", "128-bit integer")
    if "double" in t: return ("Q", "long double") if "long" in t else (("d", "") if t == ["double"] else ("U", " ".join(t)))
    if t == ["float"]: return ("f", "")
    if t == ["void"]: return ("v", "")
    if t in (["_Bool"], ["bool"]): return ("b", "")
    if all(x in INTKW for x in t): return ("i", "")
    if t[0] in ("__builtin_va_list", "__gnuc_va_list", "va_list", "__va_list_tag", "__isoc_va_list"): return ("V", "va_list")
    if len(t) == 1:
        if t[0] in tdefs and depth < 30:
            kind, val = tdefs[t[0]]
            if kind == "class": return val
            return base_class(val, tdefs, depth + 1)
        if t[0] in INTNAMES: return ("i", "")
    return ("U", " ".join(t))

TOK = re.compile(r"[A-Za-z_]\w*|\S")
def collect_typedefs(m):
    """name -> ('class', (cls, detail)) | ('alias', tokens) for every typedef in the (masked) preprocessed text."""
    td = {}
    for mt in re.finditer(r"\btypedef\b", m):
        i, d, j = mt.end(), 0, mt.end()
        while j < len(m):
            c = m[j]
            if c in OPEN: d += 1
            elif c in CLOSE: d -= 1
            elif c == ";" and d == 0: break
            j += 1
        body = strip_attrs(m[i:j])
        fp = re.search(r"\(\s*\*\s*(?:const\s+)?(\w+)\s*\)\s*\(", body)          # typedef R (*name)(...)
        if fp: td[fp.group(1)] = ("class", ("p", "function pointer")); continue
        if "{" in body:
            a = body.index("{"); b = match_close(body, a)
            head = body[:a].split(); decls = body[b + 1:]
            agg = ("i", "enum") if head and head[0] == "enum" else ("S", " ".join(head[:2]) if len(head) > 1 else (head[0] if head else "struct") + " (anonymous)")
            for dcl in split_top(decls):
                nm = re.search(r"(\w+)\s*(\[[^\]]*\]\s*)*$", dcl.strip())
                if not nm: continue
                if "*" in dcl or "[" in dcl: td[nm.group(1)] = ("class", ("p", "pointer"))
                else: td[nm.group(1)] = ("class", (agg[0], f"{agg[1]} {nm.group(1)}" if agg[0] == "S" else agg[1]))
            continue
        parts = split_top(body)
        first = parts[0].strip()
        fn = re.match(r"^(.*?)(\w+)\s*\($", first[:first.index("(") + 1]) if "(" in first else None
        if fn: td[fn.group(2)] = ("class", ("p", "function type")); continue    # typedef R name(...): decays to a pointer as a parameter
        nm = re.search(r"(\w+)\s*((?:\[[^\]]*\]\s*)*)$", first)
        if not nm: continue
        base = first[:nm.start()]
        btoks = [x for x in TOK.findall(base) if x != "*"]
        for k, dcl in enumerate(parts):
            dcl = dcl.strip()
            n2 = re.search(r"(\w+)\s*((?:\[[^\]]*\]\s*)*)$", dcl)
            if not n2: continue
            pre = base if k == 0 else dcl[:n2.start()]
            if "*" in pre or n2.group(2): td[n2.group(1)] = ("class", ("p", "pointer" if "*" in pre else "array"))
            else: td[n2.group(1)] = ("alias", btoks)
    return td

def param_type(p, tdefs):
    """A parameter declaration (named or not) -> (abstract type text, class, detail)."""
    p = norm(strip_attrs(p))
    if p == "...": return ("...", "E", "variadic")
    if p == "void": return ("void", "v", "")
    fp = re.search(r"\(\s*\*\s*(?:const\s+)?(\w*)\s*\)\s*\(", p)
    if fp:                                                                      # R (*name)(args)
        return (norm(p[:fp.start(1)] + p[fp.end(1):]), "p", "function pointer")
    arr = re.search(r"(\w+)?\s*((?:\[[^\]]*\]\s*)+)$", p)
    if arr and "[" in p:                                                        # T name[n]: a pointer
        head = p[:arr.start()] + (arr.group(1) if arr.group(1) and (arr.group(1) in KW or arr.group(1) in tdefs or arr.group(1) in INTNAMES) and not p[:arr.start()].strip() else "")
        return (norm(head + " *"), "p", "array parameter")
    toks = TOK.findall(p)
    # the declared name: a trailing identifier that is not a type word, with a type before it
    if len(toks) > 1 and re.match(r"[A-Za-z_]\w*$", toks[-1]) and toks[-1] not in KW and toks[-1] not in tdefs and toks[-1] not in INTNAMES:
        named = True
    elif len(toks) > 1 and re.match(r"[A-Za-z_]\w*$", toks[-1]) and toks[-1] not in KW and toks[-2] not in QUAL and toks[-2] != "*" and (toks[-2] in tdefs or toks[-2] in INTNAMES or toks[-2] in KW) and toks[-2] not in ("unsigned", "signed", "long", "short", "struct", "union", "enum"):
        named = True                                                            # `uint32_t size_t`-style shadowing: the last one is the name
    else: named = False
    if named:
        k = p.rfind(toks[-1]); t = norm(p[:k])
    else: t = p
    if "*" in t: return (t, "p", "")
    cls, det = base_class(TOK.findall(t), tdefs)
    return (t, cls, det)

HAND_WHY = {"S": "struct/union by value", "Q": "128-bit", "V": "va_list (the guest's is the AAPCS64 struct, wasm's is a pointer)", "E": "variadic", "U": "unknown type"}

# ---------------------------------------------------------------- scan one file
class Ent:
    __slots__ = "file stem kind name cname ret rcls params why hand flags thunk line".split()

def preprocess(path, stem):
    stub = f"{A.out}/scan_stubs/{stem}"; missing = []
    for _ in range(60):
        r = subprocess.run([A.cc, "-E", "-P", "-w", "-Wno-version-check", *CFLAGS, *( [f"-I{stub}"] if missing else []), path], capture_output=True, text=True)
        if r.returncode == 0: return r.stdout, missing
        new = re.findall(r"fatal error: '([^']+)' file not found", r.stderr)
        if not new: sys.exit(f"gen_hle: cannot preprocess {path}:\n" + "\n".join(r.stderr.splitlines()[:5]))
        for h in new:
            missing.append(h); q = os.path.join(stub, h); os.makedirs(os.path.dirname(q), exist_ok=True); open(q, "w").close()
    sys.exit(f"gen_hle: {path}: too many missing headers")

ENTRY = re.compile(r"\bstatic\s+const\s+(hle_ent|hle_force_ent|nvn_impl)\s+(\w+)\s*=\s*\{")
def scan(path):
    stem = re.sub(r"\W", "_", os.path.splitext(os.path.basename(path))[0])
    text, missing = preprocess(path, stem)
    m = mask(text)
    tdefs = collect_typedefs(m)
    ents = []
    for e in ENTRY.finditer(m):
        a = e.end() - 1; b = match_close(m, a)
        fields = [(s0, s1) for s0, s1 in _spans(m, a + 1, b)]
        if len(fields) < 2: continue
        name_lits = STR.findall(text[fields[0][0]:fields[0][1]])
        if not name_lits: continue                       # not a literal entry (a table built at run time)
        name = "".join(x[1:-1] for x in name_lits)
        if "\\" in name: sys.exit(f"gen_hle: {path}: escape in a symbol name: {name}")
        fn = re.findall(r"[A-Za-z_]\w*", m[fields[1][0]:fields[1][1]])[-1]
        why = " ".join(STR.findall(text[fields[2][0]:fields[2][1]])) if len(fields) > 2 else ""
        sec = re.findall(r'section\("__DATA,(\w+)"\)', text[max(0, e.start() - 160):e.start()])
        sec = sec[-1] if sec else "?"
        x = Ent(); x.file = os.path.basename(path); x.stem = stem; x.name = name; x.why = why; x.hand = None; x.line = 0
        x.cname = fn
        if sec == "swnvn":
            x.kind = "NVN" if re.search(r"\bchk_%s\b" % re.escape(name), m) else "NVN_NOPROTO"; x.flags = "NX_HLE_NVN"
        elif sec == "swforce":
            if fn.endswith("_bs") and re.search(r"\bextern\s+const\s+char\s+%s\s*\[" % re.escape(fn), m):
                x.cname = fn[:-3]; x.kind = "HLE_FORCE_BIG"; x.flags = "NX_HLE_FORCE | NX_HLE_BIG"
            else: x.kind = "HLE_FORCE"; x.flags = "NX_HLE_FORCE"
        elif sec == "swhle":
            if e.group(2).startswith("hle_lib_"): x.kind = "LIBC"; x.flags = "NX_HLE_IMPORT | NX_HLE_LIBC"
            else: x.kind = "HLE"; x.flags = "NX_HLE_IMPORT"
        else: x.kind = "?" + sec; x.flags = "0"
        # the prototype
        if x.kind == "LIBC":
            pm = re.search(r"(?:^|[;}])[ \t]*((?:[\w \t\*]|__attribute__\s*\(\([^()]*\)\))+?)\b%s[ \t]*\(" % re.escape(x.cname), m, re.M)
        else:
            pm = re.search(r"\bstatic\s+([^;{}()=,]*?)\b%s\s*\(" % re.escape(x.cname), m)
        if not pm:
            x.ret = "?"; x.rcls = "U"; x.params = []; x.hand = "no prototype found"; ents.append(x); continue
        pa = pm.end() - 1; pb = match_close(m, pa)
        rtxt = norm(strip_attrs(pm.group(1)))
        rtxt = norm(re.sub(r"\b(extern|static)\b", " ", rtxt))
        x.ret = rtxt
        if "*" in rtxt: x.rcls = "p"
        else: x.rcls, det = base_class(TOK.findall(rtxt), tdefs);
        plist = [q for q in split_top(m[pa + 1:pb]) if q.strip()]
        x.params = [param_type(q, tdefs) for q in plist]
        if len(x.params) == 1 and x.params[0][1] == "v": x.params = []
        reasons = []
        if "naked" in m[max(0, pm.start() - 60):pm.start()] or re.search(r"__attribute__\s*\(\(\s*naked\s*\)\)\s*static\s+[^;{}()]*\b%s\s*\(" % re.escape(x.cname), m):
            reasons.append("naked assembly function (its ABI is not its C type)")
        if x.rcls in HAND_WHY:
            reasons.append(f"returns {HAND_WHY[x.rcls]} ({x.ret})")
        for t, c, det in x.params:
            if c in HAND_WHY: reasons.append(f"parameter {HAND_WHY[c]} ({t})")
        if reasons: x.hand = "; ".join(dict.fromkeys(reasons))
        ents.append(x)
    # source lines, for the report (names made by token pasting are not in the source: 0)
    try:
        src = open(path, encoding="utf-8", errors="replace").read().splitlines()
        first = {}
        for n, l in enumerate(src, 1):
            for w in set(re.findall(r"\b\w+\b", l)): first.setdefault(w, n)
        for x in ents: x.line = first.get(x.cname if x.kind != "NVN" and x.kind != "NVN_NOPROTO" else x.name, 0)
    except OSError: pass
    return path, stem, ents, missing, bool(re.search(r"\}\s*hle_force_ent\s*;", m))

def _spans(m, a, b):
    """Top-level comma separated spans of m[a:b]."""
    d, s = 0, a
    for j in range(a, b):
        c = m[j]
        if c in OPEN: d += 1
        elif c in CLOSE: d -= 1
        elif c == "," and d == 0: yield (s, j); s = j + 1
    yield (s, b)

# ---------------------------------------------------------------- thunks
def thunk(x):
    sym = f"nxt_{x.stem}_{x.cname}"; x.thunk = sym
    L = [f"#ifndef NXT_HAVE_{x.cname}"]
    if x.hand:
        esc = x.hand.replace("\\", "\\\\").replace('"', '\\"')
        L += [f"void {sym}(uint64_t *ctx) {{ (void)ctx; nx_hle_hand_missing(\"{x.name}\", \"{esc}\"); }}", "#endif"]
        return "\n".join(L)
    ni = nf = ns = 0; args = []; chk = []
    for t, c, det in x.params:
        if c in ("i", "b", "p"):
            src = f"ctx[{ni}]" if ni < 8 else f"nx_stk(ctx, {ns})"
            if ni >= 8: ns += 1
            ni += 1
            if c == "p": args.append(f"({t})(uintptr_t){src}"); chk.append(f"NX_CHK_P({t});")
            elif c == "b": args.append(f"({t})((uint8_t){src} != 0)"); chk.append(f"NX_CHK_I({t});")
            else: args.append(f"({t}){src}"); chk.append(f"NX_CHK_I({t});")
        else:
            w = "32" if c == "f" else "64"
            if nf < 8: args.append(f"nx_f{w}(ctx, {nf})")
            else: args.append(f"nx_stk_f{w}(ctx, {ns})"); ns += 1
            nf += 1; chk.append(f"NX_CHK_{'F' if c == 'f' else 'D'}({t});")
    call = f"{x.cname}({', '.join(args)})"
    if x.rcls == "v": body = f"{call};"
    elif x.rcls == "p": body = f"ctx[0] = (uint64_t)(uintptr_t){call};"; chk.append(f"NX_CHK_P({x.ret});")
    elif x.rcls in ("i", "b"): body = f"ctx[0] = (uint64_t){call};"; chk.append(f"NX_CHK_I({x.ret});")
    elif x.rcls == "f": body = f"nx_ret_f32(ctx, {call});"; chk.append(f"NX_CHK_F({x.ret});")
    else: body = f"nx_ret_f64(ctx, {call});"; chk.append(f"NX_CHK_D({x.ret});")
    chk = list(dict.fromkeys(chk))
    if chk: L.append(" ".join(chk))
    L += [f"void {sym}(uint64_t *ctx) {{ {'(void)ctx; ' if not args and x.rcls == 'v' else ''}{body} }}", "#endif"]
    return "\n".join(L)

def sig(x): return (x.rcls if x.rcls != "b" else "i") + "(" + "".join("i" if c == "b" else c for _, c, _ in x.params) + ")"

# ---------------------------------------------------------------- main
with ThreadPoolExecutor(A.j) as ex: scanned = list(ex.map(scan, A.files))
allents = []
for path, stem, ents, missing, has_hle_h in scanned:
    if missing: print(f"gen_hle: {os.path.basename(path)}: scanned with empty stand-ins for {len(missing)} missing header(s): {' '.join(missing)}", file=sys.stderr)
    names = collections.Counter(x.cname for x in ents)
    for x in ents:
        if names[x.cname] > 1 and not x.hand and len({(y.ret, tuple(y.params)) for y in ents if y.cname == x.cname}) > 1: x.hand = "two entries share the C name with different prototypes"
    body = [f"// Generated by tools/gen_hle.py from {os.path.basename(path)}; do not edit. Included at the end of {stem}.tu.c."]
    seen = set()
    for x in ents:
        t = thunk(x)
        if x.thunk in seen: continue            # one function registered under several names: one thunk
        seen.add(x.thunk); body.append(t)
    allents += ents
    if not A.no_gen:
        os.makedirs(A.out, exist_ok=True)
        open(f"{A.out}/{stem}.thunks.inc", "w").write("\n".join(body) + "\n")
        hand = f"{A.hand}/{stem}.inc"
        open(f"{A.out}/{stem}.tu.c", "w").write(
            f"// Generated by tools/gen_hle.py; do not edit. {os.path.basename(path)} with its HLE thunks in one translation unit.\n"
            + ("" if has_hle_h else "#define NX_HLE_NO_NXNATIVE 1   // this file does not include hle.h (it has its own hle_ent)\n")
            + f"#include \"nx_hle.h\"\n#include \"{os.path.abspath(path)}\"\n"
            + (f"#include \"{os.path.abspath(hand)}\"   // hand-written thunks\n" if os.path.exists(hand) else "")
            + f"#include \"{stem}.thunks.inc\"\n")

allents.sort(key=lambda x: (x.name.encode(), 0 if "FORCE" in x.flags else 1, x.stem))
if not A.no_gen:
    T = ["// Generated by tools/gen_hle.py; do not edit. Replaces nxnative's Mach-O sections swhle / swforce / swnvn.",
         "#define NX_HLE_NO_NXNATIVE 1", "#include \"nx_hle.h\"", "#include <stdio.h>", "#include <stdlib.h>", ""]
    for s in sorted({x.thunk for x in allents}): T.append(f"nx_hle_thunk {s};")
    T += ["", "const nx_hle_ent nx_hle_table[] = {   // sorted by name (strcmp order)"]
    for x in allents:
        have = os.path.exists(f"{A.hand}/{x.stem}.inc") and f"NXT_HAVE_{x.cname} " in open(f"{A.hand}/{x.stem}.inc").read()
        fl = x.flags + (" | NX_HLE_HAND" if x.hand and not have else "")
        T.append(f"    {{\"{x.name}\", {x.thunk}, {fl}, {x.why if x.why else '0'}}},")
    T += ["};", f"const unsigned nx_hle_count = {len(allents)};", "",
          "const nx_hle_ent *nx_hle_find(const char *mangled) {",
          "    unsigned lo = 0, hi = nx_hle_count;",
          "    while (lo < hi) { unsigned mid = lo + (hi - lo) / 2; if (strcmp(nx_hle_table[mid].name, mangled) < 0) lo = mid + 1; else hi = mid; }",
          "    return lo < nx_hle_count && !strcmp(nx_hle_table[lo].name, mangled) ? &nx_hle_table[lo] : NULL;",
          "}",
          "const nx_hle_ent *nx_hle_find_kind(const char *mangled, uint32_t mask) {",
          "    for (const nx_hle_ent *e = nx_hle_find(mangled); e && e < nx_hle_table + nx_hle_count && !strcmp(e->name, mangled); e++) if (e->flags & mask) return e;",
          "    return NULL;",
          "}",
          "__attribute__((weak)) _Noreturn void nx_hle_hand_missing(const char *name, const char *why) {",
          "    fprintf(stderr, \"nx_hle: %s needs a hand-written thunk (%s) and has none\\n\", name, why); abort();",
          "}", ""]
    open(f"{A.out}/hle_table.c", "w").write("\n".join(T))

for x in sorted(allents, key=lambda x: (x.file, x.line, x.name)):
    print("\t".join([f"{x.file}:{x.line}", x.kind, x.name, x.cname, x.ret, ", ".join(t for t, _, _ in x.params) or "void", sig(x), "auto" if not x.hand else "hand: " + x.hand]))

kinds = collections.Counter(x.kind for x in allents)
hand = [x for x in allents if x.hand]
why = collections.Counter()
for x in hand:
    for r in x.hand.split("; "): why[re.sub(r" \(.*\)$", "", r)] += 1
dups = [n for n, c in collections.Counter((x.name, x.flags.split(" ")[0]) for x in allents).items() if c > 1]
print(f"gen_hle: {len(allents)} entries in {len(scanned)} files: " + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())), file=sys.stderr)
print(f"gen_hle: auto {len(allents) - len(hand)}, hand {len(hand)}" + ("".join(f"\n    {n:4d}  {r}" for r, n in why.most_common())), file=sys.stderr)
ov = sum(1 for x in allents if not x.hand and (sum(1 for _, c, _ in x.params if c in "ibp") > 8 or sum(1 for _, c, _ in x.params if c in "fd") > 8))
print(f"gen_hle: {ov} auto entries take arguments from the guest stack; {sum(1 for x in allents if not x.hand and (x.rcls in 'fd' or any(c in 'fd' for _, c, _ in x.params)))} use floating-point registers", file=sys.stderr)
if dups: print(f"gen_hle: {len(dups)} names registered more than once in the same table kind: " + " ".join(n for n, _ in dups[:8]), file=sys.stderr)
