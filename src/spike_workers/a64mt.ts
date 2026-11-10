// EXPERIMENTAL (spike, see SPIKE.md). The per-Worker side of the ARM64 translator when guest cores run on Workers.
// It replaces src/glue/a64_host.ts for the spike (no cache, no fault side tables, one code range).
//
// What is shared (one copy, in the shared memory):
//   - the pc map (guest pc -> function table index), written only under the translate lock
//   - the translator's whole state (it is an mtify'd module: src/spike_workers/mtify.mts)
//   - the control block: translate lock, next free table index, next free pc-map leaf, number of units published
// What every Worker has for itself:
//   - a core module instance (CPU state globals), a function table, an instance of every unit it has needed
//
// Table indices are GLOBAL: the pc map holds them, so unit U occupies [base, base + n) in every Worker's table. A
// Worker's table grows in steps, every new slot holding the core's trampoline. An index another Worker published
// therefore does one of two things here:
//   - inside this table: the trampoline calls translate(pc), which finds the pc map entry non-zero and installs the
//     unit in this Worker (instantiates the unit's module, see "transport");
//   - beyond this table's length: call_indirect traps. By the contract pc = the target and the registers are written
//     back before every indirect transfer, so the run loop catches the trap, grows the table (tableMiss) and enters
//     the guest again at pc. (Creating the table at its final size instead costs every instantiation in V8 12.4 /
//     Node 22: 23 ms per unit instance with 524288 slots, measured; see SPIKE.md.)
//
// A unit is translated ONCE, by the Worker that first missed, under the translate lock. How its compiled module
// reaches the other Workers (option `transport`):
//   "bytes"    the unit's wasm bytes are appended to a SharedArrayBuffer (the unit store) with a directory entry;
//              another Worker that needs the unit makes its own WebAssembly.Module from the same bytes,
//              synchronously, inside translate(). V8 keeps one compiled module per distinct wire bytes in the process
//              (its native module cache), so this does not compile again there: measured, see SPIKE.md.
//   "message"  the WebAssembly.Module object is posted to the other Workers (through the coordinator). A Worker
//              cannot receive a message synchronously in a browser: when it needs a unit whose message it has not
//              processed, translate() returns STOP, the translated code unwinds by the contract's pc check with
//              pc = the target, the run loop awaits the message and enters the guest again.

export interface A64Layout {
  translatorBase: number; translatorEnd: number; helpersBase: number; helpersEnd: number;
  entryBitsBase: number; codeRegionLo: number; codeRegionSize: number; pcmapBase: number; pcmapEnd: number;
}
export interface UnitMsg { base: number; n: number; module: WebAssembly.Module; from: number }
export interface A64Imports { svc(n: number): void; unimpl(pc: bigint, insn: number): void; brk(pc: bigint, imm: number): void; cntpct(): bigint }
interface Known { base: number; n: number; module?: WebAssembly.Module; off?: number; len?: number; here: boolean }

const OPT = { pcmapBase: 0, entryBase: 1, regionLo: 2, shared: 12 };
const L1_BYTES = 0x40000, LEAF = 0x10000;
// control block words (i32 index from cb >> 2)
const CB_LOCK = 0, CB_TABLE_NEXT = 1, CB_LEAF_NEXT = 2, CB_UNITS = 3, CB_STORE_USED = 4;
export const TABLE_CAP = 1 << 20;   // spike: the most function slots
const TABLE_STEP = Number((globalThis as any).process?.env?.SPIKE_TABLE_STEP ?? 1024);
// unit store: directory of 16-byte entries (base, n, offset, length) from 0, bytes from STORE_DATA
export const STORE_DIR_CAP = 8192, STORE_DATA = STORE_DIR_CAP * 16;

export class A64MT {
  static readonly STOP = 1;
  readonly table: WebAssembly.Table;
  readonly core: any;
  need = 0;                 // "message" transport: table index whose unit must arrive before the guest can go on (0 = none)
  error: unknown = null;
  stats = { translated: 0, installed: 0, translatorMs: 0, compileMs: 0, recompiled: 0, recompileMs: 0, instantiateMs: 0, coreMs: 0, tableMs: 0, tableGrows: 0, tableTraps: 0,
            lockWaits: 0, needs: 0, needMs: 0, insns: 0, bytes: 0 };
  readonly memory: WebAssembly.Memory;
  private tr: any;
  private known: Known[] = [];
  private seen = 0;         // "bytes" transport: directory entries read so far
  private unitImports: any;
  private zeroLeaf: number;
  private arrived: (() => void) | null = null;
  private lay: A64Layout; private cb: number; private worker: number;
  private publish: (u: UnitMsg) => void;
  private store: SharedArrayBuffer | undefined;

  constructor(o: { memory: WebAssembly.Memory; layout: A64Layout; cb: number; worker: number; primary: boolean; shared: boolean;
                   translator: WebAssembly.Module; helpers: WebAssembly.Module; helpersPrivate: boolean; imports: A64Imports;
                   store?: SharedArrayBuffer; noFence?: boolean; publish: (u: UnitMsg) => void }) {
    const { memory, layout: lay, cb, primary, shared, translator, helpers, helpersPrivate, imports } = o;
    this.memory = memory; this.lay = lay; this.cb = cb; this.worker = o.worker; this.publish = o.publish; this.store = o.store;
    const env = { memory, abort: () => { throw new Error("a64 translator abort"); } };
    // helpers: pure functions with static scratch memory. Private = an instance with its own small memory per Worker.
    const hlp: any = new WebAssembly.Instance(helpers, helpersPrivate ? { env: { abort: env.abort } } : { env }).exports;
    this.tr = new WebAssembly.Instance(translator, { env }).exports;
    this.zeroLeaf = lay.pcmapBase + L1_BYTES;
    const i32 = this.i32();
    if (primary) {
      this.tr.init();
      if (shared && this.tr.staticEnd() > lay.translatorEnd - 4096) throw new Error("a64mt: translator data reaches the globals page");
      new Uint32Array(memory.buffer, lay.pcmapBase, 65536).fill(this.zeroLeaf);
      this.tr.setOpt(OPT.pcmapBase, lay.pcmapBase); this.tr.setOpt(OPT.entryBase, lay.entryBitsBase);
      this.tr.setOpt(OPT.regionLo, lay.codeRegionLo); this.tr.setOpt(11, lay.codeRegionSize);
      this.tr.setOpt(OPT.shared, shared ? 1 : 0);
      if (o.noFence) this.tr.setOpt(16, 0);
      i32[(cb >> 2) + CB_TABLE_NEXT] = 2; i32[(cb >> 2) + CB_LEAF_NEXT] = this.zeroLeaf + LEAF; i32[(cb >> 2) + CB_UNITS] = 0; i32[(cb >> 2) + CB_STORE_USED] = STORE_DATA;
    }
    const t0 = performance.now();
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    this.lock();
    let coreMod: WebAssembly.Module;
    try {
      const len = this.tr.buildCore();
      coreMod = new WebAssembly.Module(new Uint8Array(memory.buffer).slice(this.tr.outPtr(), this.tr.outPtr() + len));
    } finally { this.unlock(); }
    this.core = new WebAssembly.Instance(coreMod, { env: { memory, table: this.table, translate: (pc: bigint) => this.miss(pc) } }).exports;
    this.stats.coreMs = performance.now() - t0;
    const { staticBase: _b, staticEnd: _e, memory: _m, ...hfuncs } = hlp;
    this.unitImports = { cpu: this.core, hlp: hfuncs, env: { memory, table: this.table, ...imports } };
    this.core.excl_addr.value = -1n;
  }
  private i32(): Int32Array { return new Int32Array(this.memory.buffer); }

  // ---- the translate lock: 0 free, 1 held, 2 held with waiters ----
  private lock(): void {
    const a = this.i32(), i = (this.cb >> 2) + CB_LOCK;
    if (Atomics.compareExchange(a, i, 0, 1) === 0) return;
    this.stats.lockWaits++;
    while (Atomics.exchange(a, i, 2) !== 0) { if (a.buffer instanceof ArrayBuffer) throw new Error("a64mt: translate lock re-entered"); Atomics.wait(a, i, 2); }
  }
  private unlock(): void {
    const a = this.i32(), i = (this.cb >> 2) + CB_LOCK;
    if (Atomics.exchange(a, i, 0) === 2) Atomics.notify(a, i, 1);
  }

  // ---- the function table ----
  private ensureTable(end: number): void {
    const len = this.table.length;
    if (end <= len) return;
    const t0 = performance.now();
    this.table.grow(Math.ceil((end - len) / TABLE_STEP) * TABLE_STEP, this.core.trampoline);
    this.stats.tableMs += performance.now() - t0; this.stats.tableGrows++;
  }
  // after a trap in translated code: was it an indirect transfer to a function index beyond this Worker's table?
  // Then the table has grown and the guest can be entered again at pc.
  tableMiss(pc: number): boolean {
    if (pc >= 0xFFFFFF00) return false;
    const idx = this.getPcMap(pc);
    if (idx < this.table.length) return false;
    this.ensureTable(idx + 1); this.stats.tableTraps++;
    return true;
  }

  // ---- pc map ----
  getPcMap(pc: number): number {
    const dv = new DataView(this.memory.buffer);
    return dv.getUint32(dv.getUint32(this.lay.pcmapBase + ((pc >>> 16) << 2), true) + (pc & 0xFFFC), true);
  }
  private setPcMap(pc: number, index: number, dv: DataView, i32: Int32Array): void {   // under the translate lock
    const l1 = this.lay.pcmapBase + ((pc >>> 16) << 2);
    let leaf = dv.getUint32(l1, true);
    if (leaf === this.zeroLeaf) {
      leaf = i32[(this.cb >> 2) + CB_LEAF_NEXT];
      if (leaf + LEAF > this.lay.pcmapEnd) throw new Error("a64mt: the pc map's leaf arena is full");
      i32[(this.cb >> 2) + CB_LEAF_NEXT] = leaf + LEAF;
      Atomics.store(i32, l1 >> 2, leaf);
    }
    Atomics.store(i32, (leaf + (pc & 0xFFFC)) >> 2, index);
  }
  addCode(lo: number, size: number): void {   // primary only, before any Worker runs
    const hi = lo + (size & ~3);
    if (this.tr.addRange(BigInt(lo), BigInt(hi), BigInt(lo), BigInt(hi)) < 0) throw new Error("a64mt: too many code ranges");
  }

  // ---- a pc without a function in this Worker's table (the core's trampoline calls this) ----
  private miss(pc: bigint): number {
    try {
      const p = Number(pc & 0xFFFFFFFFn);
      let idx = this.getPcMap(p);
      if (idx === 0) {
        this.lock();
        try { idx = this.getPcMap(p); if (idx === 0) return this.translate(pc); }
        finally { this.unlock(); }
      }
      // another Worker translated it: install its unit here
      if (this.store) this.readDirectory();
      const u = this.known.find(k => idx >= k.base && idx < k.base + k.n);
      if (u) { if (!u.here) this.install(u); return idx; }
      if (this.store) throw new Error(`a64mt: table index ${idx} is in the pc map but in no published unit`);
      this.need = idx; this.stats.needs++;   // "message" transport: its message has not been processed here yet
      return A64MT.STOP;
    } catch (e) { this.error = e; return A64MT.STOP; }
  }

  private translate(pc: bigint): number {   // under the translate lock
    const tr = this.tr;
    let t0 = performance.now();
    new BigUint64Array(this.memory.buffer, tr.entryBuf(), 1)[0] = pc;
    const len = tr.translate(1);
    this.stats.translatorMs += performance.now() - t0;
    if (len === 0) throw new Error("a64: translation failed");
    const meta = tr.metaBuf(), dv = new DataView(this.memory.buffer), i32 = this.i32();
    const n = dv.getUint32(meta, true), insns = dv.getUint32(meta + 4, true);
    if (dv.getUint8(meta + 16 + 4096 * 8)) throw new Error("a64: no translatable code at pc 0x" + pc.toString(16));
    const out = tr.outPtr();
    const bytes = new Uint8Array(this.memory.buffer).slice(out, out + len);
    t0 = performance.now();
    const module = new WebAssembly.Module(bytes);
    this.stats.compileMs += performance.now() - t0;
    const base = i32[(this.cb >> 2) + CB_TABLE_NEXT];
    if (base + n > TABLE_CAP) throw new Error("a64mt: function table full");
    i32[(this.cb >> 2) + CB_TABLE_NEXT] = base + n;
    const u: Known = { base, n, module, here: false };
    // publish before the pc map names it
    if (this.store) {
      const s32 = new Int32Array(this.store), k = i32[(this.cb >> 2) + CB_UNITS], off = i32[(this.cb >> 2) + CB_STORE_USED];
      if (k >= STORE_DIR_CAP || off + len > this.store.byteLength) throw new Error("a64mt: the unit store is full");
      new Uint8Array(this.store).set(bytes, off);
      s32[k * 4] = base; s32[k * 4 + 1] = n; s32[k * 4 + 2] = off; s32[k * 4 + 3] = len;
      i32[(this.cb >> 2) + CB_STORE_USED] = (off + len + 3) & ~3;
      // this Worker's own unit stays in `known` with its module; the directory reader skips entries it already has
    } else this.publish({ base, n, module, from: this.worker });
    this.known.push(u);
    this.install(u);
    Atomics.add(i32, (this.cb >> 2) + CB_UNITS, 1);
    for (let i = 0; i < n; i++) {
      if (dv.getUint8(meta + 16 + 4096 * 8 + i)) continue;   // a stub that was not translated stays on the trampoline
      this.setPcMap(dv.getUint32(meta + 16 + i * 8, true), base + i, dv, i32);
    }
    this.stats.translated++; this.stats.insns += insns; this.stats.bytes += len;
    return base;
  }
  // "bytes" transport: take note of the units published since the last look
  private readDirectory(): void {
    const count = Atomics.load(this.i32(), (this.cb >> 2) + CB_UNITS), s32 = new Int32Array(this.store!);
    for (; this.seen < count; this.seen++) {
      const k = this.seen, base = s32[k * 4];
      if (!this.known.some(u => u.base === base)) this.known.push({ base, n: s32[k * 4 + 1], off: s32[k * 4 + 2], len: s32[k * 4 + 3], here: false });
    }
  }
  private install(u: Known): void {
    this.ensureTable(u.base + u.n);
    if (!u.module) {
      // the same bytes another Worker compiled: V8 finds the compiled module in its process-wide cache
      const t0 = performance.now();
      u.module = new WebAssembly.Module(new Uint8Array(this.store!).slice(u.off!, u.off! + u.len!));
      this.stats.recompileMs += performance.now() - t0; this.stats.recompiled++;
    }
    const t0 = performance.now();
    new WebAssembly.Instance(u.module, {
      ...this.unitImports,
      env: { ...this.unitImports.env, table_base: new WebAssembly.Global({ value: "i32", mutable: false }, u.base) },
    });
    u.here = true;
    this.stats.installed++;
    this.stats.instantiateMs += performance.now() - t0;
  }
  // "message" transport: a unit another Worker compiled (message handler). Instantiated only when this Worker needs it.
  receive(u: UnitMsg): void {
    this.known.push({ base: u.base, n: u.n, module: u.module, here: false });
    if (this.arrived) { const f = this.arrived; this.arrived = null; f(); }
  }
  // resolves when the unit of `need` is known here (then it is installed and need is cleared)
  async waitNeed(): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      const idx = this.need;
      const u = this.known.find(k => idx >= k.base && idx < k.base + k.n);
      if (u) { if (!u.here) this.install(u); this.need = 0; this.stats.needMs += performance.now() - t0; return; }
      await new Promise<void>(r => { this.arrived = r; });
    }
  }
}
