// The audio module (build/audio/audio.wasm, src/audio) and its embedder: instantiation, the imports, a guest call's
// argument block, the two clocks. No browser and no Node APIs: the device is audio_device.ts, the tests bring a
// fake one. See src/audio/README.md.
import type { KitExports } from "../kit/host/reader.mts";

export interface AudioExports extends KitExports {
  audio_init(arenaBase: number, arenaLen: number): void;
  audio_static_end(): number;
  audio_scratch(): number;
  audio_lookup(namePtr: number): number;
  audio_call(fnId: number, argsPtr: number): number;
  audio_tick(guestNs: bigint, hostNs: bigint): void;
  audio_next_deadline(): bigint;
  audio_set_catchup_limit(ns: bigint): void;
  audio_device_attach(rate: number, targetFrames: number): void;
  audio_device_state(state: number): void;
  audio_ring_ptr(): number; audio_ring_data(): number; audio_ring_cap(): number;
  audio_suspend(on: number): void;
  audio_rs_open(): number; audio_rs_close(i: number): void;
  audio_rs_event(i: number): number; audio_rs_cq_event(i: number): number;
  audio_rs_ready(i: number): number; audio_rs_next(i: number): number;
  audio_rs_capture(i: number, dest: number, mix: number, samples: number, rate: number, idx: number, nIn: number, idxSize: number): number;
  audio_rs_count_render(i: number): void; audio_rs_rendered(i: number): void;
  audio_rs_update_begin(i: number, waited: number): number; audio_rs_update_end(i: number): void;
  audio_rs_stat(i: number, which: number): bigint; audio_rs_out(i: number): number;
  audio_opus_backend(b: number): void;
  audio_opus_out(req: number): number;
  audio_opus_complete(req: number, samples: number): void;
  audio_opus_stat(mgr: number, which: number): number;
  audio_fn_count(): number; audio_fn_name(id: number): number; audio_fn_name_len(id: number): number; audio_fn_is_stub(id: number): number;
  audio_red_total(): number; audio_arena_used(): number; audio_arena_size(): number;
  audio_out_max(): number; audio_out_machine(): number; audio_out_state(i: number): number; audio_out_stat(i: number, which: number): bigint;
  audio_buf_state(i: number, slot: number): number;
  audio_mixed_frames(): bigint;
  audio_resample(src: number, n: number, dst: number, outRate: number): number;
}

// The device as the module's imports see it (audio_device.ts in a browser; nothing under Node)
export interface AudioDeviceLike { start(): void; stop(): void }
// A decoder the embedder brings for the Opus decoder manager (audio_opus_webcodecs.ts)
export interface OpusBackend {
  open(dec: number, rate: number, channels: number): number;                                  // 0, or a Result
  // packet: the Opus packet without Nintendo's header (a view of linear memory: copy it before returning).
  // >= 1: samples per channel written as interleaved PCM16 at outPtr; OPUS_PENDING: audio_opus_out / audio_opus_complete follow
  decode(dec: number, req: number, packet: Uint8Array, outPtr: number, outCap: number): number;
  reset(dec: number): void;
  close(dec: number): void;
}
export const OPUS_PENDING = -1;

export interface AudioEmbedder {
  log(line: string): void;
  // Bind the guest's nn::os::SystemEvent at this address to a kernel event (0: a bare kernel event of the host's
  // own) and return a token, 0 for a failure. nxnative: hle_bind_system_event.
  eventBind(systemEvent: number, autoClear: boolean): number;
  // kernel_event_signal on the event behind the token. Must not block and must not call back into the module.
  eventSignal(token: number): void;
  eventRelease?(token: number): void;
  // The game's own SDK: the address of a function by mangled name (the module's own code even where the name is
  // taken over), and a call of it with x0..x7 that returns x0. Without them every SDK-backed call fails with a red line.
  guestFn?(name: string): bigint;
  guestCall?(fn: bigint, x: BigUint64Array): bigint;
  device?: AudioDeviceLike;
  opus?: OpusBackend;
}

export const RET = { VOID: 0, X0: 1, X0X1: 3, V0: 4 };
export const DEV = { NONE: 0, STARTING: 1, RUNNING: 2, FAILED: 3, LOST: 4 };
export const OUT_S = ["Stopped", "SilentStarting", "Live", "SilentRetry", "Suspended"];
export const BUF_S = ["Reclaimed", "Appended", "Playing", "Released"];
// Ring header words (src/audio/dev.ts)
export const RING = { WR: 0, RD: 1, CAP: 2, UNDER: 3, CB: 4, LIVE: 5, RATE: 6, TARGET: 7 };

export interface CallResult { kind: number; x0: bigint; x1: bigint; f: number }

export class AudioHost {
  x: AudioExports;
  embedder: AudioEmbedder;
  private scratch = 0;

  // memory: the process's linear memory when the module was built with --importMemory; else the module's own is used
  constructor(module: WebAssembly.Module, embedder: AudioEmbedder, memory?: WebAssembly.Memory) {
    this.embedder = embedder;
    const dec = new TextDecoder();
    const bytes = (p: number, n: number) => new Uint8Array(this.x.memory.buffer, p >>> 0, n);
    const env: Record<string, unknown> = {
      abort: () => { throw new Error("audio: abort"); },
      log: (p: number, n: number) => embedder.log(dec.decode(bytes(p, n).slice())),
      audio_event_bind: (ev: number, auto: number) => embedder.eventBind(ev >>> 0, auto !== 0),
      audio_event_signal: (t: number) => embedder.eventSignal(t >>> 0),
      audio_event_release: (t: number) => embedder.eventRelease?.(t >>> 0),
      audio_dev_start: () => this.embedder.device?.start(),
      audio_dev_stop: () => this.embedder.device?.stop(),
      audio_guest_fn: (p: number, n: number) => embedder.guestFn?.(dec.decode(bytes(p, n).slice())) ?? 0n,
      audio_guest_call: (fn: bigint, a: number) => embedder.guestCall?.(BigInt.asUintN(64, fn), new BigUint64Array(this.x.memory.buffer.slice(a >>> 0, (a >>> 0) + 64))) ?? 0n,
      audio_opus_open: (d: number, rate: number, ch: number) => this.embedder.opus ? this.embedder.opus.open(d, rate, ch) : 0x3a6f,
      audio_opus_decode: (d: number, req: number, p: number, n: number, out: number, cap: number) => this.embedder.opus ? this.embedder.opus.decode(d, req >>> 0, bytes(p, n), out >>> 0, cap) : -2,
      audio_opus_reset: (d: number) => this.embedder.opus?.reset(d),
      audio_opus_close: (d: number) => this.embedder.opus?.close(d),
    };
    if (memory) env.memory = memory;
    const inst = new WebAssembly.Instance(module, { env } as WebAssembly.Imports);
    this.x = inst.exports as unknown as AudioExports;
    if (memory && !this.x.memory) (this.x as { memory: WebAssembly.Memory }).memory = memory;
    this.scratch = this.x.audio_scratch() >>> 0;
  }
  get dv(): DataView { return new DataView(this.x.memory.buffer); }

  lookup(name: string): number {
    const u8 = new Uint8Array(this.x.memory.buffer, this.scratch + 256, 768);
    if (name.length > 766) return 0;
    for (let i = 0; i < name.length; i++) u8[i] = name.charCodeAt(i);
    u8[name.length] = 0;
    return this.x.audio_lookup(this.scratch + 256);
  }
  fnName(id: number): string {
    const p = this.x.audio_fn_name(id) >>> 0, n = this.x.audio_fn_name_len(id);
    return String.fromCharCode(...new Uint16Array(this.x.memory.buffer.slice(p, p + 2 * n)));
  }
  // The guest's stub was called: x = x0..x7 (and x8 when the function returns a struct in memory), v = the low 64
  // bits of v0..v7. A runtime that has the registers in linear memory builds the block itself and uses x.audio_call.
  call(fnId: number, x: (bigint | number)[] = [], o: { v?: bigint[]; x8?: bigint | number; lr?: bigint | number; f0?: number } = {}): CallResult {
    const dv = this.dv, a = this.scratch;
    for (let i = 0; i < 8; i++) dv.setBigUint64(a + 8 * i, BigInt.asUintN(64, BigInt(x[i] ?? 0)), true);
    for (let i = 0; i < 8; i++) dv.setBigUint64(a + 64 + 8 * i, BigInt.asUintN(64, o.v?.[i] ?? 0n), true);
    if (o.f0 !== undefined) dv.setFloat32(a + 64, o.f0, true);
    dv.setBigUint64(a + 128, BigInt.asUintN(64, BigInt(o.x8 ?? 0)), true);
    dv.setBigUint64(a + 136, BigInt.asUintN(64, BigInt(o.lr ?? 0)), true);
    const kind = this.x.audio_call(fnId, a), d = this.dv;
    return { kind, x0: kind & 1 ? d.getBigUint64(a, true) : 0n, x1: kind === RET.X0X1 ? d.getBigUint64(a + 8, true) : 0n, f: kind === RET.V0 ? d.getFloat32(a + 64, true) : 0 };
  }
  tick(guestNs: bigint, hostNs: bigint): void { this.x.audio_tick(guestNs, hostNs); }
  nextDeadline(): bigint { return BigInt.asUintN(64, this.x.audio_next_deadline()); }

  // The states output #id entered, oldest first, as far as the kit's trace ring still holds them
  outTrace(id: number): string[] {
    const x = this.x, dv = this.dv, total = x.kit_trace_total() >>> 0, cap = x.kit_trace_cap(), rec = x.kit_trace_rec(), base = x.kit_trace_ptr() >>> 0, m = x.audio_out_machine();
    const r: string[] = [];
    for (let n = Math.max(0, total - cap); n < total; n++) {
      const p = base + (n % cap) * rec;
      if (dv.getUint16(p + 8, true) === m && dv.getUint32(p + 4, true) === id && !(dv.getUint8(p + 13) & 1)) r.push(OUT_S[dv.getUint8(p + 11)]);
    }
    return r;
  }
  // The ring header as an Int32Array over the module's memory (8 words) and its frames
  ringHeader(): Int32Array { return new Int32Array(this.x.memory.buffer, this.x.audio_ring_ptr() >>> 0, 8); }
  ringData(): Float32Array { return new Float32Array(this.x.memory.buffer, this.x.audio_ring_data() >>> 0, this.x.audio_ring_cap() * 2); }
  outs(): { slot: number; id: number; state: string; pending: number; released: number }[] {
    const r = [];
    for (let i = 0; i < this.x.audio_out_max(); i++) {
      const s = this.x.audio_out_state(i);
      if (s >= 0) r.push({ slot: i, id: Number(this.x.audio_out_stat(i, 0)), state: OUT_S[s], pending: Number(this.x.audio_out_stat(i, 1)), released: Number(this.x.audio_out_stat(i, 2)) });
    }
    return r;
  }
}
