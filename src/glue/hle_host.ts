// nxweb take-over table, embedder side: one instance of the hle module (src/hle, AssemblyScript) and everything it
// asks of the outside as one interface, HleEnv. No Node APIs and nothing of the runtime here: src/glue/hle_rt.ts
// connects an HleHost to a Runtime, the tests (test/hle) give it a fake guest memory and fake kernel events.
import type { KitExports } from "../kit/host/reader.mts";

export interface HleExports extends KitExports {
  hle_init(): void;
  hle_count(): number; hle_internal_count(): number;
  hle_name(id: number): number; hle_demangled(id: number): number; hle_flags(id: number): number; hle_lookup(name: number): number;
  hle_args(): number; hle_scratch(): number;
  hle_call(id: number, args: number): bigint; hle_resume(id: number, args: number, how: number): bigint;
  hle_ret_flags(): number; hle_ret_x1(): bigint; hle_ret_d0(): bigint; hle_wait_handle(): number; hle_wait_timeout(): bigint;
  hle_call_count(id: number): number;
  hle_cfg(key: number, value: bigint): void; hle_cfg_str(key: number, ptr: number, len: number): void;
  hle_aoc_set(ptr: number, n: number): void; hle_font_set(which: number, ptr: number, len: number): void;
  hle_focus_set(state: number): void; hle_set_opmode(mode: number): void; hle_opmode(): number; hle_focus_seen(): number; hle_focus_front(): number;
  hle_notify(msg: number): void; hle_notify_count(): number;
  hle_applet_enter(name: number): void; hle_applet_leave(): void;
  hle_shutdown(): number; hle_exit_done(): void; hle_exit_state(): number; hle_exit_reason(): number;
  hle_text_answer(result: number, ptr: number, len: number): number; hle_text_state(): number;
  hle_web_message(ptr: number, len: number): void; hle_web_ended(reason: number, url: number): void; hle_web_failed(why: number): void; hle_web_state(): number;
  hle_vsync_tick(binding: bigint): number;
  hle_event_bind(ev: number, autoclear: number): void; hle_event_signal(ev: number): void; hle_event_clear(ev: number): void;
  hle_event_handle(ev: number): number; hle_event_count(): number; hle_handle_closed(h: number): void;
  hle_entropy64(): bigint; hle_errno(): number;
  hle_mii_standin(kind: number, out: number, cap: number): number;
  hle_static_end(): number;
}

// hle_cfg keys (src/hle/base.ts CFG_*) and hle_cfg_str keys (STR_*)
export const CFG = { opmode: 0, perfBoost: 1, fixedTime: 2, prevProgram: 3, sdkMajor: 4, fontDecode: 5, sharedFontTtf: 6, allocBigAlign: 7, detEntropy: 8,
  sfTrace: 9, programIndex: 10, hasPrograms: 11 } as const;
export const STR = { lang: 0, nick: 1, gameEnv: 2, launchSpec: 3, launchBytes: 4, displayVersion: 5, kbd: 6 } as const;
export const RET = { x1: 1, d0: 2, wait: 4, noReturn: 8 } as const;
export const EXIT_REASON = ["", "hostShutdown", "executeProgram", "abort"] as const;
export const ARGS_SIZE = 208;

export interface TextRequest { title: string; sub: string; guide: string; initial: string; maxChars: number; minChars: number; kind: "keyboard" | "inline" }
// Everything the take-overs need from outside the module
export interface HleEnv {
  log(line: string): void;                                   // red lines start with "[RED] "
  guestNs(): bigint;                                         // kernel_guest_ns
  monoNs(): bigint;                                          // host monotonic clock
  realNs(): bigint;                                          // ns since 1970-01-01 UTC
  timeZone(posixSeconds: bigint): { offset: number; dst: boolean; name: string };   // the host's zone then: seconds east of UTC, its abbreviation (at most 7 bytes)
  entropy(out: Uint8Array): void;
  eventNew(): { r: number; w: number };                      // kernel_event_new: readable and writable handle
  eventSignal(h: number): boolean;                           // kernel_event_signal (by writable handle); false: no such handle
  eventClear(h: number): boolean;                            // kernel_event_clear
  eventDupReadable(h: number): number;
  guestSym(name: string): bigint;                            // a symbol's address in the guest's own modules (never a take-over); 0n = none
  guestCall(fn: bigint, args: bigint[]): bigint;             // run a guest function on the calling thread; its x0
  moduleOf(addr: bigint): number;                            // index of the loaded module that holds addr, -1 = none
  stubAddr(id: number, name: string): bigint;                // the address guest code calls to reach take-over id; 0n = cannot
  hostAlloc(size: bigint): bigint;                           // zeroed memory the guest can address, for the life of the process; 0n = none
  clockFreeze(reason: number, on: boolean): void;            // kernel_clock_freeze
  textRequest(req: TextRequest): void;                       // show the input box; answer with HleHost.textAnswer, now or later
  webOpen(path: string, callback: string, hidden: boolean, keyRepeatDelay: number, keyRepeatPulse: number): number;   // 0 shown by a web view, 1 page not found, 2 no web view
  webShow(): void; webSend(message: Uint8Array): void; webClose(): void;
  inputHold(on: boolean): void;                              // a web page holds the input: the game reads nothing
  vsyncEvent(binding: bigint): void;                         // call HleHost.vsyncTick(binding) at every vertical blank until it returns false
  connectedNpad(): number;                                   // the npad id of the controller connected now
  nativeImageBlank(w: number, h: number): number; nativeImageBlankFree(handle: number): void;
  exitRequest(reason: typeof EXIT_REASON[number], value: bigint, bytes: Uint8Array): void;   // stop audio, graphics and the run loop, then HleHost.exitDone()
}

export interface HleEntry { id: number; name: string; demangled: string; forced: boolean; implemented: boolean; shadowed: boolean; duplicate: boolean; internal: boolean }
export interface HleRegs { x?: (bigint | number)[]; d?: (bigint | number)[]; f?: Record<number, number>; x8?: bigint | number; lr?: bigint | number }
export interface HleResult { x0: bigint; x1?: bigint; d0?: bigint; wait?: { handle: number; timeoutNs: bigint }; noReturn: boolean }
// A call that is waiting: what resume() needs
export interface HlePending { id: number; block: Uint8Array }

const enc = new TextEncoder(), dec = new TextDecoder();
const u64 = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

export class HleHost {
  readonly x: HleExports;
  readonly memory: WebAssembly.Memory;
  readonly env: HleEnv;
  private entryList: HleEntry[] | undefined;
  private ids = new Map<string, number>();

  // memory: the shared linear memory, for a module built with --importMemory (hleBuildShared); omitted: the module's own
  constructor(module: WebAssembly.Module, env: HleEnv, memory?: WebAssembly.Memory) {
    this.env = env;
    const self = this;
    let x!: HleExports;
    const mem = () => self.memory.buffer;
    const str = (p: number, max = 4096) => { const b = new Uint8Array(mem()); let e = p >>> 0; while (b[e] && e - p < max) e++; return dec.decode(b.slice(p >>> 0, e)); };
    const imports = {
      log: (p: number, n: number) => env.log(dec.decode(new Uint8Array(mem()).slice(p >>> 0, (p >>> 0) + n))),
      abort: () => { throw new Error("hle: abort"); },
      hle_guest_ns: () => u64(env.guestNs()), hle_mono_ns: () => u64(env.monoNs()), hle_real_ns: () => BigInt.asIntN(64, env.realNs()),
      hle_tz: (t: bigint, out: number) => {
        const z = env.timeZone(t), dv = new DataView(mem());
        dv.setInt32(out >>> 0, z.offset, true); dv.setInt32((out >>> 0) + 4, z.dst ? 1 : 0, true);
        const nm = enc.encode(z.name).subarray(0, 7), b = new Uint8Array(mem());
        b.fill(0, (out >>> 0) + 8, (out >>> 0) + 16); b.set(nm, (out >>> 0) + 8);
      },
      hle_entropy: (p: number, n: number) => { const t = new Uint8Array(n); env.entropy(t); new Uint8Array(mem()).set(t, p >>> 0); },
      hle_event_new: (w: number) => { const e = env.eventNew(); if (w) new DataView(mem()).setUint32(w >>> 0, e.w, true); return e.r; },
      hle_event_signal: (h: number) => env.eventSignal(h >>> 0) ? 1 : 0,
      hle_event_clear: (h: number) => env.eventClear(h >>> 0) ? 1 : 0,
      hle_event_dup_readable: (h: number) => env.eventDupReadable(h >>> 0),
      hle_guest_sym: (p: number) => u64(env.guestSym(str(p))),
      hle_guest_call: (fn: bigint, p: number, n: number) => {
        const dv = new DataView(mem()), args: bigint[] = [];
        for (let i = 0; i < n; i++) args.push(dv.getBigUint64((p >>> 0) + 8 * i, true));
        return u64(env.guestCall(u64(fn), args));
      },
      hle_module_of: (a: bigint) => env.moduleOf(u64(a)),
      hle_stub_addr: (id: number) => u64(env.stubAddr(id, str(x.hle_name(id)))),
      hle_host_alloc: (n: bigint) => u64(env.hostAlloc(u64(n))),
      hle_clock_freeze: (reason: number, on: number) => env.clockFreeze(reason, on !== 0),
      hle_text_request: (r: number) => {
        const dv = new DataView(mem()), q = r >>> 0, s = (o: number) => str(Number(dv.getBigUint64(q + o, true)));
        env.textRequest({ title: s(0), sub: s(8), guide: s(16), initial: s(24), maxChars: dv.getInt32(q + 32, true), minChars: dv.getInt32(q + 36, true),
          kind: dv.getInt32(q + 40, true) ? "inline" : "keyboard" });
      },
      hle_web_open: (path: number, cb: number, hidden: number, delay: number, pulse: number) => env.webOpen(str(path), str(cb), hidden !== 0, delay >>> 0, pulse >>> 0),
      hle_web_show: () => env.webShow(),
      hle_web_send: (p: number, n: number) => env.webSend(new Uint8Array(mem()).slice(p >>> 0, (p >>> 0) + n)),
      hle_web_close: () => env.webClose(),
      hle_input_hold: (on: number) => env.inputHold(on !== 0),
      hle_vsync_event: (binding: bigint) => env.vsyncEvent(u64(binding)),
      hle_connected_npad: () => env.connectedNpad(),
      hle_native_image_blank: (w: number, h: number) => env.nativeImageBlank(w >>> 0, h >>> 0),
      hle_native_image_blank_free: (h: number) => env.nativeImageBlankFree(h >>> 0),
      hle_exit_request: (reason: number, value: bigint, p: number, n: number) =>
        env.exitRequest(EXIT_REASON[reason] ?? "abort", u64(value), new Uint8Array(mem()).slice(p >>> 0, (p >>> 0) + (n >>> 0))),
    };
    const inst = new WebAssembly.Instance(module, { env: memory ? { ...imports, memory } : imports });
    x = inst.exports as unknown as HleExports;
    this.x = x;
    this.memory = memory ?? x.memory;
    x.hle_init();
  }
  private cstr(p: number): string { const b = new Uint8Array(this.memory.buffer); let e = p; while (b[e]) e++; return dec.decode(b.slice(p, e)); }
  private scratch(bytes: Uint8Array): number {
    const p = this.x.hle_scratch() >>> 0;
    if (bytes.length > 8191) throw new Error("hle: a string for the module is longer than its 8 KB scratch");
    const b = new Uint8Array(this.memory.buffer); b.set(bytes, p); b[p + bytes.length] = 0;
    return p;
  }

  // ---- the table ----
  // Every entry, internal ones last. Register `forced` ones as forced take-overs and the others as weak; skip
  // `shadowed` (the name also has a forced entry) and `duplicate` ones.
  entries(): HleEntry[] {
    if (this.entryList) return this.entryList;
    const x = this.x, n = x.hle_count(), out: HleEntry[] = [];
    for (let id = 0; id < n + x.hle_internal_count(); id++) {
      const f = x.hle_flags(id);
      out.push({ id, name: this.cstr(x.hle_name(id) >>> 0), demangled: this.cstr(x.hle_demangled(id) >>> 0), forced: (f & 1) !== 0, implemented: (f & 2) !== 0,
        shadowed: (f & 8) !== 0, duplicate: (f & 32) !== 0, internal: id >= n });
    }
    return this.entryList = out;
  }
  lookup(name: string): number {
    let id = this.ids.get(name);
    if (id === undefined) { id = this.x.hle_lookup(this.scratch(enc.encode(name))); this.ids.set(name, id); }
    return id;
  }

  // ---- calls ----
  private result(x0: bigint): HleResult {
    const x = this.x, f = x.hle_ret_flags(), r: HleResult = { x0: u64(x0), noReturn: (f & RET.noReturn) !== 0 };
    if (f & RET.x1) r.x1 = u64(x.hle_ret_x1());
    if (f & RET.d0) r.d0 = u64(x.hle_ret_d0());
    if (f & RET.wait) r.wait = { handle: x.hle_wait_handle() >>> 0, timeoutNs: BigInt.asIntN(64, x.hle_wait_timeout()) };
    return r;
  }
  // Call take-over id. x: x0..x7; d: the low 64 bits of v0..v7 as raw bits (f: floats by index instead); x8; lr.
  // When the result has `wait`, park the guest thread on that readable handle (WaitSynchronization with the
  // timeout), keep pending(), and call resume() with how the wait ended; repeat while the result has `wait`.
  call(id: number, regs: HleRegs = {}): HleResult {
    const p = this.x.hle_args() >>> 0, dv = new DataView(this.memory.buffer);
    for (let i = 0; i < ARGS_SIZE; i += 8) dv.setBigUint64(p + i, 0n, true);
    (regs.x ?? []).slice(0, 8).forEach((v, i) => dv.setBigUint64(p + 8 * i, u64(v), true));
    (regs.d ?? []).slice(0, 8).forEach((v, i) => dv.setBigUint64(p + 64 + 8 * i, u64(v), true));
    for (const [i, v] of Object.entries(regs.f ?? {})) dv.setFloat32(p + 64 + 8 * Number(i), v, true);
    dv.setBigUint64(p + 128, u64(regs.x8 ?? 0), true); dv.setBigUint64(p + 136, u64(regs.lr ?? 0), true);
    return this.result(this.x.hle_call(id, p));
  }
  // The argument block of the call that just returned `wait` (the continuation slots are in it)
  pending(id: number): HlePending { const p = this.x.hle_args() >>> 0; return { id, block: new Uint8Array(this.memory.buffer).slice(p, p + ARGS_SIZE) }; }
  resume(pend: HlePending, how: "signaled" | "timeout" | "cancelled"): HleResult {
    const p = this.x.hle_args() >>> 0;
    new Uint8Array(this.memory.buffer).set(pend.block, p);
    return this.result(this.x.hle_resume(pend.id, p, how === "signaled" ? 1 : how === "timeout" ? 2 : 3));
  }

  // ---- configuration: what nxnative reads from its environment and the game profile; before the guest runs ----
  config(o: { opmode?: number; perfBoost?: boolean; fixedTime?: bigint | number; prevProgram?: number; sdkMajor?: number; fontDecodeImported?: boolean;
    sharedFontTtf?: boolean; allocBigAlign?: boolean; deterministicEntropy?: boolean; sfTrace?: boolean; programIndex?: number; hasPrograms?: boolean;
    lang?: string; nick?: string; gameEnv?: string; launchSpec?: string; launchBytes?: Uint8Array | null; displayVersion?: string; kbd?: string | null }): void {
    const x = this.x, n = (k: number, v: bigint | number | boolean | undefined) => { if (v !== undefined) x.hle_cfg(k, BigInt(typeof v === "boolean" ? (v ? 1 : 0) : v)); };
    n(CFG.opmode, o.opmode); n(CFG.perfBoost, o.perfBoost); n(CFG.fixedTime, o.fixedTime); n(CFG.prevProgram, o.prevProgram); n(CFG.sdkMajor, o.sdkMajor);
    n(CFG.fontDecode, o.fontDecodeImported); n(CFG.sharedFontTtf, o.sharedFontTtf); n(CFG.allocBigAlign, o.allocBigAlign); n(CFG.detEntropy, o.deterministicEntropy);
    n(CFG.sfTrace, o.sfTrace); n(CFG.programIndex, o.programIndex); n(CFG.hasPrograms, o.hasPrograms);
    const s = (k: number, v: string | Uint8Array | null | undefined) => {
      if (v === undefined) return;
      if (v === null) { x.hle_cfg_str(k, 0, -1); return; }
      const b = typeof v === "string" ? enc.encode(v) : v;
      x.hle_cfg_str(k, this.scratch(b), b.length);
    };
    s(STR.lang, o.lang); s(STR.nick, o.nick); s(STR.gameEnv, o.gameEnv); s(STR.launchSpec, o.launchSpec); s(STR.launchBytes, o.launchBytes);
    s(STR.displayVersion, o.displayVersion); s(STR.kbd, o.kbd);
  }
  // The owned add-on content indices (nxnative: the numeric subdirectories of DM_AOC_DIR)
  aocSet(indices: number[]): void {
    const p = this.x.hle_scratch() >>> 0, dv = new DataView(this.memory.buffer), n = Math.min(indices.length, 2000);
    for (let i = 0; i < n; i++) dv.setInt32(p + 4 * i, indices[i], true);
    this.x.hle_aoc_set(p, n);
  }
  // A stand-in shared font: `address` is memory the guest can address that holds 8 free bytes and then the TTF
  // (`size` = 8 + the TTF's size); the module writes the BFTTF header into the 8 bytes. which: "standard" or "extension"
  fontSet(which: "standard" | "extension", address: number, size: number): void { this.x.hle_font_set(which === "extension" ? 1 : 0, address, size); }

  // ---- what the front end reports ----
  focusSet(state: 1 | 2 | 3): void { this.x.hle_focus_set(state); }
  setOpmode(mode: 0 | 1): void { this.x.hle_set_opmode(mode); }
  shutdown(): boolean { return this.x.hle_shutdown() !== 0; }
  exitDone(): void { this.x.hle_exit_done(); }
  get exit(): { state: "Running" | "Exiting" | "Exited"; reason: typeof EXIT_REASON[number] } {
    return { state: (["Running", "Exiting", "Exited"] as const)[this.x.hle_exit_state()], reason: EXIT_REASON[this.x.hle_exit_reason()] ?? "" };
  }
  // The input box's answer: a string (OK), null (cancel) or "no window". false: no request was waiting
  textAnswer(text: string | null | { noWindow: true }): boolean {
    if (typeof text === "string") { const b = enc.encode(text); return this.x.hle_text_answer(1, this.scratch(b), b.length) !== 0; }
    return this.x.hle_text_answer(text === null ? 0 : -1, 0, 0) !== 0;
  }
  webMessage(message: string | Uint8Array): void { const b = typeof message === "string" ? enc.encode(message) : message; this.x.hle_web_message(this.scratch(b), b.length); }
  // reason: 0 the page called nx.endApplet, 1 back from its first page, 2 the game asked, 3 the callback URL was reached
  webEnded(reason: number, lastUrl?: string): void { this.x.hle_web_ended(reason, lastUrl ? this.scratch(enc.encode(lastUrl)) : 0); }
  webFailed(why: string): void { this.x.hle_web_failed(this.scratch(enc.encode(why))); }
  vsyncTick(binding: bigint): boolean { return this.x.hle_vsync_tick(binding) !== 0; }
  handleClosed(handle: number): void { this.x.hle_handle_closed(handle); }
}
