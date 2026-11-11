// The prepare module (build/prepare/prepare.wasm) behind a TypeScript face: bytes in, results out. No Node or
// browser API here.
export const STATES = ["Idle", "Detect", "Index", "Profile", "Code", "Shaders", "Ready", "Failed", "Cancelled"] as const;
export type PrepState = typeof STATES[number];
export const REASONS = ["", "layout", "npdm", "arch", "version", "dlc", "module", "romfs", "profile", "cut", "read", "storage", "internal"] as const;
export type FailReason = Exclude<typeof REASONS[number], "">;
export const COUNT = { done: 0, total: 1, bytesDone: 2, bytesTotal: 3, files: 4, modules: 5, cuts: 6, romFiles: 7, romDirs: 8, aoc: 9, skipped: 10, ran: 11, shFound: 12, shTranslated: 13, shFailed: 14 } as const;
export type Counts = { -readonly [k in keyof typeof COUNT]: number };

interface X {
  memory: WebAssembly.Memory;
  prep_reset(): void; prep_state(): number; prep_reason(): number; prep_start(): number; prep_stage_end(skipped: number): number;
  prep_fail(reason: number): number; prep_cancel(): number; prep_count(i: number): number; prep_count_set(i: number, v: number): void; prep_count_add(i: number, v: number): void;
  prep_alloc(len: number): number; prep_arena_reset(): void; prep_arena_used(): number; prep_error_ptr(): number; prep_error_len(): number; prep_error_clear(): void;
  prep_sha256(ptr: number, len: number, out: number): void; prep_sha_buf(): number; prep_sha_begin(): void; prep_sha_update(len: number): void; prep_sha_end(): number;
  npdm_parse(ptr: number, len: number): number; npdm_program_id(): bigint; npdm_sys_resource(): number; npdm_flags(): number; npdm_stack_size(): number;
  npdm_version(): number; npdm_main_thread(): number; npdm_name_ptr(): number;
  nso_peek(ptr: number, len: number): number; nso_check(ptr: number, len: number): number; nso_parse(ptr: number, len: number): number; nso_build_id_ptr(): number;
  nso_image_size(): number; nso_text_size(): number; nso_bss(): number; nso_flags(): number;
  nso_open_begin(ptr: number, len: number): number; nso_open_step(budget: number): number; nso_open_work_total(): number; nso_open_work_done(): number;
  cut_apply(file: number, len: number, list: number, listLen: number): number; cut_out_ptr(): number; cut_out_len(): number; cut_failed_index(): number; cut_applied(): number;
  match_run(file: number, len: number, list: number, listLen: number): number; match_image(image: number, len: number, textEnd: number): number; match_resolve(list: number, listLen: number): number;
  match_status_ptr(): number; match_status_len(): number; match_cuts_ptr(): number; match_cuts_len(): number; match_cut_count(): number; match_src_ptr(): number;
  match_overlap_at(): number; match_image_error(): number; match_image_error_at(): number; match_fn_count(): number; match_fn_start(i: number): number; match_fn_end(i: number): number;
  match_fingerprint(start: number, out: number): number; match_writes(word: number): number;
  match_fn_ptr(): number; scan_image(file: number, len: number): number; nso_text_off(): number;
  rom_build(list: number, listLen: number): number; rom_tables_ptr(): number; rom_tables_len(): number; rom_offsets_ptr(): number; rom_dirs(): number; rom_files(): number;
  rom_data_offset(): number; rom_data_size(): number;
  bnsh_scan(ptr: number, len: number, max: number): number; bnsh_rec_ptr(): number; bnsh_containers(): number; bnsh_dropped(): number;
  kit_refused_total(): number;
}
export interface Cut { off: number; orig: string; new: string; why?: string }
// A function-matched rule (nxnative MATCH_CUTS, as tools/prepare/convert_profiles.py writes it): cuts at offsets from
// the start of the one function that has the size and one of the fingerprints; a rule of several functions applies
// whole or not at all; rules of one name are one patch's implementations, of which exactly one must match
export interface MatchRule { name: string; functions: { size: number; fingerprints: string[]; cuts: Cut[] }[]; file?: string }
// What became of one patch (the rules of one name) on a module: its cuts' offsets, or why it was not placed
export interface MatchOutcome { name: string; set: number; matched: boolean; offsets: number[]; why: string }
export interface MatchResult { cuts: (Cut & { set: number })[]; outcomes: MatchOutcome[]; functions: number }
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
  // While a module is open (open() .. close()) the arena is kept: its file and its unpacked image are in it
  private held: { file: Uint8Array; ptr: number } | null = null;
  private done(): void { if (!this.held) this.x.prep_arena_reset(); }
  private filePtr(file: Uint8Array): number { return this.held?.file === file ? this.held.ptr : this.put(file); }
  // The whole module, as nsoCheck, but in steps of about `budget` bytes unpacked or hashed, with `tick` awaited
  // between them (progress, a chance to draw, a Cancel: what it throws ends the open). A main module of system
  // 22.0.0 on is ZBIC compressed and over 100 MB unpacked; in one call that is the page not answering for seconds.
  // The module then stays open: nsoCheck, match and cut on this same `file` object use the image already unpacked
  // and verified, until close() (always call it: nothing else is freed while a module is open).
  async open(file: Uint8Array, tick?: (done: number, total: number) => Promise<void> | void, budget = 4 << 20): Promise<NsoInfo | { error: string }> {
    this.close();
    this.x.prep_error_clear();
    try {
      const ptr = this.put(file);
      let r = this.x.nso_open_begin(ptr, file.length);
      if (!r) {
        const total = this.x.nso_open_work_total();
        while ((r = this.x.nso_open_step(budget)) === -1) await tick?.(this.x.nso_open_work_done(), total);
      }
      if (r) return { error: this.lastError() };
      this.held = { file, ptr };
      return { buildId: hex(this.u8(this.x.nso_build_id_ptr(), 16)), imageSize: this.x.nso_image_size() >>> 0, textSize: this.x.nso_text_size() >>> 0, bss: this.x.nso_bss() >>> 0, flags: this.x.nso_flags() >>> 0 };
    } finally { this.done(); }
  }
  close(): void { this.held = null; this.x.prep_arena_reset(); }
  // Up to 64 KB in one call; more in pieces through the module's fixed buffer, so that a file of any size is hashed
  // without lying in the module's memory
  sha256(b: Uint8Array): string {
    if (b.length > 65536) {
      this.x.prep_sha_begin();
      const buf = this.x.prep_sha_buf() >>> 0;
      for (let at = 0; at < b.length; at += 65536) { const n = Math.min(65536, b.length - at); this.u8(buf, n).set(b.subarray(at, at + n)); this.x.prep_sha_update(n); }
      return hex(this.u8(this.x.prep_sha_end() >>> 0, 32));
    }
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
      if (this.x.nso_check(this.filePtr(file), file.length)) return { error: this.lastError() };
      return { buildId: hex(this.u8(this.x.nso_build_id_ptr(), 16)), imageSize: this.x.nso_image_size() >>> 0, textSize: this.x.nso_text_size() >>> 0, bss: this.x.nso_bss() >>> 0, flags: this.x.nso_flags() >>> 0 };
    } finally { this.done(); }
  }
  // For the instruction scan (src/glue/a64_scan.ts): the module's text and the functions of its unwind table as
  // [start, end) module offsets sorted by start (null: no table). `text` is a view of this module's memory: it is
  // good until the next call that allocates here, so scan it before anything else is asked of this object.
  scanInput(file: Uint8Array): { text: Uint8Array; textOff: number; functions: Uint32Array | null } | null {
    try {
      this.x.prep_error_clear();
      const image = this.x.scan_image(this.filePtr(file), file.length) >>> 0;
      if (!image) return null;
      const n = this.x.match_fn_count() >>> 0, textOff = this.x.nso_text_off() >>> 0, textSize = this.x.nso_text_size() >>> 0;
      let functions: Uint32Array | null = null;
      if (n) {
        const raw = new Uint32Array(this.x.memory.buffer, this.x.match_fn_ptr() >>> 0, 2 * n);
        functions = new Uint32Array(2 * n);
        for (let i = 0; i < n; i++) { functions[2 * i] = raw[2 * i + 1]; functions[2 * i + 1] = raw[2 * i]; }   // u64 start << 32 | end, little endian
      }
      return { text: this.u8(image + textOff, textSize), textOff, functions };
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
      const f = this.filePtr(file), l = this.put(list);
      const r = this.x.cut_apply(f, file.length, l, list.length);
      if (r) return { error: this.lastError(), index: this.x.cut_failed_index(), code: r };
      return { bytes: this.u8(this.x.cut_out_ptr(), this.x.cut_out_len() >>> 0).slice(), applied: this.x.cut_applied() >>> 0 };
    } finally { this.done(); }
  }
  // Function-matched cuts (src/prepare/match.ts). sets[i] is one list of rules resolved on its own (nxnative: the
  // game's rules, then the rules for every game). On a module file, or with `textEnd` on an unpacked image (tests).
  // Nothing is changed: the cuts found go through cut() like registered ones.
  match(file: Uint8Array, sets: MatchRule[][], textEnd?: number): MatchResult | { error: string; code: number } {
    try {
      this.x.prep_error_clear();
      const rules = sets.flatMap((rs, set) => rs.map(r => ({ r, set })));
      const groups = new Map<string, number>(), parts: number[][] = [], u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
      parts.push(u32(rules.length));
      for (const { r, set } of rules) {
        const k = set + "\0" + r.name;
        if (!groups.has(k)) groups.set(k, groups.size);
        parts.push(u32(set), u32(groups.get(k)!), u32(r.functions.length));
        for (const f of r.functions) {
          parts.push(u32(f.size), u32(f.fingerprints.length));
          for (const d of f.fingerprints) { if (!/^[0-9a-f]{64}$/.test(d)) return { error: `[RED] prepare: function patch '${r.name}': a fingerprint is not 64 hex digits`, code: -2 }; parts.push([...hexBytes(d)]); }
          parts.push(u32(f.cuts.length));
          for (const c of f.cuts) {
            const o = hexBytes(c.orig), w = hexBytes(c.new);
            if (o.length !== w.length) return { error: `[RED] prepare: function patch '${r.name}': ${o.length} original bytes and ${w.length} new ones`, code: -2 };
            parts.push(u32(c.off), u32(o.length), [...o], [...w]);
          }
        }
      }
      const list = Uint8Array.from(parts.flat());
      const f = textEnd === undefined ? this.filePtr(file) : this.put(file), l = this.put(list);
      let rc: number;
      if (textEnd === undefined) rc = this.x.match_run(f, file.length, l, list.length);
      else { this.x.match_image(f, file.length, textEnd); rc = this.x.match_resolve(l, list.length); }
      const hx = (v: number) => "0x" + (v >>> 0).toString(16);
      if (rc === -6) return { error: `[RED] prepare: function patches overlap at ${hx(this.x.match_overlap_at())}`, code: rc };
      if (rc === -2) return { error: "[RED] prepare: the list of function patches is malformed", code: rc };
      if (rc) return { error: this.lastError() || `[RED] prepare: function patches: error ${rc}`, code: rc };
      const dv = new DataView(this.x.memory.buffer), sp = this.x.match_status_ptr() >>> 0;
      const ie = this.x.match_image_error();
      const imageWhy = ["", "no MOD0", "cannot read function boundaries", `conflicting function boundaries at ${hx(this.x.match_image_error_at())}`, "no memory for the function table"][ie];
      // per rule: matched, chosen, the starts of its functions, and nxnative's sentence for a miss
      let at = sp;
      const st = rules.map(({ r }) => {
        const matched = dv.getUint32(at, true) === 0, chosen = dv.getUint32(at + 4, true) === 1, n = r.functions.length;
        at += 12;
        const misses: string[] = [];
        r.functions.forEach((fn, i) => {
          const state = dv.getUint32(at, true), detail = dv.getUint32(at + 4, true);
          at += 12;
          const why = state === 1 ? `${detail} matching functions (need exactly one)` : state === 2 ? `original bytes differ at ${hx(detail)}` : "";
          if (state === 3) misses.push(`function ${i + 1} of ${n} matched a function another one did`);
          else if (state) misses.push(n > 1 ? `function ${i + 1} of ${n} (${fn.size} bytes): ${why}` : why);
        });
        return { matched, chosen, why: imageWhy || misses.join("; ") + (n > 1 && misses.length && misses.length < n ? `; the other ${n - misses.length} matched` : "") };
      });
      const count = this.x.match_cut_count() >>> 0, cp = this.x.match_cuts_ptr() >>> 0, src = this.x.match_src_ptr() >>> 0;
      const cuts: MatchResult["cuts"] = [], offsets = new Map<string, number[]>();
      let p = cp + 4;
      for (let i = 0; i < count; i++) {
        const off = dv.getUint32(p, true), len = dv.getUint32(p + 4, true);
        const ri = dv.getUint32(src + 12 * i, true), fi = dv.getUint32(src + 12 * i + 4, true), ci = dv.getUint32(src + 12 * i + 8, true);
        const { r, set } = rules[ri], c = r.functions[fi].cuts[ci];
        cuts.push({ off, orig: hex(this.u8(p + 8, len)), new: hex(this.u8(p + 8 + len, len)), why: (c.why ?? r.name) + " [function match]", set });
        const k = set + "\0" + r.name; offsets.set(k, [...(offsets.get(k) ?? []), off]);
        p += 8 + 2 * len;
      }
      const outcomes: MatchOutcome[] = [];
      for (const k of groups.keys()) {
        const mine = rules.map((x, i) => ({ ...x, i })).filter(x => x.set + "\0" + x.r.name === k), found = mine.filter(x => st[x.i].matched);
        const base = { name: mine[0].r.name, set: mine[0].set };
        if (found.length === 1 && st[found[0].i].chosen) outcomes.push({ ...base, matched: true, offsets: offsets.get(k) ?? [], why: `implementation ${mine.indexOf(found[0]) + 1} of ${mine.length}` });
        else outcomes.push({ ...base, matched: false, offsets: [], why: found.length ? `${found.length} implementations match (need exactly one)` : [...new Set(mine.map(x => st[x.i].why))].join("; ") });
      }
      return { cuts, outcomes, functions: this.x.match_fn_count() >>> 0 };
    } finally { this.done(); }
  }
  // The fingerprint of every function of an unpacked image's unwind table (null: a branch leaves it for a place with
  // no identity), as nxnative's nso_match.py Image.fingerprint gives it; the tests compare the two
  fingerprints(image: Uint8Array, textEnd: number): { functions: { start: number; end: number; fingerprint: string | null }[]; error: number } {
    try {
      const error = this.x.match_image(this.put(image), image.length, textEnd), o = this.x.prep_alloc(32) >>> 0, out = [];
      for (let i = 0, n = this.x.match_fn_count() >>> 0; i < n; i++) {
        const start = this.x.match_fn_start(i) >>> 0;
        out.push({ start, end: this.x.match_fn_end(i) >>> 0, fingerprint: this.x.match_fingerprint(start, o) ? hex(this.u8(o, 32)) : null });
      }
      return { functions: out, error };
    } finally { this.done(); }
  }
  // The registers (bit n: xn) the measured table counts an instruction as writing (src/prepare/gen/match_writes.ts)
  writes(word: number): number { return this.x.match_writes(word) >>> 0; }
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
