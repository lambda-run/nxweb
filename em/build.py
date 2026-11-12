#!/usr/bin/env python3
"""nxem build (run in the VM): python3 build.py <target> [--mem 32|64] [--env node|web] [--gb N] [-j N]

Targets: p1 (thread stress), p2 (translated guest threads), p4 (the real game's code: boot harness), nxtests (nxnative's own unit tests), all.
C sources (.c: nxnative's files, generated ports, C glue) are compiled with emcc, C++ sources (.cpp: seam code) with
em++, into build/obj/<mem>/, and linked in ONE em++ step. Shared interfaces are `extern "C"` headers (kernel/nx_guest.h,
kernel/shim/nx_port.h); C++ never includes nxnative's dm.h. Objects are rebuilt when their source or any header under
kernel/ or the nxnative host directory is newer.
"""
import argparse, os, subprocess, sys, glob
from concurrent.futures import ThreadPoolExecutor

R = os.path.dirname(os.path.abspath(__file__))
NX = os.environ.get("NXNATIVE", "/ctl/repos/nxnative/dm")
W = os.path.dirname(R)                                 # the nxweb tree this directory is part of (branch emscripten-port): its src/ is imported as it is
WB = os.environ.get("NXWEB_BUILD", "/mnt/build")       # nxweb's built modules (translator, helpers, loader): the main checkout's, read-only, until this tree builds its own
EM = "/ctl/emsdk/emscripten"
os.environ["EM_CONFIG"] = "/ctl/emsdk/emscripten.cfg"
GAME = "0400486024DEC000"

def sh(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode: sys.exit(f"build: failed: {' '.join(cmd)[:300]}")
    return r

def newer(out, deps):
    if not os.path.exists(out): return True
    t = os.path.getmtime(out)
    return any(os.path.getmtime(d) > t for d in deps if os.path.exists(d))

HEADERS = None
def headers():
    global HEADERS
    if HEADERS is None:
        HEADERS = glob.glob(f"{R}/kernel/**/*.h", recursive=True) + glob.glob(f"{NX}/host/*.h") + [f"{R}/build/gen/game_profile.h", __file__]
    return HEADERS

def flags(mem, cxx):
    f = ["-O2", "-g1", "-pthread", "-D_GNU_SOURCE", f"-I{R}/kernel", f"-I{R}/kernel/shim", f"-I{R}/hle", f"-I{NX}/host", f"-I{R}/build/gen",
         "-Wno-int-to-pointer-cast", "-Wno-pointer-to-int-cast", "-Wno-format", "-Wno-unused-function"]
    if mem == 64: f.append("-sMEMORY64=1")
    if cxx: f += ["-std=c++20", "-fno-exceptions", "-fno-rtti"]
    return f

def compile_all(srcs, mem, extra=(), tag=""):
    odir = f"{R}/build/obj/{mem}{tag}"; os.makedirs(odir, exist_ok=True)
    jobs, objs = [], []
    for s in srcs:
        cxx = s.endswith(".cpp")
        o = f"{odir}/{os.path.basename(s)}.o"; objs.append(o)
        if newer(o, [s] + headers()):
            jobs.append([f"{EM}/em++" if cxx else f"{EM}/emcc", *flags(mem, cxx), *extra, "-c", s, "-o", o])
    with ThreadPoolExecutor(ARGS.j) as ex: list(ex.map(sh, jobs))
    return objs

def link(objs, out, mem, lflags):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sh([f"{EM}/em++", "-O2", "-g1", "-pthread", *(["-sMEMORY64=1"] if mem == 64 else []), *objs, "-o", out, "-sPROXY_TO_PTHREAD", "-sEXIT_RUNTIME=1",
        "-Wno-version-check", *lflags])
    print(f"build: {out} ({os.path.getsize(out[:-3] + '.wasm')} bytes of wasm)")

def gen():
    os.makedirs(f"{R}/build/gen", exist_ok=True); os.makedirs(f"{R}/build/host/tests", exist_ok=True)
    sh(["python3", f"{NX}/games/game.py", "header", GAME, f"{R}/build/gen/game_profile.h"])
    out = f"{R}/build/host/hle_thread.c"
    if newer(out, [f"{NX}/host/hle_thread.c", f"{R}/kernel/port_thread.py"]):
        sh(["python3", f"{R}/kernel/port_thread.py", f"{NX}/host/hle_thread.c", out])
    return out

KERNEL_C = lambda: [gen(), f"{R}/kernel/nx_shims.c"]
SEAM = [f"{R}/kernel/nx_guest.c", f"{R}/kernel/nx_units.cpp", f"{R}/kernel/nx_proc.c", f"{R}/kernel/nx_mem.cpp", f"{R}/kernel/nx_stubs.c"]

def p1():
    objs = compile_all(KERNEL_C() + [f"{R}/test/p1_stress.c"], 32)
    link(objs, f"{R}/build/p1/p1_stress.js", 32, ["-sPTHREAD_POOL_SIZE=24", "-sINITIAL_MEMORY=268435456", "-sENVIRONMENT=node,worker"])

def guest(B, mem):
    ld = f"{R}/guest/guest.ld"
    if mem == 64:
        hi = f"{B}/guest_hi.ld"; open(hi, "w").write(open(ld).read().replace("0x08000000", "0x180000000")); ld = hi
    for v, isa in (("v80", ["-march=armv8-a"]), ("a78c", ["-mcpu=cortex-a78c", "-mbranch-protection=pac-ret+b-key+leaf", "-mno-outline-atomics"])):
        sh(["clang", "--target=aarch64-none-elf", "-ffreestanding", "-nostdlib", "-fno-builtin", *isa, "-O2", "-w", "-c", f"{R}/guest/mt.c", "-o", f"{B}/mt.{v}.o"])
        sh(["ld.lld", "-T", ld, f"{B}/mt.{v}.o", "-o", f"{B}/mt.{v}.elf"])
        sh(["llvm-objcopy", "-O", "binary", f"{B}/mt.{v}.elf", f"{B}/mt.{v}.bin"])
        nm = subprocess.check_output(["llvm-nm", f"{B}/mt.{v}.elf"], text=True)
        open(f"{B}/mt.{v}.add3", "w").write([l.split()[0] for l in nm.splitlines() if l.endswith(" guest_add3")][0] + "\n")

def nxweb_parts(B, mem):
    """nxweb's glue this track imports as it is (translator host, layout, loader, the wasm64 calling adapter, the shared
    rewrite), bundled into one script; the translator and helpers as nxweb built them."""
    open(f"{B}/a64_entry.ts", "w").write(f'export {{ A64Host }} from "{W}/src/glue/a64_host.ts";\nexport {{ A64, HOST_END, STUBS, range }} from "{W}/src/glue/rt_layout.ts";\n'
        f'export {{ Loader }} from "{W}/src/loader/host/loader.mts";\nexport {{ instantiate }} from "{W}/src/glue/wasm_abi.ts";\nexport {{ sharedBuild }} from "{W}/src/glue/wasm_shared.ts";\n')
    sh([f"{W}/node_modules/.bin/esbuild", f"{B}/a64_entry.ts", "--bundle", "--format=iife", "--global-name=NXA64", f"--outfile={B}/a64_host.js", "--log-level=warning"])
    x = "64" if mem == 64 else ""
    for n in ("translator", "helpers"): sh(["cp", f"{WB}/runtime/{n}{x}.shared.wasm", f"{B}/{n}.shared.wasm"])
    if mem == 64: sh(["cp", f"{WB}/runtime/loader64.wasm", f"{B}/loader64.wasm"])
    open(f"{B}/nxweb.rev", "w").write(subprocess.run(["git", "-C", W, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout)

# nxnative's HLE files that compile for wasm64 today (tools/hle_inventory.py); thread.c is replaced by kernel/nx_proc.c
HLE_HOST = ("hle_account hle_audren hle_codec hle_codec_video hle_count hle_fpslock hle_friends hle_glslc hle_guestthread hle_haptics hle_hid hle_mii hle_misc "
            "hle_net hle_nvdrv hle_oe hle_oodle hle_os hle_ro hle_sdk16 hle_sdkinit hle_sf hle_swkbd hle_table hle_time hle_touch hle_uecvar hle_web").split()
HLE_GFX = ["hle_nv", "hle_vi"]
def hle():
    """nxnative's HLE files, unedited, each as a generated translation unit with its argument thunks (tools/gen_hle.py),
    the table of what is built (nx_hle_find) and the list of every name the host answers (nx_hle_names)."""
    G = f"{R}/build/hle/p4gen"; os.makedirs(G, exist_ok=True)
    files = [f"{NX}/host/{f}.c" for f in HLE_HOST] + [f"{NX}/gfx/{f}.c" for f in HLE_GFX]
    # every file is built from a copy in which calls through function pointers go through NXG (tools/port_gcalls.py:
    # a guest function is not a C function here), then hle/port/<name>.edits when there is one: a list of (old, new)
    sys.path.insert(0, f"{R}/tools"); import port_gcalls
    notes = []
    for i, f in enumerate(files):
        stem = os.path.basename(f)[:-2]
        out = f"{R}/build/host/{stem}.c"; os.makedirs(os.path.dirname(out), exist_ok=True)
        text, n, casts = port_gcalls.rewrite(open(f, encoding="utf-8").read())
        notes.append(f"{stem}: {n} calls through function pointers{f', {casts} possible calls through a cast' if casts else ''}")
        ed = f"{R}/hle/port/{stem}.edits"
        if os.path.exists(ed):
            for old, new in eval(open(ed, encoding="utf-8").read()):
                if text.count(old) != 1: sys.exit(f"build: {ed}: an anchor occurs {text.count(old)} times: {old[:60]!r}")
                text = text.replace(old, new)
        text = f"// GENERATED by build.py from nxnative's {stem}.c (tools/port_gcalls.py, hle/port/): do not edit. (Its translation unit includes hle/nx_hle.h first.)\n" + text
        if not os.path.exists(out) or open(out, encoding="utf-8").read() != text: open(out, "w", encoding="utf-8").write(text)
        files[i] = out
    open(f"{G}/gcalls.txt", "w").write("\n".join(notes) + "\n")
    if newer(f"{G}/hle_table.c", files + [f"{R}/tools/gen_hle.py", f"{R}/hle/nx_hle.h"]):
        sh(["python3", f"{R}/tools/gen_hle.py", "--out", G, *files], stdout=open(f"{G}/report.tsv", "w"), stderr=open(f"{G}/report.summary", "w"))
    allr = f"{R}/build/hle/report_all.tsv"
    if not os.path.exists(allr):
        sh(["python3", f"{R}/tools/gen_hle.py", "--no-gen", "--out", f"{R}/build/hle/gen", *glob.glob(f"{NX}/host/*.c"), f"{NX}/gfx/hle_nv.c", f"{NX}/gfx/hle_vi.c", f"{NX}/gfx/nvn/hle_nvn.c"],
           stdout=open(allr, "w"), stderr=subprocess.DEVNULL)
    flag = {"HLE": 1, "HLE_FORCE": 2, "HLE_FORCE_BIG": 6, "NVN": 8, "NVN_NOPROTO": 8, "LIBC": 16}
    names = {}
    for l in open(allr):
        c = l.rstrip("\n").split("\t")
        if len(c) > 2 and c[1] in flag: names[c[2]] = names.get(c[2], 0) | flag[c[1]]
    out = ['// GENERATED by build.py from tools/gen_hle.py\'s report: every name nxnative\'s host answers', "#include <stdint.h>",
           "typedef struct { const char *name; uint32_t flags; } nx_hle_name;", "const nx_hle_name nx_hle_names[] = {"]
    out += [f'    {{"{n}", {f}}},' for n, f in sorted(names.items())] + ["};", f"const unsigned nx_hle_names_n = {len(names)};", ""]
    text = "\n".join(out)
    if not os.path.exists(f"{G}/hle_names.c") or open(f"{G}/hle_names.c").read() != text: open(f"{G}/hle_names.c", "w").write(text)
    inc = [f"-I{R}/hle/shim", f"-I{G}", f"-I{NX}/gfx", f"-I{NX}/gfx/nvn", f"-I{NX}/gfx/nvn/include", f"-I{NX}/third_party/libvpx", f"-I{NX}/third_party/dav1d/include", f"-I{NX}/third_party/stb_vorbis", "-w"]
    return compile_all([f"{G}/{f}.tu.c" for f in HLE_HOST + HLE_GFX] + [f"{G}/hle_table.c", f"{G}/hle_names.c"], 64, inc, ".hle")

def p4():
    """The real game's code under the C kernel (node, memory64, 16 GB): test/p4_boot.c."""
    B = f"{R}/build/p4"; os.makedirs(B, exist_ok=True)
    nxweb_parts(B, 64)
    objs = compile_all(KERNEL_C() + SEAM + [f"{R}/test/p4_boot.c"], 64) + hle()
    # the owner realm: nxweb's fs glue, container reader and RomFS device, bundled as they are (node)
    sh([f"{W}/node_modules/.bin/esbuild", f"{R}/owner/owner.ts", "--bundle", "--platform=node", "--format=iife", "--global-name=NXOWN", f"--outfile={B}/owner.js", "--log-level=warning"])
    open(f"{B}/owner_pre.js", "w").write(open(f"{B}/owner.js").read() + open(f"{R}/owner/owner_pre.js").read())
    link(objs, f"{B}/p4.js", 64, ["-sERROR_ON_UNDEFINED_SYMBOLS=0", "--js-library", f"{R}/kernel/nx_guest.js", "--js-library", f"{R}/kernel/nx_owner.js", "--pre-js", f"{B}/a64_host.js", "--pre-js", f"{B}/owner_pre.js", f"-sGLOBAL_BASE={14 << 30}", f"-sINITIAL_MEMORY={16 << 30}",
                                  "-sNODERAWFS=1", "-sENVIRONMENT=node,worker", "-sPTHREAD_POOL_SIZE=8", "-sEXPORTED_FUNCTIONS=_main,_malloc,_free", "-sSTACK_SIZE=1048576"])

def p2():
    mem, env, gb = ARGS.mem, ARGS.env, ARGS.gb
    B = f"{R}/build/web/p2" if env == "web" else f"{R}/build/p2_64" if mem == 64 else f"{R}/build/p2"
    os.makedirs(B, exist_ok=True)
    guest(B, mem)
    # nxweb's translator host glue and layout, bundled as they are; the translator and helpers as nxweb built them
    nxweb_parts(B, mem)
    objs = compile_all(KERNEL_C() + SEAM + [f"{R}/test/p2_main.c"], mem)
    # Emscripten's data, stacks and heap go above the guest: 256 MB .. 512 MB of a 32-bit memory, the last GBs of a 64-bit one
    if mem == 32: memf = ["-sGLOBAL_BASE=268435456", "-sINITIAL_MEMORY=536870912"]
    elif env == "web": memf = [f"-sGLOBAL_BASE={(gb - 2) << 30}", f"-sINITIAL_MEMORY={gb << 30}"]
    else: memf = ["-sGLOBAL_BASE=7516192768", "-sINITIAL_MEMORY=8589934592"]
    if env == "web":
        envf = ["-sENVIRONMENT=web,worker", "-sPTHREAD_POOL_SIZE=30"]
        for f in ("mt.a78c.bin", "mt.v80.bin", "translator.shared.wasm", "helpers.shared.wasm"): envf += ["--embed-file", f"{B}/{f}@/{f}"]
        sh(["cp", f"{R}/web/p2.html", f"{B}/index.html"])
    else: envf = ["-sNODERAWFS=1", "-sENVIRONMENT=node,worker", "-sPTHREAD_POOL_SIZE=8"]
    link(objs, f"{B}/p2.js", mem, ["--js-library", f"{R}/kernel/nx_guest.js", "--js-library", f"{R}/kernel/nx_owner.js", "--pre-js", f"{B}/a64_host.js", *memf, *envf, "-sEXPORTED_FUNCTIONS=_main,_malloc,_free"])

def nxtests():
    """nxnative's own unit tests of the thread core, unchanged, against the ported hle_thread.c."""
    gen(); T = f"{R}/build/host/tests"; B = f"{R}/build/nxtests"
    for t in ("t_condvar", "t_sync_wait", "t_pollwait", "t_clockwait"): sh(["cp", f"{NX}/host/tests/{t}.c", T])
    stub = [f"{R}/kernel/nx_shims.c", f"{R}/test/nxtest_stub.c"]
    lf = ["-sPTHREAD_POOL_SIZE=8", "-sINITIAL_MEMORY=134217728", "-sENVIRONMENT=node,worker"]
    inc = [f"-I{NX}/host/tests", "-w"]
    link(compile_all([f"{T}/t_condvar.c", f"{R}/build/host/hle_thread.c"] + stub, 32, inc + ["-DDM_TEST_HOOKS"], ".cv"), f"{B}/t_condvar.js", 32, lf)
    link(compile_all([f"{T}/t_condvar.c", f"{R}/build/host/hle_thread.c"] + stub, 32, inc + ["-DDM_TEST_HOOKS", "-DDM_TEST_CV_OLD_ORDER"], ".cvold"), f"{B}/t_condvar_old.js", 32, lf)
    for t in ("t_sync_wait", "t_pollwait", "t_clockwait"):
        link(compile_all([f"{T}/{t}.c"] + stub, 32, inc, "." + t), f"{B}/{t}.js", 32, lf)

ap = argparse.ArgumentParser()
ap.add_argument("target"); ap.add_argument("--mem", type=int, default=32); ap.add_argument("--env", default="node"); ap.add_argument("--gb", type=int, default=16); ap.add_argument("-j", type=int, default=3)
ARGS = ap.parse_args()
if ARGS.env == "web": ARGS.mem = 64
{"p1": p1, "p2": p2, "p4": p4, "nxtests": nxtests, "all": lambda: (p1(), p2(), nxtests())}[ARGS.target]()
print("BUILD_DONE")
