#!/usr/bin/env python3
"""Convert nxnative's game profiles (dm/games/<title id>/game.tsv, patches.py; dm/tools/sdk_patches.py,
engine_patches.py) into what nxweb's prepare step reads: one JSON per game under src/prepare/profiles/, the SDK
cuts, an index, and the report of what converted.

  convert_profiles.py [--nxnative DIR] [--out DIR] [--check] [--strict]

nxnative is MIT licensed (Copyright (c) 2026 seedds); the profiles are its constants and tables. Nothing here reads a
game file. What is carried over: profile keys, build IDs, and the registered cuts (offset, the original bytes a cut
asserts, the bytes that replace them, the reason). What is not: comments, shader tables (they are keyed by hashes of
game files and belong to nxnative's offline chain), launcher settings.

Key classes (KEYS below is the single source; src/prepare/README.md has the table generated from it):
  a  applies as is: the value means the same on nxweb and is handed to the runtime
  b  Apple / Metal / rewriter / offline-chain specific: dropped
  c  switches a per-game mechanism nxweb does not have yet: listed for the player as "will not work"

The address space is not judged here: a profile's reserved regions are handed to the runtime's own rule
(src/glue/rt_process.ts layoutFor, run through tools/prepare/layout_verdict.mts), and what it answers ("profile",
"pool" or "short", with its sentence) is what the profile file and the report hold. Node is needed for that.

Patch files are Python. They are not imported: each is executed in a namespace with no builtins but a short
whitelist, whose only importable modules are `struct` and `nso_asm` (nxnative's 28-line encoder module, executed the
same way). CUTS and MATCH_CUTS are data once evaluated. FRAME_STEP functions are called with a recording context,
which shows what they would write (sites, stub words) but not something nxweb can apply: see `UNCONVERTED`.
A patch file that cannot be evaluated this way (it imports a module the sandbox does not provide, uses a builtin
outside the whitelist, or fails while it runs) does not stop the conversion: its profile is converted from game.tsv,
its patches are marked as not converted with the reason, the run ends with a list of such files and exit code 0.
`--strict` makes that a failure, as it was.
"""
import argparse, hashlib, json, os, struct, subprocess, sys, types

NXNATIVE = os.environ.get("NXNATIVE", "/home/user/nxnative")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "prepare", "profiles")
SOURCE = "nxnative dm/games (MIT, Copyright (c) 2026 seedds)"

LAYOUT_VERDICT = os.path.join(HERE, "layout_verdict.mts")   # the runtime's layoutFor over the profiles' reserved regions

# key -> (class, where it goes or why it is dropped, for class c: what the player is told)
KEYS = {
    # ---- a: applies as is ----
    "title_id":       ("a", "identity: the prepare step selects the profile by it", ""),
    "program_id":     ("a", "kernel_init cfg +104 (GetInfo ProgramId); fs_set_program_id", ""),
    "name":           ("a", "label on the prepare page", ""),
    "build":          ("a", "the builds the game was brought up on: version, display version (hle STR_DISPLAY_VERSION), module build IDs (which cuts apply)", ""),
    "package":        ("a", "the version the profile was made on (information: nxweb packs the newest in the folder, as nxnative)", ""),
    "modules":        ("a", "which code modules are loaded and in what order (prepare's Code stage)", ""),
    "romfs_marker":   ("a", "a path that must exist in the RomFS (prepare's Profile stage warns when it does not)", ""),
    "app_pool":       ("a", "kernel_init cfg +80 (GetInfo TotalMemorySize)", ""),
    "mem_used":       ("a", "kernel_init cfg +88 (GetInfo UsedMemorySize beside the heap)", ""),
    "sys_resource":   ("a", "kernel_init cfg +96 (GetInfo TotalSystemResourceSize); checked against main.npdm", ""),
    "mem_map_limit":  ("a", "kernel_init cfg flag 1 (MapPhysicalMemory fails past the pool)", ""),
    "game_env":       ("a", "hle_cfg_str STR_GAME_ENV (the game's getenv)", ""),
    "launch_param":   ("a", "hle_cfg_str STR_LAUNCH_SPEC (oe::TryPopLaunchParameter)", ""),
    "game_args":      ("a", "arguments handed to the game before nninitStartup (no profile sets any)", ""),
    "op_mode":        ("a", "hle_cfg CFG_OPMODE (console / handheld at start)", ""),
    "perf_mode":      ("a", "hle_cfg CFG_PERF_BOOST", ""),
    "alloc_big_align": ("a", "hle_cfg CFG_ALLOC_BIG_ALIGN (StandardAllocator blocks of 64 KB and more aligned to 64 KB)", ""),
    "shared_font":    ("a", "hle_cfg CFG_SHARED_FONT_TTF", ""),
    "device_api":     ("a", "the NVN API version nvnDeviceGetInteger reports (an SDK version fact; no profile sets it, the SDK version decides)", ""),
    "pad_layout":     ("a", "input setting: which controls the game needs (simple / full / touch), a hint for the page's on-screen controls", ""),
    "render_cond":    ("a", "gfx_set_profile bit 1 (src/gfx/report.ts): SetRenderEnable / SetRenderEnableConditional evaluated when a submission is lowered, a timestamp report's counter field 0", ""),
    "tex_flush_upload": ("a", "gfx_set_profile bit 2 (src/gfx/texwatch.ts): textures in pools the CPU writes are registered; a pool flush over one publishes it (full check at its next use, also of a texture the GPU wrote)", ""),
    "tex_dirty_upload": ("c", "hle_nvn.c nvn_ft_written (page write tracking)", "Textures the game rewrites in memory without telling NVN are not uploaded again (needs write tracking of guest pages)."),
    # ---- b: Apple / Metal / rewriter / offline chain, dropped ----
    "ipa":            ("b", "iOS package file name", ""),
    "app_category":   ("b", "App Store category", ""),
    "zip_store":      ("b", "IPA compression", ""),
    "mem_reserve":    ("b", "the Apple host's guest block size; with mem_alias and mem_stack it gives the regions the runtime's per-game layout starts from (see `address_space`)", ""),
    "mem_alias":      ("b", "the iPhone's alias region size; as mem_reserve", ""),
    "mem_stack":      ("b", "the Apple host's stack region size; as mem_reserve", ""),
    "shader_versions": ("b", "which versions nxnative's offline shader tables are the union of", ""),
    "shader_groups":  ("b", "shader_split.py's source groups (offline chain bookkeeping)", ""),
    "shader_note":    ("b", "shader_split.py's table header", ""),
    "depth_mode":     ("b", "the depth mode for Metal pipelines made before the game runs; nxweb takes the game's nvnDeviceSetDepthMode call", ""),
    "pso_mtl4":       ("b", "Metal 4 pipeline compiler", ""),
    "pso_gpu":        ("b", "Metal pipeline archive GPU families", ""),
    "enc_thread":     ("b", "Metal encoding thread", ""),
    "present_snap":   ("b", "Metal present snapshots", ""),
    "draw_barriers":  ("b", "Metal render pass ordering (a GPU time optimization of nxnative's replayer)", ""),
    "vconv_range":    ("b", "the range of nxnative's CPU vertex conversion (an optimization of its replayer)", ""),
    "core_preempt":   ("b", "a scheduling remedy over pthreads; nxweb's kernel schedules the four cores itself", ""),
    "jit_key_data":   ("b", "the nn::jit image an iPhone (which cannot JIT) is served; nxweb translates code at run time", ""),
    "jit_out_code":   ("b", "as jit_key_data", ""),
    "jit_route":      ("b", "as jit_key_data (the capture's input script)", ""),
    # ---- c: needs a counterpart ----
    "fps_target":     ("c", "hle_fpslock.c / FRAME_STEP stubs", "The frame rate the game was tested at is not applied (nxnative writes the engine's frame limit or steps the game by the host's vsyncs); the game runs at its own rate."),
    "fps_max":        ("c", "hle_fpslock.c", "The 120 fps option is not available."),
    "fps_hold":       ("c", "nvn_fstep.h", "Frame holding under a frame-rate cap is not implemented."),
    "present_interval": ("c", "hle_nvn.c present pacing", "Presents are not re-paced to the display: the game keeps the present interval it asks for (often 30 fps)."),
    "ue_fps_cvar":    ("c", "hle_fpslock.c", "The Unreal console variable that holds the frame limit is not written."),
    "ue_texture_pool": ("c", "hle_uecvar.c + ue_cvar.py", "Unreal's texture streaming pool is not raised: distant textures may stay blurry."),
    "render_base":    ("c", "render-scale stub (FRAME_STEP)", "The render scale setting is not available."),
    "screen_aspect":  ("c", "screen-shape stubs (FRAME_STEP)", "Only 16:9 output: the game's taller-screen mode is not available."),
    "tex_dyn_slots":  ("c", "shader chain fallback arrays", "Shaders that index textures by a handle computed at run time are not supported."),
    "gpu_timestamps": ("c", "nvn_mtl.m timestamp reports per segment", "GPU timestamp reports are not per segment: a game that measures its GPU time may pick a wrong dynamic resolution."),
    "shader_key_skip": ("c", "hle_nvn.c keys_hash", "Shader keys do not mask the control-section bytes this engine varies: every variant is translated separately (slow first use)."),
    "stdalloc_cap":   ("c", "hle_svc.c StandardAllocator gate", "The cap on nn::mem::StandardAllocator's address space is not applied: the game may run out of address space."),
    "snowdrop_pools": ("c", "snowdrop_pools.py (a rewrite found by code)", "Snowdrop's page pools are not resized: the engine reserves 12 GB of address space, which a 4 GB memory cannot give."),
    "programs":       ("c", "main.c multi-program", "A game of several programs: only the program in the folder runs; starting another program (oe::ExecuteProgram) is not implemented."),
    "program_of":     ("c", "main.c multi-program", "One program of a multi-program game: it runs alone, with the launch parameter of its profile."),
}
# derived, class c: not a key of game.tsv but what the runtime's layout rule answers for its memory keys ("short")
ADDRESS_SPACE = ("c", "wasm32: one 4 GB memory; the verdict is the runtime's (src/glue/rt_process.ts layoutFor), only \"short\" is listed", "This game does not fit a 32-bit memory: {note}.")

UNCONVERTED = {
    "FRAME_STEP": "frame-step and screen-shape stubs: code assembled into a patch area beside the module that reads a state page the host writes each frame. Missing in the runtime: a patch area mapped with the module (the loader maps an NSO's three segments and nothing beside them), the state page, and the driver that writes the step each present (nxnative hle_nvn.c fstep_tick); docs/PORTING-STATUS.md, \"Frame-step stubs\"",
    "MATCH_FRAME_STEP": "as FRAME_STEP, placed by a function fingerprint (the matcher exists: src/prepare/match.ts); the stub is a Python function of the matched addresses, and what it writes needs the same patch area and state page",
    "OBS": "observation gates: a host callback at a pc; the translator hook exists in the hand-off format but no gate number has a nxweb callback",
    "PATCH_FILE": "the patch file could not be evaluated in the converter's sandbox (the entry says why): none of its patches is converted",
}
# rewrites nxnative's rewriter finds by code in any build (patch_nso.py), none ported: name -> (module, what)
FOUND_BY_CODE = {
    "ue_cvar.py": "Unreal console variables by their registered names (for fps_target, ue_texture_pool)",
    "fps_target.py": "a target frame rate global the game steps by",
    "ue_fixed_rate.py": "Unreal's FixedFrameRate property and flag",
    "unity_fps.py": "Unity's targetFrameRate and vSyncCount",
    "ue_malloc.py": "Unreal's FMallocBinned3 constructor calls cut (37 GB reservation), the host's allocator in its place",
    "unity_bucket.py": "Unity 2019's bucket allocator reservation cut to 256 MB",
    "snowdrop_pools.py": "Snowdrop's three page pools resized (profile key snowdrop_pools)",
    "ue_region.py": "Unreal's 62 GB engine region sized to what the alias region has",
    "ue_ring.py": "Unreal's NVN dynamic buffers: 3 copies to 4",
    "region_gates": "observation gates on VammManager's AllocateAddressRegion / FreeAddressRegion (the host's region table)",
    "spin waits": "spin-wait loops copied behind a yield gate (not needed: src/prepare/README.md)",
}


def read_tsv(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f.read().splitlines():
            if not line.strip() or line.lstrip().startswith("#"): continue
            c = line.split("\t")
            rows.append((c[0].strip(), [v.strip() for v in c[1:]]))
    return rows


# ---- patch files, evaluated without importing them ----
SAFE = {n: getattr(__builtins__, n) if not isinstance(__builtins__, dict) else __builtins__[n] for n in (
    "len", "range", "int", "bytes", "bytearray", "dict", "list", "tuple", "set", "frozenset", "sorted", "enumerate", "zip", "min", "max", "sum", "abs",
    "hex", "str", "isinstance", "any", "all", "reversed", "bool", "float", "divmod", "map", "filter", "repr", "round", "next", "iter",
    "AssertionError", "ValueError", "KeyError", "Exception", "True", "False", "None")}


class SandboxMissing(ImportError):
    """A patch file asks for a module the sandbox does not provide"""


class PatchFileSkipped(Exception):
    """A patch file that cannot be evaluated here: the reason, for the profile and the report"""


def sandbox(path, modules):
    """Execute a Python file with the whitelist above; `import` gives only what `modules` holds"""
    def imp(name, globals=None, locals=None, fromlist=(), level=0):
        if name not in modules: raise SandboxMissing(f"imports {name}, which the sandbox does not provide (it has {', '.join(sorted(modules)) or 'no modules'})")
        return modules[name]
    ns = {"__builtins__": dict(SAFE, __import__=imp, print=lambda *a, **k: None, __build_class__=None), "__name__": "patches"}
    with open(path, encoding="utf-8") as f: src = f.read()
    exec(compile(src, path, "exec"), ns)
    return ns


def load_asm(nx):
    ns = sandbox(os.path.join(nx, "dm", "tools", "nso_asm.py"), {})
    m = types.ModuleType("nso_asm")
    for k, v in ns.items():
        if not k.startswith("__"): setattr(m, k, v)
    return m


def hexb(s):
    b = bytes.fromhex(s)
    return b.hex()


def convert_cuts(table, where, problems):
    """CUTS {build id: [(offset, original hex, new hex, reason)]} -> {build id: [{off, orig, new, why}]}"""
    out, n, bad = {}, 0, 0
    for bid, rows in table.items():
        cuts = []
        for row in rows:
            n += 1
            try:
                off, ob, nb, why = row
                ob, nb = hexb(ob), hexb(nb)
                if not isinstance(off, int) or off < 0 or len(ob) != len(nb) or not ob: raise ValueError("offset or lengths")
                cuts.append({"off": off, "orig": ob, "new": nb, "why": str(why)})
            except Exception as e:
                bad += 1; problems.append(f"{where} build {bid}: a cut does not convert ({e})")
        out[bid] = cuts
    return out, n, bad


class Recorder:
    """What a FRAME_STEP function would do, at an assumed layout (the patch area 96 MB after the base, the state page
    before it): enough to count sites and stub words. Not applicable on nxweb."""
    def __init__(self):
        self.patch_base, self.state = 0x6000000, 0x5FF8000
        self.words, self.sites, self.puts = [], [], []
        self.render_scale, self.base, self.others, self.capabilities = 0, 0, {}, set()
    def here(self): return self.patch_base + 4 * len(self.words)
    def emit(self, w, kind=None): self.words.append(w & 0xFFFFFFFF)
    def site(self, off, orig): self.sites.append((off, hexb(orig)))
    def put(self, off, words, why): self.puts.append((off, len(words), why))
    def address(self, off): raise ValueError("ctx.address reads the game's text")


# ---- MATCH_CUTS: cuts placed by the function they lie in (nxnative dm/tools/nso_match.py; here src/prepare/match.ts) ----
def _signed(n, bits): return n - (1 << bits) if n & (1 << (bits - 1)) else n


def _relative(w):
    """The signed byte displacement of a direct branch (b, bl, b.cond, cbz, cbnz, tbz, tbnz), or None"""
    if w & 0x7c000000 == 0x14000000: return _signed(w & 0x3ffffff, 26) * 4
    if w & 0xff000010 == 0x54000000 or w & 0x7e000000 == 0x34000000: return _signed((w >> 5) & 0x7ffff, 19) * 4
    if w & 0x7e000000 == 0x36000000: return _signed((w >> 5) & 0x3fff, 14) * 4
    return None


def convert_match_function(fn):
    """One function of a rule, checked as nxnative's nso_match.validate checks it: {size, fingerprints, cuts}"""
    if set(fn) != {"size", "fingerprints", "cuts"}: raise ValueError("a function of a patch has size, fingerprints and cuts")
    size, fps = fn["size"], fn["fingerprints"]
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0 or size % 4: raise ValueError("invalid function size")
    if not isinstance(fps, (list, tuple)) or not fps: raise ValueError("missing function fingerprints")
    for d in fps:
        if not isinstance(d, str) or len(d) != 64 or any(c not in "0123456789abcdef" for c in d): raise ValueError("invalid function fingerprint")
    if not fn["cuts"]: raise ValueError("function patch has no cuts")
    used, cuts = set(), []
    for delta, old, new, reason in fn["cuts"]:
        ob, nb = bytes.fromhex(old), bytes.fromhex(new)
        if not reason or not isinstance(delta, int) or len(ob) != len(nb) or not ob or len(ob) % 4 or delta % 4 or not 0 <= delta <= size - len(ob): raise ValueError("invalid function-relative cut")
        span = set(range(delta, delta + len(ob)))
        if used & span: raise ValueError("overlapping cuts")
        used |= span
        for i, (w,) in enumerate(struct.iter_unpack("<I", nb)):
            # a branch that stays inside the matched function means the same wherever the function lies; anything else that is PC-relative depends on an address
            br = _relative(w)
            pcrel = br is not None or w & 0x1f000000 == 0x10000000 or w & 0x3b000000 == 0x18000000
            if pcrel and not (br is not None and 0 <= delta + i * 4 + br < size): raise ValueError("replacement must not contain PC-relative instructions, except branches inside the matched function")
        cuts.append({"off": delta, "orig": ob.hex(), "new": nb.hex(), "why": str(reason)})
    return {"size": size, "fingerprints": list(fps), "cuts": cuts}


def convert_match_cuts(table, where, problems):
    """MATCH_CUTS {module: [rule]} -> {module: [{name, functions: [{size, fingerprints, cuts: [{off, orig, new, why}]}]}]}; off is from the function's start.
    A rule of one function ({name, size, fingerprints, cuts}) and one of several ({name, functions}) come out in the one shape. Rules of one name are one
    patch's reviewed implementations: exactly one must match (the order is kept)"""
    out, n, bad = {}, 0, 0
    for mod, rules in table.items():
        conv = []
        for rule in rules:
            n += 1
            try:
                if not isinstance(rule, dict) or not rule.get("name") or not isinstance(rule["name"], str): raise ValueError("a rule needs a name")
                if "functions" in rule:
                    if set(rule) != {"name", "functions"}: raise ValueError("a patch of several functions needs only name and functions")
                    if not isinstance(rule["functions"], (list, tuple)) or len(rule["functions"]) < 2: raise ValueError("a patch of several functions needs at least two")
                    fns = [convert_match_function(f) for f in rule["functions"]]
                else:
                    if set(rule) != {"name", "size", "fingerprints", "cuts"}: raise ValueError("function patch needs name, size, fingerprints and cuts")
                    fns = [convert_match_function({k: rule[k] for k in ("size", "fingerprints", "cuts")})]
                conv.append({"name": rule["name"], "functions": fns})
            except Exception as e:
                bad += 1; problems.append(f"{where} module {mod}: a function-matched rule does not convert ({type(e).__name__}: {e})")
        if conv: out[str(mod)] = conv
    return out, n, bad


def convert_patch_file(path, asm, label):
    problems = []
    try: ns = sandbox(path, {"struct": struct, "nso_asm": asm})
    except SandboxMissing as e: raise PatchFileSkipped(str(e))
    except NameError as e: raise PatchFileSkipped(f"uses a name the sandbox does not provide ({e})")
    except Exception as e: raise PatchFileSkipped(f"fails while it is evaluated ({type(e).__name__}: {e})")
    res = {"cuts": {}, "n_cuts": 0, "bad_cuts": 0, "unconverted": [], "capabilities": {}}
    res["cuts"], res["n_cuts"], res["bad_cuts"] = convert_cuts(ns.get("CUTS", {}), label, problems)
    res["match_cuts"], res["n_match"], res["bad_match"] = convert_match_cuts(ns.get("MATCH_CUTS", {}), label, problems)
    for bid, fn in ns.get("FRAME_STEP", {}).items():
        r = Recorder(); note = ""
        try: fn(r)
        except Exception as e: note = f"; the recording stopped: {type(e).__name__}: {e}"
        res["unconverted"].append({"kind": "FRAME_STEP", "build": bid, "sites": len(r.sites), "writes": len(r.puts), "stub_words": len(r.words),
                                   "capabilities": sorted(r.capabilities), "render_scale": bool(r.render_scale), "note": "recorded" + note})
    for mod, rules in ns.get("MATCH_FRAME_STEP", {}).items():
        res["unconverted"].append({"kind": "MATCH_FRAME_STEP", "module": mod, "rules": len(rules), "names": sorted({r.get("name", "?") for r in rules})})
    for bid, rows in ns.get("OBS", {}).items():
        res["unconverted"].append({"kind": "OBS", "build": bid, "gates": len(rows)})
    for bid, caps in ns.get("CAPABILITIES", {}).items(): res["capabilities"][bid] = list(caps)
    return res, problems


EMPTY_PATCHES = {"cuts": {}, "n_cuts": 0, "bad_cuts": 0, "unconverted": [], "capabilities": {}, "match_cuts": {}, "n_match": 0, "bad_match": 0}


def version_number(v):   # 'v327680' -> 327680
    return int(v[1:]) if v.startswith("v") and v[1:].isdigit() else None


def convert_game(nx, gid, asm, problems, skipped, strict):
    d = os.path.join(nx, "dm", "games", gid)
    rows = read_tsv(os.path.join(d, "game.tsv"))
    prof = {"source": f"nxnative dm/games/{gid}/game.tsv" + ("" if not os.path.exists(os.path.join(d, "patches.py")) else " and patches.py") + " (MIT, Copyright (c) 2026 seedds)",
            "title_id": gid, "name": "", "builds": [], "apply": {}, "needs": [], "dropped": [], "unknown": [], "cuts": {}, "match_cuts": {}, "unconverted": []}
    seen = {}
    for key, vals in rows:
        val = " ".join(vals)
        if key == "build":
            if len(vals) < 2: problems.append(f"{gid}: a build row with {len(vals)} columns"); continue
            mods = dict(m.split("=", 1) for m in vals[2:] if "=" in m)
            prof["builds"].append({"version": version_number(vals[0]), "tag": vals[0], "display": vals[1], "modules": mods})
            seen.setdefault("build", "a"); continue
        cls = KEYS.get(key)
        if cls is None: prof["unknown"].append(key); problems.append(f"{gid}: key {key} is not classified"); continue
        seen[key] = cls[0]
        if key == "name": prof["name"] = val
        if cls[0] == "a": prof["apply"][key] = val
        elif cls[0] == "c": prof["needs"].append({"key": key, "value": val, "what": cls[2]})
        else: prof["dropped"].append(key)
    # the regions the profile reserves (nxnative hle_svc.c: the heap region is the reserve less 256 MB, the stack region and the alias region); what the
    # runtime makes of them is asked of the runtime's rule for all profiles together (layout_verdicts)
    raw = {k: " ".join(v) for k, v in rows}
    try:
        reserve, alias, stack = int(raw["mem_reserve"], 0), int(raw["mem_alias"], 0), int(raw["mem_stack"], 0)
        prof["address_space"] = {"heap_region": reserve - 0x10000000 - stack - alias, "alias_region": alias, "stack_region": stack}
    except (KeyError, ValueError) as e: problems.append(f"{gid}: memory keys: {e}")
    counts = {"cuts": 0, "bad_cuts": 0, "match": 0, "bad_match": 0}
    pp = os.path.join(d, "patches.py")
    if os.path.exists(pp):
        try: res, pr = convert_patch_file(pp, asm, gid)
        except PatchFileSkipped as e:
            if strict: sys.exit(f"[RED] convert_profiles --strict: {gid}/patches.py {e}")
            skipped.append({"file": f"{gid}/patches.py", "profile": gid, "reason": str(e)})
            prof["patches"] = {"converted": False, "reason": str(e)}
            prof["unconverted"] = [{"kind": "PATCH_FILE", "reason": str(e)}]
            return prof, seen, counts
        problems += pr
        own = {b for row in prof["builds"] for b in row["modules"].values()}
        for bid in res["cuts"]:
            if bid not in own: problems.append(f"{gid}: patches.py has cuts of build {bid}, which no build row of the profile names")
        # which module a build id is: from the build rows
        modof = {b: m for row in prof["builds"] for m, b in row["modules"].items()}
        prof["cuts"] = {bid: {"module": modof.get(bid, "main"), "cuts": cuts} for bid, cuts in res["cuts"].items()}
        prof["match_cuts"] = res["match_cuts"]
        prof["unconverted"] = res["unconverted"]
        if res["capabilities"]: prof["capabilities"] = res["capabilities"]
        counts = {"cuts": res["n_cuts"], "bad_cuts": res["bad_cuts"], "match": res["n_match"], "bad_match": res["bad_match"]}
    return prof, seen, counts


def layout_verdicts(profs):
    """The runtime's layout rule over every profile's regions: {title id: verdict}, and the rule's own constants for the report"""
    ask = [{"id": p["title_id"], "apply": p["apply"], "space": p["address_space"]} for p in profs if "address_space" in p]
    try: r = subprocess.run([os.environ.get("NODE", "node"), LAYOUT_VERDICT], input=json.dumps(ask), capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e: sys.exit(f"[RED] convert_profiles: the layout rule could not be run (node {LAYOUT_VERDICT}): {e}")
    if r.returncode: sys.exit(f"[RED] convert_profiles: the layout rule failed (node {LAYOUT_VERDICT}): {r.stderr.strip()[-600:]}")
    out = json.loads(r.stdout)
    return {v["id"]: v for v in out["verdicts"]}, {"rule": out["rule"], "space": out["space"], "defaults": out["defaults"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nxnative", default=NXNATIVE); ap.add_argument("--out", default=OUT)
    ap.add_argument("--check", action="store_true", help="fail when the files in --out are not what this run would write")
    ap.add_argument("--strict", action="store_true", help="fail on a patch file the sandbox cannot evaluate, instead of converting its profile without patches")
    a = ap.parse_args()
    nx, out = a.nxnative, os.path.abspath(a.out)
    games_dir = os.path.join(nx, "dm", "games")
    if not os.path.isdir(games_dir): sys.exit(f"[RED] convert_profiles: no nxnative checkout at {nx} (NXNATIVE)")
    asm = load_asm(nx)
    problems, files, skipped = [], {}, []
    gids = sorted(g for g in os.listdir(games_dir) if os.path.isfile(os.path.join(games_dir, g, "game.tsv")))
    per_class = {"a": 0, "b": 0, "c": 0}       # (profile, key) pairs
    key_profiles = {}                          # key -> number of profiles that set it
    index = {"source": SOURCE, "games": {}, "builds": {}}
    conv = {"registered_cuts": 0, "converted_cuts": 0, "patch_files": 0, "cut_builds": 0, "match_rules": 0, "converted_match_rules": 0, "match_profiles": [], "unconverted": {}}
    def unconverted(u, where):
        e = conv["unconverted"].setdefault(u["kind"], {"entries": 0, "items": 0, "profiles": []})
        e["entries"] += 1; e["items"] += u.get("rules", u.get("sites", u.get("gates", 0))); e["profiles"].append(where)
    converted = [convert_game(nx, gid, asm, problems, skipped, a.strict) for gid in gids]
    verdicts, rule = layout_verdicts([c[0] for c in converted])
    space = {"rule": rule["rule"], "space": rule["space"], "defaults": rule["defaults"], "profile": [], "pool": [], "short": [], "unknown": []}
    for gid, (prof, seen, counts) in zip(gids, converted):
        v = verdicts.get(gid)
        if v is None: space["unknown"].append(gid)
        else:
            sp = prof["address_space"]
            sp.update(fit=v["fit"], fits=v["fit"] != "short", note=v["note"], layout={"heap": v["heap"], "alias": v["alias"], "stack": v["stack"], "pool": v["pool"]})
            space[v["fit"]].append({"id": gid, "why": v["note"]} if v["fit"] != "profile" else gid)
            if v["fit"] == "short":
                prof["needs"].append({"key": "address_space", "value": f"heap {sp['heap_region']:#x} alias {sp['alias_region']:#x} stack {sp['stack_region']:#x}", "what": ADDRESS_SPACE[2].format(note=v["note"])})
                seen["address_space"] = "c"
        for k, c in seen.items():
            per_class[c] += 1; key_profiles[k] = key_profiles.get(k, 0) + 1
        files[f"{gid}.json"] = prof
        index["games"][gid] = {"name": prof["name"], "builds": len(prof["builds"]), "needs": len(prof["needs"]), "cuts": sum(len(v["cuts"]) for v in prof["cuts"].values())}
        for row in prof["builds"]:
            if "main" in row["modules"]: index["builds"].setdefault(row["modules"]["main"], gid)
        if os.path.exists(os.path.join(games_dir, gid, "patches.py")): conv["patch_files"] += 1
        conv["registered_cuts"] += counts["cuts"]; conv["converted_cuts"] += counts["cuts"] - counts["bad_cuts"]; conv["cut_builds"] += len(prof["cuts"])
        conv["match_rules"] += counts["match"]; conv["converted_match_rules"] += counts["match"] - counts["bad_match"]
        if prof["match_cuts"]: conv["match_profiles"].append(gid)
        for u in prof["unconverted"]: unconverted(u, gid)
    # the shared files: Nintendo SDK module builds, and engine-wide rules
    shared = {}
    for name in ("sdk_patches.py", "engine_patches.py"):
        try: shared[name], pr = convert_patch_file(os.path.join(nx, "dm", "tools", name), asm, name); problems += pr
        except PatchFileSkipped as e:
            if a.strict: sys.exit(f"[RED] convert_profiles --strict: {name} {e}")
            skipped.append({"file": name, "profile": None, "reason": str(e)})
            shared[name] = dict(EMPTY_PATCHES, unconverted=[{"kind": "PATCH_FILE", "reason": str(e)}])
    sdk, eng = shared["sdk_patches.py"], shared["engine_patches.py"]
    # rules for every game's module of a name, whatever the profile: the SDK's first, then the engines' (nxnative patch_nso.py SHARED)
    wide = {}
    for name, res in shared.items():
        for mod, rules in res["match_cuts"].items(): wide.setdefault(mod, []).extend(dict(r, file=name) for r in rules)
    files["_sdk.json"] = {"source": "nxnative dm/tools/sdk_patches.py and engine_patches.py (MIT, Copyright (c) 2026 seedds)",
                          "cuts": {bid: {"module": "sdk", "cuts": cuts} for bid, cuts in sdk["cuts"].items()}, "match_cuts": wide,
                          "unconverted": sdk["unconverted"] + [dict(u, file="engine_patches.py") for u in eng["unconverted"]]}
    conv["sdk_cuts"] = sdk["n_cuts"]; conv["sdk_converted"] = sdk["n_cuts"] - sdk["bad_cuts"]; conv["sdk_builds"] = len(sdk["cuts"])
    conv["wide_match_rules"] = sdk["n_match"] + eng["n_match"]; conv["converted_wide_match_rules"] = conv["wide_match_rules"] - sdk["bad_match"] - eng["bad_match"]
    for name, res in shared.items():
        for u in res["unconverted"]: unconverted(u, name)
    conv["patch_files_skipped"] = skipped
    # no build id may be claimed twice (nxnative stops the rewrite)
    claimed = {}
    for name, f in files.items():
        for bid in f.get("cuts", {}):
            if bid in claimed: problems.append(f"build {bid} has cuts in both {claimed[bid]} and {name}")
            claimed[bid] = name
    index["sdk_builds"] = sorted(files["_sdk.json"]["cuts"])
    index["match_modules"] = sorted(wide)
    classes = {k: {"class": v[0], "note": v[1], "what": v[2], "profiles": key_profiles.get(k, 0)} for k, v in KEYS.items()}
    classes["address_space"] = {"class": "c", "note": ADDRESS_SPACE[1], "what": ADDRESS_SPACE[2], "profiles": key_profiles.get("address_space", 0), "derived": True}
    top_c = sorted(((k, n) for k, n in key_profiles.items() if classes[k]["class"] == "c"), key=lambda x: (-x[1], x[0]))[:20]
    space["counts"] = {k: len(space[k]) for k in ("profile", "pool", "short", "unknown")}
    report = {"source": SOURCE, "profiles": len(gids), "address_space": space,
              "pairs_per_class": per_class, "keys_per_class": {c: sum(1 for v in classes.values() if v["class"] == c) for c in "abc"},
              "keys_set_per_class": {c: sum(1 for k, v in classes.items() if v["class"] == c and key_profiles.get(k)) for c in "abc"},
              "top_c": [{"key": k, "profiles": n} for k, n in top_c], "classes": classes, "conversion": conv,
              "unconverted_reasons": UNCONVERTED, "found_by_code": FOUND_BY_CODE, "problems": problems}
    files["index.json"] = index
    files["report.json"] = report
    text = {n: json.dumps(f, indent=1, ensure_ascii=False, sort_keys=False) + "\n" for n, f in files.items()}
    c = conv
    def summary():
        sc = space["counts"]
        print(f"address space, by the runtime's rule ({rule['rule']}): {sc['profile']} fit as reserved, {sc['pool']} fit what their pool lets them commit, {sc['short']} do not fit" + (f", {sc['unknown']} without memory keys" if sc["unknown"] else ""))
        for e in space["short"]: print(f"  does not fit: {e['id']}: {e['why']}")
        for k, e in sorted(c["unconverted"].items()): print(f"not converted: {k}: {e['entries']} entries ({e['items']} rules / sites) in {len(set(e['profiles']))} files: {', '.join(sorted(set(e['profiles'])))}")
        if skipped:
            print(f"patch files not evaluated: {len(skipped)} (their profiles are converted from game.tsv, without patches; --strict fails here)")
            for e in skipped: print(f"  {e['file']}: {e['reason']}")
    if a.check:
        stale = [n for n, t in text.items() if not os.path.exists(os.path.join(out, n)) or open(os.path.join(out, n), encoding="utf-8").read() != t]
        extra = [n for n in os.listdir(out) if n.endswith(".json") and n not in text] if os.path.isdir(out) else []
        if stale or extra: sys.exit(f"[RED] convert_profiles --check: {len(stale)} files differ, {len(extra)} are not written by this tool ({', '.join((stale + extra)[:5])})")
        print(f"convert_profiles --check: {len(text)} files are up to date")
        summary(); return
    os.makedirs(out, exist_ok=True)
    for n in os.listdir(out):
        if n.endswith(".json") and n not in text: os.remove(os.path.join(out, n))
    for n, t in text.items():
        with open(os.path.join(out, n), "w", encoding="utf-8") as f: f.write(t)
    print(f"profiles: {len(gids)} converted into {out}")
    print(f"(profile, key) pairs: a {per_class['a']}, b {per_class['b']}, c {per_class['c']}; keys known: a {report['keys_per_class']['a']}, b {report['keys_per_class']['b']}, c {report['keys_per_class']['c']}")
    print("top class c keys: " + ", ".join(f"{k} {n}" for k, n in top_c))
    print(f"registered cuts: {c['converted_cuts']} of {c['registered_cuts']} in {c['cut_builds']} builds of {c['patch_files']} patch files; sdk: {c['sdk_converted']} of {c['sdk_cuts']} in {c['sdk_builds']} builds")
    print(f"function-matched rules: {c['converted_match_rules']} of {c['match_rules']} in {len(c['match_profiles'])} profiles; for every game (sdk, engines): {c['converted_wide_match_rules']} of {c['wide_match_rules']}")
    summary()
    for p in problems: print(f"[RED] {p}")
    if problems: sys.exit(1)


if __name__ == "__main__":
    main()
