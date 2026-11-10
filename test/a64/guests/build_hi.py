#!/usr/bin/env python3
"""Both guest corpora (test/guests/src and test/a64/guests/*.c) linked above 4 GB, for the translator's memory64
mode: image, bss and stack at 0x1_8000_0000, expected output from the Unicorn reference runner at that address.

    python3 test/a64/guests/build_hi.py [--force]     -> test/a64/guests/out_hi/

The programs are the same sources as the usual corpora; only the link address differs (the linker scripts are
copied with the base replaced). A translator that dropped the upper half of an address anywhere would read and
write around 0x8000_0000 instead, where a 64-bit memory of this size has plain zeroed pages: the run would not
trap, it would print the wrong thing. Skipped when the output is newer than every input."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
OUT = os.path.join(HERE, "out_hi")
BASE = 0x1_8000_0000
LOW = "0x08000000"


def newest(paths):
    t = 0
    for p in paths:
        if os.path.isdir(p):
            for d, _, fs in os.walk(p):
                if os.path.basename(d) in ("out", "out_hi", "out_big", "gen", "__pycache__"):
                    continue
                for f in fs:
                    t = max(t, os.path.getmtime(os.path.join(d, f)))
        elif os.path.exists(p):
            t = max(t, os.path.getmtime(p))
    return t


def relink(script, out):
    text = open(script).read()
    if text.count(LOW) != 1:
        sys.exit("[RED] %s does not set its base the expected way (. = %s;)" % (script, LOW))
    open(out, "w").write(text.replace(LOW, "%#x" % BASE))
    return out


def main():
    stamp = os.path.join(OUT, "built")
    inputs = [os.path.join(ROOT, "test", "guests", "src"), os.path.join(ROOT, "test", "guests", "rt"), HERE,
              os.path.join(ROOT, "tools", "build_guests.py"), os.path.join(ROOT, "tools", "ref_run.py")]
    if "--force" not in sys.argv and os.path.exists(stamp) and os.path.getmtime(stamp) >= newest(inputs):
        return 0
    os.makedirs(os.path.join(OUT, "ld"), exist_ok=True)
    env = dict(os.environ)
    env["GUESTS_LD"] = relink(os.path.join(ROOT, "test", "guests", "rt", "guest.ld"), os.path.join(OUT, "ld", "shared.ld"))
    subprocess.check_call([sys.executable, os.path.join(ROOT, "tools", "build_guests.py"), "--out", OUT], env=env,
                          stdout=subprocess.DEVNULL)
    env = dict(os.environ)
    env["A64_GUEST_LD"] = relink(os.path.join(HERE, "guest.ld"), os.path.join(OUT, "ld", "a64.ld"))
    env["A64_GUEST_BASE"] = "%#x" % BASE
    env["A64_GUEST_OUT"] = OUT
    subprocess.check_call([sys.executable, os.path.join(HERE, "build.py")], env=env, stdout=subprocess.DEVNULL)
    n = len([f for f in os.listdir(OUT) if f.endswith(".json") and f != "manifest.json"])
    open(stamp, "w").write("%d images at %#x\n" % (n, BASE))
    print("a64 guests above 4 GB: %d images linked at %#x in %s" % (n, BASE, os.path.relpath(OUT, ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
