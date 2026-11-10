// The prepare module (build/prepare/prepare.wasm) behind a TypeScript face: bytes in, results out. No Node or
// browser API here.
export const STATES = ["Idle", "Detect", "Index", "Profile", "Code", "Shaders", "Ready", "Failed", "Cancelled"] as const;
export type PrepState = typeof STATES[number];
export const REASONS = ["", "layout", "npdm", "arch", "version", "dlc", "module", "romfs", "profile", "cut", "read", "storage", "internal"] as const;
export type FailReason = Exclude<typeof REASONS[number], "">;
export const COUNT = { done: 0, total: 1, bytesDone: 2, bytesTotal: 3, files: 4, modules: 5, cuts: 6, romFiles: 7, romDirs: 8, aoc: 9, skipped: 10, ran: 11 } as const;
export type Counts = { -readonly [k in keyof typeof COUNT]: number };

interface X {
  memory: WebAssembly.Memory;
  prep_reset(): void; prep_state(): number; prep_reason(): number; prep_start(): number; prep_stage_end(skipped: number): number;
  prep_fail(reason: number): number; prep_cancel(): number; prep_count(i: number): number; prep_count_set(i: number, v: number): void; prep_count_add(i: number, v: number): void;
  prep_alloc(len: number): number; prep_arena_reset(): void; prep_arena_used(): number; prep_error_ptr(): number; prep_error_len(): number; prep_error_clear(): void;
  prep_sha256(ptr: number, len: number, out: number): void;
  npdm_parse(ptr: number, len: number): number; npdm_program_id(): bigint; npdm_sys_resource(): number; npdm_flags(): number; npdm_stack_size(): number;
  npdm_version(): number; npdm_main_thread(): number; npdm_name_ptr(): number;
  nso_peek(ptr: number, len: number): number; nso_check(ptr: number, len: number): number; nso_parse(ptr: number, len: number): number; nso_build_id_ptr(): number;
  nso_image_size(): number; nso_text_size(): number; nso_bss(): number; nso_flags(): number;
  cut_apply(file: number, len: number, list: number, listLen: number): number; cut_out_ptr(): number; cut_out_len(): number; cut_failed_index(): number; cut_applied(): number;
  rom_build(list: number, listLen: number): number; rom_tables_ptr(): number; rom_tables_len(): number; rom_offsets_ptr(): number; rom_dirs(): number; rom_files(): number;
  rom_data_offset(): number; rom_data_size(): number;
  bnsh_scan(ptr: number, len: number, max: number): number; bnsh_rec_ptr(): number; bnsh_containers(): number; bnsh_dropped(): number;
  kit_refused_total(): number;
}
export interface Cut { off: number; orig: string; new: string; why?: string }
export interface NpdmInfo { programId: bigint; titleId: string; sysResource: number; is64: boolean; stackSize: number; version: number; name: string }
export interface NsoInfo { buildId: string; imageSize: number; textSize: number; bss: number; flags: number }
export interface RomEntry { path: string; size: number; dir?: boolean }
export interface RomTables { tables: Uint8Array; starts: Float64Array; dirs: number; files: number; dataOffset: number; dataSize: number; size: number }
export interface BnshStage { container: number; variation: number; stage: "vs" | "hs" | "ds" | "gs" | "ps" | "cs"; status: string; control: [number, number]; code: [number, number]; key: string }
export const BNSH_STATUS = ["ok", "no grsc block", "a pointer leads outside the file", "bad control section", "code area header magic does not match the stage",
  "control +0x704 does not match the code area length", "NVN2 control section (not read)"] as const;
const hex = (b: Uint8Array) => { let s = ""; for (const v of b) s += (v < 16 ? "0" : "") + v.toString(16); return s; };
export const hexBytes = (s: string) => { const b = new Uint8Array(s.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(2 * i, 2), 16); return b; };

export class PrepWasm {
  readonly x: X;
  readonly lines: string[] = [];
  log: (line: string) => void;
  constructor(module: WebAssembly.Module, log: (line: string) => void = () => {}) {
    this.log = log;
    const dec = new TextDecoder();
    const inst = new WebAssembly.Instance(module, { env: {
      log: (p: number, n: number) => { const l = dec.decode(new Uint8Array(this.x.memory.buffer, p >>> 0, n).slice()); this.lines.push(l); if (this.lines.length > 400) this.lines.shift(); this.log(l); },
      abort: () => { throw new Error("prepare: abort"); },
    } });
    this.x = inst.exports as unknown as X;
    this.x.prep_reset();
  }
  // ---- machine ----
  get state(): PrepState { return STATES[this.x.prep_state()]; }
  get reason(): FailReason | "" { return REASONS[this.x.prep_reason()] ?? ""; }
  start(): boolean { return !!this.x.prep_start(); }
  stageEnd(skipped: boolean): boolean { return !!this.x.prep_stage_end(skipped ? 1 : 0); }
  fail(reason: FailReason): boolean { return !!this.x.prep_fail(REASONS.indexOf(reason)); }
  cancel(): boolean { return !!this.x.prep_cancel(); }
  count(k: keyof typeof COUNT): number { return this.x.prep_count(COUNT[k]); }
  setCount(k: keyof typeof COUNT, v: number): void { this.x.prep_count_set(COUNT[k], v); }
  addCount(k: keyof typeof COUNT, v: number): void { this.x.prep_count_add(COUNT[k], v); }
  counts(): Counts { const o = {} as Counts; for (const k of Object.keys(COUNT) as (keyof typeof COUNT)[]) o[k] = this.count(k); return o; }
  lastError(): string { return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.prep_error_ptr(), this.x.prep_error_len()).slice()); }

  // ---- bytes ----
  private u8(ptr: number, len: number): Uint8Array { return new Uint8Array(this.x.memory.buffer, ptr >>> 0, len); }
  private put(b: Uint8Array): number {
    const p = this.x.prep_alloc(b.length || 1) >>> 0;
    if (!p) throw new Error(`prepare: no memory for ${b.length} bytes`);
    this.u8(p, b.length).set(b);
    return p;
  }
  private done(): void { this.x.prep_arena_reset(); }
  sha256(b: Uint8Array): string {
    try { const p = this.put(b), o = this.x.prep_alloc(32) >>> 0; this.x.prep_sha256(p, b.length, o); return hex(this.u8(o, 32)); }
    finally { this.done(); }
  }
  sha256Text(s: string): string { return this.sha256(new TextEncoder().encode(s)); }
  // main.npdm: the program's identity, or the red line that says why not
  npdm(b: Uint8Array): NpdmInfo | { error: string; code: number } {
    try {
      this.x.prep_error_clear();
      const r = this.x.npdm_parse(this.put(b), b.length);
      if (r) return { error: this.lastError(), code: r };
      const id = BigInt.asUintN(64, this.x.npdm_program_id()), fl = this.x.npdm_flags();
      const nm = this.u8(this.x.npdm_name_ptr(), 16); let n = 0; while (n < 16 && nm[n]) n++;
      return { programId: id, titleId: id.toString(16).toUpperCase().padStart(16, "0"), sysResource: this.x.npdm_sys_resource() >>> 0, is64: (fl & 1) !== 0,
        stackSize: this.x.npdm_stack_size() >>> 0, version: this.x.npdm_version() >>> 0, name: new TextDecoder().decode(nm.slice(0, n)) };
    } finally { this.done(); }
  }
  // The build ID from a module's first 0x100 bytes (32 hex digits: the first 16 bytes, as nxnative's profiles write it)
  nsoBuildId(head: Uint8Array): string | null {
    try { if (this.x.nso_peek(this.put(head), head.length)) return null; return hex(this.u8(this.x.nso_build_id_ptr(), 16)); }
    finally { this.done(); }
  }
  // The whole module: header, segments, hashes
  nsoCheck(file: Uint8Array): NsoInfo | { error: string } {
    try {
      this.x.prep_error_clear();
      if (this.x.nso_check(this.put(file), file.length)) return { error: this.lastError() };
      return { buildId: hex(this.u8(this.x.nso_build_id_ptr(), 16)), imageSize: this.x.nso_image_size() >>> 0, textSize: this.x.nso_text_size() >>> 0, bss: this.x.nso_bss() >>> 0, flags: this.x.nso_flags() >>> 0 };
    } finally { this.done(); }
  }
  // Registered cuts on a module file: the cut module (an NSO again), or the red line and the cut that stopped it
  cut(file: Uint8Array, cuts: Cut[]): { bytes: Uint8Array; applied: number } | { error: string; index: number; code: number } {
    try {
      this.x.prep_error_clear();
      let n = 4; const parts = cuts.map(c => { const o = hexBytes(c.orig), w = hexBytes(c.new); n += 8 + o.length + (o.length === w.length ? w.length : o.length); return [o, w] as const; });
      const list = new Uint8Array(n), dv = new DataView(list.buffer);
      dv.setUint32(0, cuts.length, true);
      let at = 4;
      for (let i = 0; i < cuts.length; i++) {
        const [o, w] = parts[i];
        if (o.length !== w.length || !o.length) return { error: `[RED] prepare: cut ${i} at 0x${cuts[i].off.toString(16)}: ${o.length} original bytes and ${w.length} new ones`, index: i, code: -2 };
        dv.setUint32(at, cuts[i].off, true); dv.setUint32(at + 4, o.length, true); list.set(o, at + 8); list.set(w, at + 8 + o.length); at += 8 + 2 * o.length;
      }
      const f = this.put(file), l = this.put(list);
      const r = this.x.cut_apply(f, file.length, l, list.length);
      if (r) return { error: this.lastError(), index: this.x.cut_failed_index(), code: r };
      return { bytes: this.u8(this.x.cut_out_ptr(), this.x.cut_out_len() >>> 0).slice(), applied: this.x.cut_applied() >>> 0 };
    } finally { this.done(); }
  }
  // The header and tables of a RomFS image over a tree (src/prepare/romfs_build.ts). starts[i] is where file i of
  // `entries` (directories not counted) begins in the virtual image.
  romTables(entries: RomEntry[]): RomTables | { error: string } {
    try {
      this.x.prep_error_clear();
      const enc = new TextEncoder(), names = entries.map(e => enc.encode(e.path));
      let n = 4; for (const b of names) n += 16 + b.length;
      const p = this.x.prep_alloc(n) >>> 0;
      if (!p) return { error: `[RED] prepare: no memory for a RomFS list of ${n} bytes` };
      let dv = new DataView(this.x.memory.buffer), at = p;
      dv.setUint32(at, entries.length, true); at += 4;
      for (let i = 0; i < entries.length; i++) {
        dv.setBigUint64(at, BigInt(entries[i].dir ? 0 : entries[i].size), true); dv.setUint32(at + 8, entries[i].dir ? 1 : 0, true); dv.setUint32(at + 12, names[i].length, true);
        new Uint8Array(this.x.memory.buffer, at + 16, names[i].length).set(names[i]); at += 16 + names[i].length;
      }
      if (this.x.rom_build(p, n)) return { error: this.lastError() };
      const files = this.x.rom_files() >>> 0, dataOffset = this.x.rom_data_offset(), dataSize = this.x.rom_data_size();
      dv = new DataView(this.x.memory.buffer);
      const starts = new Float64Array(files), op = this.x.rom_offsets_ptr() >>> 0;
      for (let i = 0; i < files; i++) starts[i] = dataOffset + Number(dv.getBigUint64(op + 8 * i, true));
      return { tables: this.u8(this.x.rom_tables_ptr(), this.x.rom_tables_len() >>> 0).slice(), starts, dirs: this.x.rom_dirs() >>> 0, files, dataOffset, dataSize, size: dataOffset + dataSize };
    } finally { this.done(); }
  }
  // Every stage of every BNSH container in the bytes (src/prepare/bnsh.ts)
  bnsh(b: Uint8Array, max = 65536): { stages: BnshStage[]; containers: number; dropped: number } {
    try {
      const n = this.x.bnsh_scan(this.put(b), b.length, max), rp = this.x.bnsh_rec_ptr() >>> 0, dv = new DataView(this.x.memory.buffer), out: BnshStage[] = [];
      for (let i = 0; i < n; i++) {
        const r = rp + 48 * i;
        out.push({ container: dv.getUint32(r, true), variation: dv.getUint32(r + 4, true), stage: (["vs", "hs", "ds", "gs", "ps", "cs"] as const)[dv.getUint32(r + 8, true)],
          status: BNSH_STATUS[dv.getUint32(r + 12, true)], control: [dv.getUint32(r + 16, true), dv.getUint32(r + 20, true)], code: [dv.getUint32(r + 24, true), dv.getUint32(r + 28, true)],
          key: hex(this.u8(r + 32, 8)) });
      }
      return { stages: out, containers: this.x.bnsh_containers() >>> 0, dropped: this.x.bnsh_dropped() >>> 0 };
    } finally { this.done(); }
  }
}
