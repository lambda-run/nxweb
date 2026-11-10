// nxweb glue for the ARM64 -> WebAssembly translator (src/a64).
// Owns the function table and the pc map, instantiates the core module and translation units,
// and provides their imports. No translation logic lives here.

export interface A64Imports {
  svc(n: number): void;
  unimpl(pc: bigint, insn: number): void;
  brk(pc: bigint, imm: number): void;
  cntpct(): bigint;
}

export interface A64Options {
  memory: WebAssembly.Memory;   // guest linear memory (shared with everything else)
  pcmapBase: number;            // address in `memory` of the pc map (u32 per guest instruction)
  codeLo: number;               // first guest address covered by the pc map
  mapSize: number;              // bytes of guest code covered (the pc map is this many bytes too)
  imports: A64Imports;
  maxInsns?: number;            // function size cap (1 = single-instruction mode)
  maxFuncs?: number;            // functions per unit (entries + auto-discovered BL targets)
  fma?: boolean;                // relaxed-simd fused multiply-add (default true)
  tailCalls?: boolean;          // wasm tail calls (default true)
  nanFix?: boolean;             // ARM NaN generation/propagation on FP arithmetic (default true)
  depthLimit?: number;          // nested guest calls before a call unwinds through run() (default 160, 0 = off)
  // called by the index-0 trampoline when a pc has no translation yet; returns a table index.
  // Default: translate a unit starting at pc. Return A64Host.STOP to stop execution instead.
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

const OPT = { pcmapBase: 0, codeLo: 1, mapSize: 2, maxInsns: 3, maxFuncs: 4, fma: 5, tail: 6, nan: 7, depth: 8 };

export class A64Host {
  static readonly TRAMPOLINE = 0;
  static readonly STOP = 1;
  readonly table: WebAssembly.Table;
  readonly core: CoreExports;
  readonly memory: WebAssembly.Memory;
  translateNs = 0;        // time spent in translator + wasm compile (ns)
  translatorNs = 0;       // time spent in the translator alone (ns)
  translatedFuncs = 0;
  translatedInsns = 0;    // guest instructions translated
  moduleBytes = 0;
  private tr: any;
  private opts: A64Options;
  private unitImports: WebAssembly.Imports;

  constructor(translatorWasm: BufferSource | WebAssembly.Module, helpersWasm: BufferSource | WebAssembly.Module, opts: A64Options) {
    this.opts = opts;
    this.memory = opts.memory;
    const mod = translatorWasm instanceof WebAssembly.Module ? translatorWasm : new WebAssembly.Module(translatorWasm);
    const hmod = helpersWasm instanceof WebAssembly.Module ? helpersWasm : new WebAssembly.Module(helpersWasm);
    const hlp = new WebAssembly.Instance(hmod, { env: { abort: () => { throw new Error("a64 helpers abort"); } } }).exports;
    this.tr = new WebAssembly.Instance(mod, { env: { abort: () => { throw new Error("a64 translator abort"); } } }).exports;
    this.tr.init();
    this.setOptions(opts);
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    const coreLen = this.tr.buildCore();
    const coreBytes = new Uint8Array(this.tr.memory.buffer, this.tr.outPtr(), coreLen).slice();
    const coreMod = new WebAssembly.Module(coreBytes);
    const onTranslate = opts.onTranslate ?? ((pc: bigint) => this.translateUnit([pc])[0]);
    this.core = new WebAssembly.Instance(coreMod, {
      env: { memory: this.memory, table: this.table, translate: onTranslate },
    }).exports as unknown as CoreExports;
    this.unitImports = { cpu: this.core as any, hlp: hlp as any, env: { memory: this.memory, table: this.table, ...opts.imports } };
    (this.core.excl_addr as WebAssembly.Global).value = -1n;
  }

  setOptions(o: Partial<A64Options>): void {
    const t = this.tr;
    if (o.pcmapBase !== undefined) t.setOpt(OPT.pcmapBase, o.pcmapBase);
    if (o.codeLo !== undefined) t.setOpt(OPT.codeLo, o.codeLo);
    if (o.mapSize !== undefined) t.setOpt(OPT.mapSize, o.mapSize);
    if (o.maxInsns !== undefined) t.setOpt(OPT.maxInsns, o.maxInsns);
    if (o.maxFuncs !== undefined) t.setOpt(OPT.maxFuncs, o.maxFuncs);
    if (o.fma !== undefined) t.setOpt(OPT.fma, o.fma ? 1 : 0);
    if (o.tailCalls !== undefined) t.setOpt(OPT.tail, o.tailCalls ? 1 : 0);
    if (o.nanFix !== undefined) t.setOpt(OPT.nan, o.nanFix ? 1 : 0);
    if (o.depthLimit !== undefined) t.setOpt(OPT.depth, o.depthLimit);
  }

  // give the translator the guest code bytes for [base, base + bytes.length)
  setCode(base: bigint, bytes: Uint8Array): void {
    const p = this.tr.codeBuf(bytes.length);
    new Uint8Array(this.tr.memory.buffer, p, bytes.length).set(bytes);
    this.tr.setCode(base, bytes.length);
  }

  // translate one unit; returns the table index of every requested entry
  translateUnit(entries: bigint[]): number[] {
    const t0 = performance.now();
    const tr = this.tr;
    new BigUint64Array(tr.memory.buffer, tr.entryBuf(), entries.length).set(entries);
    const len = tr.translate(entries.length);
    this.translatorNs += (performance.now() - t0) * 1e6;
    if (len === 0) throw new Error("a64: translation failed");
    const bytes = new Uint8Array(tr.memory.buffer, tr.outPtr(), len);
    const meta = tr.metaBuf();
    const dv = new DataView(tr.memory.buffer);
    const n = dv.getUint32(meta, true);
    for (let i = 0; i < entries.length; i++) {
      if (dv.getUint8(meta + 8 + 4096 * 8 + i)) throw new Error("a64: no translatable code at pc 0x" + entries[i].toString(16));
    }
    const base = this.table.length;
    this.table.grow(n);
    const mod = new WebAssembly.Module(bytes);
    new WebAssembly.Instance(mod, {
      ...this.unitImports,
      env: { ...(this.unitImports.env as object), table_base: new WebAssembly.Global({ value: "i32", mutable: false }, base) },
    });
    const map = new DataView(this.memory.buffer);
    const { codeLo, mapSize, pcmapBase } = this.opts;
    for (let i = 0; i < n; i++) {
      if (dv.getUint8(meta + 8 + 4096 * 8 + i)) continue;   // stub: stays on the trampoline path
      const pc = Number(dv.getBigUint64(meta + 8 + i * 8, true) & 0xFFFFFFFFn);
      const off = pc - codeLo;
      if (off >= 0 && off < mapSize) map.setUint32(pcmapBase + off, base + i, true);
    }
    this.translatedFuncs += n;
    this.translatedInsns += dv.getUint32(meta + 4, true);
    this.moduleBytes += len;
    this.translateNs += (performance.now() - t0) * 1e6;
    return entries.map((_, i) => base + i);
  }

  // forget every translation (the table slots are simply abandoned)
  invalidate(): void {
    const { mapSize, pcmapBase } = this.opts;
    new Uint8Array(this.memory.buffer, pcmapBase, mapSize).fill(0);
  }
}
