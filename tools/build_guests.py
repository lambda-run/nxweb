#!/usr/bin/env python3
"""Build the ARM64 test guests and their expected outputs.

    tools/build_guests.py            build everything into test/guests/out/
    tools/build_guests.py --check    build twice, confirm byte-identical results
    tools/build_guests.py NAME...    build only the named programs (no coverage.txt)

For every test/guests/src/NAME.c three variants are built (-O0, -O2, -Os); a
NAME.S is a standalone image without crt0 and gives one variant ("asm"). Each
image is run on the Unicorn reference runner (tools/ref_run.py) twice: once
plain to produce NAME.VARIANT.out, once with block counting for insn_count
and the mnemonic coverage. Both runs must agree.

A source line `// CFLAGS: <flags>` adds compiler flags for that program.
"""
import argparse
import concurrent.futures
import filecmp
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ref_run  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUESTS = os.path.join(ROOT, "test", "guests")
RT = os.path.join(GUESTS, "rt")
SRC = os.path.join(GUESTS, "src")
VARIANTS = ["O0", "O2", "Os"]
MAX_INSNS = 20_000_000
BASE_CFLAGS = [
    "--target=aarch64-none-elf", "-ffreestanding", "-nostdlib", "-fno-pic",
    "-mcpu=cortex-a57", "-mno-outline-atomics", "-fno-math-errno",
    "-fno-unwind-tables", "-fno-asynchronous-unwind-tables",
    "-std=gnu11", "-Wall", "-Wextra", "-I" + RT,
]
RT_SOURCES = ["svc.S", "setjmp.S", "libc.c"]   # crt0.S is linked first, separately


def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("command failed: %s\n%s%s" % (" ".join(cmd), r.stdout, r.stderr))
    return r.stderr


def tool(*names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


CLANG = tool("clang", "clang-18")
LLD = tool("ld.lld", "ld.lld-18")
OBJCOPY = tool("llvm-objcopy", "llvm-objcopy-18")


def elf_symbols(path):
    """{name: value} from an ELF64 little-endian .symtab."""
    d = open(path, "rb").read()
    shoff, = struct.unpack_from("<Q", d, 0x28)
    shentsize, shnum = struct.unpack_from("<HH", d, 0x3A)
    secs = [struct.unpack_from("<IIQQQQIIQQ", d, shoff + i * shentsize) for i in range(shnum)]
    syms = {}
    for s in secs:
        if s[1] != 2:      # SHT_SYMTAB
            continue
        stroff = secs[s[6]][4]
        for off in range(s[4], s[4] + s[5], 24):
            name, _info, _other, _shndx, value, _size = struct.unpack_from("<IBBHQQ", d, off)
            end = d.index(b"\0", stroff + name)
            syms[d[stroff + name:end].decode()] = value
    return syms


def elf_to_flat(elf, out, base):
    """ELF -> flat binary. llvm-objcopy if present, else from the PT_LOAD segments."""
    if OBJCOPY:
        sh([OBJCOPY, "-O", "binary", elf, out])
        return
    d = open(elf, "rb").read()
    phoff, = struct.unpack_from("<Q", d, 0x20)
    phentsize, phnum = struct.unpack_from("<HH", d, 0x36)
    img = bytearray()
    for i in range(phnum):
        ptype, _flags, off, vaddr, _paddr, filesz, _memsz, _align = struct.unpack_from(
            "<IIQQQQQQ", d, phoff + i * phentsize)
        if ptype != 1 or filesz == 0:
            continue
        end = vaddr - base + filesz
        if len(img) < end:
            img.extend(bytes(end - len(img)))
        img[vaddr - base:end] = d[off:off + filesz]
    open(out, "wb").write(bytes(img))


def extra_cflags(src):
    flags = []
    for line in open(src):
        m = re.match(r"\s*//\s*CFLAGS:\s*(.*)", line)
        if m:
            flags += m.group(1).split()
    return flags


def build_rt(objdir, variant):
    d = os.path.join(objdir, "rt-" + variant)
    os.makedirs(d, exist_ok=True)
    objs = []
    for s in ["crt0.S"] + RT_SOURCES:
        o = os.path.join(d, s + ".o")
        sh([CLANG] + BASE_CFLAGS + ["-" + (variant if variant != "asm" else "O2"), "-c",
                                    os.path.join(RT, s), "-o", o])
        objs.append(o)
    return objs


def build_one(job):
    """Compile, link, run. Returns a dict for the manifest (runs in a worker process)."""
    name, variant, src, rt_objs, outdir, objdir = job
    stem = "%s.%s" % (name, variant)
    obj = os.path.join(objdir, stem + ".o")
    elf = os.path.join(objdir, stem + ".elf")
    binp = os.path.join(outdir, stem + ".bin")
    opt = [] if variant == "asm" else ["-" + variant]
    warnings = sh([CLANG] + BASE_CFLAGS + opt + extra_cflags(src) + ["-c", src, "-o", obj])
    # crt0 first so that _start is at offset 0; a .S program brings its own _start.
    link = rt_objs[1:] if variant == "asm" else rt_objs
    link = ([obj] + link) if variant == "asm" else ([link[0], obj] + link[1:])
    sh([LLD, "-T", os.path.join(RT, "guest.ld"), "--gc-sections", "-o", elf] + link)
    syms = elf_symbols(elf)
    base = syms["__image_start"]
    if syms["_start"] != base:
        raise RuntimeError("%s: _start is not at offset 0" % stem)
    elf_to_flat(elf, binp, base)
    image = open(binp, "rb").read()
    try:
        plain = ref_run.run(image, stack_top=syms["__stack_top"], base=base)
        counted = ref_run.run(image, stack_top=syms["__stack_top"], base=base, count=True)
    except ref_run.GuestFault as e:
        raise RuntimeError("%s: %s\nstdout so far:\n%s" % (
            stem, e, e.result.stdout[-2000:].decode("latin-1")))
    if (plain.stdout, plain.exit_code) != (counted.stdout, counted.exit_code):
        raise RuntimeError("%s: two reference runs disagree" % stem)
    open(os.path.join(outdir, stem + ".out"), "wb").write(plain.stdout)
    side = {
        "base": base,
        "entry": base,
        "image": stem + ".bin",
        "bss_end": syms["__bss_end"],
        "stack_top": syms["__stack_top"],
        "expected_stdout": stem + ".out",
        "exit_code": plain.exit_code,
        "insn_count": counted.insn_count,
    }
    with open(os.path.join(outdir, stem + ".json"), "w") as f:
        json.dump(side, f, indent=2)
        f.write("\n")
    return {
        "name": name, "variant": variant, "sidecar": stem + ".json",
        "image_bytes": len(image), "stdout_bytes": len(plain.stdout),
        "exit_code": plain.exit_code, "insn_count": counted.insn_count,
        "hist": ref_run.mnemonic_histogram(image, counted.blocks, base),
        "warnings": warnings,
    }


def build_all(outdir, only=None, jobs=None, quiet=False):
    for t, n in ((CLANG, "clang"), (LLD, "ld.lld")):
        if not t:
            sys.exit("[RED] %s not found" % n)
    os.makedirs(outdir, exist_ok=True)
    objdir = os.path.join(outdir, "obj")
    os.makedirs(objdir, exist_ok=True)
    rt = {v: build_rt(objdir, v) for v in VARIANTS + ["asm"]}
    work = []
    for fn in sorted(os.listdir(SRC)):
        name, ext = os.path.splitext(fn)
        if ext not in (".c", ".S") or (only and name not in only):
            continue
        for v in (VARIANTS if ext == ".c" else ["asm"]):
            work.append((name, v, os.path.join(SRC, fn), rt[v], outdir, objdir))
    if only:
        missing = set(only) - {w[0] for w in work}
        if missing:
            sys.exit("[RED] no such program: %s" % ", ".join(sorted(missing)))
    results, failed = [], []
    with concurrent.futures.ProcessPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(build_one, w): w for w in work}
        for fut, w in futs.items():
            try:
                results.append(fut.result())
            except Exception as e:  # noqa: BLE001
                failed.append("%s.%s: %s" % (w[0], w[1], e))
    results.sort(key=lambda r: (r["name"], VARIANTS.index(r["variant"]) if r["variant"] in VARIANTS else 9))
    for r in results:
        if r["warnings"] and not quiet:
            sys.stderr.write(r["warnings"])
        if r["insn_count"] > MAX_INSNS:
            failed.append("%s.%s: %d instructions, over the %d budget" % (
                r["name"], r["variant"], r["insn_count"], MAX_INSNS))
    if not quiet:
        print("%-16s %-4s %10s %8s %8s %5s" % ("program", "var", "insns", "image", "stdout", "exit"))
        for r in results:
            print("%-16s %-4s %10d %8d %8d %5d" % (r["name"], r["variant"], r["insn_count"],
                                                  r["image_bytes"], r["stdout_bytes"], r["exit_code"]))
    by_name = {}
    for r in results:
        by_name.setdefault(r["name"], set()).add(
            open(os.path.join(outdir, "%s.%s.out" % (r["name"], r["variant"])), "rb").read())
    for n, outs in sorted(by_name.items()):
        if len(outs) > 1 and not quiet:
            print("note: %s prints different output at different optimisation levels" % n)
    if failed:
        for f in failed:
            print("[RED] " + f, file=sys.stderr)
        sys.exit(1)
    if not only:
        write_coverage(outdir, results)
        manifest = [{k: r[k] for k in ("name", "variant", "sidecar", "exit_code", "insn_count")}
                    for r in results]
        with open(os.path.join(outdir, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=1)
            f.write("\n")
    return results


def write_coverage(outdir, results):
    total, images = {}, {}
    for r in results:
        for m, n in r["hist"].items():
            total[m] = total.get(m, 0) + n
            images[m] = images.get(m, 0) + 1
    grand = sum(total.values())
    with open(os.path.join(outdir, "coverage.txt"), "w") as f:
        f.write("# Executed instruction mnemonics (capstone names, aliases as capstone prints them)\n")
        f.write("# across all %d guest images. %d distinct mnemonics, %d instructions executed.\n"
                % (len(results), len(total), grand))
        f.write("# %-10s %12s %8s %7s\n" % ("mnemonic", "executed", "share", "images"))
        for m, n in sorted(total.items(), key=lambda kv: (-kv[1], kv[0])):
            f.write("%-12s %12d %7.3f%% %7d\n" % (m, n, 100.0 * n / grand, images[m]))


def check(jobs):
    out = os.path.join(GUESTS, "out")
    build_all(out, jobs=jobs)
    tmp = tempfile.mkdtemp(prefix="guests-check-")
    try:
        build_all(tmp, jobs=jobs, quiet=True)
        names = sorted(f for f in os.listdir(out) if os.path.isfile(os.path.join(out, f)))
        names2 = sorted(f for f in os.listdir(tmp) if os.path.isfile(os.path.join(tmp, f)))
        bad = [n for n in names if n not in names2 or
               not filecmp.cmp(os.path.join(out, n), os.path.join(tmp, n), shallow=False)]
        bad += [n for n in names2 if n not in names]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if bad:
        print("[RED] not deterministic: " + ", ".join(bad), file=sys.stderr)
        sys.exit(1)
    print("guests:check ok: %d files identical across two builds and runs" % len(names))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("names", nargs="*", help="only these programs")
    ap.add_argument("--check", action="store_true", help="build twice and compare everything")
    ap.add_argument("-j", "--jobs", type=int, default=os.cpu_count())
    ap.add_argument("--out", default=os.path.join(GUESTS, "out"))
    args = ap.parse_args()
    if args.check:
        check(args.jobs)
    else:
        build_all(args.out, only=args.names or None, jobs=args.jobs)


if __name__ == "__main__":
    main()
