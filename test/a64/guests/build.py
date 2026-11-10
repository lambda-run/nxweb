#!/usr/bin/env python3
"""Build the translator's own test guests (test/a64/guests/*.c) into out/ as flat images with
sidecars (contract test ABI). Expected output comes from the Unicorn reference runner tools/ref_run.py."""
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
for path, opts, STACK_TOP, OUT in SOURCES:
    os.makedirs(OUT, exist_ok=True)
    src = os.path.basename(path)
    for opt in opts:
        name = "a64_%s.%s" % (src[:-2], opt)
        elf = os.path.join(OUT, name + ".elf")
        obj = os.path.join(OUT, name + ".o")
        subprocess.check_call(["clang", "--target=aarch64-none-elf", "-ffreestanding", "-nostdlib", "-mcpu=cortex-a57", "-" + opt,
                               "-fno-math-errno", "-w", "-c", path, "-o", obj])
        subprocess.check_call(["ld.lld", "-T", LD, obj, "-o", elf])
        subprocess.check_call(["llvm-objcopy", "-O", "binary", elf, os.path.join(OUT, name + ".bin")])
        nm = subprocess.check_output(["llvm-nm", elf], text=True)
        bss_end = next(int(l.split()[0], 16) for l in nm.splitlines() if l.endswith(" __bss_end"))
        image = open(os.path.join(OUT, name + ".bin"), "rb").read()
        res = ref_run.run(image, stack_top=STACK_TOP, base=BASE, count=True)
        open(os.path.join(OUT, name + ".out"), "wb").write(res.stdout)
        json.dump({"base": BASE, "entry": BASE, "image": name + ".bin", "bss_end": bss_end, "stack_top": STACK_TOP,
                   "expected_stdout": name + ".out", "exit_code": res.exit_code, "insn_count": res.insn_count},
                  open(os.path.join(OUT, name + ".json"), "w"), indent=1)
        os.remove(obj)
        print("%-24s exit=%s insns=%s stdout=%d bytes" % (name, res.exit_code, res.insn_count, len(res.stdout)))
