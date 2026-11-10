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
  // controllers, the screen, vibration (src/hle/hid.ts)
  hle_input(player: number, snapshot: number): number; hle_input_peek(out: number): void;
  hle_hold(reason: number, on: number): void; hle_hold_state(): number;
  hle_ctrl_answer(result: number): number; hle_ctrl_state(): number;
  hle_pad_slot(op: number, id: number): number;
  hle_players_reported(): number; hle_player_npad(player: number): number; hle_npad_style(id: number): number;
  hle_input_samples(): bigint; hle_cheat_keys(): bigint; hle_joy_mouse_wanted(): number;
  hle_haptics_init(sink: number, enabled: number): void; hle_haptics_route(player: number, on: number): void; hle_haptics_enable(on: number): void;
  hle_haptics_suspend(reason: number, on: number): void; hle_haptics_epoch(player: number): bigint; hle_haptics_available(): number;
  hle_motion_map(map: number, spec: number): number; hle_motion_reset(state: number): void;
  hle_motion_update(state: number, map: number, acc: number, rot: number, dt: number, k: number): void;
  hle_motion_fill(state: number, out: number): void; hle_motion_phone(orient: number, inp: number, out: number): void;
  // nn::vi, nn::ro, nn::jit
  hle_vi_frame_queued(frame: bigint): void; hle_vi_layer_size(): number; hle_vi_layer_crop(): bigint; hle_vi_native_window(): number;
  hle_ro_refuse(sha: number): void; hle_ro_loaded(): number; hle_jit_envs(): number;
  hle_sha256(p: number, n: number, out: number): void;
}

// hle_cfg keys (src/hle/base.ts CFG_*) and hle_cfg_str keys (STR_*)
export const CFG = { opmode: 0, perfBoost: 1, fixedTime: 2, prevProgram: 3, sdkMajor: 4, fontDecode: 5, sharedFontTtf: 6, allocBigAlign: 7, detEntropy: 8,
  sfTrace: 9, programIndex: 10, hasPrograms: 11, motionOff: 12, motionAccNeg: 13, motionGain: 14, motionLog: 15, phoneMotion: 16, inputScripted: 17,
  displayW: 18, displayH: 19, sdkOunce: 20 } as const;
export const STR = { lang: 0, nick: 1, gameEnv: 2, launchSpec: 3, launchBytes: 4, displayVersion: 5, kbd: 6, motionAxes: 7 } as const;
// A player's input snapshot (src/hle/hid.ts has the layout): its size and flag bits
export const SNAP_SIZE = 0x1B0;
export const IN = { connected: 1, motion: 2, raw: 4, console: 8, joyL: 0x10, joyR: 0x20, joy2: 0x40, jmotionL: 0x80, jmotionR: 0x100, mouseL: 0x200, mouseR: 0x400,
  touch: 0x800, rumble: 0x1000, clrMotion: 0x10000, clrRaw: 0x20000, clrJmotionL: 0x40000, clrJmotionR: 0x80000 } as const;
// NpadButton bits; SHAKE (bit 63) shakes player 1's controller and never reaches the game's buttons
export const BTN = { A: 1n << 0n, B: 1n << 1n, X: 1n << 2n, Y: 1n << 3n, LS: 1n << 4n, RS: 1n << 5n, L: 1n << 6n, R: 1n << 7n, ZL: 1n << 8n, ZR: 1n << 9n,
  Plus: 1n << 10n, Minus: 1n << 11n, Left: 1n << 12n, Up: 1n << 13n, Right: 1n << 14n, Down: 1n << 15n,
  LSL: 1n << 24n, LSR: 1n << 25n, RSL: 1n << 26n, RSR: 1n << 27n, SHAKE: 1n << 63n } as const;
// Why the game's input is held (HleHost.hold): the game reads nothing while any reason holds
export const HOLD = { web: 1, controllerPrompt: 2, keyboard: 3, embedder: 4 } as const;
export const STICK_MAX = 32767;

type V3 = [number, number, number] | Float32Array | number[];
export interface MotionSample { acc: V3; rot: V3 }                    // G (gravity (0, 0, -1) face up), rad/s
export interface TimedMotion extends MotionSample { sampleNs: bigint }   // the sample's time on the host's monotonic clock (HleEnv.monoNs)
export interface JoyConInput { buttons?: bigint | number; stick?: [number, number]; motion?: TimedMotion; clearMotion?: boolean;
  mouse?: { dx: number; dy: number; connected?: boolean; onSurface?: boolean } }
// One player's whole input at a moment. Everything left out is "nothing": no buttons, centred sticks, no new sample
export interface InputSnapshot {
  connected?: boolean;               // default true; false: this player's controller went away (player 1 always counts as connected)
  sourceId?: number;                 // the source's stable non-zero id, for HleHost.input(-1, ...) and the slot rules
  buttons?: bigint | number; shake?: boolean;
  lx?: number; ly?: number; rx?: number; ry?: number;   // -32767..32767, right and up positive
  motion?: MotionSample;             // the pad's gyro and accelerometer in the controller's own frame (config motionAxes maps it)
  rawMotion?: TimedMotion;           // the same from a raw sensor stream, already in the Switch frame, with the sample's time
  consoleMotion?: MotionSample;      // player 1: the device's own sensors in the Switch frame
  clearMotion?: boolean; clearRawMotion?: boolean;   // that source stopped: another fresh one can take over at once
  joyLeft?: JoyConInput; joyRight?: JoyConInput; joyCon2?: boolean;   // the pad holds these Joy-Cons as devices of their own
  touches?: { id: number; x: number; y: number }[];   // player 1: every point on the screen now (0..1, origin top left)
  rumble?: boolean;                  // this player's controller has a motor the embedder can drive
}
export interface VibrationValue { amplitudeLow: number; frequencyLow: number; amplitudeHigh: number; frequencyHigh: number }
// A player's motors after a change; a changed epoch invalidates everything queued before
export interface VibrationState { player: number; epoch: bigint; motors: [VibrationValue, VibrationValue] }
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
  connectedNpad?(): number;                                  // no longer asked: the module has the controllers itself (src/hle/hid.ts)
  nativeImageBlank(w: number, h: number): number; nativeImageBlankFree(handle: number): void;
  exitRequest(reason: typeof EXIT_REASON[number], value: bigint, bytes: Uint8Array): void;   // stop audio, graphics and the run loop, then HleHost.exitDone()
  // ---- added with controllers, nn::vi, nn::ro and nn::jit. Each is optional: without it the take-overs answer as
  // ---- nxnative does with no window, no motor and no loader, and what cannot be answered is one red line
  stackArg?(index: number): bigint;                          // the index-th 8-byte stack argument of the guest call being taken over ([sp + 8 * index])
  ctrlPrompt?(min: number, max: number): boolean;            // show the controller prompt (it waits for players); answer with HleHost.ctrlAnswer. false: no window
  joyMouseWanted?(on: boolean): void;                        // the game set up (or finalized) the Joy-Con mouse sensors
  vibration?(state: VibrationState): void;                   // a player's motors changed (HleHost.haptics({ output: true }) turns this on)
  viLayer?(w: number, h: number): void;                      // vi::CreateLayer with a size: the present shows the picture in that shape
  viCrop?(x: number, y: number, w: number, h: number): void; // vi::SetLayerCrop changed (all 0: none)
  viFrameCount?(): bigint;                                   // frames the game has presented so far
  viPresentProgress?(): { queued: bigint; done: bigint };    // presents queued, presents handed on to the screen
  viPresentedNs?(ticket: bigint): bigint;                    // when present `ticket` reached the screen (monoNs clock); 0n not known, -1n dropped
  // nn::ro / nn::jit: the loader and the translator. token: any non-zero value that names the mapped module
  roLoad?(image: bigint, size: number, sha256: Uint8Array, alone: boolean): bigint;   // map and relocate, run nothing; 0n = could not
  roCalls?(token: bigint, kind: "init" | "fini"): bigint[];  // the functions to call for its init (DT_INIT, or its init_array) or fini
  roActivate?(token: bigint): void;                          // its init ran: it joins the lookups, earlier modules' imports bind to it
  roUnload?(token: bigint): void;
  roLookupIn?(token: bigint, name: string): bigint;          // a definition in that one module; 0n = none
  jitMemory?(rxSize: bigint, roSize: bigint): { rx: bigint; ro: bigint } | null;   // code memory the game can jump into, and data memory
  jitCodeWritten?(rx: bigint, offset: bigint, size: bigint): void;                 // translations of that range are stale
  jitFree?(rx: bigint, rxSize: bigint, ro: bigint, roSize: bigint): void;
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
    const calls = new Map<string, bigint[]>(), told = new Set<string>();
    const missing = (what: string, line: string) => { if (!told.has(what)) { told.add(what); env.log(`[RED] hle: ${line} (HleEnv.${what} is not given)`); } };
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
      hle_connected_npad: () => env.connectedNpad?.() ?? 0,
      hle_stack_arg: (i: number) => { if (env.stackArg) return u64(env.stackArg(i)); missing("stackArg", "a take-over reads an argument from the guest stack: answered 0"); return 0n; },
      hle_ctrl_prompt: (min: number, max: number) => env.ctrlPrompt?.(min, max) ? 0 : -1,
      hle_joy_mouse_wanted: (on: number) => env.joyMouseWanted?.(on !== 0),
      hle_vibration: (p: number) => {
        if (!env.vibration) return;
        const dv = new DataView(mem()), q = p >>> 0, v = (o: number): VibrationValue =>
          ({ amplitudeLow: dv.getFloat32(q + o, true), frequencyLow: dv.getFloat32(q + o + 4, true), amplitudeHigh: dv.getFloat32(q + o + 8, true), frequencyHigh: dv.getFloat32(q + o + 12, true) });
        env.vibration({ player: dv.getInt32(q, true), epoch: dv.getBigUint64(q + 8, true), motors: [v(16), v(32)] });
      },
      hle_vi_layer: (w: number, h: number) => env.viLayer?.(w >>> 0, h >>> 0),
      hle_vi_crop: (cx: number, cy: number, w: number, h: number) => env.viCrop?.(cx >>> 0, cy >>> 0, w >>> 0, h >>> 0),
      hle_vi_frame_count: () => { if (env.viFrameCount) return u64(env.viFrameCount()); missing("viFrameCount", "vi: the layer's frame number is asked for: answered 0"); return 0n; },
      hle_vi_present_progress: (out: number) => { const r = env.viPresentProgress?.() ?? { queued: 0n, done: 0n }, dv = new DataView(mem()); dv.setBigUint64(out >>> 0, u64(r.queued), true); dv.setBigUint64((out >>> 0) + 8, u64(r.done), true); },
      hle_vi_presented_ns: (ticket: bigint) => BigInt.asIntN(64, env.viPresentedNs?.(u64(ticket)) ?? 0n),
      hle_ro_load: (image: bigint, size: number, sha: number, alone: number) => {
        if (!env.roLoad) { missing("roLoad", "nn::ro / nn::jit: a module is to be loaded at run time and the embedder has no loader for it"); return 0n; }
        return u64(env.roLoad(u64(image), size >>> 0, new Uint8Array(mem()).slice(sha >>> 0, (sha >>> 0) + 32), alone !== 0));
      },
      hle_ro_call: (token: bigint, fini: number, index: number) => {
        const key = `${u64(token)}/${fini}`;
        if (index === 0 || !calls.has(key)) calls.set(key, env.roCalls?.(u64(token), fini ? "fini" : "init") ?? []);
        const list = calls.get(key)!;
        if (index < list.length) return u64(list[index]);
        calls.delete(key); return 0n;
      },
      hle_ro_activate: (token: bigint) => env.roActivate?.(u64(token)),
      hle_ro_unload: (token: bigint) => env.roUnload?.(u64(token)),
      hle_ro_lookup_in: (token: bigint, name: number) => u64(env.roLookupIn?.(u64(token), str(name)) ?? 0n),
      hle_jit_memory: (rxSize: bigint, roSize: bigint, out: number) => {
        const r = env.jitMemory?.(u64(rxSize), u64(roSize));
        if (!r) { missing("jitMemory", "nn::jit: code memory is asked for and the embedder gives none"); return 1; }
        const dv = new DataView(mem()); dv.setBigUint64(out >>> 0, u64(r.rx), true); dv.setBigUint64((out >>> 0) + 8, u64(r.ro), true);
        return 0;
      },
      hle_jit_code_written: (rx: bigint, off: bigint, size: bigint) => env.jitCodeWritten?.(u64(rx), u64(off), u64(size)),
      hle_jit_free: (rx: bigint, rxSize: bigint, ro: bigint, roSize: bigint) => env.jitFree?.(u64(rx), u64(rxSize), u64(ro), u64(roSize)),
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
    lang?: string; nick?: string; gameEnv?: string; launchSpec?: string; launchBytes?: Uint8Array | null; displayVersion?: string; kbd?: string | null;
    // controllers and the display (nxnative's DM_MOTION, DM_MOTION_AXES "x,-z,y", DM_MOTION_ACC_SIGN=-1, DM_MOTION_GAIN, DM_MOTION_LOG,
    // DM_PHONE_MOTION auto / 0 / 1; scripted input instead of DM_KEYS / DM_CTL; the display's pixels; a Switch 2 SDK)
    motion?: boolean; motionAxes?: string | null; motionAccNegative?: boolean; motionGain?: number; motionLog?: boolean; consoleMotion?: "auto" | boolean;
    inputScripted?: boolean; display?: { w: number; h: number }; sdkOunce?: boolean }): void {
    const x = this.x, n = (k: number, v: bigint | number | boolean | undefined) => { if (v !== undefined) x.hle_cfg(k, BigInt(typeof v === "boolean" ? (v ? 1 : 0) : v)); };
    n(CFG.opmode, o.opmode); n(CFG.perfBoost, o.perfBoost); n(CFG.fixedTime, o.fixedTime); n(CFG.prevProgram, o.prevProgram); n(CFG.sdkMajor, o.sdkMajor);
    n(CFG.fontDecode, o.fontDecodeImported); n(CFG.sharedFontTtf, o.sharedFontTtf); n(CFG.allocBigAlign, o.allocBigAlign); n(CFG.detEntropy, o.deterministicEntropy);
    n(CFG.sfTrace, o.sfTrace); n(CFG.programIndex, o.programIndex); n(CFG.hasPrograms, o.hasPrograms);
    if (o.motion !== undefined) n(CFG.motionOff, !o.motion);
    n(CFG.motionAccNeg, o.motionAccNegative); n(CFG.motionLog, o.motionLog); n(CFG.inputScripted, o.inputScripted); n(CFG.sdkOunce, o.sdkOunce);
    if (o.motionGain !== undefined) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, o.motionGain, true); x.hle_cfg(CFG.motionGain, b.getBigInt64(0, true)); }
    if (o.consoleMotion !== undefined) n(CFG.phoneMotion, o.consoleMotion === "auto" ? -1 : o.consoleMotion ? 1 : 0);
    if (o.display) { n(CFG.displayW, o.display.w); n(CFG.displayH, o.display.h); }
    const s = (k: number, v: string | Uint8Array | null | undefined) => {
      if (v === undefined) return;
      if (v === null) { x.hle_cfg_str(k, 0, -1); return; }
      const b = typeof v === "string" ? enc.encode(v) : v;
      x.hle_cfg_str(k, this.scratch(b), b.length);
    };
    s(STR.lang, o.lang); s(STR.nick, o.nick); s(STR.gameEnv, o.gameEnv); s(STR.launchSpec, o.launchSpec); s(STR.launchBytes, o.launchBytes);
    s(STR.displayVersion, o.displayVersion); s(STR.kbd, o.kbd); s(STR.motionAxes, o.motionAxes);
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

  // ---- controllers, the screen, vibration ----
  // A player's whole input. player 0..7, or -1: the snapshot's sourceId takes a player slot (a source that reconnects
  // gets its player back) or, with connected: false, frees it. Returns the player, -1 when there is none.
  // Call it whenever a source changed and at least once per frame while motion or touches are live
  input(player: number, snap: InputSnapshot): number {
    const b = new Uint8Array(SNAP_SIZE), dv = new DataView(b.buffer);
    const v3 = (o: number, v: V3) => { for (let i = 0; i < 3; i++) dv.setFloat32(o + 4 * i, v[i] ?? 0, true); };
    let f = snap.connected === false ? 0 : IN.connected;
    dv.setUint32(4, (snap.sourceId ?? 0) >>> 0, true);
    dv.setBigUint64(8, (u64(snap.buttons ?? 0) & ~BTN.SHAKE) | (snap.shake ? BTN.SHAKE : 0n), true);
    [snap.lx, snap.ly, snap.rx, snap.ry].forEach((v, i) => dv.setInt32(0x10 + 4 * i, Math.max(-STICK_MAX, Math.min(STICK_MAX, Math.round(v ?? 0))), true));
    if (snap.motion) { f |= IN.motion; v3(0x20, snap.motion.acc); v3(0x2C, snap.motion.rot); }
    if (snap.rawMotion) { f |= IN.raw; v3(0x38, snap.rawMotion.acc); v3(0x44, snap.rawMotion.rot); dv.setBigUint64(0x50, u64(snap.rawMotion.sampleNs), true); }
    if (snap.consoleMotion) { f |= IN.console; v3(0x58, snap.consoleMotion.acc); v3(0x64, snap.consoleMotion.rot); }
    if (snap.clearMotion) f |= IN.clrMotion;
    if (snap.clearRawMotion) f |= IN.clrRaw;
    [snap.joyLeft, snap.joyRight].forEach((j, side) => {
      if (!j) return;
      const o = 0x70 + 0x30 * side;
      f |= IN.joyL << side;
      dv.setBigUint64(o, u64(j.buttons ?? 0), true); dv.setInt32(o + 8, Math.round(j.stick?.[0] ?? 0), true); dv.setInt32(o + 12, Math.round(j.stick?.[1] ?? 0), true);
      if (j.motion) { f |= IN.jmotionL << side; v3(o + 0x10, j.motion.acc); v3(o + 0x1C, j.motion.rot); dv.setBigUint64(o + 0x28, u64(j.motion.sampleNs), true); }
      if (j.clearMotion) f |= IN.clrJmotionL << side;
      if (j.mouse) { f |= IN.mouseL << side; const q = 0xD0 + 12 * side; dv.setInt32(q, j.mouse.dx, true); dv.setInt32(q + 4, j.mouse.dy, true); dv.setUint32(q + 8, (j.mouse.connected === false ? 0 : 1) | (j.mouse.onSurface ? 2 : 0), true); }
    });
    if (snap.joyCon2) f |= IN.joy2;
    if (snap.touches) {
      f |= IN.touch;
      const n = Math.min(16, snap.touches.length); dv.setUint32(0xE8, n, true);
      for (let i = 0; i < n; i++) { const t = snap.touches[i], o = 0xF0 + 12 * i; dv.setUint32(o, t.id >>> 0, true); dv.setFloat32(o + 4, t.x, true); dv.setFloat32(o + 8, t.y, true); }
    }
    if (snap.rumble) f |= IN.rumble;
    dv.setUint32(0, f, true);
    return this.x.hle_input(player, this.scratch(b));
  }
  // What an applet in front of the game reads: every player ORed, each stick axis the most deflected one, and the
  // presses since the last peek
  inputPeek(): { buttons: number; axes: [number, number, number, number] } {
    const p = this.x.hle_scratch() >>> 0; this.x.hle_input_peek(p);
    const dv = new DataView(this.memory.buffer);
    return { buttons: Number(dv.getBigUint64(p, true)), axes: [dv.getInt32(p + 8, true), dv.getInt32(p + 12, true), dv.getInt32(p + 16, true), dv.getInt32(p + 20, true)] };
  }
  // Hold the game's input for a reason, or give it back; the game reads nothing while any reason holds
  hold(reason: keyof typeof HOLD, on: boolean): void { this.x.hle_hold(HOLD[reason], on ? 1 : 0); }
  get holds(): (keyof typeof HOLD)[] { const m = this.x.hle_hold_state(); return (Object.keys(HOLD) as (keyof typeof HOLD)[]).filter(k => (m >> HOLD[k]) & 1); }
  // The controller prompt's answer: true = enough players joined and OK, false = the player closed it. false: no prompt was waiting
  ctrlAnswer(ok: boolean): boolean { return this.x.hle_ctrl_answer(ok ? 1 : 0) !== 0; }
  // The player slots of the input sources, for an embedder that assigns players itself (input(-1, ...) does it too)
  padSlot(op: "of" | "take" | "takeLowest" | "free", sourceId: number): number { return this.x.hle_pad_slot(op === "of" ? 0 : op === "take" ? 1 : op === "takeLowest" ? 2 : 3, sourceId >>> 0); }
  get padSlotMask(): number { return this.x.hle_pad_slot(4, 0) >>> 0; }
  get playersReported(): number { return this.x.hle_players_reported(); }
  playerNpad(player: number): number { return this.x.hle_player_npad(player) >>> 0; }
  // Vibration: output = HleEnv.vibration plays it; enabled = the player's rumble switch
  haptics(o: { output: boolean; enabled?: boolean }): void { this.x.hle_haptics_init(o.output ? 1 : 0, o.enabled === false ? 0 : 1); }
  hapticsEnable(on: boolean): void { this.x.hle_haptics_enable(on ? 1 : 0); }
  hapticsRoute(player: number, on: boolean): void { this.x.hle_haptics_route(player, on ? 1 : 0); }
  hapticsSuspend(reason: "inactive" | "interrupted", on: boolean): void { this.x.hle_haptics_suspend(reason === "inactive" ? 1 : 2, on ? 1 : 0); }

  // ---- nn::vi, nn::ro ----
  // At each present the game queues, with the frame count that present makes (ListFrameHistory)
  viFrameQueued(frame: bigint): void { this.x.hle_vi_frame_queued(frame); }
  get viLayer(): { w: number; h: number } | null { const v = this.x.hle_vi_layer_size() >>> 0; return v ? { w: v & 0xFFFF, h: v >>> 16 } : null; }
  get viCrop(): { x: number; y: number; w: number; h: number } | null {
    const v = u64(this.x.hle_vi_layer_crop());
    return v ? { x: Number(v & 0xFFFFn), y: Number((v >> 16n) & 0xFFFFn), w: Number((v >> 32n) & 0xFFFFn), h: Number(v >> 48n) } : null;
  }
  // An NRO that must never be loaded (an online SDK), by the SHA-256 of its image
  roRefuse(sha256: Uint8Array): void { if (sha256.length !== 32) throw new Error("hle: a SHA-256 is 32 bytes"); this.x.hle_ro_refuse(this.scratch(sha256)); }
}
