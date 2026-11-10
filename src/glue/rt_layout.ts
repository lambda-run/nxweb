// nxweb runtime: the one table of the shared linear memory's host area, 0 .. 0x0800_0000 (the kernel's "host" region,
// src/kernel/README.md). Every AssemblyScript module that lives in the shared memory gets its static data placed by
// `asc --memoryBase` from this table (src/runtime/host/build.mts), and the runtime checks at start that each module's
// static data ends inside its range (src/glue/rt_runtime.ts, rt_ranges_check in src/runtime/index.ts).
// The ranges are given as sizes in address order, so two of them cannot overlap; `layout()` turns them into addresses.

export const HOST_END = 0x0800_0000;   // the guest's code region starts here (kernel default layout)

export interface Range { name: string; lo: number; hi: number; module?: "rt" | "loader" | "kernel"; what: string }

const SIZES: [name: string, size: number, module: Range["module"] | undefined, what: string][] = [
  ["null guard",     0x0001_0000, undefined, "never written by the host: a guest null pointer reads zeroes here"],
  ["rt static",      0x000F_0000, "rt",      "src/runtime static data: process machine, fault record, clock, scratch"],
  ["loader static",  0x0010_0000, "loader",  "src/loader static data (tables, kit trace)"],
  ["loader arena",   0x0060_0000, undefined, "module records, export tables, names (ld_init)"],
  ["kernel static",  0x00A0_0000, "kernel",  "src/kernel static data: thread records and contexts, handle table, alias page states (8 MB)"],
  ["gfx static",     0x0010_0000, undefined, "reserved: src/gfx static data (its --memoryBase), not instantiated by the runtime yet"],
  ["gfx arena",      0x0100_0000, undefined, "reserved: gfx_init(arena, 16 MB), the NVN tables and host-lent segments"],
  ["file staging",   0x0200_0000, undefined, "NSO/NRO file bytes while the loader needs them"],
  ["pc map",         0x03CC_0000, undefined, "translator pc map: one u32 per guest instruction of [host stubs lo, + pc map size)"],
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

// Guest side (the kernel's default layout): where the runtime puts what it places itself
export const GUEST = {
  codeBase: 0x0800_0000,          // modules are mapped from here, one free page between them
  stackRegion: 0x7800_0000,       // the main thread's stack is the first mapping of the stack region
  mainStackSize: 0x0010_0000,     // 1 MB (default; RuntimeOptions.mainStackSize)
  pcExit: 0xFFFF_FFF0,
  pcYield: 0xFFFF_FFE0,
};

// The pc map covers the stub region and the code that follows it
export const PCMAP = { base: range("pc map").lo, codeLo: range("host stubs").lo, size: range("pc map").hi - range("pc map").lo };
export const STUBS = { base: range("host stubs").lo, cap: (range("host stubs").hi - range("host stubs").lo) >>> 2 };
