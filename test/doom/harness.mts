// The Doom guest's build: the doomgeneric engine (GPL-2, not in this repository: tools/doom/fetch.sh puts it into
// build/third_party/doomgeneric, or DOOMGENERIC names a checkout) with this repository's platform layer and small C
// library (test/doom/guest), compiled and linked like the runtime's test modules (clang aarch64 -> ld.lld ->
// tools/elf2nso.py) into build/doom/doom.nso. The game data is a file the user has (DOOM_WAD); nothing fetches it.
// Without the engine, the data file or nxnative's nvn.h every Doom step is skipped with a line that says why.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, NVN_INCLUDE, haveNvn } from "../runtime/harness.mts";

export const DOOM_OUT = join(ROOT, "build", "doom");
const GUEST = join(ROOT, "test", "doom", "guest"), RT_SRC = join(ROOT, "test", "runtime", "src");
// the engine's objects: doomgeneric's Makefile list without its own platform file
const ENGINE = ("dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus " +
  "i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy " +
  "p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main " +
  "r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc " +
  "i_input i_video doomgeneric").split(" ");
const CFLAGS = ["--target=aarch64-none-elf", "-fPIC", "-ffreestanding", "-nostdlib", "-O2", "-mcpu=cortex-a57", "-mno-outline-atomics",
  "-fvisibility=hidden", "-fsemantic-interposition", "-fno-asynchronous-unwind-tables", "-fno-unwind-tables"];
const LDFLAGS = ["-shared", "-z", "max-page-size=4096", "-z", "norelro", "--build-id=sha1", "--hash-style=both", "-T", join(ROOT, "test", "loader", "src", "module.ld")];

// The engine checkout (the directory that holds doomgeneric.h), or null
export function doomEngine(): string | null {
  const top = process.env.DOOMGENERIC || join(ROOT, "build", "third_party", "doomgeneric");
  const dir = join(top, "doomgeneric");
  return existsSync(join(dir, "doomgeneric.h")) ? dir : null;
}
// The game data file DOOM_WAD names, or null
export function doomWad(): string | null {
  const p = process.env.DOOM_WAD;
  return p && existsSync(p) ? p : null;
}
// Why the Doom steps cannot run here ("" when they can); wad: the data file is needed too
export function doomSkip(wad: boolean): string {
  if (!doomEngine()) return "the doomgeneric engine is not here (run tools/doom/fetch.sh, or set DOOMGENERIC to a checkout)";
  if (!haveNvn()) return `${join(NVN_INCLUDE, "nvn.h")} not found (set NXNATIVE_NVN_INCLUDE)`;
  if (wad && !doomWad()) return process.env.DOOM_WAD ? `DOOM_WAD=${process.env.DOOM_WAD} does not exist` : "DOOM_WAD is not set (the path of doom1.wad, the shareware data file; it is not fetched)";
  return "";
}

// build/doom/doom.nso; null (and one line) when the engine or nvn.h is absent. Objects are rebuilt when their source,
// a header of the guest or the flags changed.
export function buildDoom(log: (l: string) => void = l => console.error(l)): string | null {
  const why = doomSkip(false);
  if (why) { log(`doom: SKIPPED, ${why}`); return null; }
  const engine = doomEngine()!, obj = join(DOOM_OUT, "obj"), nso = join(DOOM_OUT, "doom.nso");
  mkdirSync(obj, { recursive: true });
  const mtime = (p: string) => statSync(p).mtimeMs, o = (n: string) => join(obj, n + ".o");
  const inc = ["-I", join(GUEST, "include"), "-I", engine];
  const stamp = JSON.stringify([engine, CFLAGS, LDFLAGS, "lz4", execFileSync("clang", ["--version"], { encoding: "utf8" }).split("\n")[0]]);
  const fresh = existsSync(join(obj, "stamp")) && readFileSync(join(obj, "stamp"), "utf8") === stamp;
  const headers = Math.max(...(readdirSync(join(GUEST, "include"), { recursive: true }) as string[]).map(h => mtime(join(GUEST, "include", h))), mtime(join(RT_SRC, "rt.h")), mtime(join(RT_SRC, "gfx.h")));
  const cc = (src: string, out: string, flags: string[]) => {
    if (fresh && existsSync(out) && mtime(out) > Math.max(mtime(src), headers)) return false;
    execFileSync("clang", [...CFLAGS, ...flags, "-c", src, "-o", out], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    return true;
  };
  let built = 0;
  for (const n of ENGINE) built += Number(cc(join(engine, n + ".c"), o(n), [...inc, "-w"]));   // third-party code: its warnings are not ours
  built += Number(cc(join(GUEST, "libc.c"), o("nx_libc"), [...inc, "-I", RT_SRC, "-Wall", "-Wno-unused-parameter", "-Wno-unused-function"]));
  built += Number(cc(join(GUEST, "dg_nx.c"), o("nx_dg"), [...inc, "-I", RT_SRC, "-I", NVN_INCLUDE, "-Wall", "-Wno-unused-parameter", "-Wno-unused-function", "-Wno-unused-variable"]));
  built += Number(cc(join(RT_SRC, "crt0.S"), o("nx_crt0"), []));
  built += Number(cc(join(RT_SRC, "svc.S"), o("nx_svc"), []));
  writeFileSync(join(obj, "stamp"), stamp);
  if (built || !fresh || !existsSync(nso)) {
    const so = join(DOOM_OUT, "doom.so");
    execFileSync("ld.lld", [...LDFLAGS, o("nx_crt0"), ...ENGINE.map(o), o("nx_libc"), o("nx_dg"), o("nx_svc"), "-o", so], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    execFileSync("python3", [join(ROOT, "tools", "elf2nso.py"), so, nso, "--lz4"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    log(`doom: built ${nso} (${statSync(nso).size} bytes, ${built} objects compiled) from the engine at ${engine}`);
  }
  return nso;
}

// The reference: the same engine built for this machine with a platform layer that shows nothing (ref/dg_host.c), run
// with the given arguments in build/doom/ref. Returns what it printed ("REF <tic> <frame checksum> <map> <health>
// <bullets> <x> <y>" for every 50th tic), or null when the host compiler cannot build it (said in one line).
export function doomReference(args: string[], log: (l: string) => void = l => console.error(l)): string | null {
  const engine = doomEngine(), wad = doomWad();
  if (!engine || !wad) return null;
  const dir = join(DOOM_OUT, "ref"), exe = join(dir, "doomref"), src = join(ROOT, "test", "doom", "ref", "dg_host.c");
  mkdirSync(dir, { recursive: true });
  try {
    if (!existsSync(exe) || statSync(exe).mtimeMs < statSync(src).mtimeMs)
      execFileSync("clang", ["-O1", "-w", "-funsigned-char", "-I", engine, ...ENGINE.map(n => join(engine, n + ".c")), src, "-lm", "-o", exe], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) { log(`doom: the reference build for this machine failed (${String((e as { stderr?: Buffer }).stderr ?? e).split("\n")[0]}): the comparison is skipped`); return null; }
  // the engine ends a -timedemo through its error exit
  try { return execFileSync(exe, ["-iwad", wad, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 }); }
  catch (e) { return String((e as { stdout?: string }).stdout ?? ""); }
}
