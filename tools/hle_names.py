#!/usr/bin/env python3
"""The take-over inventory: every SDK function nxnative answers on the host, by name.

  python3 tools/hle_names.py            write test/hle/inventory.tsv, test/hle/status.tsv, src/hle/gen/table.ts and the
                                        status table in src/hle/README.md; print the counts per file
  python3 tools/hle_names.py --check    fail when a generated file is out of date

Reads nxnative's dm/host/*.c (NXNATIVE overrides /home/user/nxnative): every HLE(...), HLE_FORCE(...) and
HLE_FORCE_BIG(...), also through the wrapper macros a file defines (SKF, SSF, SSC, STPL_PAD, IKB_IGNORE, PALMA_FAIL),
the libc pass-through list of hle_table.c and table entries written out by hand (hle_offline.c's PlayReport::Send).
The graphics layers (dm/gfx) are read for the counts only.

For the files this area ports (SCOPE) it also generates src/hle/gen/table.ts: the names, the kind of each entry
and what answers it:
  hand   a function `export function <cname>(a: usize): u64` in src/hle/<file>.ts (found by scanning the sources)
  ops    a body that only stores constants, binds or signals an event, opens an applet and returns a constant is
         compiled from the C text into a few words that src/hle/ops.ts interprets
  stub   neither: one red line, then STUB_RET's value or 0
"""
import os, re, subprocess, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NX = os.environ.get("NXNATIVE", "/home/user/nxnative")
HOST = os.path.join(NX, "dm", "host")
GFX = os.path.join(NX, "dm", "gfx")
OUT_INV = os.path.join(ROOT, "test", "hle", "inventory.tsv")
OUT_STATUS = os.path.join(ROOT, "test", "hle", "status.tsv")
OUT_TABLE = os.path.join(ROOT, "src", "hle", "gen", "table.ts")
README = os.path.join(ROOT, "src", "hle", "README.md")
SRC = os.path.join(ROOT, "src", "hle")

# nxnative file -> the AssemblyScript module that ports it (src/hle/<module>.ts)
SCOPE = {
    "hle_sdkinit.c": "sdkinit", "hle_os.c": "os", "hle_oe.c": "oe", "hle_time.c": "time", "hle_account.c": "account",
    "hle_misc.c": "misc", "hle_lifecycle.c": "lifecycle", "hle_net.c": "net", "hle_offline.c": "offline",
    "hle_friends.c": "friends", "hle_mii.c": "mii", "hle_sf.c": "sf", "hle_nvdrv.c": "nvdrv", "hle_swkbd.c": "swkbd",
    "hle_web.c": "web", "hle_sdk16.c": "sdk16", "hle_table.c": "libc", "hle_count.c": "count",
}
# Not this area's, with the owner the task names
OUT_OF_SCOPE = {
    "hle_fs.c": "file system (src/fs)", "hle_audio.c": "audio", "hle_audren.c": "audio", "hle_codec.c": "audio",
    "hle_codec_video.c": "movies", "hle_movie.c": "movies", "hle_movie_av1.c": "movies", "hle_movie_avc.c": "movies",
    "hle_cheats.c": "cheats", "hle_hid.c": "controllers (src/glue/rt_hle.ts)", "hle_haptics.c": "controllers", "hle_touch.c": "controllers",
}
# A stub's result where nxnative's "nothing to do" result is evident from its code (cname -> value)
STUB_RET = {}

CONSTS = {
    "RES_OK": 0, "RES_FAIL": 0x2A2, "NULL": 0, "NV_ERR": 3, "SK_ENETDOWN": 50, "SK_EAI_FAIL": 4, "IRS_UNCONNECTED": 2,
    "MII_RES_NOT_FOUND": 0x87E, "MII_RES_CANCELED": 0xE7E, "MII_RES_TEST_MODE": 0x1987E, "MII_DEFAULTS": 6,
    "SWKBD_RESULT_CANCELED": 0x29F, "NFP_RES_TAG_NOT_FOUND": 115 | 97 << 9,
}
OP_STORE, OP_ZERO, OP_APPLET, OP_RED, OP_ERRNO, OP_BIND, OP_SIGNAL, OP_RET, OP_RETSTR = range(1, 10)


def strip_comments(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == "\\" else 1
            out.append(s[i:j + 1]); i = j + 1
        elif s.startswith("//", i):
            j = s.find("\n", i); i = n if j < 0 else j
        elif s.startswith("/*", i):
            j = s.find("*/", i); i = n if j < 0 else j + 2; out.append(" ")
        else:
            out.append(c); i += 1
    return "".join(out)


def split_args(s, i):
    """s[i] == '(' : the top-level comma separated arguments and the index after the closing parenthesis."""
    assert s[i] == "("
    args, depth, cur, i = [], 0, [], i + 1
    n = len(s)
    while i < n:
        c = s[i]
        if c == '"' or c == "'":
            j = i + 1
            while s[j] != c:
                j += 2 if s[j] == "\\" else 1
            cur.append(s[i:j + 1]); i = j + 1; continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                args.append("".join(cur).strip()); return args, i + 1
            depth -= 1
        elif c == "," and depth == 0:
            args.append("".join(cur).strip()); cur = []; i += 1; continue
        cur.append(c); i += 1
    raise ValueError("unbalanced parentheses")


def body_at(s, i):
    """The braces block starting at the first '{' at or after i (only white space before it): text inside, end index."""
    j = i
    while j < len(s) and s[j].isspace():
        j += 1
    if j >= len(s) or s[j] != "{":
        return None, i
    depth, k = 0, j
    while k < len(s):
        c = s[k]
        if c == '"' or c == "'":
            k += 1
            while s[k] != c:
                k += 2 if s[k] == "\\" else 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[j + 1:k], k + 1
        k += 1
    raise ValueError("unbalanced braces")


def sub_outside_strings(text, mapping):
    parts = re.split(r'("(?:\\.|[^"\\])*")', text)
    for k in range(0, len(parts), 2):
        parts[k] = re.sub(r"\b[A-Za-z_]\w*\b", lambda m: mapping.get(m.group(0), m.group(0)), parts[k])
    return "".join(parts)


def cstr(lit):
    """The value of adjacent C string literals."""
    out = []
    for m in re.finditer(r'"((?:\\.|[^"\\])*)"', lit):
        out.append(m.group(1))
    s = "".join(out)
    return bytes(s, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8", "replace") if "\\" in s else s


def parse_file(path):
    name = os.path.basename(path)
    raw = open(path, encoding="utf-8", errors="replace").read()
    text = strip_comments(raw).replace("\\\n", " ")
    macros, alias, lines = {}, {}, []
    for ln in text.split("\n"):
        m = re.match(r"\s*#\s*define\s+(\w+)\(([^)]*)\)\s*(.*)$", ln)
        if m and re.search(r"\bHLE(_FORCE(_BIG)?)?\s*\(", m.group(3)):
            macros[m.group(1)] = ([p.strip() for p in m.group(2).split(",")], m.group(3))
            continue
        m2 = re.match(r"\s*#\s*define\s+(HLE\w*)\s+(HLE\w*)\s*$", ln)
        if m2:
            alias[m2.group(1)] = m2.group(2)
        lines.append("" if ln.lstrip().startswith("#") else ln)
    text = "\n".join(lines)
    for _ in range(4):   # expand the wrapper macros
        changed = False
        for mname, (params, mbody) in macros.items():
            pos = 0
            while True:
                m = re.compile(r"\b%s\s*\(" % re.escape(mname)).search(text, pos)
                if not m:
                    break
                args, end = split_args(text, m.end() - 1)
                mp = {}
                fixed = [p for p in params if p != "..."]
                for k, p in enumerate(fixed):
                    mp[p] = args[k] if k < len(args) else ""
                mp["__VA_ARGS__"] = ", ".join(args[len(fixed):])
                exp = sub_outside_strings(mbody, mp)
                text = text[:m.start()] + exp + text[end:]
                pos = m.start() + 1
                changed = True
        if not changed:
            break
    ents = []
    for m in re.finditer(r"\b(HLE_FORCE_BIG|HLE_FORCE|HLE)\s*\(", text):
        macro = alias.get(m.group(1), m.group(1))
        args, end = split_args(text, m.end() - 1)
        if not args or not args[0].startswith('"'):
            continue
        forced = macro != "HLE"
        mangled = cstr(args[0])
        if forced:
            why, ret, cname, params = cstr(args[1]), args[2], args[3], args[4:]
        else:
            why, ret, cname, params = "", args[1], args[2], args[3:]
        body, _ = body_at(text, end)
        ents.append(dict(file=name, kind="forced" if forced else "weak", mangled=mangled, why=why, ret=ret, cname=cname,
                         params=[p for p in params if p and p != "void"], body=body or "", big=macro == "HLE_FORCE_BIG"))
    for m in re.finditer(r'hle_force_ent\s+\w+\s*=\s*\{\s*("(?:\\.|[^"\\])*")\s*,\s*\(void \*\)\s*(\w+)\s*,\s*((?:"(?:\\.|[^"\\])*"\s*)+)\}', text):
        ents.append(dict(file=name, kind="forced", mangled=cstr(m.group(1)), why=cstr(m.group(3)), ret="void", cname=m.group(2),
                         params=[], body="", big=False, manual=True))
    if name == "hle_table.c":
        for m in re.finditer(r"\bL\((\w+)\)", text):
            ents.append(dict(file=name, kind="weak", mangled=m.group(1), why="", ret="(libc)", cname="lib_" + m.group(1),
                             params=["..."], body="", big=False, libc=True))
    return ents


def demangle(names):
    for tool in ("c++filt", "llvm-cxxfilt"):
        try:
            out = subprocess.run([tool], input="\n".join(names) + "\n", capture_output=True, text=True, check=True).stdout.split("\n")
            if len(out) >= len(names):
                return out[:len(names)]
        except (OSError, subprocess.CalledProcessError):
            pass
    return list(names)


# ---------------- the micro-op compiler ----------------
def reg_classes(params):
    """[(name, type, 'x'|'d', index)] by AAPCS64: integers and pointers in x0.., float and double in d0.."""
    out, nx, nd = [], 0, 0
    for p in params:
        m = re.match(r"^(.*?)(\w+)\s*(\[\d*\])?$", p.strip())
        if not m:
            return None
        ty, nm = m.group(1).strip(), m.group(2)
        if not ty:   # a type with no name
            ty, nm = nm, ""
        if re.search(r"\b(float|double)\b", ty) and "*" not in ty:
            out.append((nm, ty, "d", nd)); nd += 1
        else:
            out.append((nm, ty, "x", nx)); nx += 1
    return out


def pointee_size(ty):
    t = re.sub(r"\bconst\b", "", ty).strip()
    if not t.endswith("*"):
        return None
    base = t[:-1].strip()
    if base.endswith("*"):
        return 8
    return {"int": 4, "int32_t": 4, "uint32_t": 4, "unsigned": 4, "unsigned int": 4, "Result": 4, "uint64_t": 8, "int64_t": 8,
            "size_t": 8, "unsigned long": 8, "long": 8, "uint8_t": 1, "int8_t": 1, "char": 1, "bool": 1, "uint16_t": 2, "int16_t": 2}.get(base)


def const_value(e):
    e = e.strip()
    while e.startswith("(") and e.endswith(")"):
        e = e[1:-1].strip()
    if e in CONSTS:
        return CONSTS[e]
    m = re.match(r"^(-?)(0[xX][0-9a-fA-F]+|\d+)[uUlL]*$", e)
    if m:
        v = int(m.group(2), 0)
        return -v if m.group(1) else v
    if re.match(r'^nfp_no_tag\("[^"]*"\)$', e):
        return CONSTS["NFP_RES_TAG_NOT_FOUND"]
    return None


RET64 = {"uint64_t", "int64_t", "size_t", "long", "unsigned long", "void *", "const void *", "const char *", "char *"}


def compile_ops(e, strings):
    """The op words of an entry whose C body is simple enough, else None."""
    if e.get("manual") or e.get("libc"):
        return None
    regs = reg_classes(e["params"])
    if regs is None:
        return None
    byname = {r[0]: r for r in regs}
    ret64 = e["ret"].strip() in RET64 or e["ret"].strip().endswith("*")
    body = e["body"]
    ops, returned = [], False

    def sref(text):
        return strings.setdefault(text, len(strings))

    # statements at the top level; `if (...) stmt` stays one statement
    stmts, depth, cur, i = [], 0, [], 0
    while i < len(body):
        c = body[i]
        if c == '"' or c == "'":
            j = i + 1
            while body[j] != c:
                j += 2 if body[j] == "\\" else 1
            cur.append(body[i:j + 1]); i = j + 1; continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == ";" and depth == 0:
            stmts.append("".join(cur).strip()); cur = []
        else:
            cur.append(c)
        i += 1
    if "".join(cur).strip():
        return None

    def ptr_arg(nm):
        r = byname.get(nm)
        if not r or r[2] != "x" or r[3] > 7:
            return None
        return r

    def log_stmt(s):
        m = re.match(r'^LOG\((.*)\)$', s, re.S)
        if not m:
            return False
        args, _ = split_args("(" + m.group(1) + ")", 0)
        text = cstr(args[0])
        if text.startswith("[RED] "):
            if len(args) > 1 or "%" in text:
                return None
            ops.extend([OP_RED, sref(text)])
        return True

    for s in stmts:
        if returned:
            return None
        if not s or re.match(r"^\(void\)\s*\w+$", s) or re.match(r"^static (_Atomic )?int \w+$", s):
            continue
        m = re.match(r'^DM_APPLET\("([^"]*)"\)$', s)
        if m:
            ops.extend([OP_APPLET, sref(m.group(1))]); continue
        m = re.match(r"^if \(!(\w+)\+\+\) (LOG\(.*\))$", s, re.S)
        if m:
            r = log_stmt(m.group(2))
            if r is None:
                return None
            continue
        if s.startswith("LOG("):
            r = log_stmt(s)
            if not r:
                return None
            continue
        m = re.match(r"^(?:if \((\w+)\) )?\*(\w+) = (.+)$", s)
        if m and (m.group(1) is None or m.group(1) == m.group(2)):
            r, v = ptr_arg(m.group(2)), const_value(m.group(3))
            size = pointee_size(r[1]) if r else None
            if r is None or v is None or size is None:
                return None
            v &= (1 << (8 * size)) - 1
            ops.extend([OP_STORE, r[3] | size << 8 | (1 if m.group(1) else 0) << 16, v & 0xFFFFFFFF, v >> 32]); continue
        m = re.match(r"^memset\((\w+), 0, (\w+)\)$", s)
        if m and ptr_arg(m.group(1)) and const_value(m.group(2)) is not None:
            ops.extend([OP_ZERO, ptr_arg(m.group(1))[3], const_value(m.group(2))]); continue
        m = re.match(r"^hle_bind_system_event\((\w+), (\d)\)$", s)
        if m and ptr_arg(m.group(1)):
            ops.extend([OP_BIND, ptr_arg(m.group(1))[3], int(m.group(2))]); continue
        m = re.match(r"^hle_signal_system_event\((\w+)\)$", s)
        if m and ptr_arg(m.group(1)):
            ops.extend([OP_SIGNAL, ptr_arg(m.group(1))[3]]); continue
        m = re.match(r"^t_skerr = (\w+)$", s)
        if m and const_value(m.group(1)) is not None:
            ops.extend([OP_ERRNO, const_value(m.group(1))]); continue
        m = re.match(r"^return (.+)$", s, re.S)
        if m:
            x = m.group(1).strip()
            if x == "sk_fail()":
                ops.extend([OP_ERRNO, 50]); v = -1
            elif re.match(r'^"[^"]*"$', x):
                ops.extend([OP_RETSTR, sref(cstr(x))]); returned = True; continue
            else:
                v = const_value(x)
                if v is None:
                    return None
            v &= 0xFFFFFFFFFFFFFFFF if ret64 else 0xFFFFFFFF
            ops.extend([OP_RET, v & 0xFFFFFFFF, v >> 32]); returned = True; continue
        return None
    if not returned:
        ops.extend([OP_RET, 0, 0])
    return ops


def hand_functions():
    """cname -> True for each `export function <cname>(a: usize): u64` in src/hle/<module>.ts"""
    found = {}
    for mod in set(SCOPE.values()):
        p = os.path.join(SRC, mod + ".ts")
        if not os.path.exists(p):
            continue
        for m in re.finditer(r"^export function (\w+)\(a: usize\): u64", open(p).read(), re.M):
            found[(mod, m.group(1))] = True
    return found


def ts_bytes(b):
    return ",".join(str(x) for x in b)


def main():
    check = "--check" in sys.argv
    files = sorted(f for f in os.listdir(HOST) if f.endswith(".c"))
    ents = []
    for f in files:
        ents.extend(parse_file(os.path.join(HOST, f)))
    gfx_counts = {}
    for d, _, fs in sorted(os.walk(GFX)):
        for f in sorted(fs):
            if f.endswith((".c", ".m")) and "/tests" not in d and "/tools" not in d:
                try:
                    n = len(parse_file(os.path.join(d, f)))
                except Exception:
                    n = 0
                raw = open(os.path.join(d, f), encoding="utf-8", errors="replace").read()
                tbl = len(re.findall(r"^\s*(?:GL|VK|GLB|VKB|GL_BIG|VK_BIG)\w*\(", raw, re.M)) if f in ("hle_gl.m", "hle_vk.m") else 0
                if n or tbl:
                    gfx_counts[os.path.relpath(os.path.join(d, f), os.path.join(NX, "dm"))] = (n, tbl)
    dem = demangle([e["mangled"] for e in ents])
    for e, d in zip(ents, dem):
        e["demangled"] = d

    # ---- inventory.tsv ----
    inv = ["file\tkind\tmangled\tdemangled\tsignature\treason"]
    for e in ents:
        sig = "%s %s(%s)" % (e["ret"], e["cname"], ", ".join(e["params"]) or "void")
        inv.append("\t".join([e["file"], e["kind"], e["mangled"], e["demangled"], sig, e["why"].replace("\t", " ")]))
    inv_text = "\n".join(inv) + "\n"

    # ---- in scope: what answers each entry ----
    hand = hand_functions()
    strings = {}
    scope = [e for e in ents if e["file"] in SCOPE]
    forced_names = {e["mangled"] for e in scope if e["kind"] == "forced"}
    seen = {}
    for e in scope:
        mod = SCOPE[e["file"]]
        e["mod"] = mod
        key = (e["mangled"], e["kind"])
        e["dup"] = key in seen
        seen.setdefault(key, e)
        e["shadowed"] = e["kind"] == "weak" and e["mangled"] in forced_names
        if (mod, e["cname"]) in hand:
            e["how"] = "hand"
        else:
            ops = compile_ops(e, strings)
            if ops is not None:
                e["how"], e["ops"] = "ops", ops
            else:
                e["how"] = "stub"
    status = ["file\tmangled\tkind\tstatus\tcname"]
    for e in ents:
        st = e.get("how") or ("out of scope: " + OUT_OF_SCOPE.get(e["file"], "not assigned to src/hle"))
        status.append("\t".join([e["file"], e["mangled"], e["kind"], {"hand": "implemented", "ops": "implemented (from the C body)", "stub": "stub"}.get(st, st), e["cname"]]))
    status_text = "\n".join(status) + "\n"

    # ---- table.ts ----
    names, dnames, name_off, dname_off = bytearray(), bytearray(), [], []
    for e in scope:
        name_off.append(len(names)); names += e["mangled"].encode() + b"\0"
        dname_off.append(len(dnames)); dnames += e["demangled"].encode() + b"\0"
    strblob, str_off = bytearray(), {}
    for s, k in sorted(strings.items(), key=lambda kv: kv[1]):
        str_off[k] = len(strblob); strblob += s.encode() + b"\0"
    opwords, op_off = [], []
    for e in scope:
        if e["how"] == "ops":
            op_off.append(len(opwords))
            w = list(e["ops"]); i = 0
            while i < len(w):   # string indices -> blob offsets
                op = w[i]
                if op in (OP_APPLET, OP_RED, OP_RETSTR):
                    w[i + 1] = str_off[w[i + 1]]
                i += {OP_STORE: 4, OP_ZERO: 3, OP_APPLET: 2, OP_RED: 2, OP_ERRNO: 2, OP_BIND: 3, OP_SIGNAL: 2, OP_RET: 3, OP_RETSTR: 2}[op]
            opwords += w
        else:
            op_off.append(0xFFFFFFFF)
    order = sorted(range(len(scope)), key=lambda i: (scope[i]["mangled"].encode(), 0 if scope[i]["kind"] == "forced" else 1, i))
    mods = sorted({e["mod"] for e in scope if e["how"] == "hand"})
    T = []
    T.append("// Generated by tools/hle_names.py from nxnative's dm/host/*.c. Do not edit; run `npm run hle:names`.")
    T.append("// The take-over table of src/hle: names, flags, the compiled bodies and the dispatch to the hand-written functions.")
    for m in mods:
        T.append('import * as %s from "../%s";' % (m, m))
    T.append("")
    T.append("export const COUNT: i32 = %d;" % len(scope))
    T.append("export const F_FORCED: u32 = 1, F_IMPL: u32 = 2, F_SHADOWED: u32 = 8, F_OPS: u32 = 16, F_DUP: u32 = 32;")
    T.append("export const NAMES: usize = memory.data<u8>([%s]);" % ts_bytes(names))
    T.append("export const DNAMES: usize = memory.data<u8>([%s]);" % ts_bytes(dnames))
    T.append("export const STRINGS: usize = memory.data<u8>([%s]);" % ts_bytes(strblob or b"\0"))
    T.append("export const NAME_OFF: usize = memory.data<u32>([%s]);" % ts_bytes(name_off))
    T.append("export const DNAME_OFF: usize = memory.data<u32>([%s]);" % ts_bytes(dname_off))
    flags = []
    for e in scope:
        f = (1 if e["kind"] == "forced" else 0) | (2 if e["how"] != "stub" else 0) | (8 if e["shadowed"] else 0) | (16 if e["how"] == "ops" else 0) | (32 if e["dup"] else 0)
        flags.append(f)
    T.append("export const FLAGS: usize = memory.data<u8>([%s]);" % ts_bytes(flags))
    T.append("export const OP_OFF: usize = memory.data<u32>([%s]);" % ts_bytes(op_off))
    T.append("export const OPS: usize = memory.data<u32>([%s]);" % ts_bytes(opwords or [0]))
    T.append("export const SORTED: usize = memory.data<u16>([%s]);" % ts_bytes(order))
    T.append("export const STUB_RET: usize = memory.data<u64>([%s]);" % ts_bytes([STUB_RET.get(e["cname"], 0) & 0xFFFFFFFFFFFFFFFF for e in scope]))
    T.append("")
    T.append("// The hand-written function of an entry; `found` stays false for the others")
    T.append("export let found: bool = false;")
    T.append("export function dispatch(id: i32, a: usize): u64 {")
    T.append("  found = true;")
    T.append("  switch (id) {")
    for i, e in enumerate(scope):
        if e["how"] == "hand":
            T.append("    case %d: return %s.%s(a);" % (i, e["mod"], e["cname"]))
    T.append("    default: found = false; return 0;")
    T.append("  }")
    T.append("}")
    table_text = "\n".join(T) + "\n"

    # ---- counts ----
    per = {}
    for e in ents:
        c = per.setdefault(e["file"], dict(weak=0, forced=0, hand=0, ops=0, stub=0))
        c[e["kind"]] += 1
        if "how" in e:
            c[e["how"]] += 1
    rows = ["| nxnative file | entries | forced | weak | implemented by hand | implemented from the C body | stubbed (red) | |",
            "|---|---|---|---|---|---|---|---|"]
    tot = dict(n=0, forced=0, weak=0, hand=0, ops=0, stub=0)
    for f in sorted(per):
        c = per[f]; n = c["weak"] + c["forced"]
        if f in SCOPE:
            rows.append("| `%s` | %d | %d | %d | %d | %d | %d | `src/hle/%s.ts` |" % (f, n, c["forced"], c["weak"], c["hand"], c["ops"], c["stub"], SCOPE[f]))
            for k in ("forced", "weak", "hand", "ops", "stub"):
                tot[k] += c[k]
            tot["n"] += n
    for f in sorted(SCOPE):
        if f not in per:
            rows.append("| `%s` | 0 | 0 | 0 | 0 | 0 | 0 | no table entries (see below) |" % f)
    rows.append("| **in scope** | **%d** | **%d** | **%d** | **%d** | **%d** | **%d** | |" % (tot["n"], tot["forced"], tot["weak"], tot["hand"], tot["ops"], tot["stub"]))
    out_n = 0
    for f in sorted(per):
        if f not in SCOPE:
            c = per[f]; n = c["weak"] + c["forced"]; out_n += n
            rows.append("| `%s` | %d | %d | %d | | | | out of scope: %s |" % (f, n, c["forced"], c["weak"], OUT_OF_SCOPE.get(f, "not assigned to src/hle")))
    rows.append("| **dm/host total** | **%d** | | | | | | %d out of scope |" % (tot["n"] + out_n, out_n))
    for f, (n, tbl) in sorted(gfx_counts.items()):
        rows.append("| `%s` | %d | | | | | | graphics, counted only%s |" % (f, n + tbl, " (%d of them pass-through table rows)" % tbl if tbl else ""))
    table_md = "\n".join(rows)

    outputs = [(OUT_INV, inv_text), (OUT_STATUS, status_text), (OUT_TABLE, table_text)]
    if os.path.exists(README):
        r = open(README).read()
        a, b = "<!-- status:begin -->", "<!-- status:end -->"
        if a in r and b in r:
            outputs.append((README, r[:r.index(a) + len(a)] + "\n" + table_md + "\n" + r[r.index(b):]))
    stale = []
    for p, t in outputs:
        old = open(p).read() if os.path.exists(p) else None
        if old != t:
            stale.append(os.path.relpath(p, ROOT))
            if not check:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                open(p, "w").write(t)
    if check:
        for s in stale:
            print("[RED] hle:names: %s is out of date (run `npm run hle:names`)" % s)
        sys.exit(1 if stale else 0)

    print("%-22s %7s %6s %5s | %5s %5s %5s" % ("file", "entries", "forced", "weak", "hand", "ops", "stub"))
    for f in sorted(per):
        c = per[f]
        tail = "%5d %5d %5d" % (c["hand"], c["ops"], c["stub"]) if f in SCOPE else "out of scope"
        print("%-22s %7d %6d %5d | %s" % (f, c["weak"] + c["forced"], c["forced"], c["weak"], tail))
    print("%-22s %7d %6d %5d | %5d %5d %5d" % ("in scope", tot["n"], tot["forced"], tot["weak"], tot["hand"], tot["ops"], tot["stub"]))
    print("dm/host total %d (%d out of scope)" % (tot["n"] + out_n, out_n))
    for f, (n, tbl) in sorted(gfx_counts.items()):
        print("%-28s %5d (graphics, counted only)" % (f, n + tbl))
    dups = [e for e in scope if e["dup"]]
    for e in dups:
        print("duplicate name in scope: %s (%s %s)" % (e["mangled"], e["file"], e["kind"]))
    if "--stubs" in sys.argv:
        for e in scope:
            if e["how"] == "stub":
                print("stub: %s %s" % (e["file"], e["cname"]))


if __name__ == "__main__":
    main()
