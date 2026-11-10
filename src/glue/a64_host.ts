// nxweb glue for the ARM64 -> WebAssembly translator (src/a64).
// Owns the function table, the two-level pc map and the list of translated units; instantiates the
// translator, the helpers, the core module and the translation units, all on the one shared linear
// memory, and provides their imports. No translation logic lives here. No Node APIs.

export interface A64Imports {
  svc(n: number): void;
  unimpl(pc: bigint, insn: number): void;
  brk(pc: bigint, imm: number): void;
  cntpct(): bigint;
}

// Where the translator's data lives in the shared memory. translatorBase and helpersBase are baked
// into translator.wasm / helpers.wasm at build time (asc --memoryBase, root `a64:build` script).
export interface A64Layout {
  translatorBase: number; translatorEnd: number;   // translator static data + buffers
  helpersBase: number; helpersEnd: number;         // helpers static data
  entryBitsBase: number;                           // 1 bit per instruction of the code region
  codeRegionLo: number; codeRegionSize: number;    // the region the entry bitmap covers
  pcmapBase: number; pcmapEnd: number;             // first level (256 KB) + zero leaf (64 KB) + leaves on demand
}

export interface A64Options {
  memory: WebAssembly.Memory;   // the one linear memory (guest addresses are offsets)
  layout: A64Layout;
  imports: A64Imports;
  maxInsns?: number;            // function size cap (1 = single-instruction mode)
  maxFuncs?: number;            // functions per unit
  chunk?: number;               // region mode chunk in bytes (0 = one entry per unit)
  fma?: boolean;                // relaxed-simd fused multiply-add (default true)
  tailCalls?: boolean;          // wasm tail calls (default true)
  nanFix?: boolean;             // ARM NaN generation/propagation (default true)
  rmodeArith?: boolean;         // scalar FP arithmetic honours FPCR.RMode (default true)
  depthLimit?: number;          // nested guest calls before a call unwinds through run() (default 160, 0 = off)
  shared?: boolean;             // memory is shared: modules import it as shared, exclusives and LDAR/STLR are atomic
  cntYield?: boolean;           // `mrs cntpct_el0` is a yield point (see README)
  preciseFaults?: 0 | 1 | 2;    // 1: pc written before every memory instruction; 2: registers too (default 0: side table)
  guardBase?: number;           // guest data accesses below this address trap (default 0 = off): the embedder's host area
  // called by the index-0 trampoline when a pc has no translation yet; returns a table index.
  // Default: translate (or take from the cache) a unit for pc. Return A64Host.STOP to stop instead.
  onTranslate?: (pc: bigint) => number;
}

export interface CoreExports {
  run(): void;
  stop(): void;
  save_ctx(ptr: number): void;
  load_ctx(ptr: number): void;
  pc: WebAssembly.Global; sp: WebAssembly.Global; budget: WebAssembly.Global;
  excl_addr: WebAssembly.Global;
  [name: string]: unknown;
}

// one translated unit (= one wasm module)
export interface A64Unit {
  tableBase: number;        // function i is table[tableBase + i]
  pcs: Uint32Array;         // guest pc of each function (0xFFFFFFFF: a stub that was not translated)
  side: Uint32Array;        // (module byte offset, guest pc) per translated instruction, ascending offsets
  bytes: Uint8Array | null; // the module's bytes (kept when keepBytes is set, for the translation cache)
  insns: number;
  cached: boolean;          // came from the translation cache
}

export interface A64Fault { pc: number; unit: A64Unit; funcPc: number; offset: number }

const OPT = { pcmapBase: 0, entryBase: 1, regionLo: 2, maxInsns: 3, maxFuncs: 4, fma: 5, tail: 6, nan: 7, depth: 8, chunk: 9, rmArith: 10,
              regionSize: 11, shared: 12, cntYield: 13, precise: 14, guard: 15 };
const L1_BYTES = 0x40000, LEAF = 0x10000;
export const A64_CACHE_VERSION = 3;   // bump when the translator's output changes

export class A64Host {
  static readonly TRAMPOLINE = 0;
  static readonly STOP = 1;
  readonly table: WebAssembly.Table;
  readonly core: CoreExports;
  readonly memory: WebAssembly.Memory;
  readonly units: A64Unit[] = [];
  keepBytes = false;      // keep every unit's wasm bytes (needed by exportCache)
  translateNs = 0;        // time spent in translator + wasm compile + instantiate (ns)
  translatorNs = 0;       // time spent in the translator alone (ns)
  translatedFuncs = 0;
  translatedInsns = 0;    // guest instructions translated (not counting cache hits)
  moduleBytes = 0;
  modules = 0;
  maxModuleBytes = 0;
  cacheHits = 0;          // units instantiated from the translation cache
  private tr: any;
  private opts: A64Options;
  private lay: A64Layout;
  private unitImports: WebAssembly.Imports;
  private zeroLeaf: number;
  private leafNext: number;
  private leafFree: number[] = [];
  private ranges: { lo: number; hi: number }[] = [];
  private byFunc = new Map<number, A64Unit>();         // function pc -> unit (for fault lookup)
  private cache = new Map<number, CachedUnit>();        // function pc -> cached unit not yet instantiated

  constructor(translatorWasm: BufferSource | WebAssembly.Module, helpersWasm: BufferSource | WebAssembly.Module, opts: A64Options) {
    this.opts = opts;
    this.memory = opts.memory;
    const lay = this.lay = opts.layout;
    const env = { memory: this.memory, abort: () => { throw new Error("a64 translator abort"); } };
    const mod = translatorWasm instanceof WebAssembly.Module ? translatorWasm : new WebAssembly.Module(translatorWasm);
    const hmod = helpersWasm instanceof WebAssembly.Module ? helpersWasm : new WebAssembly.Module(helpersWasm);
    if (this.memory.buffer.byteLength < lay.pcmapEnd) throw new Error("a64: the memory does not reach the end of the a64 layout");
    const hlp = new WebAssembly.Instance(hmod, { env }).exports as any;
    this.tr = new WebAssembly.Instance(mod, { env }).exports;
    this.tr.init();
    if (this.tr.staticBase() !== lay.translatorBase || hlp.staticBase() !== lay.helpersBase)
      throw new Error(`a64: translator.wasm / helpers.wasm were built for memory bases 0x${this.tr.staticBase().toString(16)} / 0x${hlp.staticBase().toString(16)}, the layout says 0x${lay.translatorBase.toString(16)} / 0x${lay.helpersBase.toString(16)} (root a64:build script)`);
    if (this.tr.staticEnd() > lay.translatorEnd || hlp.staticEnd() > lay.helpersEnd)
      throw new Error(`a64: translator data ends at 0x${this.tr.staticEnd().toString(16)}, helpers at 0x${hlp.staticEnd().toString(16)}: beyond their ranges`);
    // pc map: first level, then the shared zero leaf, then leaves on demand
    this.zeroLeaf = lay.pcmapBase + L1_BYTES;
    this.leafNext = this.zeroLeaf + LEAF;
    new Uint32Array(this.memory.buffer, lay.pcmapBase, 65536).fill(this.zeroLeaf);
    this.setOptions(opts);
    this.tr.setOpt(OPT.pcmapBase, lay.pcmapBase);
    this.tr.setOpt(OPT.entryBase, lay.entryBitsBase);
    this.tr.setOpt(OPT.regionLo, lay.codeRegionLo);
    this.tr.setOpt(OPT.regionSize, lay.codeRegionSize);
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    const coreLen = this.tr.buildCore();
    const coreMod = new WebAssembly.Module(this.u8().slice(this.tr.outPtr(), this.tr.outPtr() + coreLen));
    const onTranslate = opts.onTranslate ?? ((pc: bigint) => this.translateUnit([pc])[0]);
    this.core = new WebAssembly.Instance(coreMod, {
      env: { memory: this.memory, table: this.table, translate: onTranslate },
    }).exports as unknown as CoreExports;
    const { staticBase: _b, staticEnd: _e, memory: _m, ...hfuncs } = hlp;
    this.unitImports = { cpu: this.core as any, hlp: hfuncs, env: { memory: this.memory, table: this.table, ...opts.imports } };
    (this.core.excl_addr as WebAssembly.Global).value = -1n;
  }

  private u8(): Uint8Array { return new Uint8Array(this.memory.buffer); }

  setOptions(o: Partial<A64Options>): void {
    const t = this.tr;
    if (o.maxInsns !== undefined) t.setOpt(OPT.maxInsns, o.maxInsns);
    if (o.maxFuncs !== undefined) t.setOpt(OPT.maxFuncs, o.maxFuncs);
    if (o.fma !== undefined) t.setOpt(OPT.fma, o.fma ? 1 : 0);
    if (o.tailCalls !== undefined) t.setOpt(OPT.tail, o.tailCalls ? 1 : 0);
    if (o.nanFix !== undefined) t.setOpt(OPT.nan, o.nanFix ? 1 : 0);
    if (o.depthLimit !== undefined) t.setOpt(OPT.depth, o.depthLimit);
    if (o.chunk !== undefined) t.setOpt(OPT.chunk, o.chunk);
    if (o.rmodeArith !== undefined) t.setOpt(OPT.rmArith, o.rmodeArith ? 1 : 0);
    if (o.shared !== undefined) t.setOpt(OPT.shared, o.shared ? 1 : 0);
    if (o.cntYield !== undefined) t.setOpt(OPT.cntYield, o.cntYield ? 1 : 0);
    if (o.preciseFaults !== undefined) t.setOpt(OPT.precise, o.preciseFaults);
    if (o.guardBase !== undefined) t.setOpt(OPT.guard, o.guardBase);
    Object.assign(this.opts, o);
  }

  // a string that changes whenever the generated code would: part of every translation-cache key
  optionsKey(): string {
    const o = this.opts, l = this.lay;
    return [A64_CACHE_VERSION, l.pcmapBase, o.maxInsns ?? "", o.maxFuncs ?? "", o.chunk ?? "", o.fma ?? "", o.tailCalls ?? "", o.nanFix ?? "",
            o.rmodeArith ?? "", o.depthLimit ?? "", o.shared ?? "", o.cntYield ?? "", o.preciseFaults ?? "", o.guardBase ?? ""].join(".");
  }

  // ---- pc map (two levels: 64 KB leaves, allocated on demand) ----
  getPcMap(pc: number): number {
    const dv = new DataView(this.memory.buffer);
    return dv.getUint32(dv.getUint32(this.lay.pcmapBase + ((pc >>> 16) << 2), true) + (pc & 0xFFFC), true);
  }
  private leafFor(pc: number, dv: DataView): number {
    const l1 = this.lay.pcmapBase + ((pc >>> 16) << 2);
    let leaf = dv.getUint32(l1, true);
    if (leaf === this.zeroLeaf) {
      if (this.leafFree.length) leaf = this.leafFree.pop()!;
      else {
        if (this.leafNext + LEAF > this.lay.pcmapEnd) throw new Error("a64: the pc map's leaf arena is full");
        leaf = this.leafNext; this.leafNext += LEAF;
      }
      dv.setUint32(l1, leaf, true);
    }
    return leaf;
  }
  setPcMap(pc: number, index: number): void {
    const dv = new DataView(this.memory.buffer);
    dv.setUint32(this.leafFor(pc, dv) + (pc & 0xFFFC), index, true);
  }
  // `count` consecutive instructions from pc get the same table index (host stub regions)
  fillPcMap(pc: number, count: number, index: number): void {
    const dv = new DataView(this.memory.buffer);
    for (let i = 0; i < count; i++, pc += 4) dv.setUint32(this.leafFor(pc, dv) + (pc & 0xFFFC), index, true);
  }
  // drop every entry of [lo, hi); whole leaves go back to the free list
  clearPcMap(lo: number, hi: number): void {
    const dv = new DataView(this.memory.buffer), u8 = this.u8();
    for (let page = lo >>> 16; page <= (hi - 1) >>> 16; page++) {
      const l1 = this.lay.pcmapBase + (page << 2), leaf = dv.getUint32(l1, true);
      if (leaf === this.zeroLeaf) continue;
      const a = Math.max(lo, page * LEAF) - page * LEAF, b = Math.min(hi, (page + 1) * LEAF) - page * LEAF;
      u8.fill(0, leaf + a, leaf + b);
      // a leaf with nothing left in it goes back to the free list
      if ((a === 0 && b === LEAF) || new Uint32Array(this.memory.buffer, leaf, LEAF >> 2).every(v => v === 0)) { dv.setUint32(l1, this.zeroLeaf, true); this.leafFree.push(leaf); }
    }
  }
  get pcMapBytes(): number { return this.leafNext - this.lay.pcmapBase - this.leafFree.length * LEAF; }

  // ---- code ranges ----
  // register guest code that is in memory at [lo, lo + size). text: the part that holds instructions (default: all).
  // entries: function entries the loader knows (symbols, relocation targets, init functions).
  addCode(lo: number, size: number, o: { text?: { lo: number; hi: number }; entries?: Iterable<number> } = {}): void {
    const hi = lo + (size & ~3);
    this.removeCode(lo, hi - lo);
    const t = o.text ?? { lo, hi };
    if (this.tr.addRange(BigInt(lo), BigInt(hi), BigInt(t.lo), BigInt(t.hi)) < 0) throw new Error("a64: too many code ranges");
    this.ranges.push({ lo, hi });
    if (o.entries) for (const e of o.entries) this.tr.setEntry(BigInt(e));
  }
  addEntries(entries: Iterable<number>): void { for (const e of entries) this.tr.setEntry(BigInt(e)); }
  // forget a range that is being unloaded: its pc-map entries, its units (table slots are cleared so the
  // engine can free the modules) and its pending cache entries
  removeCode(lo: number, size: number): void {
    const hi = lo + size;
    if (!this.ranges.some(r => r.lo < hi && lo < r.hi)) return;
    this.tr.removeRange(BigInt(lo), BigInt(hi));
    for (const r of this.ranges.filter(r => r.lo < hi && lo < r.hi)) this.dropTranslations(r.lo, r.hi);
    this.ranges = this.ranges.filter(r => !(r.lo < hi && lo < r.hi));
  }
  private dropTranslations(lo: number, hi: number): void {
    this.clearPcMap(lo, hi);
    for (let k = this.units.length - 1; k >= 0; k--) {
      const u = this.units[k];
      let inside = 0, n = 0;
      for (const pc of u.pcs) { if (pc === 0xFFFFFFFF) continue; n++; if (pc >= lo && pc < hi) inside++; }
      if (inside === 0) continue;
      for (let i = 0; i < u.pcs.length; i++) {
        const pc = u.pcs[i];
        if (pc !== 0xFFFFFFFF && pc >= lo && pc < hi) { this.table.set(u.tableBase + i, null); if (this.byFunc.get(pc) === u) this.byFunc.delete(pc); }
      }
      if (inside === n) this.units.splice(k, 1);
    }
    for (const pc of [...this.cache.keys()]) if (pc >= lo && pc < hi) this.cache.delete(pc);
  }
  codeRanges(): { lo: number; hi: number }[] { return this.ranges.map(r => ({ ...r })); }
  // compatibility with the one-window interface: the code is already in memory at `base`
  setCode(base: bigint, bytes: Uint8Array): void {
    for (const r of [...this.ranges]) this.removeCode(r.lo, r.hi - r.lo);
    const lo = Number(base);
    const u8 = this.u8();
    if (bytes.buffer !== u8.buffer || bytes.byteOffset !== lo) u8.set(bytes, lo);
    this.addCode(lo, bytes.length);
  }
  // forget every translation of every range (ranges and known entries stay)
  invalidate(): void { for (const r of this.ranges) this.dropTranslations(r.lo, r.hi); }

  // ---- translation ----
  // translate one unit (or take it from the cache); returns the table index of every requested entry
  translateUnit(entries: bigint[]): number[] {
    const first = Number(entries[0] & 0xFFFFFFFFn);
    const hit = entries.length === 1 && entries[0] <= 0xFFFFFFFFn ? this.cache.get(first) : undefined;
    if (hit) {
      const t0 = performance.now();
      const u = this.install(hit.bytes, hit.pcs, hit.side, hit.insns, true);
      for (const pc of hit.pcs) if (this.cache.get(pc) === hit) this.cache.delete(pc);
      this.cacheHits++;
      this.translateNs += (performance.now() - t0) * 1e6;
      return [u.tableBase + hit.pcs.indexOf(first)];
    }
    const t0 = performance.now();
    const tr = this.tr;
    new BigUint64Array(this.memory.buffer, tr.entryBuf(), entries.length).set(entries);
    const len = tr.translate(entries.length);
    this.translatorNs += (performance.now() - t0) * 1e6;
    if (len === 0) throw new Error("a64: translation failed");
    const meta = tr.metaBuf();
    const dv = new DataView(this.memory.buffer);
    const n = dv.getUint32(meta, true), insns = dv.getUint32(meta + 4, true), nSide = dv.getUint32(meta + 8, true), hlen = dv.getUint32(meta + 12, true);
    for (let i = 0; i < entries.length; i++) {
      if (dv.getUint8(meta + 16 + 4096 * 8 + i)) throw new Error("a64: no translatable code at pc 0x" + entries[i].toString(16));
    }
    const pcs = new Uint32Array(n);
    for (let i = 0; i < n; i++) pcs[i] = dv.getUint8(meta + 16 + 4096 * 8 + i) ? 0xFFFFFFFF : dv.getUint32(meta + 16 + i * 8, true);
    const side = new Uint32Array(this.memory.buffer, tr.sideBuf(), nSide * 2).slice();
    for (let i = 0; i < side.length; i += 2) side[i] += hlen;
    const out = tr.outPtr();
    // a shared memory's bytes cannot be compiled in place in every engine: copy when needed
    const bytes = this.keepBytes || this.opts.shared ? this.u8().slice(out, out + len) : new Uint8Array(this.memory.buffer, out, len);
    const u = this.install(bytes, pcs, side, insns, false);
    this.translatedFuncs += n;
    this.translatedInsns += insns;
    this.translateNs += (performance.now() - t0) * 1e6;
    return entries.map((_, i) => u.tableBase + i);
  }

  private install(bytes: Uint8Array, pcs: Uint32Array, side: Uint32Array, insns: number, cached: boolean): A64Unit {
    const base = this.table.length;
    this.table.grow(pcs.length);
    const mod = new WebAssembly.Module(bytes as unknown as BufferSource);
    new WebAssembly.Instance(mod, {
      ...this.unitImports,
      env: { ...(this.unitImports.env as object), table_base: new WebAssembly.Global({ value: "i32", mutable: false }, base) },
    });
    const u: A64Unit = { tableBase: base, pcs, side, bytes: this.keepBytes ? bytes : null, insns, cached };
    this.units.push(u);
    const dv = new DataView(this.memory.buffer);
    for (let i = 0; i < pcs.length; i++) {
      const pc = pcs[i];
      if (pc === 0xFFFFFFFF) continue;          // stub: stays on the trampoline path
      dv.setUint32(this.leafFor(pc, dv) + (pc & 0xFFFC), base + i, true);
      this.byFunc.set(pc, u);
    }
    this.moduleBytes += bytes.length;
    this.modules++;
    if (bytes.length > this.maxModuleBytes) this.maxModuleBytes = bytes.length;
    return u;
  }

  get translatorMemoryBytes(): number { return this.tr.staticEnd() - this.lay.translatorBase; }

  // ---- faults ----
  // The guest pc of a wasm trap raised in translated code, from the trap's stack: V8 prints the innermost
  // frame as `at f_<hex function pc> (wasm://wasm/<hash>:wasm-function[N]:0x<module offset>)`; the unit's
  // side table maps the offset to the instruction. undefined when the innermost wasm frame is not a unit's.
  faultFromError(e: unknown): A64Fault | undefined {
    const stack = (e as { stack?: string } | null)?.stack;
    if (typeof stack !== "string") return undefined;
    const line = stack.split("\n").find(l => l.includes("wasm-function["));   // innermost wasm frame
    const m = line ? /f_([0-9a-f]+)\b.*wasm-function\[\d+\]:0x([0-9a-f]+)/.exec(line) : null;
    if (!m) return undefined;
    const funcPc = parseInt(m[1], 16), offset = parseInt(m[2], 16);
    const unit = this.byFunc.get(funcPc);
    if (!unit) return undefined;
    const s = unit.side;
    let lo = 0, hi = (s.length >> 1) - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid * 2] <= offset) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0) return undefined;
    return { pc: s[at * 2 + 1], unit, funcPc, offset };
  }

  // ---- translation cache ----
  // every unit whose functions lie in [lo, lo + size), serialized (needs keepBytes = true before translating)
  exportCache(lo: number, size: number): Uint8Array {
    const hi = lo + size;
    const us = this.units.filter(u => u.bytes && u.pcs.some(pc => pc !== 0xFFFFFFFF) && u.pcs.every(pc => pc === 0xFFFFFFFF || (pc >= lo && pc < hi)));
    let total = 16;
    for (const u of us) total += 16 + u.pcs.byteLength + u.side.byteLength + ((u.bytes!.length + 3) & ~3);
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x43343641, true); dv.setUint32(4, A64_CACHE_VERSION, true); dv.setUint32(8, us.length, true); dv.setUint32(12, lo, true);
    let p = 16;
    for (const u of us) {
      dv.setUint32(p, u.pcs.length, true); dv.setUint32(p + 4, u.side.length, true); dv.setUint32(p + 8, u.bytes!.length, true); dv.setUint32(p + 12, u.insns, true);
      p += 16;
      out.set(new Uint8Array(u.pcs.buffer, u.pcs.byteOffset, u.pcs.byteLength), p); p += u.pcs.byteLength;
      out.set(new Uint8Array(u.side.buffer, u.side.byteOffset, u.side.byteLength), p); p += u.side.byteLength;
      out.set(u.bytes!, p); p += (u.bytes!.length + 3) & ~3;
    }
    return out;
  }
  // make cached units available: they are compiled and instantiated when one of their functions is first needed.
  // The caller's key must cover the code's identity (build id), its load address and optionsKey(). Returns the unit count.
  importCache(blob: Uint8Array): number {
    if (blob.length < 16) return 0;
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    if (dv.getUint32(0, true) !== 0x43343641 || dv.getUint32(4, true) !== A64_CACHE_VERSION) return 0;
    const n = dv.getUint32(8, true);
    let p = 16;
    for (let k = 0; k < n; k++) {
      const np = dv.getUint32(p, true), ns = dv.getUint32(p + 4, true), nb = dv.getUint32(p + 8, true), insns = dv.getUint32(p + 12, true);
      p += 16;
      const pcs = new Uint32Array(blob.slice(p, p + np * 4).buffer); p += np * 4;
      const side = new Uint32Array(blob.slice(p, p + ns * 4).buffer); p += ns * 4;
      const bytes = blob.slice(p, p + nb); p += (nb + 3) & ~3;
      const cu: CachedUnit = { pcs, side, bytes, insns };
      for (const pc of pcs) if (pc !== 0xFFFFFFFF && this.getPcMap(pc) === 0) this.cache.set(pc, cu);
    }
    return n;
  }
}

interface CachedUnit { pcs: Uint32Array; side: Uint32Array; bytes: Uint8Array; insns: number }

// storage for translation caches: Node tests use a directory (test/a64/cache_node.ts), browsers the Cache API
export interface A64CacheStore { get(key: string): Promise<Uint8Array | null>; put(key: string, bytes: Uint8Array): Promise<void> }

// Cache API store (window or worker, secure context)
export function webCacheStore(name = "nxweb-a64"): A64CacheStore {
  const url = (key: string) => "/a64-cache/" + encodeURIComponent(key);
  return {
    async get(key) {
      const c = await (globalThis as any).caches.open(name);
      const r = await c.match(url(key));
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async put(key, bytes) {
      const c = await (globalThis as any).caches.open(name);
      await c.put(url(key), new Response(bytes as unknown as BodyInit, { headers: { "Content-Type": "application/octet-stream" } }));
    },
  };
}
