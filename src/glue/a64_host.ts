// nxweb glue for the ARM64 -> WebAssembly translator (src/a64).
// Owns the function table, the two-level pc map and the list of translated units; instantiates the
// translator, the helpers, the core module and the translation units, all on the one shared linear
// memory, and provides their imports. No translation logic lives here. No Node APIs.
//
// Two modes, one per build of the translator. memory32 (the default): a 32-bit memory, guest addresses below 4 GB.
// memory64 (`mem64: true`, with translator64.wasm / helpers64.wasm and a memory made by makeMemory64): a 64-bit
// memory, guest addresses used whole. Addresses in this file's interface are JavaScript numbers in both modes
// (exact to 2^53; a 64-bit memory ends at 2^34 today): layout fields, addCode, the pc map, units' pcs, fault pcs,
// save_ctx / load_ctx of `core`. Guest register values are BigInt as they always were (the wasm globals are i64:
// `core.pc.value`, `core.x0.value`, the entries of translateUnit, onTranslate's pc, unimpl / brk's pc). Inside,
// a number becomes a BigInt exactly where it crosses into a wasm64 export's i64 parameter (setAddr, the code range
// calls, the core's context pointer) and a wasm64 export's usize result comes back through `num`; nothing else
// converts. No 32-bit operator (`>>>`, `&`, `|`) is applied to an address in the memory64 mode (memory32 keeps its
// one `pc >>> 0`, the wrap of the contract).

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
  // memory64 only: the guest addresses [0, pcmapSpan) the pc map's first level covers, a multiple of 64 KB (default
  // 16 GB, the engines' limit for a 64-bit memory: a first level of 2 MB, 8 bytes per 64 KB). A pc beyond it has no
  // translation. To extend: a larger span (128 MB of first level per TB).
  pcmapSpan?: number;
}

export interface A64Options {
  memory: WebAssembly.Memory;   // the one linear memory (guest addresses are offsets)
  mem64?: boolean;              // the memory is a 64-bit memory (makeMemory64) and the binaries are translator64 / helpers64
  memoryMaxPages?: number;      // mem64 and shared: the maximum the memory was made with (default 262144 = 16 GB); the modules must declare it
  layout: A64Layout;
  imports: A64Imports;
  // more pc map leaves once the layout's own arena is used up: the address of 64 KB of memory that stays the
  // translator's for the life of this host (it is zeroed here), or 0 when there is none
  leafAlloc?: () => number;
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
  save_ctx(ptr: number): void;   // (a number in both modes: A64Host converts for the wasm64 core)
  load_ctx(ptr: number): void;
  pc: WebAssembly.Global; sp: WebAssembly.Global; budget: WebAssembly.Global;
  excl_addr: WebAssembly.Global;
  [name: string]: unknown;
}

// one translated unit (= one wasm module)
export interface A64Unit {
  tableBase: number;        // function i is table[tableBase + i]
  pcs: Uint32Array | Float64Array;   // guest pc of each function (0xFFFFFFFF: a stub that was not translated); Float64Array with mem64
  side: Uint32Array;        // (module byte offset, guest pc) per translated instruction, ascending offsets; with mem64 the pc's low 32 bits (faultFromError restores the rest from the function's pc)
  bytes: Uint8Array | null; // the module's bytes (kept when keepBytes is set, for the translation cache)
  insns: number;
  cached: boolean;          // came from the translation cache
}

export interface A64Fault { pc: number; unit: A64Unit; funcPc: number; offset: number }

const OPT = { pcmapBase: 0, entryBase: 1, regionLo: 2, maxInsns: 3, maxFuncs: 4, fma: 5, tail: 6, nan: 7, depth: 8, chunk: 9, rmArith: 10,
              regionSize: 11, shared: 12, cntYield: 13, precise: 14, guard: 15, pcSpan: 16, maxPages: 17 };
const L1_BYTES = 0x40000, LEAF = 0x10000;
const GB4 = 0x1_0000_0000;
export const MEM64_MAX_PAGES = 262144;   // 16 GB: what V8 gives a 64-bit memory
const num = (v: number | bigint): number => typeof v === "bigint" ? Number(v) : v;   // a wasm64 export's usize result
export const A64_CACHE_VERSION = 4;   // bump when the translator's output changes

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
  readonly mem64: boolean;
  coreModule!: WebAssembly.Module;   // the core module, compiled: another thread on the same shared memory instantiates its own (its own CPU state)
  private tr: any;
  private l1Bytes = L1_BYTES;   // the pc map's first level
  private span = GB4;           // the guest addresses it covers
  private opts: A64Options;
  private lay: A64Layout;
  private unitImports: WebAssembly.Imports;
  private zeroLeaf: number;
  private leafNext: number;
  private leafFree: number[] = [];
  private leafExtra = 0;   // leaves from opts.leafAlloc
  private ranges: { lo: number; hi: number }[] = [];
  private byFunc = new Map<number, A64Unit>();         // function pc -> unit (for fault lookup)
  private cache = new Map<number, CachedUnit>();        // function pc -> cached unit not yet instantiated

  constructor(translatorWasm: BufferSource | WebAssembly.Module, helpersWasm: BufferSource | WebAssembly.Module, opts: A64Options) {
    this.opts = opts;
    this.memory = opts.memory;
    const m64 = this.mem64 = !!opts.mem64;
    const lay = this.lay = opts.layout;
    const env = { memory: this.memory, abort: () => { throw new Error("a64 translator abort"); } };
    const mod = translatorWasm instanceof WebAssembly.Module ? translatorWasm : new WebAssembly.Module(translatorWasm);
    const hmod = helpersWasm instanceof WebAssembly.Module ? helpersWasm : new WebAssembly.Module(helpersWasm);
    if (this.memory.buffer.byteLength < lay.pcmapEnd) throw new Error("a64: the memory does not reach the end of the a64 layout");
    const hlp = new WebAssembly.Instance(hmod, { env }).exports as any;
    this.tr = new WebAssembly.Instance(mod, { env }).exports;
    const bits = this.tr.addrBits?.() ?? 32;
    if (bits !== (m64 ? 64 : 32))
      throw new Error(`a64: the translator binary is the ${bits}-bit memory build, the host was asked for ${m64 ? "memory64 (translator64.wasm, helpers64.wasm)" : "memory32 (translator.wasm, helpers.wasm)"}`);
    this.tr.init();
    if (num(this.tr.staticBase()) !== lay.translatorBase || num(hlp.staticBase()) !== lay.helpersBase)
      throw new Error(`a64: translator.wasm / helpers.wasm were built for memory bases 0x${this.tr.staticBase().toString(16)} / 0x${hlp.staticBase().toString(16)}, the layout says 0x${lay.translatorBase.toString(16)} / 0x${lay.helpersBase.toString(16)} (root a64:build script)`);
    if (num(this.tr.staticEnd()) > lay.translatorEnd || num(hlp.staticEnd()) > lay.helpersEnd)
      throw new Error(`a64: translator data ends at 0x${this.tr.staticEnd().toString(16)}, helpers at 0x${hlp.staticEnd().toString(16)}: beyond their ranges`);
    // pc map: first level, then the shared zero leaf, then leaves on demand
    if (m64) {
      // one u64 leaf address per 64 KB of [0, span), and one more entry that stays the zero leaf: where a pc
      // beyond the span is looked up
      this.span = lay.pcmapSpan ?? MEM64_MAX_PAGES * LEAF;
      if (this.span % LEAF || this.span < LEAF) throw new Error("a64: pcmapSpan must be a multiple of 64 KB");
      this.l1Bytes = Math.ceil((this.span / LEAF + 1) * 8 / LEAF) * LEAF;
      if (lay.pcmapBase + this.l1Bytes + 2 * LEAF > lay.pcmapEnd) throw new Error(`a64: the pc map range is too small for a first level of ${this.l1Bytes >> 10} KB`);
    }
    this.zeroLeaf = lay.pcmapBase + this.l1Bytes;
    this.leafNext = this.zeroLeaf + LEAF;
    if (m64) new BigUint64Array(this.memory.buffer, lay.pcmapBase, this.span / LEAF + 1).fill(BigInt(this.zeroLeaf));
    else new Uint32Array(this.memory.buffer, lay.pcmapBase, 65536).fill(this.zeroLeaf);
    this.setOptions(opts);
    this.setAddr(OPT.pcmapBase, lay.pcmapBase);
    this.setAddr(OPT.entryBase, lay.entryBitsBase);
    this.setAddr(OPT.regionLo, lay.codeRegionLo);
    this.setAddr(OPT.regionSize, lay.codeRegionSize);
    if (m64) { this.setAddr(OPT.pcSpan, this.span); this.tr.setOpt(OPT.maxPages, opts.memoryMaxPages ?? MEM64_MAX_PAGES); }
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    const coreLen = this.tr.buildCore();
    const coreMod = new WebAssembly.Module(this.u8().slice(num(this.tr.outPtr()), num(this.tr.outPtr()) + coreLen));
    this.coreModule = coreMod;
    const onTranslate = opts.onTranslate ?? ((pc: bigint) => this.translateUnit([pc])[0]);
    const coreX = new WebAssembly.Instance(coreMod, {
      env: { memory: this.memory, table: this.table, translate: onTranslate },
    }).exports as unknown as CoreExports;
    // the wasm64 core takes the context pointer as an i64: `core` keeps taking a number
    this.core = !m64 ? coreX : { ...coreX, save_ctx: (p: number) => (coreX.save_ctx as any)(BigInt(p)), load_ctx: (p: number) => (coreX.load_ctx as any)(BigInt(p)) };
    const { staticBase: _b, staticEnd: _e, memory: _m, ...hfuncs } = hlp;
    this.unitImports = { cpu: coreX as any, hlp: hfuncs, env: { memory: this.memory, table: this.table, ...opts.imports } };
    (this.core.excl_addr as WebAssembly.Global).value = -1n;
  }

  private u8(): Uint8Array { return new Uint8Array(this.memory.buffer); }
  // an address-valued translator option: an i64 parameter of the wasm64 build
  private setAddr(id: number, v: number): void { if (this.mem64) this.tr.setOptAddr(id, BigInt(v)); else this.tr.setOpt(id, v); }
  // is this pc one of the embedder's special values (0xFFFF_FF00 .. 0xFFFF_FFFF: thread exit, yield)? In memory32
  // every pc from 0xFFFF_FF00 up is; with memory64 code may lie above them and it is exactly that window.
  isHostPc(pc: bigint): boolean { return pc >= 0xFFFFFF00n && (!this.mem64 || pc <= 0xFFFFFFFFn); }

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
    if (o.guardBase !== undefined) this.setAddr(OPT.guard, o.guardBase);
    Object.assign(this.opts, o);
  }

  // a string that changes whenever the generated code would: part of every translation-cache key
  optionsKey(): string {
    const o = this.opts, l = this.lay;
    return [A64_CACHE_VERSION, l.pcmapBase, o.maxInsns ?? "", o.maxFuncs ?? "", o.chunk ?? "", o.fma ?? "", o.tailCalls ?? "", o.nanFix ?? "",
            o.rmodeArith ?? "", o.depthLimit ?? "", o.shared ?? "", o.cntYield ?? "", o.preciseFaults ?? "", o.guardBase ?? "",
            this.mem64 ? `m64.${this.span / LEAF}.${o.shared ? o.memoryMaxPages ?? MEM64_MAX_PAGES : ""}` : "m32"].join(".");
  }

  // ---- pc map (two levels: 64 KB leaves, allocated on demand) ----
  // memory32: 65536 u32 leaf addresses, the pc taken modulo 4 GB. memory64: span / 64 KB u64 leaf addresses, the pc
  // whole; a pc at or beyond the span has no entry (reads 0, cannot be set).
  private l1At(dv: DataView, page: number): number { return this.mem64 ? Number(dv.getBigUint64(this.lay.pcmapBase + page * 8, true)) : dv.getUint32(this.lay.pcmapBase + page * 4, true); }
  private l1Set(dv: DataView, page: number, leaf: number): void { if (this.mem64) dv.setBigUint64(this.lay.pcmapBase + page * 8, BigInt(leaf), true); else dv.setUint32(this.lay.pcmapBase + page * 4, leaf, true); }
  private norm(pc: number): number { return this.mem64 ? pc : pc >>> 0; }
  getPcMap(pc: number): number {
    pc = this.norm(pc);
    if (pc >= this.span || pc < 0) return 0;
    const dv = this.dv(), page = Math.floor(pc / LEAF);
    return dv.getUint32(this.l1At(dv, page) + ((pc - page * LEAF) & 0xFFFC), true);
  }
  // a DataView of the memory as it is now (a leaf from leafAlloc may have grown it: views made before are detached)
  private dvc: DataView | null = null;
  private dv(): DataView { return this.dvc && this.dvc.buffer === this.memory.buffer ? this.dvc : (this.dvc = new DataView(this.memory.buffer)); }
  private leafFor(pc: number): number {
    if (pc >= this.span || pc < 0) throw new Error(`a64: pc 0x${pc.toString(16)} is beyond the pc map (it covers 0x${this.span.toString(16)} bytes: A64Layout.pcmapSpan)`);
    let dv = this.dv();
    const page = Math.floor(pc / LEAF);
    let leaf = this.l1At(dv, page);
    if (leaf === this.zeroLeaf) {
      if (this.leafFree.length) leaf = this.leafFree.pop()!;
      else {
        if (this.leafNext + LEAF <= this.lay.pcmapEnd) { leaf = this.leafNext; this.leafNext += LEAF; }
        else {
          leaf = this.opts.leafAlloc?.() ?? 0;
          if (!leaf || leaf % 4 || leaf + LEAF > this.memory.buffer.byteLength)
            throw new Error(`a64: no memory for the pc map of code at 0x${pc.toString(16)}: the pc map's leaf arena is full (${this.pcMapBytes >> 20} MB)` + (this.opts.leafAlloc ? " and there is no room left to extend it" : ""));
          dv = this.dv();   // the allocation may have grown the memory
          new Uint8Array(this.memory.buffer, leaf, LEAF).fill(0);
          this.leafExtra++;
        }
      }
      this.l1Set(dv, page, leaf);
    }
    return leaf;
  }
  private setLeaf(pc: number, index: number): void { pc = this.norm(pc); const leaf = this.leafFor(pc); this.dv().setUint32(leaf + ((pc - Math.floor(pc / LEAF) * LEAF) & 0xFFFC), index, true); }
  setPcMap(pc: number, index: number): void { this.setLeaf(pc, index); }
  // `count` consecutive instructions from pc get the same table index (host stub regions)
  fillPcMap(pc: number, count: number, index: number): void {
    for (let i = 0; i < count; i++, pc += 4) this.setLeaf(pc, index);
  }
  // drop every entry of [lo, hi); whole leaves go back to the free list
  clearPcMap(lo: number, hi: number): void {
    const dv = this.dv(), u8 = this.u8();
    hi = Math.min(hi, this.span);
    for (let page = Math.floor(lo / LEAF); page <= Math.floor((hi - 1) / LEAF); page++) {
      const leaf = this.l1At(dv, page);
      if (leaf === this.zeroLeaf) continue;
      const a = Math.max(lo, page * LEAF) - page * LEAF, b = Math.min(hi, (page + 1) * LEAF) - page * LEAF;
      u8.fill(0, leaf + a, leaf + b);
      // a leaf with nothing left in it goes back to the free list
      if ((a === 0 && b === LEAF) || new Uint32Array(this.memory.buffer, leaf, LEAF >> 2).every(v => v === 0)) { this.l1Set(dv, page, this.zeroLeaf); this.leafFree.push(leaf); }
    }
  }
  // the fixed part of the pc map in a layout: the first level and the zero leaf (memory32: 320 KB; memory64 with
  // the default 16 GB span: 2.2 MB). A layout's pc map range is this plus 64 KB per leaf.
  static pcMapFixedBytes(mem64 = false, span = MEM64_MAX_PAGES * LEAF): number { return (mem64 ? Math.ceil((span / LEAF + 1) * 8 / LEAF) * LEAF : L1_BYTES) + LEAF; }
  get pcMapBytes(): number { return this.leafNext - this.lay.pcmapBase + (this.leafExtra - this.leafFree.length) * LEAF; }

  // ---- code ranges ----
  // register guest code that is in memory at [lo, lo + size). text: the part that holds instructions (default: all).
  // entries: function entries the loader knows (symbols, relocation targets, init functions).
  addCode(lo: number, size: number, o: { text?: { lo: number; hi: number }; entries?: Iterable<number> } = {}): void {
    const hi = lo + size - size % 4;
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
  private freeSlots: { base: number; len: number }[] = [];   // table ranges of units that were dropped whole
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
      if (inside === n) {
        // the whole unit is gone: its table slots are free for the next unit (a module loaded and unloaded again
        // and again used to grow the table by its units every time)
        this.units.splice(k, 1);
        for (let i = 0; i < u.pcs.length; i++) this.table.set(u.tableBase + i, null);
        this.freeSlots.push({ base: u.tableBase, len: u.pcs.length });
      }
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
    const first = this.mem64 ? Number(entries[0]) : Number(entries[0] & 0xFFFFFFFFn);
    const hit = entries.length === 1 && (this.mem64 || entries[0] <= 0xFFFFFFFFn) ? this.cache.get(first) : undefined;
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
    new BigUint64Array(this.memory.buffer, num(tr.entryBuf()), entries.length).set(entries);
    const len = tr.translate(entries.length);
    this.translatorNs += (performance.now() - t0) * 1e6;
    if (len === 0) throw new Error("a64: translation failed");
    const meta = num(tr.metaBuf()), m64 = this.mem64;
    const dv = new DataView(this.memory.buffer);
    const n = dv.getUint32(meta, true), insns = dv.getUint32(meta + 4, true), nSide = dv.getUint32(meta + 8, true), hlen = dv.getUint32(meta + 12, true);
    for (let i = 0; i < entries.length; i++) {
      if (dv.getUint8(meta + 16 + 4096 * 8 + i)) throw new Error("a64: no translatable code at pc 0x" + entries[i].toString(16));
    }
    const pcs = m64 ? new Float64Array(n) : new Uint32Array(n);
    for (let i = 0; i < n; i++) pcs[i] = dv.getUint8(meta + 16 + 4096 * 8 + i) ? 0xFFFFFFFF : m64 ? Number(dv.getBigUint64(meta + 16 + i * 8, true)) : dv.getUint32(meta + 16 + i * 8, true);
    const side = new Uint32Array(this.memory.buffer, num(tr.sideBuf()), nSide * 2).slice();
    for (let i = 0; i < side.length; i += 2) side[i] += hlen;
    const out = num(tr.outPtr());
    // a shared memory's bytes cannot be compiled in place in every engine: copy when needed
    const bytes = this.keepBytes || this.opts.shared ? this.u8().slice(out, out + len) : new Uint8Array(this.memory.buffer, out, len);
    const u = this.install(bytes, pcs, side, insns, false);
    this.translatedFuncs += n;
    this.translatedInsns += insns;
    this.translateNs += (performance.now() - t0) * 1e6;
    return entries.map((_, i) => u.tableBase + i);
  }

  private install(bytes: Uint8Array, pcs: Uint32Array | Float64Array, side: Uint32Array, insns: number, cached: boolean): A64Unit {
    // a range of table slots a dropped unit left (a module that was unloaded), else new slots at the end
    let base = -1;
    for (let k = 0; k < this.freeSlots.length; k++) {
      const f = this.freeSlots[k];
      if (f.len < pcs.length) continue;
      base = f.base;
      if (f.len === pcs.length) this.freeSlots.splice(k, 1); else { f.base += pcs.length; f.len -= pcs.length; }
      break;
    }
    if (base < 0) { base = this.table.length; this.table.grow(pcs.length); }
    const mod = new WebAssembly.Module(bytes as unknown as BufferSource);
    new WebAssembly.Instance(mod, {
      ...this.unitImports,
      env: { ...(this.unitImports.env as object), table_base: new WebAssembly.Global({ value: "i32", mutable: false }, base) },
    });
    const u: A64Unit = { tableBase: base, pcs, side, bytes: this.keepBytes ? bytes : null, insns, cached };
    this.units.push(u);
    for (let i = 0; i < pcs.length; i++) {
      const pc = pcs[i];
      if (pc === 0xFFFFFFFF) continue;          // stub: stays on the trampoline path
      this.setLeaf(pc, base + i);
      this.byFunc.set(pc, u);
    }
    this.moduleBytes += bytes.length;
    this.modules++;
    if (bytes.length > this.maxModuleBytes) this.maxModuleBytes = bytes.length;
    return u;
  }

  get translatorMemoryBytes(): number { return num(this.tr.staticEnd()) - this.lay.translatorBase; }

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
    let pc = s[at * 2 + 1];
    if (this.mem64) {
      // the side table has the low 32 bits; an instruction is within 256 KB of its function's entry
      pc += Math.floor(funcPc / GB4) * GB4;
      if (pc - funcPc > GB4 / 2) pc -= GB4; else if (funcPc - pc > GB4 / 2) pc += GB4;
    }
    return { pc, unit, funcPc, offset };
  }

  // ---- translation cache ----
  // every unit whose functions lie in [lo, lo + size), serialized (needs keepBytes = true before translating)
  exportCache(lo: number, size: number): Uint8Array {
    const hi = lo + size;
    const us = this.units.filter(u => u.bytes && u.pcs.some(pc => pc !== 0xFFFFFFFF) && u.pcs.every(pc => pc === 0xFFFFFFFF || (pc >= lo && pc < hi)));
    let total = 16;
    for (const u of us) total += 16 + u.pcs.byteLength + u.side.byteLength + ((u.bytes!.length + 3) & ~3);
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    // memory64 blobs have their own magic (pcs are 8 bytes each) and carry the base in 64 KB units
    dv.setUint32(0, this.mem64 ? CACHE_MAGIC64 : CACHE_MAGIC, true); dv.setUint32(4, A64_CACHE_VERSION, true); dv.setUint32(8, us.length, true); dv.setUint32(12, this.mem64 ? Math.floor(lo / LEAF) : lo, true);
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
    if (dv.getUint32(0, true) !== (this.mem64 ? CACHE_MAGIC64 : CACHE_MAGIC) || dv.getUint32(4, true) !== A64_CACHE_VERSION) return 0;
    const n = dv.getUint32(8, true);
    let p = 16;
    for (let k = 0; k < n; k++) {
      const np = dv.getUint32(p, true), ns = dv.getUint32(p + 4, true), nb = dv.getUint32(p + 8, true), insns = dv.getUint32(p + 12, true);
      p += 16;
      const pb = this.mem64 ? 8 : 4;
      const pcs = this.mem64 ? new Float64Array(blob.slice(p, p + np * pb).buffer) : new Uint32Array(blob.slice(p, p + np * pb).buffer); p += np * pb;
      const side = new Uint32Array(blob.slice(p, p + ns * 4).buffer); p += ns * 4;
      const bytes = blob.slice(p, p + nb); p += (nb + 3) & ~3;
      const cu: CachedUnit = { pcs, side, bytes, insns };
      for (const pc of pcs) if (pc !== 0xFFFFFFFF && this.getPcMap(pc) === 0) this.cache.set(pc, cu);
    }
    return n;
  }
}

interface CachedUnit { pcs: Uint32Array | Float64Array; side: Uint32Array; bytes: Uint8Array; insns: number }
const CACHE_MAGIC = 0x43343641, CACHE_MAGIC64 = 0x44343641;

// ---- a 64-bit linear memory ----
// Made by instantiating a hand-assembled module that defines and exports the memory, which is the same in every
// engine that has memory64: Node 22's JavaScript API has no `address: "i64"` (the option is ignored and a 32-bit
// memory comes back), and where the API has it, `grow` and the descriptor want BigInt. `grow` and `pages` here are
// the module's own memory.grow / memory.size. `imports` is what a module built by tools/asc64 imports in place of
// those two instructions (env.memory_size, env.memory_grow: pages, i32).
export interface Memory64 {
  memory: WebAssembly.Memory;
  pages(): number;
  grow(pages: number): number;   // the size before in pages, or -1
  imports(): { memory_size: () => number; memory_grow: (pages: number) => number };
}
export function memory64Module(initialPages: number, maximumPages?: number, shared = false): Uint8Array {
  const leb = (v: number) => { const n: number[] = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; n.push(b); } while (v); return n; };
  const str = (t: string) => [t.length, ...Array.from(t, c => c.charCodeAt(0))];
  const sec = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
  if (shared && maximumPages === undefined) throw new Error("a64: a shared memory needs a maximum");
  const limits = [0x04 | (maximumPages !== undefined ? 1 : 0) | (shared ? 2 : 0), ...leb(initialPages), ...(maximumPages !== undefined ? leb(maximumPages) : [])];
  return new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0,
    ...sec(1, [2, 0x60, 1, 0x7E, 1, 0x7E, 0x60, 0, 1, 0x7E]),          // (i64) -> i64, () -> i64
    ...sec(3, [2, 0, 1]),
    ...sec(5, [1, ...limits]),
    ...sec(7, [3, ...str("memory"), 2, 0, ...str("grow"), 0, 0, ...str("size"), 0, 1]),
    ...sec(10, [2, 6, 0, 0x20, 0, 0x40, 0, 0x0B, 4, 0, 0x3F, 0, 0x0B])]);   // memory.grow, memory.size
}
// does this engine have 64-bit memories?
export function hasMemory64(): boolean {
  try { return WebAssembly.validate(memory64Module(1) as unknown as BufferSource); } catch { return false; }
}
export function makeMemory64(o: { initial: number; maximum?: number; shared?: boolean }): Memory64 {
  let x: any;
  try { x = new WebAssembly.Instance(new WebAssembly.Module(memory64Module(o.initial, o.maximum, !!o.shared) as unknown as BufferSource)).exports; }
  catch (e) { throw new Error(`a64: no 64-bit memory of ${o.initial} pages here (${(e as Error).message}); the engine needs memory64 (Node 22: on, or --experimental-wasm-memory64; Chromium 133 and later)`); }
  const m: Memory64 = {
    memory: x.memory,
    pages: () => Number(x.size()),
    grow: (pages: number) => Number(BigInt.asIntN(64, x.grow(BigInt(pages)))),
    imports: () => ({ memory_size: m.pages, memory_grow: m.grow }),
  };
  return m;
}

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
