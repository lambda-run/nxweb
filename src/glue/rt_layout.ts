// nxweb runtime: the one table of the shared linear memory's host area, 0 .. 0x0800_0000 (the kernel's "host" region,
// src/kernel/README.md). Every AssemblyScript module that lives in the shared memory gets its static data placed by
// `asc --memoryBase` from this table (src/runtime/host/build.mts), and the runtime checks at start that each module's
// static data ends inside its range (src/glue/rt_runtime.ts, rt_ranges_check in src/runtime/index.ts).
// The ranges are given as sizes in address order, so two of them cannot overlap; `layout()` turns them into addresses.

export const HOST_END = 0x0800_0000;   // the guest's code region starts here (kernel default layout)

export interface Range { name: string; lo: number; hi: number; module?: "rt" | "loader" | "kernel" | "gfx" | "fs" | "hle" | "audio"; what: string }

const SIZES: [name: string, size: number, module: Range["module"] | undefined, what: string][] = [
  ["null guard",     0x0001_0000, undefined, "never written by the host: a guest null pointer reads zeroes here"],
  ["rt static",      0x000F_0000, "rt",      "src/runtime static data: process machine, fault record, clock, scratch"],
  ["loader static",  0x0010_0000, "loader",  "src/loader static data (tables, kit trace)"],
  ["loader arena",   0x0060_0000, undefined, "module records, export tables, names (ld_init)"],
  ["kernel static",  0x0100_0000, "kernel",  "src/kernel static data: thread records and contexts, handle table, alias page states (14 MB for an alias region of up to 3.5 GB)"],
  ["gfx static",     0x0010_0000, "gfx",     "src/gfx static data (its --memoryBase in build/runtime/gfx.wasm)"],
  ["gfx arena",      0x0200_0000, undefined, "gfx_init(arena, gfx_arena_bytes()): 24 MB today, 32 MB kept"],
  ["file staging",   0x0100_0000, undefined, "module file bytes while the loader needs them, when they are small (16 MB): the start set of a small program, modules loaded at run time; its free tail is scratch. A larger start set is staged outside this table: STAGING below"],
  ["fs static",      0x0010_0000, "fs",      "src/fs static data (its --memoryBase in build/runtime/fs.wasm; about 400 KB)"],
  ["fs arena",       0x0070_0000, undefined, "fs_init(arena): RomFS tables of the mounted images, save trees, directory snapshots (7 MB)"],
  ["a64 translator", 0x0100_0000, undefined, "src/a64 translator static data and buffers (its --memoryBase, root a64:build script)"],
  ["a64 helpers",    0x0001_0000, undefined, "src/a64 helpers static data (its --memoryBase)"],
  ["a64 entry bits", 0x0080_0000, undefined, "translator: 1 bit per instruction of the 256 MB code region (known function entries)"],
  ["pc map",         0x014B_0000, undefined, "translator pc map: first level (256 KB), zero leaf, then one 64 KB leaf per touched 64 KB of code"],
  // ---- from here on the guest may read and write (GUARD_BASE): the two modules below hand the guest pointers into
  // ---- their static data, as nxnative's host does in its one address space (SystemEvent objects the SDK fills,
  // ---- localtime's struct tm, language lists, device names)
  ["hle static",     0x0010_0000, "hle",     "src/hle static data (its --memoryBase in build/runtime/hle.wasm; about 460 KB)"],
  ["audio static",   0x0010_0000, "audio",   "src/audio static data (its --memoryBase in build/runtime/audio.wasm; about 300 KB with the device ring). Its arena is host-allocated at the first nn::audio call"],
  ["host stubs",     0x0004_0000, undefined, "loader stub region: 4 bytes (UDF #id) per host function, 65536 stubs"],
];

export function layout(): Range[] {
  const out: Range[] = [];
  let lo = 0;
  for (const [name, size, module, what] of SIZES) { out.push({ name, lo, hi: lo + size, module, what }); lo += size; }
  return out;
}
export const RANGES: Range[] = layout();
export function range(name: string): Range {
  const r = RANGES.find(r => r.name === name);
  if (!r) throw new Error(`rt_layout: no range "${name}"`);
  return r;
}

// File staging beyond the fixed range. The loader needs each module's file in linear memory until the module is pinned,
// and a game's main module is 20 to 150 MB or more. Rather than a fixed range sized for the largest game (address space
// and memory every small program would pay for), the files of a start set that does not fit "file staging" are staged
// in the process's own data regions, from the base of the heap region on (heap, stack and alias regions follow each
// other without a gap in a layout made by layoutFor), sized from the files themselves. Nothing is mapped there while
// the process is loaded, and the game commits that memory anyway: no address space is reserved, and the pages are
// used again by the game's heap. The modules of a start set are pinned as soon as they are relocated (they are never
// unloaded), and the staged bytes are zeroed again before the main thread's stack is mapped and long before the first
// guest instruction: the guest never sees them, and the kernel finds the zeroes it expects of memory it has not
// handed out. What remains as limits: the files together must fit those regions (3.6 GB in the default layout) and
// the host must let the memory grow that far; each image must fit the code region (rt_process.ts layoutFor({ code })
// sizes it per game); a module loaded at run time that does not fit "file staging" is staged in host-allocated pages
// of the code region, for the life of the process.
export const STAGING = {
  fixed: "file staging",                       // the range of the table that is tried first
  borrowed: "heap, stack and alias regions",   // ProcessLayout.heapBase .. the end of the alias region (the kernel's default: 0x1800_0000 .. 0xFFFF_0000)
  pageAlign: 0x1000,                           // every file starts on a page
};

// Guest side (the kernel's default layout): where the runtime puts what it places itself
export const GUEST = {
  codeBase: 0x0800_0000,          // modules are mapped from here, one free page between them
  stackRegion: 0x7800_0000,       // the main thread's stack is the first mapping of the stack region
  mainStackSize: 0x0010_0000,     // 1 MB (default; RuntimeOptions.mainStackSize)
  pcExit: 0xFFFF_FFF0,
  pcYield: 0xFFFF_FFE0,
};

// The a64 translator's part of the table (src/glue/a64_host.ts, A64Layout). The pc map is two-level and covers the
// whole 4 GB of guest addresses; its leaves are allocated on demand from the "pc map" range.
export const A64 = {
  translatorBase: range("a64 translator").lo, translatorEnd: range("a64 translator").hi,
  helpersBase: range("a64 helpers").lo, helpersEnd: range("a64 helpers").hi,
  entryBitsBase: range("a64 entry bits").lo, codeRegionLo: GUEST.codeBase, codeRegionSize: 0x1000_0000,
  pcmapBase: range("pc map").lo, pcmapEnd: range("pc map").hi,
};
// With the guard (RuntimeOptions.guard) a guest load or store below this address traps: the null page and the state of
// the runtime, the loader, the kernel, graphics, the file system and the translator. Above it, still in the host
// area: the take-over table's and the audio module's static data (the guest is handed pointers into them) and the
// stub region.
export const GUARD_BASE = range("hle static").lo;
export const STUBS = { base: range("host stubs").lo, cap: (range("host stubs").hi - range("host stubs").lo) >>> 2 };
