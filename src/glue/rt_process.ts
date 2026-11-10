// nxweb runtime glue: one process's address-space layout and settings, from the game's profile (src/prepare:
// HandOff.profile.apply and its address_space) instead of the kernel's fixed default.
//
// What a profile asks for is RESERVED address space (nxnative's mem_reserve / mem_alias / mem_stack: a heap region,
// an alias region, a stack region); what a game can COMMIT in the heap and the alias region together is bounded by
// the application pool the kernel reports (app_pool: 3285 MiB on a Switch, hle_svc.c APP_POOL) less mem_used and the
// modules. A wasm32 memory has 4 GB of addresses: 128 MB host area, 252 MB code region, 4 MB thread-local region,
// and 0x1800_0000 .. 0xFFFF_0000 (3.62 GB) for heap + stack region + alias region. So the split is chosen per game:
//   "profile"  the regions fit as the profile has them (the heap region capped at pool - used, which SetHeapSize
//              cannot pass anyway)
//   "pool"     they fit once the stack region is 64 MB and the larger of the two regions is cut to the address space
//              that is left: less than the profile reserved, and still at least the pool, that is everything the
//              game can commit there
//   "short"    not even that: the pool itself is larger than the address space (Switch 2 titles with a 9 GB pool).
//              The process gets what there is and a red line; such a game needs a 64-bit memory.
// A 64-bit memory (RuntimeOptions.mem64; V8 gives one at most 16 GB) has the same host area and the same rule with
// more room: the regions end at 0x3_FFFF_0000 instead of 0xFFFF_0000 and the alias region has no cap of its own
// (the kernel's page table is two-level; its leaves beyond 3.5 GB of mapped address space come from an arena at the
// top of the code region, which the layout sizes). By that rule every profile that is "short" in 32 bits fits:
// layoutChoice() is the one function that says which mode a profile needs, and what the mode may cost in real memory.
import type { Runtime } from "./rt_runtime.ts";
import { HOST_END } from "./rt_layout.ts";

export interface ProcessWant {
  heap?: number; alias?: number; stack?: number;        // bytes of address space the profile reserves (address_space)
  code?: number;                                        // bytes of the start set's images (nsoImageBytes of each file): the code region grows past its 252 MB when they need it
  appPool?: number; memUsed?: number; sysResource?: number; programId?: bigint; mapLimit?: boolean; switch2?: boolean;
}
export interface ProcessLayout {
  codeBase: number; codeSize: number; tlsBase: number; tlsSize: number;
  heapBase: number; heapSize: number; stackBase: number; stackSize: number; aliasBase: number; aliasSize: number;
  appPool: number; memUsed: number; sysResource: number; programId: bigint; flags: number;
  fit: "profile" | "pool" | "short"; note: string;
  mem64?: boolean;       // the layout is for a 64-bit memory (it may reach past 4 GB): the Runtime needs mem64 and the wasm64 modules
  aliasArena?: number;   // bytes at the top of the code region for the kernel's alias page table (kernel_alias_arena); 0 or absent: the static leaves are enough
}
// Where a layout is made: the kind of memory, and where the code region starts (tests place the whole process above
// 4 GB with it; the regions follow the code region as they always do)
export interface SpaceOptions { mem64?: boolean; codeBase?: number }
export const SPACE64 = { hi: 0x3_FFFF_0000, aliasStatic: 0xE000_0000 };   // 16 GB less the last 64 KiB; the alias address space the kernel's static leaves cover
let defaultSpace: SpaceOptions = {};
// What layoutFor and a Runtime without a layout use when they are not told (tests: NX_MEM=64hi puts every process
// above 4 GB with it). The default default is the 32-bit space with the code region at 0x0800_0000.
export function setDefaultSpace(o: SpaceOptions): void { defaultSpace = { ...o }; }
export function getDefaultSpace(): SpaceOptions { return defaultSpace; }
const MB = 1 << 20, GB = 1024 * MB, up = (v: number, a: number) => Math.ceil(v / a) * a;
export const SPACE = { codeBase: 0x0800_0000, codeSize: 0x0FC0_0000, tlsBase: 0x17C0_0000, tlsSize: 0x0040_0000, lo: 0x1800_0000, hi: 0xFFFF_0000, aliasMax: 0xE000_0000 };
export const DEFAULTS = { heap: 0x6000_0000, alias: 0x77FF_0000, stack: 0x1000_0000, appPool: 0xCD50_0000, memUsed: 0x0400_0000 };

// What the code region holds besides the start set's images: modules loaded at run time, host-allocated blocks (the
// audio arena, JIT environments, font work buffers), one free page after each
export const CODE_SPARE = 64 * MB;
// The image size an NSO file's header declares (text .. the end of the bss, in pages); 0 when it is not an NSO. Only
// to size the code region before the process exists: the loader validates the header when the file is loaded.
export function nsoImageBytes(file: Uint8Array): number {
  if (file.length < 0x100 || file[0] !== 0x4E || file[1] !== 0x53 || file[2] !== 0x4F || file[3] !== 0x30) return 0;
  const dv = new DataView(file.buffer, file.byteOffset, 0x100);
  let end = 0;
  for (let i = 0; i < 3; i++) end = Math.max(end, dv.getUint32(0x14 + 16 * i, true) + dv.getUint32(0x18 + 16 * i, true));
  return up(end + dv.getUint32(0x3C, true), 0x1000);
}

export function layoutFor(w: ProcessWant = {}, o: SpaceOptions = defaultSpace): ProcessLayout {
  const mem64 = !!o.mem64, codeBase = o.codeBase ?? SPACE.codeBase, spaceHi = mem64 ? SPACE64.hi : SPACE.hi;
  const spaceLo = codeBase + (SPACE.lo - SPACE.codeBase);   // where the heap region starts behind a code region of the default size
  // a 64-bit memory: the alias region may be larger than the kernel's static page-table leaves cover (3.5 GB); the
  // leaves beyond them (16 bytes per 4 KiB page) are an arena at the top of the code region
  const arena = mem64 ? up(Math.max(0, Math.min(w.alias ?? 0, spaceHi) - SPACE64.aliasStatic) / 256, 2 * MB) : 0;
  // the code region: 252 MB, or what the images need (plus a free page each and the spare), in 2 MB steps. The
  // thread-local region follows it and the heap region starts after that, so a larger code region is address space
  // the heap, stack and alias regions do not have
  const lo = Math.min(Math.max(spaceLo, up(codeBase + (w.code ?? 0) + CODE_SPARE + arena + SPACE.tlsSize, 2 * MB)), spaceHi - 512 * MB);
  const tlsBase = lo - SPACE.tlsSize, codeSize = tlsBase - codeBase;
  const images = lo > spaceLo ? w.code ?? 0 : 0;   // the images are committed from the pool too: with a larger code region, that much less is left for the heap and the alias region
  const room = spaceHi - lo, pool = w.appPool ?? DEFAULTS.appPool, used = w.memUsed ?? DEFAULTS.memUsed;
  const gb = (v: number) => (v / GB).toFixed(2) + " GB";
  // no profile: the default regions, the alias region less what a larger code region takes
  let heap = up(w.heap ?? DEFAULTS.heap, 2 * MB), alias = up(w.alias ?? Math.max(256 * MB, DEFAULTS.alias - (lo - spaceLo)), 0x10000), stack = up(w.stack ?? DEFAULTS.stack, 2 * MB);
  const asked = { heap, alias, stack };
  let fit: ProcessLayout["fit"] = "profile", note = "";
  // the heap can never be set past pool - used: address space beyond it is never touched
  const heapMost = up(Math.max(2 * MB, pool - used), 2 * MB);
  if (heap > heapMost) heap = heapMost;
  if (heap + alias + stack > room) {
    fit = "pool";
    stack = Math.min(stack, 64 * MB);
    // a game that maps in the alias region commits that much less heap, and the other way round: what both can hold
    // together is the pool. The region the profile made large must hold the pool; the other keeps what it asked for
    if (asked.alias >= asked.heap) {
      heap = Math.min(heap, asked.heap);
      alias = Math.min(asked.alias, room - stack - heap);   // all the address space there is: the SDK's virtual address manager spreads over what it is told
      if (alias < Math.min(asked.alias, pool - images)) { fit = "short"; heap = Math.min(heap, 128 * MB); alias = room - stack - heap; }
    } else {
      alias = Math.min(alias, asked.alias, Math.max(256 * MB, room - stack - heap));
      if (heap + alias + stack > room) { fit = "short"; alias = 256 * MB; heap = room - stack - alias; }
    }
  }
  heap = Math.floor(heap / (2 * MB)) * 2 * MB; stack = Math.floor(stack / (2 * MB)) * 2 * MB;
  const heapBase = lo, stackBase = heapBase + heap, aliasBase = stackBase + stack;
  let aliasSize = Math.min(alias, spaceHi - aliasBase, mem64 ? spaceHi : SPACE.aliasMax);
  aliasSize = Math.floor(aliasSize / 0x10000) * 0x10000;
  if (fit !== "profile") note = `the profile reserves heap ${gb(asked.heap)}, alias ${gb(asked.alias)}, stack ${gb(asked.stack)} with a pool of ${gb(pool)}; this process has heap ${gb(heap)}, alias ${gb(aliasSize)}, stack ${gb(stack)}` +
    (fit === "pool" ? ": everything the pool lets the game commit fits, with less spare address space than nxnative gives it" : (mem64 ? ": the pool is larger than the 16 GB a 64-bit memory can have; the game runs until it needs more" : ": the pool is larger than a 32-bit address space can hold; the game runs until it needs more (a 64-bit memory would be needed)"));
  if (lo > spaceLo) note = `code region ${(codeSize / MB).toFixed(0)} MB for ${((w.code ?? 0) / MB).toFixed(0)} MB of module images` + (note ? "; " + note : "");
  const l: ProcessLayout = { codeBase, codeSize, tlsBase, tlsSize: SPACE.tlsSize, heapBase, heapSize: heap, stackBase, stackSize: stack, aliasBase, aliasSize,
    appPool: fit === "short" ? Math.min(pool, room - stack) : pool, memUsed: used, sysResource: w.sysResource ?? 0, programId: w.programId ?? 0n, flags: (w.mapLimit ? 1 : 0) | (w.switch2 ? 2 : 0), fit, note };
  if (mem64) { l.mem64 = true; l.aliasArena = aliasSize > SPACE64.aliasStatic ? Math.min(arena, up((aliasSize - SPACE64.aliasStatic) / 256, 0x10000)) : 0; }
  return l;
}

// Which memory a process needs, by the one rule: the 32-bit layout when the profile fits it ("profile" or "pool"),
// else the layout for a 64-bit memory. `real`: the most real memory the linear memory may come to hold in that
// layout, in bytes: everything the pool lets the game commit, the module images, and the host area with the spare of
// the code region (nxweb's own tables, host-allocated blocks). What the GPU process and the browser hold is not in it.
export interface LayoutChoice { layout: ProcessLayout; mem64: boolean; real: number; sentence: string }
export function memoryMost(l: ProcessLayout, code = 0): number {
  return Math.min(l.appPool, l.heapSize + l.aliasSize) + up(code, 2 * MB) + HOST_END + CODE_SPARE + (l.aliasArena ?? 0);
}
export function layoutChoice(w: ProcessWant = {}, o: { codeBase?: number; have64?: boolean } = {}): LayoutChoice {
  const gb = (v: number) => (v / GB).toFixed(1) + " GB";
  const l32 = layoutFor(w, { codeBase: o.codeBase });
  if (l32.fit !== "short") return { layout: l32, mem64: false, real: memoryMost(l32, w.code), sentence: "" };
  const l64 = layoutFor(w, { mem64: true, codeBase: o.codeBase }), real = memoryMost(l64, w.code);
  if (l64.fit === "short" || o.have64 === false) return { layout: l32, mem64: false, real: memoryMost(l32, w.code), sentence: l32.note };
  return { layout: l64, mem64: true, real,
    sentence: `runs in 64-bit memory mode: heap ${gb(l64.heapSize)}, alias ${gb(l64.aliasSize)}, pool ${gb(l64.appPool)} (${l64.fit === "profile" ? "as the profile reserves them" : "everything the pool lets the game commit"}); the tab may come to use up to ${gb(real)} of real memory` };
}

// ---- a profile's `apply` record (src/prepare: Record<string, string>) ----
const num = (s: string | undefined): number | undefined => s === undefined || s === "" ? undefined : Number(s);
export interface ProfileApply { [key: string]: string }
export interface ProcessSettings {
  layout: ProcessLayout;
  mainStackSize?: number;                                   // npdm.stackSize
  hle: { opmode?: number; perfBoost?: boolean; allocBigAlign?: boolean; gameEnv?: string; launchSpec?: string; displayVersion?: string };
  choice?: LayoutChoice;                                    // settingsFor(..., { mem64: "auto" }): which memory the layout is for, and its cost
  gfx: GfxSettings;
}
// What the graphics glue takes from a profile (RtGfx's `profile` option). bits: src/gfx/profile.ts (gfx_set_profile)
export interface GfxSettings { bits: number }
export const GFX_PROFILE = { renderCond: 1, texFlush: 2, texDirty: 4, tsSegment: 8, presentDisplay: 16 };
export function gfxSettingsFor(apply: ProfileApply = {}): GfxSettings {
  let bits = 0;
  if (apply.render_cond === "on") bits |= GFX_PROFILE.renderCond;
  if (apply.tex_flush_upload === "on") bits |= GFX_PROFILE.texFlush;
  if (apply.tex_dirty_upload === "on" && apply.tex_flush_upload === "on") bits |= GFX_PROFILE.texDirty;   // nxnative: needs tex_flush_upload
  if (apply.gpu_timestamps === "segment") bits |= GFX_PROFILE.tsSegment;
  if (apply.present_interval === "display") bits |= GFX_PROFILE.presentDisplay;
  return { bits };
}
// apply: the profile's keys; space: its address_space record (bytes); npdm / displayVersion: from the hand-off
// mem64: false (default) the layout for a 32-bit memory, as it always was; true the one for a 64-bit memory;
// "auto" what layoutChoice says (64-bit only for a profile that is short in 32 bits). `choice` is set with "auto".
// in: the space to lay out in instead (tests); none of the two given: the default space.
export function settingsFor(apply: ProfileApply = {}, o: { space?: { heap_region?: number; alias_region?: number; stack_region?: number }; stackSize?: number; displayVersion?: string | null; programId?: string; code?: number; mem64?: boolean | "auto"; in?: SpaceOptions } = {}): ProcessSettings {
  const id = apply.program_id ?? o.programId ?? apply.title_id;
  const want: ProcessWant = { code: o.code, heap: o.space?.heap_region, alias: o.space?.alias_region, stack: o.space?.stack_region, appPool: num(apply.app_pool), memUsed: num(apply.mem_used), sysResource: num(apply.sys_resource),
    programId: id && /^[0-9a-fA-F]{1,16}$/.test(id) ? BigInt("0x" + id) : 0n, mapLimit: apply.mem_map_limit === "on" || apply.mem_map_limit === "1" };
  const choice = o.mem64 === "auto" ? layoutChoice(want) : undefined;
  const layout = choice ? choice.layout : o.in ? layoutFor(want, o.in) : o.mem64 === undefined ? layoutFor(want) : layoutFor(want, { mem64: o.mem64 });
  const hle: ProcessSettings["hle"] = {};
  if (apply.op_mode) hle.opmode = apply.op_mode === "handheld" ? 0 : 1;
  if (apply.perf_mode) hle.perfBoost = apply.perf_mode === "boost";
  if (apply.alloc_big_align) hle.allocBigAlign = apply.alloc_big_align === "on";
  if (apply.game_env) hle.gameEnv = apply.game_env;
  if (apply.launch_param) hle.launchSpec = apply.launch_param;
  if (o.displayVersion) hle.displayVersion = o.displayVersion;
  return { layout, mainStackSize: o.stackSize && o.stackSize >= 0x4000 ? o.stackSize : undefined, hle, gfx: gfxSettingsFor(apply), choice };
}
// The kernel's cfg block (src/kernel/index.ts kernel_init) at p
export function writeKernelCfg(rt: Pick<Runtime, "dv">, p: number, l: ProcessLayout): void {
  const dv = rt.dv(), v = [l.codeBase, l.codeSize, l.tlsBase, l.tlsSize, l.heapBase, l.heapSize, l.stackBase, l.stackSize, l.aliasBase, l.aliasSize, l.appPool, l.memUsed, l.sysResource];
  v.forEach((x, i) => dv.setBigUint64(p + 8 * i, BigInt(x), true));
  dv.setBigUint64(p + 104, l.programId, true); dv.setBigUint64(p + 112, BigInt(l.flags), true); dv.setBigUint64(p + 120, 0n, true);
}
