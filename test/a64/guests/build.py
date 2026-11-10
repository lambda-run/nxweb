#!/usr/bin/env python3
"""Build the translator's own test guests (test/a64/guests/*.c) into out/ as flat images with
sidecars (contract test ABI). Expected output comes from the Unicorn reference runner tools/ref_run.py.

Two instruction sets. The default is the first Switch's (-mcpu=cortex-a57, reference model Cortex-A57). A source
with a line `// ISA: a78c` needs the Switch 2's (-mcpu=cortex-a78c: LSE, RCPC, FP16, DotProd, RDM, pointer
authentication; return addresses signed with the B key, leaf functions too, so PACIBSP / RETAB are everywhere) and is
built only that way, as NAME.a78c.O0 / .O2; the sources in A78C_TOO are built that way in addition (.a78c.O2).
Such an image's sidecar says "cpu": "max": the reference runs it on Unicorn's model with every extension, where the
authentication keys are disabled, which is the translator's contract (docs/CONTRACT.md)."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
# A64_GUEST_BASE / A64_GUEST_LD / A64_GUEST_OUT: the same programs linked at another address into another
# directory (build_hi.py: above 4 GB, for the memory64 mode)
OUT = os.environ.get("A64_GUEST_OUT") or os.path.join(HERE, "out")
LD = os.environ.get("A64_GUEST_LD") or os.path.join(HERE, "guest.ld")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import ref_run  # noqa: E402
BASE = int(os.environ.get("A64_GUEST_BASE", "0x08000000"), 0)
STACK_TOP = BASE + 0x100000
os.makedirs(OUT, exist_ok=True)
GEN = os.path.join(HERE, "gen")
os.makedirs(GEN, exist_ok=True)
if "--big" in sys.argv:   # larger-code check: generated, about 300k instructions
    subprocess.check_call([sys.executable, os.path.join(HERE, "big_gen.py"), os.path.join(GEN, "big.c")])
    SOURCES = [(os.path.join(GEN, "big.c"), ("O1",), BASE + 0x800000, os.path.join(HERE, "out_big"))]
else:
    SOURCES = [(os.path.join(HERE, f), ("O0", "O2"), STACK_TOP, OUT) for f in sorted(os.listdir(HERE)) if f.endswith(".c")]
A57 = ["-mcpu=cortex-a57"]
A78C = ["-mcpu=cortex-a78c", "-mbranch-protection=pac-ret+b-key+leaf", "-mno-outline-atomics"]
A78C_TOO = ("deep.c", "fploop.c", "jmp.c", "jmp2.c", "recursion.c", "sort.c", "vecloop.c")
for path, opts, STACK_TOP, OUT in SOURCES:
    os.makedirs(OUT, exist_ok=True)
    src = os.path.basename(path)
    only78 = any(l.strip() == "// ISA: a78c" for l in open(path))
    variants = [("a78c." + o, o, A78C, "max") for o in opts] if only78 else [(o, o, A57, None) for o in opts]
    if src in A78C_TOO:
        variants.append(("a78c.O2", "O2", A78C, "max"))
    for vname, opt, isa, cpu in variants:
        name = "a64_%s.%s" % (src[:-2], vname)
        elf = os.path.join(OUT, name + ".elf")
        obj = os.path.join(OUT, name + ".o")
        subprocess.check_call(["clang", "--target=aarch64-none-elf", "-ffreestanding", "-nostdlib"] + isa + ["-" + opt,
                               "-fno-math-errno", "-w", "-c", path, "-o", obj])
        subprocess.check_call(["ld.lld", "-T", LD, obj, "-o", elf])
        subprocess.check_call(["llvm-objcopy", "-O", "binary", elf, os.path.join(OUT, name + ".bin")])
        nm = subprocess.check_output(["llvm-nm", elf], text=True)
        bss_end = next(int(l.split()[0], 16) for l in nm.splitlines() if l.endswith(" __bss_end"))
        image = open(os.path.join(OUT, name + ".bin"), "rb").read()
        res = ref_run.run(image, stack_top=STACK_TOP, base=BASE, count=True, cpu=cpu)
        open(os.path.join(OUT, name + ".out"), "wb").write(res.stdout)
        json.dump({"base": BASE, "entry": BASE, "image": name + ".bin", "bss_end": bss_end, "stack_top": STACK_TOP,
                   "expected_stdout": name + ".out", "exit_code": res.exit_code, "insn_count": res.insn_count, **({"cpu": cpu} if cpu else {})},
                  open(os.path.join(OUT, name + ".json"), "w"), indent=1)
        os.remove(obj)
        print("%-24s exit=%s insns=%s stdout=%d bytes" % (name, res.exit_code, res.insn_count, len(res.stdout)))

# Raw functions for the thread test (test/a64/lse_threads.ts): mt/NAME.c -> out/mt_NAME.bin, the function at offset
# 0; no reference output, the test checks invariants that hold only when the atomics are atomic.
MT = os.path.join(HERE, "mt")
if "--big" not in sys.argv:
    OUT = os.environ.get("A64_GUEST_OUT") or os.path.join(HERE, "out")
    for f in sorted(os.listdir(MT)):
        if not f.endswith(".c"):
            continue
        name = "mt_" + f[:-2]
        obj, elf = os.path.join(OUT, name + ".o"), os.path.join(OUT, name + ".elf")
        subprocess.check_call(["clang", "--target=aarch64-none-elf", "-ffreestanding", "-nostdlib"] + A78C + ["-O2", "-w", "-c", os.path.join(MT, f), "-o", obj])
        subprocess.check_call(["ld.lld", "-T", LD, "-e", "worker", obj, "-o", elf])
        subprocess.check_call(["llvm-objcopy", "-O", "binary", elf, os.path.join(OUT, name + ".bin")])
        os.remove(obj)
        print("%-24s %d bytes (thread test)" % (name, os.path.getsize(os.path.join(OUT, name + ".bin"))))
