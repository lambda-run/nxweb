#!/usr/bin/env python3
# Build the translator benchmark (npm run a64:bench:build): real-world-shaped C, compiled three ways from one source.
#   zstd_bench  zstd 1.5.6's decoder over dictionary-compressed frames (a RomFS of small .zs files and a shared dict)
#   str_bench   a resource-name table: the libc string family (memcmp/strcmp/strlen/strncat/memcpy/...)
# The aarch64 images (-mcpu=cortex-a78c, -O2, pac-ret: Switch 2 shaped) link Arm's optimized-routines for the C
# library, the way an SDK libc is hand-tuned assembly. Each program is also built native (the reference output and
# native time) and as wasm32 by clang (wasm-native time: the same C on the same engine). Sources are fetched pinned
# into build/a64/bench/src; nothing third-party is committed.
import hashlib, io, json, os, random, struct, subprocess, sys, tarfile, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../.."))
OUT = os.path.join(ROOT, "build/a64/bench")
SRC = os.path.join(OUT, "src")
ZSTD_URL = "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz"
ZSTD_SHA = "8c29e06cf42aacc1eafc4077ae2ec6c6fcb96a626157e0593d5e82a34fd403c1"
OR_REPO = "https://github.com/ARM-software/optimized-routines"
OR_REF = "20859d3fd9e797dde592c489c8ef7d383f778620"
OR_FILES = ["memcpy", "memset", "memcmp", "memchr", "strlen", "strnlen", "strcmp", "strncmp", "strchr", "strcpy"]
BASE = 0x08000000
BASE_HI = 0x1_8000_0000   # the memory64-high mode: image, data and stack above 4 GB
ROUNDS = {"zstd_bench": int(os.environ.get("ZROUNDS", "4")), "str_bench": int(os.environ.get("SROUNDS", "3")), "libc_test": 1}

def fetch():
    os.makedirs(SRC, exist_ok=True)
    zdir = os.path.join(SRC, "zstd-1.5.6")
    if not os.path.exists(os.path.join(zdir, "zstddeclib.c")):
        data = urllib.request.urlopen(ZSTD_URL).read()
        if hashlib.sha256(data).hexdigest() != ZSTD_SHA: sys.exit("zstd tarball sha256 mismatch")
        tarfile.open(fileobj=io.BytesIO(data)).extractall(SRC, filter="data")
        sf = os.path.join(zdir, "build/single_file_libs")
        subprocess.check_call([sys.executable, "combine.py", "-r", "../../lib", "-x", "legacy/zstd_legacy.h", "-o", "zstddeclib.c", "zstddeclib-in.c"],
                              cwd=sf, stdout=subprocess.DEVNULL)
        os.replace(os.path.join(sf, "zstddeclib.c"), os.path.join(zdir, "zstddeclib.c"))
    odir = os.path.join(SRC, "optimized-routines")
    if not os.path.exists(os.path.join(odir, "string/aarch64/memcmp.S")):
        subprocess.check_call(["git", "init", "-q", odir])
        subprocess.check_call(["git", "-C", odir, "fetch", "-q", "--depth", "1", OR_REPO, OR_REF])
        subprocess.check_call(["git", "-C", odir, "checkout", "-q", "FETCH_HEAD"])
    return zdir, odir

def zstd_mod():
    try:
        from compression import zstd
    except ImportError:
        from backports import zstd
    return zstd

def corpus():
    # game-shaped files: text configs naming resources, quantised vertex streams, index tables, padded records
    rnd = random.Random(1618)
    words = ["Link", "Navi", "Deku", "Kokiri", "Hyrule", "Zora", "Goron", "Gerudo", "Sheik", "Ganon", "Epona", "Saria",
             "Model", "Anim", "Texture", "Shader", "Collision", "Actor", "Scene", "Room", "Param", "Flag", "Event"]
    files = []
    for i in range(96):
        kind = i % 4; b = bytearray()
        size = rnd.randrange(8 << 10, 56 << 10)
        if kind == 0:
            while len(b) < size:
                w = rnd.choice(words); v = rnd.randrange(1000)
                b += ("  <%s name=\"%s_%s%d\" value=\"%d\" scale=\"%.3f\" enabled=\"%s\"/>\n" % (rnd.choice(words), w, rnd.choice(words), rnd.randrange(64), v, v / 7.0, rnd.choice(["true", "false"]))).encode()
        elif kind == 1:
            t = rnd.random() * 6.28
            while len(b) < size:
                t += 0.01; x = (int(1000 * (t % 3.7)) & 0xFFFF)
                b += struct.pack("<hhhhBBBBf", x, (x * 3) & 0x7FFF, (x * 7 + rnd.randrange(4)) & 0x7FFF, 0x3C00, 255, rnd.randrange(250, 256), 128, 255, round(t, 2))
        elif kind == 2:
            k = 0
            while len(b) < size:
                k += rnd.choice([1, 1, 1, 2, 3, -1, 17]); b += struct.pack("<HHH", k & 0xFFFF, (k + 1) & 0xFFFF, (k + 2) & 0xFFFF)
        else:
            while len(b) < size:
                b += struct.pack("<IIff", rnd.randrange(1 << 12), 0xDEADBEEF if rnd.random() < 0.5 else 0, rnd.random(), 1.0) + bytes(16) + rnd.choice(words).encode().ljust(16, b"\0")
        files.append(bytes(b[:size]))
    return files

def zdata(path):
    zstd = zstd_mod()
    files = corpus()
    d = zstd.train_dict(files[::2], 64 << 10)
    blobs = [zstd.compress(f, level=15, zstd_dict=d) for f in files]
    off, blob = [], bytearray()
    for z in blobs: off.append(len(blob)); blob += z
    arr = lambda name, data: "static const unsigned char %s[] __attribute__((aligned(16))) = {%s};\n" % (name, ",".join(str(x) for x in data))
    with open(path, "w") as f:
        f.write("#define ZFILES %d\n#define ZMAXOUT %d\n" % (len(files), max(map(len, files))))
        f.write(arr("zdict", d.dict_content)); f.write(arr("zblob", blob))
        f.write("static const unsigned zoff[] = {%s};\nstatic const unsigned zlen[] = {%s};\nstatic const unsigned zout[] = {%s};\n" % (
            ",".join(map(str, off)), ",".join(str(len(z)) for z in blobs), ",".join(str(len(x)) for x in files)))
    return sum(map(len, files)), len(blob)

def main():
    zdir, odir = fetch()
    gen = os.path.join(OUT, "gen"); os.makedirs(gen, exist_ok=True)
    raw, packed = zdata(os.path.join(gen, "zdata.h"))
    print("zstd corpus: 96 files, %d bytes -> %d compressed with a 64 KB dictionary" % (raw, packed))
    common = ["-O2", "-w", "-I", HERE, "-I", gen, "-I", zdir, "-DZSTD_DISABLE_ASM", "-DZSTD_STRIP_ERROR_STRINGS", "-DDEBUGLEVEL=0", "-DNDEBUG"]
    orobj = []
    for f in OR_FILES:
        o = os.path.join(OUT, "or_" + f + ".o")
        subprocess.check_call(["clang", "--target=aarch64-none-elf", "-mcpu=cortex-a78c", "-c", os.path.join(odir, "string/aarch64", f + ".S"),
                               "-I", os.path.join(odir, "string/aarch64"), "-I", os.path.join(odir, "string/include"), "-o", o])
        orobj.append(o)
    for name in ROUNDS:
        src = os.path.join(HERE, name + ".c")
        rd = ["-DZROUNDS=%d" % ROUNDS["zstd_bench"], "-DSROUNDS=%d" % ROUNDS["str_bench"]]
        nat = os.path.join(OUT, name + ".native")
        subprocess.check_call(["clang", "-DBENCH_NATIVE"] + common + rd + [src, "-o", nat])
        expected = subprocess.run([nat], check=True, capture_output=True).stdout
        open(os.path.join(OUT, name + ".out"), "wb").write(expected)
        wasm = os.path.join(OUT, name + ".wasm")
        subprocess.check_call(["clang", "--target=wasm32", "-DBENCH_WASM", "-isystem", os.path.join(HERE, "shim"), "-nostdlib", "-mbulk-memory", "-msimd128"] + common + rd +
                              [src, "-Wl,--no-entry", "-Wl,--export=main", "-Wl,-z,stack-size=1048576", "-Wl,--allow-undefined", "-o", wasm])
        for tag, base in (("", BASE), ("_hi", BASE_HI)):
            ld = os.path.join(OUT, "guest%s.ld" % tag)
            open(ld, "w").write(open(os.path.join(HERE, "../guests/guest.ld")).read().replace("0x08000000", "%#x" % base))
            elf = os.path.join(OUT, name + tag + ".elf")
            subprocess.check_call(["clang", "--target=aarch64-none-elf", "-DBENCH_GUEST", "-isystem", os.path.join(HERE, "shim"), "-ffreestanding", "-nostdlib",
                                   "-mcpu=cortex-a78c", "-mbranch-protection=pac-ret", "-mno-outline-atomics", "-fno-builtin-malloc"] + common + rd +
                                  [src] + orobj + ["-Wl,--defsym=%s=__%s_aarch64" % (f, f) for f in OR_FILES + ["memmove"]] + ["-fuse-ld=lld", "-Wl,-T," + ld, "-o", elf])
            subprocess.check_call(["llvm-objcopy", "-O", "binary", elf, os.path.join(OUT, name + tag + ".bin")])
            syms = subprocess.run(["llvm-nm", "-n", elf], check=True, capture_output=True, text=True).stdout
            tab = {}
            for line in syms.splitlines():
                p = line.split()
                if len(p) == 3: tab[p[2]] = int(p[0], 16)
            bss_end = tab["__bss_end"]
            stack_top = (bss_end + 0x10FFFF) & ~0xFFFF
            json.dump({"base": base, "entry": base, "image": name + tag + ".bin", "bss_end": bss_end, "stack_top": stack_top, "expected_stdout": name + ".out",
                       "exit_code": 0, "rounds": ROUNDS[name], "symbols": {k: v for k, v in tab.items() if v >= base and not k.startswith(".")}},
                      open(os.path.join(OUT, name + tag + ".json"), "w"), indent=1)
        print("%-12s image=%d bytes stdout=%s" % (name, os.path.getsize(os.path.join(OUT, name + ".bin")), expected.decode().strip().replace("\n", "; ")))

if __name__ == "__main__":
    main()
