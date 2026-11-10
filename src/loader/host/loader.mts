// Embedder side of the loader (Node or browser, no Node APIs): a typed wrapper over the ld_* exports of a module
// built from src/loader/index.ts. See ../README.md.
import type { KitExports } from "../../kit/host/reader.mts";

export interface LoaderExports extends KitExports {
  ld_init(arena: number, arenaLen: number, stubBase: number, stubCap: number): number;
  ld_host_add(name: number, len: number, kind: number): number;
  ld_host_count(): number; ld_host_kind(id: number): number; ld_host_name_ptr(id: number): number; ld_host_name_len(id: number): number;
  ld_host_refs(id: number): number; ld_host_first_module(id: number): number; ld_host_find(name: number, len: number): number;
  ld_stub_base(): number; ld_stub_cap(): number; ld_stub_addr(id: number): number; ld_stub_id(addr: bigint): number; ld_stub_overflow(): number;
  ld_check_forced(): number; ld_force_strict(on: number): void;
  ld_parse(file: number, len: number, opts: number): number;
  ld_set_name(h: number, name: number, len: number): number;
  ld_map(h: number, base: number): number; ld_relocate(h: number): number; ld_activate(h: number): number;
  ld_pin(h: number): number; ld_unload(h: number): number;
  ld_state(h: number): number; ld_get(h: number, what: number): number;
  ld_module_count(): number; ld_loaded_count(): number; ld_loaded_at(i: number): number;
  ld_lookup(name: number, len: number): bigint; ld_lookup_in(h: number, name: number, len: number): bigint; ld_lookup_module(): number;
  ld_unresolved(h: number, out: number, cap: number): number;
  ld_code_entries(h: number, out: number, cap: number): number;
  ld_error_ptr(): number; ld_error_len(): number; ld_error_clear(): void;
  ld_faults(): number; ld_arena_used(): number; ld_heap_base(): number;
  ld_sha256(ptr: number, len: number, out: number): void;
  ld_lz4(src: number, srcLen: number, dst: number, dstCap: number): number;
  ld_zbic(src: number, srcLen: number, dst: number, dstCap: number): number;
  ld_zbic_begin(src: number, srcLen: number, dst: number, dstCap: number): void; ld_zbic_step(budget: number): number; ld_zbic_produced(): number;
  ld_zbic_stat(i: number): number; ld_zbic_stats_clear(): void; ld_xxh64(ptr: number, len: number): bigint;
}

// Must match src/loader/module.ts and src/loader/defs/module.json
export const OK = 0, ERR_ARG = -1, ERR_STATE = -2, ERR_REFUSED = -3, ERR_NOMEM = -4;
export const HOST_HLE = 0, HOST_FORCE = 1, HOST_UNRESOLVED = 2;
export const OPT_VERIFY_HASH = 1;
export const KIND_NSO = 1, KIND_NRO = 2;
export const STATES = ["New", "Parsed", "Mapped", "Relocated", "Active", "Pinned", "Unloaded", "Refused"] as const;
export type State = typeof STATES[number];
export const REFUSE_REASONS = ["", "header", "layout", "decompress", "hash", "mod0", "dynamic", "symbols", "relocs", "arena"] as const;
export const Info = {
  Kind: 0, Base: 1, ImageSize: 2, Entry: 3, TextOff: 4, TextSize: 5, RoOff: 6, RoSize: 7, DataOff: 8, DataSize: 9, BssSize: 10, Flags: 11,
  BuildIdPtr: 12, Mod0: 13, Dynamic: 14, Init: 15, Fini: 16, InitArray: 17, InitArrayCount: 18, FiniArray: 19, FiniArrayCount: 20,
  SymbolCount: 21, HasHash: 22, HasGnuHash: 23, HasRelr: 24, RelRelative: 25, RelRelr: 26, RelAbs64: 27, RelGlobDat: 28, RelJumpSlot: 29,
  RelUnsupported: 30, RelWeakZero: 31, Loads: 32, RefuseReason: 33, NamePtr: 34, NameLen: 35, FilePtr: 36, Mod0BssStart: 37, Mod0BssEnd: 38,
} as const;

export class LoaderError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

export interface HostFunction { id: number; name: string; kind: number; stub: number; refs: number; firstModule: number }
export interface ModuleInfo {
  handle: number; name: string; state: State; kind: number; base: number; imageSize: number; entry: number;
  text: { addr: number; size: number }; ro: { addr: number; size: number }; data: { addr: number; size: number }; bssSize: number;
  buildId: Uint8Array; init: number; fini: number; initArray: number[]; finiArray: number[]; symbolCount: number;
  relocs: { relative: number; relr: number; abs64: number; globDat: number; jumpSlot: number; unsupported: number; weakZero: number };
  loads: number; refuseReason: string;
}
export interface FileInMemory { name: string; ptr: number; len: number }
export interface LoadedSet {
  modules: ModuleInfo[];
  entry: number;                 // guest address of the first module's first instruction
  initCalls: number[];           // DT_INIT of each module that has one, in load order (what Horizon's rtld calls)
  unresolved: { module: string; name: string; stub: number }[];
  forcedUnused: number;          // forced take-over names no module referred to (each was logged red)
}

const SCRATCH = 0x2000;   // the start of the arena is the wrapper's: names passed to the module, lists read back

export class Loader {
  x: LoaderExports;
  private scratch: number;
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  // arena: working memory of the loader (records, export tables, names: about 8 bytes per dynamic symbol plus 64 KiB is
  // plenty); stubBase/stubCap: the host stub region, 4 bytes per host function, a guest address range kept free of modules.
  constructor(x: LoaderExports, o: { arena: number; arenaLen: number; stubBase: number; stubCap: number }) {
    this.x = x;
    this.scratch = o.arena;
    if (o.arenaLen <= SCRATCH) throw new LoaderError(ERR_ARG, "the arena is too small");
    this.check(x.ld_init(o.arena + SCRATCH, o.arenaLen - SCRATCH, o.stubBase, o.stubCap));
  }

  private get u8(): Uint8Array { return new Uint8Array(this.x.memory.buffer); }
  private get dv(): DataView { return new DataView(this.x.memory.buffer); }
  error(): string { return this.dec.decode(this.u8.subarray(this.x.ld_error_ptr() >>> 0, (this.x.ld_error_ptr() >>> 0) + this.x.ld_error_len())); }
  private check(rc: number): number {
    if (rc < 0) throw new LoaderError(rc, this.error() || `loader error ${rc}`);
    return rc;
  }
  private name(s: string): [number, number] {
    const b = this.enc.encode(s);
    if (b.length > SCRATCH) throw new LoaderError(ERR_ARG, "name too long");
    this.u8.set(b, this.scratch);
    return [this.scratch, b.length];
  }
  private str(ptr: number, len: number): string { return this.dec.decode(this.u8.subarray(ptr >>> 0, (ptr >>> 0) + len)); }

  // ---- host functions ----
  // The host implements `name`. forced: it wins over every module's definition; otherwise it only fills imports no
  // module defines. Returns the host function id; its stub is at stubAddr(id).
  hostAdd(name: string, forced: boolean): number { return this.check(this.x.ld_host_add(...this.name(name), forced ? HOST_FORCE : HOST_HLE)); }
  stubAddr(id: number): number { return this.x.ld_stub_addr(id) >>> 0; }
  // The host function id of a guest address, or -1 when it is not a stub
  stubId(addr: number | bigint): number { return this.x.ld_stub_id(BigInt(addr)); }
  hostFind(name: string): number { return this.x.ld_host_find(...this.name(name)); }
  hostFunction(id: number): HostFunction {
    const x = this.x;
    return { id, name: this.str(x.ld_host_name_ptr(id), x.ld_host_name_len(id)), kind: x.ld_host_kind(id), stub: this.stubAddr(id),
      refs: x.ld_host_refs(id), firstModule: x.ld_host_first_module(id) };
  }
  // The whole table: host functions as added, then the stubs the loader made for unresolved imports
  hostFunctions(): HostFunction[] { return Array.from({ length: this.x.ld_host_count() }, (_, id) => this.hostFunction(id)); }
  checkForced(): number { return this.x.ld_check_forced(); }
  // true: every forced name no module refers to is a red line of its own; false (default): one summary line
  forceStrict(on: boolean): void { this.x.ld_force_strict(on ? 1 : 0); }

  // ---- modules ----
  // A module from file bytes in linear memory (they must stay there, unchanged, until the module is pinned).
  // Throws LoaderError when the file is refused.
  parse(f: FileInMemory, o: { verifyHash?: boolean } = {}): number {
    const h = this.check(this.x.ld_parse(f.ptr, f.len, o.verifyHash === false ? 0 : OPT_VERIFY_HASH));
    this.x.ld_set_name(h, ...this.name(f.name));
    if (this.state(h) === "Refused") throw new LoaderError(ERR_REFUSED, this.error());
    return h;
  }
  map(h: number, base: number): void { this.check(this.x.ld_map(h, base)); }
  relocate(h: number): void { this.check(this.x.ld_relocate(h)); }
  activate(h: number): void { this.check(this.x.ld_activate(h)); }
  pin(h: number): void { this.check(this.x.ld_pin(h)); }
  unload(h: number): void { this.check(this.x.ld_unload(h)); }
  state(h: number): State { return STATES[this.x.ld_state(h)]; }
  get(h: number, what: number): number { return this.x.ld_get(h, what) >>> 0; }

  info(h: number): ModuleInfo {
    const g = (w: number) => this.get(h, w), base = g(Info.Base), dv = this.dv;
    const list = (ptr: number, n: number) => Array.from({ length: n }, (_, i) => Number(dv.getBigUint64(ptr + 8 * i, true)));
    const seg = (o: number, s: number) => ({ addr: base + g(o), size: g(s) });
    return {
      handle: h, name: this.str(g(Info.NamePtr), g(Info.NameLen)), state: this.state(h), kind: g(Info.Kind), base, imageSize: g(Info.ImageSize), entry: g(Info.Entry),
      text: seg(Info.TextOff, Info.TextSize), ro: seg(Info.RoOff, Info.RoSize), data: seg(Info.DataOff, Info.DataSize), bssSize: g(Info.BssSize),
      buildId: this.u8.slice(g(Info.BuildIdPtr), g(Info.BuildIdPtr) + 32), init: g(Info.Init), fini: g(Info.Fini),
      initArray: list(g(Info.InitArray), g(Info.InitArrayCount)), finiArray: list(g(Info.FiniArray), g(Info.FiniArrayCount)), symbolCount: g(Info.SymbolCount),
      relocs: { relative: g(Info.RelRelative), relr: g(Info.RelRelr), abs64: g(Info.RelAbs64), globDat: g(Info.RelGlobDat), jumpSlot: g(Info.RelJumpSlot),
        unsupported: g(Info.RelUnsupported), weakZero: g(Info.RelWeakZero) },
      loads: g(Info.Loads), refuseReason: REFUSE_REASONS[g(Info.RefuseReason)] ?? "",
    };
  }

  // ---- symbols ----
  // Guest address of the first exported definition of `name` in the mapped modules, in load order
  lookup(name: string): number | undefined {
    const a = this.x.ld_lookup(...this.name(name));
    return this.x.ld_lookup_module() < 0 ? undefined : Number(a);
  }
  lookupIn(h: number, name: string): number | undefined {
    const a = this.x.ld_lookup_in(h, ...this.name(name));
    return this.x.ld_lookup_module() < 0 ? undefined : Number(a);
  }
  // The imports of a module that are bound to an unresolved stub right now
  unresolved(h: number): HostFunction[] {
    const cap = SCRATCH / 4;
    const n = this.check(this.x.ld_unresolved(h, this.scratch, cap));
    const ids = Array.from({ length: Math.min(n, cap) }, (_, i) => this.dv.getUint32(this.scratch + 4 * i, true));
    return ids.map(id => this.hostFunction(id));
  }

  // The function entries the loader knows of a relocated module (function symbols, init / fini functions, relative
  // relocations into the text), for the translator's addCode({ entries }). out/cap: free linear memory for the list.
  codeEntries(h: number, out: number, cap: number): Uint32Array {
    const n = this.check(this.x.ld_code_entries(h, out, cap));
    return new Uint32Array(this.x.memory.buffer, out, Math.min(n, cap)).slice();
  }

  // Load a set of modules as at process start: parse all, map all in the given order (the symbol lookup order; on the
  // Switch: rtld, main, subsdk*, sdk), then relocate all. place(imageSize, name) chooses each guest base.
  // Register the host functions before. A refused file throws; the modules are left Relocated: run initCalls, then activate().
  loadSet(files: FileInMemory[], place: (imageSize: number, name: string) => number, o: { verifyHash?: boolean } = {}): LoadedSet {
    const hs = files.map(f => this.parse(f, o));
    for (const h of hs) this.map(h, place(this.get(h, Info.ImageSize), this.info(h).name));
    for (const h of hs) this.relocate(h);
    const modules = hs.map(h => this.info(h));
    return {
      modules, entry: modules.length ? modules[0].entry : 0,
      initCalls: modules.filter(m => m.init).map(m => m.init),
      unresolved: modules.flatMap(m => this.unresolved(m.handle).map(u => ({ module: m.name, name: u.name, stub: u.stub }))),
      forcedUnused: this.checkForced(),
    };
  }
}
