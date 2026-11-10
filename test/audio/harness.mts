// The audio tests' harness: fresh instances of build/audio/audio.wasm (its own memory is the guest memory), a
// scripted guest (each helper puts arguments in guest memory, makes the audio_call and reads the results back),
// the two clocks as plain numbers, kernel events as a table, and a fake device the test drives by hand: it sets
// the device's state and plays the worklet's part on the ring header (take frames, count a callback).
import { execFileSync } from "node:child_process";
import { buildPair } from "../../tools/asc64/abi.mjs";
import { makeMemory64, MEM64_MAX_PAGES } from "../../src/glue/a64_host.ts";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { KIT_DIR } from "../../src/kit/host/defs.mts";
import { readMachines, type WasmMachine } from "../../src/kit/host/reader.mts";
import { AudioHost, RING, DEV, OUT_S, BUF_S, RET, REQ, REN_S, REN_THREAD_S, OPUS_PENDING, type AudioEmbedder, type OpusBackend, type CallResult } from "../../src/glue/audio_host.ts";

export { RING, DEV, OUT_S, BUF_S, RET, REQ, REN_S, REN_THREAD_S, OPUS_PENDING };
export const ROOT = join(KIT_DIR, "..", "..");
// NX_MEM (tools/modes.mjs): "32" (default) audio.wasm, whose own memory is the guest memory; "64" audio64.wasm on a
// 64-bit memory made here; "64hi" the same with the scripted guest's memory and the arena (host-allocated in the
// runtime: pages of the code region) above 4 GB.
export const MEM_MODE = process.env.NX_MEM ?? "32";
export const M64 = MEM_MODE !== "32";
export const HI = MEM_MODE === "64hi" ? 0x1_8000_0000 : 0;
export const WASM = join(ROOT, "build", "audio", M64 ? "audio64.wasm" : "audio.wasm");
export const NXNATIVE = process.env.NXNATIVE ?? "/home/user/nxnative";
export const MACHINES = ["audio_buf", "audio_out", "opus_req", "audio_ren", "audio_ren_thread", "audio_render", "audio_ren_update"];

export function build(): void {
  mkdirSync(dirname(WASM), { recursive: true });
  buildPair("src/audio/index.ts", join("build", "audio", "audio.wasm"), ["--runtime", "stub", "-O2"], { args64: ["--runtime", "stub", "-O2", "--importMemory"] });
}

// Fn ids by nxnative's identifier (h_<x>), from src/audio/names.ts
const namesSrc = readFileSync(join(ROOT, "src", "audio", "names.ts"), "utf8");
export const FN: Record<string, number> = Object.fromEntries([...namesSrc.matchAll(/^\s+(\w+) = (\d+),$/gm)].map(m => [m[1], Number(m[2])]));
export const MANGLED: string[] = [...namesSrc.matchAll(/^\s+"(_Z\w+)",$/gm)].map(m => m[1]);

export const R = { OK: 0n, FAIL: 0x2A2n, BUSY: 0x3a6fn, TWICE: 0x499n };
export const MS = 1_000_000n;

export interface Event { token: number; ptr: number; autoClear: boolean; signals: number; flag: boolean; released: boolean }
export interface AuOptions { cover?: boolean; guest?: number; arena?: number; threadEntry?: bigint; sdk?: Record<string, (x: BigUint64Array, au: Au) => bigint | number>; opus?: OpusBackend }

let module: WebAssembly.Module | undefined;
const live: Au[] = [];
let sum: Uint8Array[] | undefined;

export class Au {
  host: AudioHost;
  x: AudioHost["x"];
  logs: string[] = [];
  events: Event[] = [];
  devStarts = 0; devStops = 0;
  g = 0n;          // guest clock, ns
  h = 1_000_000_000n;   // host clock, ns (an arbitrary origin)
  sdkCalls: string[] = [];
  private top: number; private limit: number;
  private sdkAddr = new Map<string, bigint>(); private sdkName = new Map<bigint, string>();

  constructor(o: AuOptions = {}) {
    module ??= new WebAssembly.Module(readFileSync(WASM));
    const embedder: AudioEmbedder = {
      log: l => { this.logs.push(l); if (process.env.AUDIO_TEST_LOG) console.log("    | " + l); },
      eventBind: (ptr, autoClear) => { const e = { token: this.events.length + 1, ptr, autoClear, signals: 0, flag: false, released: false }; this.events.push(e); return e.token; },
      eventSignal: t => { const e = this.events[t - 1]; if (!e || e.released) throw new Error(`signal of event token ${t}, which is not bound`); e.signals++; e.flag = true; },
      eventRelease: t => { this.events[t - 1].released = true; },
      device: { start: () => { this.devStarts++; }, stop: () => { this.devStops++; } },
      opus: o.opus,
    };
    if (o.sdk) {
      const sdk = o.sdk;
      embedder.guestFn = name => {
        if (!(name in sdk)) return 0n;
        if (!this.sdkAddr.has(name)) { const a = 0x7100_0000n + BigInt(this.sdkAddr.size) * 0x100n; this.sdkAddr.set(name, a); this.sdkName.set(a, name); }
        return this.sdkAddr.get(name)!;
      };
      embedder.threadEntry = () => o.threadEntry ?? 0x7200_0000n;
      embedder.handleDup = h => h ? h + 0x1000 : 0;
      embedder.guestCall = (fn, x) => { const name = this.sdkName.get(fn); if (!name) throw new Error(`guest call of ${fn.toString(16)}`); this.sdkCalls.push(name); return BigInt.asUintN(64, BigInt(sdk[name](x, this))); };
    }
    const mem = M64 ? makeMemory64({ initial: 16, maximum: MEM64_MAX_PAGES }) : null;
    this.host = mem ? new AudioHost(module, embedder, mem.memory, mem.imports()) : new AudioHost(module, embedder);
    this.x = this.host.x;
    const guest = o.guest ?? (8 << 20), arena = o.arena ?? (16 << 20);
    const end = HI + Math.ceil(this.x.audio_static_end() / 0x10000) * 0x10000;
    const have = this.x.memory.buffer.byteLength;
    if (end + guest + arena > have) { const n = Math.ceil((end + guest + arena - have) / 65536); if (mem) mem.grow(n); else this.x.memory.grow(n); }
    this.top = end; this.limit = end + guest;
    this.x.audio_init(end + guest, arena);
    if (o.cover !== false) { this.x.kit_cover_enable(1); live.push(this); }
    this.x.audio_tick(this.g, this.h);
  }
  get red(): string[] { return this.logs.filter(l => l.startsWith("[RED] ")); }
  // The fake SDK's functions: a function's name by its address, and a function put at an address of guest memory
  // (where the test wrote its first instructions: the module reads the SDK's code)
  sdkNameOf(addr: bigint): string | undefined { return this.sdkName.get(addr); }
  sdkPlace(name: string, addr: number): void { const old = this.sdkAddr.get(name); if (old !== undefined) this.sdkName.delete(old); this.sdkAddr.set(name, BigInt(addr)); this.sdkName.set(BigInt(addr), name); }
  get dv(): DataView { return new DataView(this.x.memory.buffer); }
  get u8(): Uint8Array { return new Uint8Array(this.x.memory.buffer); }

  // ---- guest memory ----
  alloc(n: number): number {
    const p = this.top; this.top += (n + 15) & ~15;
    if (this.top > this.limit) throw new Error("the test's guest memory is used up");
    this.u8.fill(0, p, p + n);
    return p;
  }
  cstr(s: string): number { const p = this.alloc(s.length + 1); this.u8.set(Buffer.from(s, "latin1"), p); return p; }
  str(p: number, max = 256): string { const u = this.u8; let e = p; while (e < p + max && u[e]) e++; return Buffer.from(u.subarray(p, e)).toString("latin1"); }

  // ---- time ----
  // Both clocks move together by default (a guest that runs in real time)
  tick(dtNs: bigint | number = 0n, host: bigint | number | undefined = undefined): void {
    this.g += BigInt(dtNs); this.h += BigInt(host ?? dtNs);
    this.x.audio_tick(this.g, this.h);
  }
  ms(n: number, stepMs = 1): void { for (let i = 0; i < n; i += stepMs) this.tick(BigInt(Math.round(Math.min(stepMs, n - i) * 1e6))); }
  // Run the guest clock to the silent sinks' next release, as an embedder with a deterministic clock does
  toDeadline(): boolean {
    const t = this.host.nextDeadline();
    if (t === 0xFFFF_FFFF_FFFF_FFFFn) return false;
    if (t > this.g) this.tick(t - this.g); else this.tick(0n);
    return true;
  }

  // ---- calls ----
  call(name: string, x: (bigint | number)[] = [], o: Parameters<AudioHost["call"]>[2] = {}): CallResult {
    const id = FN[name];
    if (!id) throw new Error(`no function ${name}`);
    this.x.audio_tick(this.g, this.h);
    return this.host.call(id, x, o);
  }
  c(name: string, ...x: (bigint | number)[]): bigint { return this.call(name, x).x0; }

  // ---- AudioOut helpers ----
  param(ch = 0, rate = 0): number { const p = this.alloc(16); this.c("au_InitParam", p); this.dv.setInt32(p, rate, true); this.dv.setUint16(p + 4, ch, true); return p; }
  // An AudioOut object opened with (true) or without a release event; returns its address
  open(ch = 2, withEvent = true): number {
    const g = this.alloc(64), ev = withEvent ? this.alloc(64) : 0, n = this.events.length;
    const r = withEvent ? this.c("au_Open", g, ev, this.cstr("DeviceOut"), this.param(ch)) : this.c("au_Open4", g, this.cstr("DeviceOut"), this.param(ch));
    if (r !== 0n) throw new Error(`OpenAudioOut failed ${r.toString(16)}`);
    if (withEvent) { if (this.events.length !== n + 1 || this.events[n].ptr !== ev || !this.events[n].autoClear) throw new Error("the release event was not bound"); this.evOf.set(g, this.events[n]); }
    else if (this.events.length !== n) throw new Error("an event was bound for an output that polls");
    return g;
  }
  evOf = new Map<number, Event>();
  ev(g: number): Event { return this.evOf.get(g)!; }
  slotOf(g: number): number { for (let i = 0; i < this.x.audio_out_max(); i++) if (this.x.audio_out_state(i) >= 0 && Number(this.x.audio_out_stat(i, 13)) === g) return i; return -1; }
  state(g: number): string { const s = this.slotOf(g); return s < 0 ? "closed" : OUT_S[this.x.audio_out_state(s)]; }
  stat(g: number, which: number): number { return Number(this.x.audio_out_stat(this.slotOf(g), which)); }
  // A guest AudioOutBuffer with its PCM; returns the AudioOutBuffer's address
  buf(pcm: Int16Array | number): number {
    const n = typeof pcm === "number" ? pcm : pcm.length * 2;
    const data = this.alloc(n || 16), b = this.alloc(64);
    if (typeof pcm !== "number") new Int16Array(this.x.memory.buffer, data, pcm.length).set(pcm);
    this.c("au_SetBuf", b, data, n, n);
    return b;
  }
  append(g: number, b: number): boolean { return this.c("au_Append", g, b) === 1n; }
  released(g: number): number { return Number(this.c("au_Released", g)); }
  drain(g: number): number[] { const r: number[] = []; for (let b = this.released(g); b; b = this.released(g)) r.push(b); return r; }

  // ---- the fake device ----
  attach(rate = 48000, target = 0): void { this.x.audio_device_attach(rate, target); }
  dev(state: number): void { this.x.audio_device_state(state); }
  get ring(): Int32Array { return this.host.ringHeader(); }
  // The worklet's callback: take up to `frames` frames from the ring (silence for what it lacks) and count a callback
  callback(frames = 128): Float32Array {
    const h = this.ring, d = this.host.ringData(), cap = h[RING.CAP], out = new Float32Array(frames * 2);
    const avail = (h[RING.WR] - h[RING.RD]) >>> 0, k = Math.min(avail, frames);
    for (let i = 0; i < k; i++) { const p = ((h[RING.RD] + i) >>> 0) & (cap - 1); out[2 * i] = d[2 * p]; out[2 * i + 1] = d[2 * p + 1]; }
    if (k < frames && h[RING.LIVE] > 0) h[RING.UNDER] += frames - k;
    h[RING.RD] = (h[RING.RD] + k) | 0; h[RING.CB]++;
    return out;
  }
  // A device that runs for ms milliseconds in real time: every quantum (128 frames by default) one tick and one callback
  play(ms: number, rate = 48000, quantum = 128): Float32Array {
    const chunks: Float32Array[] = [];
    const q = BigInt(Math.round(quantum * 1e9 / rate));
    for (let t = 0n; t < BigInt(ms) * MS; t += q) { this.tick(q); chunks.push(this.callback(quantum)); }
    const all = new Float32Array(chunks.length * quantum * 2);
    chunks.forEach((c, i) => all.set(c, i * quantum * 2));
    return all;
  }
  // Start an output and bring it to Live on a running device
  goLive(g: number): void {
    if (this.c("au_Start", g) !== 0n) throw new Error("StartAudioOut failed");
    this.dev(DEV.RUNNING);
    this.tick(MS); this.callback(); this.tick(MS);
    if (this.state(g) !== "Live") throw new Error(`the output is ${this.state(g)}, not Live`);
  }
}

// ---- signals ----
export function sine(freq: number, frames: number, ch = 2, amp = 0.5, start = 0, rate = 48000): Int16Array {
  const a = new Int16Array(frames * ch);
  for (let i = 0; i < frames; i++) { const v = Math.round(amp * 32767 * Math.sin(2 * Math.PI * freq * (start + i) / rate)); for (let c = 0; c < ch; c++) a[i * ch + c] = v; }
  return a;
}
// Least-squares fit of a sine of known frequency to x (one channel): amplitude, and the signal-to-residual ratio in dB
export function fit(x: ArrayLike<number>, freq: number, rate: number): { amp: number; snr: number } {
  let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0, xx = 0;
  const w = 2 * Math.PI * freq / rate;
  for (let i = 0; i < x.length; i++) { const s = Math.sin(w * i), c = Math.cos(w * i); ss += s * s; cc += c * c; sc += s * c; xs += x[i] * s; xc += x[i] * c; xx += x[i] * x[i]; }
  const det = ss * cc - sc * sc, a = (xs * cc - xc * sc) / det, b = (xc * ss - xs * sc) / det;
  const sig = a * a * ss + b * b * cc + 2 * a * b * sc, res = Math.max(xx - sig, 1e-30);
  return { amp: Math.hypot(a, b), snr: 10 * Math.log10(sig / res) };
}
export const channel = (inter: Float32Array, c: number): Float32Array => { const o = new Float32Array(inter.length / 2); for (let i = 0; i < o.length; i++) o[i] = inter[2 * i + c]; return o; };
// A small deterministic generator for the property tests
export function rng(seed: number): () => number { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x1_0000_0000; }; }

// ---- tests and coverage ----
export const tests: { name: string; fn: () => void | Promise<void> }[] = [];
export function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }

// Fold the hit bitmaps of every instance made since the last call into the sum, and let the instances go
export function harvest(): void {
  for (const a of live) {
    const ms = readMachines(a.x);
    sum ??= ms.map(m => new Uint8Array(m.table.length));
    ms.forEach((m, i) => m.hits.forEach((v, c) => { if (v) sum![i][c] = 1; }));
  }
  live.length = 0;
}
// The audio machines as the module has them, with the hits the module's own steps made
export function coverage(): { machines: WasmMachine[]; hits: Uint8Array[] } {
  harvest();
  const all = readMachines(new Au({ cover: false }).x);
  const pick = all.map((m, i) => ({ m, i })).filter(e => MACHINES.includes(e.m.name));
  return { machines: pick.map(e => e.m), hits: pick.map(e => sum ? sum[e.i] : new Uint8Array(e.m.table.length)) };
}

// ---- an event-driven guest: keeps `inflight` buffers of `frames` frames appended, refills when the release event
// fires (or, without an event, whenever it is asked), and checks that buffers come back once each, in order.
// Its PCM numbers the frames of the stream from 1: left = the low 15 bits, right = the next 15.
export class Feeder {
  next = 1;                 // the stream's next frame number
  queue: number[] = [];     // appended and not yet taken back, oldest first
  free: number[] = [];
  appended = 0; reclaimed = 0; wakes = 0;
  a: Au; g: number; frames: number; inflight: number; ch: number;
  constructor(a: Au, g: number, frames = 240, inflight = 4, ch = 2) {
    this.a = a; this.g = g; this.frames = frames; this.inflight = inflight; this.ch = ch;
    for (let i = 0; i < inflight + 2; i++) this.free.push(a.buf(frames * 2 * ch));
  }
  private fill(b: number): void {
    const data = Number(this.a.dv.getBigUint64(b, true)), pcm = new Int16Array(this.a.x.memory.buffer, data, this.frames * this.ch);
    for (let i = 0; i < this.frames; i++) { const n = this.next++; pcm[i * this.ch] = n & 0x7FFF; if (this.ch > 1) pcm[i * this.ch + 1] = (n >> 15) & 0x7FFF; }
  }
  refill(): void {
    for (let b = this.a.released(this.g); b; b = this.a.released(this.g)) {
      if (b !== this.queue[0]) throw new Error(`buffer ${b} came back, ${this.queue[0]} was the oldest`);
      this.queue.shift(); this.free.push(b); this.reclaimed++;
    }
    while (this.queue.length < this.inflight && this.free.length) {
      const b = this.free.pop()!; this.fill(b);
      if (!this.a.append(this.g, b)) throw new Error("append refused");
      this.queue.push(b); this.appended++;
    }
  }
  // What a guest audio thread does when it runs: only if its event fired
  step(): void {
    const ev = this.a.evOf.get(this.g);
    if (ev) { if (!ev.flag) return; ev.flag = false; this.wakes++; }
    this.refill();
  }
}
// The frame numbers in what a device played (stereo f32 of a Feeder's stream at 48 kHz): 0 for silence
export function frameNumbers(dev: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < dev.length; i += 2) out.push(Math.round(dev[i] * 32768) + Math.round(dev[i + 1] * 32768) * 32768);
  return out;
}
