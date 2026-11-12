// nxem: the owner realm. nxweb's file system (and, next, its graphics recorder) are AssemblyScript modules whose
// state lives in their instance's wasm globals, so each exists once. Here they live in the realm of the Emscripten
// module's main thread (node's main thread, the page), which stays in its event loop (PROXY_TO_PTHREAD) and can
// therefore also do what is asynchronous (opening the game container, storage, later WebGPU). Guest threads are
// pthreads: a host call that belongs to one of these modules is proxied here synchronously (kernel/nx_owner.js,
// Emscripten's `__proxy: 'sync'`) with the calling thread's context block, in arrival order.
// nxweb's own files are used as they are: src/glue/fs_host.ts (FsHost), the .nup reader and the RomFS device of
// src/prepare/host, fs_dev_node.ts for the saves under Node.
import { FsHost, FS_RETRY, fsIsPending, fsToken, type FsStorage } from "../../src/glue/fs_host.ts";
import { range } from "../../src/glue/rt_layout.ts";
import { sharedBuild } from "../../src/glue/wasm_shared.ts";
import type { PrepTree } from "../../src/prepare/host/tree.ts";
import { DirRomDevice, PrepStorage, treeSource } from "../../src/prepare/host/romdev.ts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { RtGfx } from "../../src/glue/rt_gfx.ts";
import { nvn2Items, sdkVersionIn } from "../../src/glue/rt_runtime.ts";
import { STUBS } from "../../src/glue/rt_layout.ts";
import { VCODEC, type VideoBackend, type VideoPicture, type VideoSink } from "../../src/glue/video_host.ts";

export const KIND_FS = 1, KIND_HOST = 2, KIND_VIDEO = 3;   // 3: the AV1 decoder of kernel/nx_video.c   // nxweb's fs module; a host function nxweb's glue registers (RtGfx: nvnBootstrapLoader, every NVN entry point, nv::)
export const DONE = 0, PENDING = 1, RETRY = 2;
const LOW_BASE = 0x1C000000, LOW_END = 0x1FF00000;   // host allocations that must be below 4 GB (test/p4_boot.c stages the module files below this, up to 0x1C00_0000)
const CELL = 0x3F0;   // in the caller's context block (0x400 bytes, the CPU state ends at 0x330): the word a pending call's completion sets

// What the platform (owner_node.ts, owner_web.ts) gives the owner
export interface OwnerConfig {
  tree: PrepTree;                       // the game: a .nup container as a folder (src/prepare/host/nup.ts NupTree)
  prep: PrepWasm;                       // nxweb's prepare module: RomFS tables, SHA-256
  fsModule: WebAssembly.Module;         // fs64.wasm and gfx64.wasm, rewritten for the shared memory (wasm_shared.ts) and compiled
  gfxModule: WebAssembly.Module;
  saves: FsStorage;
  programId: bigint;
  scratch: number;                      // 8 KB of the memory nothing else uses
  malloc: (n: number) => number;
  modules: () => { name: string; base: number; imageSize: number; ro: { addr: number; size: number } }[];   // the loaded code modules (kernel/nx_proc.c), once main() has loaded them
  log: (line: string) => void;
  video?: (sink: VideoSink) => VideoBackend;   // the browser's video decoder (src/glue/video_webcodecs.ts); omitted: no pictures
  nativeImage?: (handle: number) => { mem: number; size: number; w: number; h: number; stride: number } | null;   // nn::codec's picture of a native image handle (hle_codec_video.c)
  gfx?: Record<string, unknown>;        // RtGfx options: device, canvas, nextFrame, requestDevice (the page); omitted: the null replayer
}

// The game's RomFS out of the container without unpacking it: the tables are built once from the listing
// (src/prepare/romfs_build.ts, as the prepare step's Index stage does), a read is a read of the container.
export async function romStorage(c: OwnerConfig): Promise<{ storage: FsStorage; files: number; bytes: number; root: string; ms: number; exefs: string }> {
  const t0 = performance.now();
  const tree = c.tree, l = await tree.list();
  const ver = (r: string) => r.startsWith("updates/") ? Number(r.split("/")[1]) : 0;
  const pick = (kind: string) => [...new Set(l.dirs.filter(d => new RegExp("^(base|updates/\\d+)/" + kind + "$").test(d)).map(d => d + "/"))].sort((a, b) => ver(b) - ver(a))[0];
  const root = pick("romfs");   // an update's romfs is the whole patched tree (src/prepare/host/detect.ts)
  if (!root) throw new Error("owner: no romfs/ in " + tree.name);
  const cut = root.length, files = l.files.filter(f => f.path.startsWith(root));
  const entries = [...l.dirs.filter(d => d.startsWith(root) && d.length > cut).map(d => ({ path: d.slice(cut), size: 0, dir: true })), ...files.map(f => ({ path: f.path.slice(cut), size: f.size }))];
  const r = c.prep.romTables(entries as any);
  if ("error" in r) throw new Error("owner: RomFS tables: " + r.error);
  const sizes = Float64Array.from(files, f => f.size);
  const dev = new DirRomDevice({ tables: r.tables, starts: r.starts, sizes, size: r.size }, treeSource(tree, files.map(f => f.path)));
  return { storage: new PrepStorage(dev, new Map(), c.saves), files: files.length, bytes: sizes.reduce((a, b) => a + b, 0), root, ms: performance.now() - t0, exefs: pick("exefs") ?? "" };
}

type Fn = (cpu: any) => any;
interface Wait { __wait: true; done: Promise<unknown> | null; at: bigint | undefined; resume: (cpu: any, timedOut: boolean) => any; deadline: bigint | undefined }
const ARGS = 0x340;   // in the context block: x0..x7 then d0..d7, the argument block nxweb's handlers take (HostCpu.args)
const nowNs = () => BigInt(Math.round(performance.now() * 1e6));

// What nxweb's RtGfx uses of its Runtime, over the Emscripten memory. The kernel, the scheduler and guest execution are
// not here: a wait (HostCpu.waitFor) keeps the calling pthread blocked in its proxy until the owner completes it.
class RtShim {
  memory: WebAssembly.Memory; mem64 = true; memImports: Record<string, unknown>; opts = { clock: "wall" }; disposed = false;
  r: any; k = { kernel_host_time_of: () => 0xFFFF_FFFF_FFFF_FFFFn };
  handlers: Fn[] = [() => 0]; byName = new Map<string, number>(); late = new Map<number, number>(); private nextLate = STUBS.cap - 1;
  private c: OwnerConfig; private own: Owner; private sdk: any = undefined; private major = -1; private ounce: boolean | null = null;
  constructor(memory: WebAssembly.Memory, memImports: Record<string, unknown>, c: OwnerConfig, own: Owner) {
    this.memory = memory; this.memImports = memImports; this.c = c; this.own = own;
    this.r = { rt_static_check: () => 0, rt_scratch_ptr: () => c.scratch };
  }
  log(l: string): void { this.c.log(l); }
  u8(): Uint8Array { return new Uint8Array(this.memory.buffer); }
  dv(): DataView { return new DataView(this.memory.buffer); }
  hostAlloc(n: number): number { return this.own.lowAlloc(n) || this.c.malloc(n); }
  register(d: { name: string; forced?: boolean; fn: Fn }): void { this.byName.set(d.name, this.handlers.push(d.fn) - 1); }
  // A host function handed out by address at run time (an NVN entry point): a stub from the top of the loader's stub region
  lateStub(name: string, fn: Fn): number {
    const id = this.nextLate--, h = this.handlers.push(fn) - 1;
    this.late.set(id, h); this.own.lateNames.set(id, name);
    return STUBS.base + 4 * id;
  }
  requestWake(): void {}
  onDispose(): void {}
  nowNs(): bigint { return nowNs(); }
  guestNs(): bigint { return nowNs(); }
  sha256Of(parts: Uint8Array[]): Uint8Array {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
    const hex = this.c.prep.sha256(all), out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
    return out;
  }
  // A guest function the recorder or the glue wants run. Only host stubs can be served here (the owner runs no guest code)
  guestCall(fn: bigint, args: (bigint | number)[]): bigint {
    const id = (Number(fn) - STUBS.base) / 4, h = this.late.get(id);
    if (h === undefined) throw new Error(`owner: a callback into guest code at 0x${fn.toString(16)} from the owner realm (not a host stub): not supported yet`);
    return this.own.nested(h, args);
  }
  get sdkModule(): any { if (this.sdk === undefined) this.sdk = this.c.modules().find(m => m.name === "sdk") ?? null; return this.sdk ?? undefined; }
  get sdkMajor(): number {
    if (this.major < 0) { this.major = 0; for (const m of this.c.modules()) { const v = sdkVersionIn(this.u8().subarray(m.ro.addr, m.ro.addr + m.ro.size)); if (v) { this.major = v.major; this.log(`sdk: NintendoSDK nnSdk-${v.text} (major ${v.major}), from ${m.name}`); break; } } }
    return this.major;
  }
  get sdkOunce(): boolean {
    if (this.ounce === null) {
      const m = this.sdkModule, pat = [..."spec: Ounce"].map(ch => ch.charCodeAt(0)); this.ounce = false;
      if (m) { const ro = this.u8().subarray(m.ro.addr, m.base + m.imageSize); for (let i = ro.indexOf(pat[0]); i >= 0 && !this.ounce; i = ro.indexOf(pat[0], i + 1)) this.ounce = pat.every((ch, k) => ro[i + k] === ch); }
      if (this.ounce) this.log("sdk: built for the Switch 2 (spec: Ounce)");
    }
    return this.ounce;
  }
}
void nvn2Items;

export class Owner {
  readonly fs: FsHost;
  gfx: RtGfx | null = null;
  rt!: RtShim;
  lateNames = new Map<number, string>();
  presents = 0; firstPresentMs = 0; hostStream = { calls: 0, bytes: 0 }; hostNs = 0; hostCalls = 0; hostPending = 0;
  private memory: WebAssembly.Memory;
  private fsIds = new Map<string, number>();
  private fsNames = new Map<number, string>(); private shown = new Map<number, number>();
  private waiting = new Map<number, number>();   // fs token -> the context block of the thread that waits
  private log: (line: string) => void;
  private cfg!: OwnerConfig;
  private low = LOW_BASE;
  stats = { fsCalls: 0, fsPending: 0, fsRetry: 0, fsNs: 0 };

  constructor(memory: WebAssembly.Memory, storage: FsStorage, c: OwnerConfig) {
    this.memory = memory; this.log = c.log; this.cfg = c;
    const pages = memory.buffer.byteLength / 65536;
    this.fs = new FsHost(c.fsModule, storage, {
      memory, memEnv: { memory_size: () => pages, memory_grow: (n: number) => n ? -1 : pages }, log: l => c.log(l),
      saveFailed: e => c.log(`[RED] fs: a save could not be written (error ${e})`),
      // more arena has to lie below 4 GB (fs_host.ts): a bump range between the staged files and the process's address space, never freed
      arenaMore: n => { const a = this.low; if (a + n > LOW_END) { c.log(`[RED] owner: no room below 4 GB for ${n} more bytes of fs arena`); return 0; } this.low = Math.ceil((a + n) / 0x1000) * 0x1000; c.log(`fs: the arena grows by ${(n / 1048576).toFixed(1)} MB at 0x${a.toString(16)}`); return a; },
      completed: (token, result) => {
        const ctx = this.waiting.get(token);
        if (ctx === undefined) return;
        this.waiting.delete(token);
        new DataView(memory.buffer).setBigUint64(ctx, BigInt.asUintN(64, result), true);
        const cell = new Int32Array(memory.buffer, ctx + CELL, 1);
        Atomics.store(cell, 0, 1); Atomics.notify(cell, 0);
      },
    });
    const x = this.fs.x, arena = range("fs arena");
    x.fs_init(arena.lo, arena.hi - arena.lo);
    x.fs_set_program_id(c.programId);
    const enc = new TextEncoder();
    for (const n of this.fs.names()) {   // every name is looked up as a loader would: the module learns from it what the game imports (src/glue/rt_fs.ts)
      new Uint8Array(memory.buffer, c.scratch + 0x1000, 4096).set(enc.encode(n.name + "\0"));
      if (x.fs_lookup(c.scratch + 0x1000) !== n.id) throw new Error(`owner: fs_lookup(${n.name}) does not give ${n.id}`);
      this.fsIds.set(n.name, n.id); this.fsNames.set(n.id, n.name);
    }
    x.fs_set_account_save(-1);
  }
  lowAlloc(n: number): number { const a = this.low; if (a + n > LOW_END) return 0; this.low = Math.ceil((a + n) / 0x1000) * 0x1000; return a; }
  // nxweb's NVN recorder (gfx64.wasm) and its glue (src/glue/rt_gfx.ts), with the null replayer: the host stream is
  // counted, and a present is the first-frame mark. `device` / `canvas` make it the real replayer (the page).
  startGfx(c: OwnerConfig, pages: number): void {
    const o: any = c.gfx ?? {};
    const rt = this.rt = new RtShim(this.memory, { memory_size: () => pages, memory_grow: (n: number) => n ? -1 : pages }, c, this);
    const t0 = performance.now();
    this.gfx = new RtGfx(rt as any, c.gfxModule, { unpaced: !o.device, shaderWait: false, ...o, onPresent: (n: number) => { this.presents = n; if (n === 1) { this.firstPresentMs = performance.now() - t0; this.log(`gfx: FIRST PRESENT (nvnQueuePresentTexture reached the host stream), ${(this.firstPresentMs / 1000).toFixed(1)} s after the recorder started`); } } });
    if (c.nativeImage) this.gfx.nativeImageOf = c.nativeImage;
    const host: any = this.gfx.host, account = host.account.bind(host), exec = host.exec.bind(host);
    host.account = (p: number, n: number) => { this.hostStream.calls++; this.hostStream.bytes += n; return account(p, n); };
    host.exec = (p: number, n: number) => { this.hostStream.calls++; this.hostStream.bytes += n; return exec(p, n); };
    this.log(`owner: nxweb's NVN recorder is up (${this.gfx.x.nvn_count()} entry points, ${o.device ? "WebGPU replayer" : "null replayer: the host stream is counted"}); it answers ${rt.byName.size} names and hands out the rest by address`);
  }
  names(): string[] { return [...this.fsIds.keys(), ...(this.rt ? this.rt.byName.keys() : [])]; }
  // ---- video: one request of mav1_* (kernel/nx_video.c). A decode waits for the completion of its packet number.
  private videoBack: VideoBackend | null = null; private videoWait = new Map<string, number>(); videoStats = { packets: 0, pictures: 0 };
  private videoCall(ctx: number): number {
    const dv = new DataView(this.memory.buffer), n = (i: number) => Number(dv.getBigUint64(ctx + 8 * i, true));
    const op = n(0), dec = n(1), set0 = (v: number) => new DataView(this.memory.buffer).setBigUint64(ctx, BigInt(v), true);
    if (!this.videoBack) {
      if (!this.cfg.video) { if (op === 1) this.log("[RED] nn::codec: no video decoder in this environment: movies give no pictures"); set0(0); return DONE; }
      this.videoBack = this.cfg.video({ log: l => this.log(l), picture: (d, _gen, seq, pic) => this.videoDone(d, seq, pic) });
    }
    const b = this.videoBack;
    if (op === 1) { const name = b.open(dec, VCODEC.AV1, 0, 0); if (!name) this.log("[RED] nn::codec: the browser has no AV1 decoder (WebCodecs)"); set0(name ? 1 : 0); return DONE; }
    if (op === 3) { b.reset(dec, 0); for (const [k, c] of [...this.videoWait]) if (k.startsWith(dec + ":")) { this.videoWait.delete(k); new DataView(this.memory.buffer).setBigUint64(c, 0n, true); this.wake(c); } set0(0); return DONE; }
    if (op === 4) { b.close(dec); set0(0); return DONE; }
    const seq = dv.getBigUint64(ctx + 48, true);
    this.videoStats.packets++;
    new Int32Array(this.memory.buffer, ctx + CELL, 1)[0] = 0;
    this.videoWait.set(dec + ":" + seq, ctx);
    const r = b.decode(dec, 0, seq, new Uint8Array(this.memory.buffer, n(2), n(3)), false);
    if (r === 1) return PENDING;
    this.videoWait.delete(dec + ":" + seq); set0(0);
    return DONE;
  }
  private videoDone(dec: number, seq: bigint, pic: VideoPicture | null): void {
    const ctx = this.videoWait.get(dec + ":" + seq);
    if (ctx === undefined) return;
    this.videoWait.delete(dec + ":" + seq);
    const dv = new DataView(this.memory.buffer), u8 = new Uint8Array(this.memory.buffer), buf = Number(dv.getBigUint64(ctx + 32, true)), cap = Number(dv.getBigUint64(ctx + 40, true));
    let ok = 0;
    if (pic && pic.w * pic.h * 3 / 2 <= cap) {
      const { w, h } = pic, cw = (w + 1) >> 1, ch = (h + 1) >> 1;
      for (let y = 0; y < h; y++) u8.set(pic.y.subarray(y * pic.yStride, y * pic.yStride + w), buf + y * w);
      for (let y = 0; y < ch && y < h >> 1; y++) { const o = buf + w * h + y * w, pu = y * pic.uvStride; for (let x = 0; x < cw && 2 * x + 1 < w; x++) { u8[o + 2 * x] = pic.u[pu + x]; u8[o + 2 * x + 1] = pic.v[pu + x]; } }
      dv.setBigUint64(ctx + 8, BigInt(w), true); dv.setBigUint64(ctx + 16, BigInt(h), true); dv.setBigUint64(ctx + 24, BigInt(pic.matrix), true); dv.setBigUint64(ctx + 32, BigInt(pic.fullRange ? 1 : 0), true);
      ok = 1; if (!this.videoStats.pictures++) this.log(`[codec] first AV1 picture ${w}x${h} handed to the game`);
    } else if (pic) this.log(`[RED] nn::codec: a ${pic.w}x${pic.h} picture does not fit the buffer`);
    dv.setBigUint64(ctx, BigInt(ok), true);
    this.wake(ctx);
  }
  // The code of a stub the loader did not make (handed out by the owner: an NVN entry point), 0 = not one
  lookupStub(id: number): number { const h = this.rt?.late.get(id); return h === undefined ? 0 : KIND_HOST << 24 | h; }
  stubName(id: number): string { return this.lateNames.get(id) ?? ""; }
  // nxweb's HostCpu over a context block. One object serves every call that finishes at once (its block is set per
  // call); a call that waits gets an object of its own. The views are made once: the memory never grows.
  private u64!: BigUint64Array; private u32!: Uint32Array; private u8v!: Uint8Array; private dvv!: DataView; private fast: any = null;
  private views(): void { const b = this.memory.buffer; this.u64 = new BigUint64Array(b); this.u32 = new Uint32Array(b); this.u8v = new Uint8Array(b); this.dvv = new DataView(b); }
  private cpu(ctx: number): any {
    if (!this.u64) this.views();
    const rt = this.rt, u64 = this.u64, u32 = this.u32, u8 = this.u8v, dvv = this.dvv, own = this;
    const cpu: any = {
      rt, thread: 0, threadIndex: 0, q: ctx / 8,
      get lr() { return u64[this.q + 30]; },
      x(i: number) { return u64[this.q + i]; }, w(i: number) { return u32[(this.q + i) * 2]; },
      setX(i: number, v: bigint | number) { u64[this.q + i] = BigInt.asUintN(64, BigInt(v)); },
      sp() { return u64[this.q + 31]; }, u8: () => u8, dv: () => dvv,
      read: (a: number | bigint, n: number) => u8.slice(Number(a), Number(a) + n),
      write: (a: number | bigint, b: Uint8Array) => { u8.set(b, Number(a)); },
      cstr: (a: number | bigint, max = 256) => { const p = Number(a); let e = p; while (e < p + max && u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); },
      log: (l: string) => own.log(l),
      setD(i: number, bits: bigint) { u64[this.q + 38 + 2 * i] = bits; u64[this.q + 39 + 2 * i] = 0n; },
      now: () => nowNs(),
      // x0..x7 then d0..d7 (the low halves of v0..v7), contiguous, in the block's spare room
      args() { const q = this.q; u64.copyWithin(q + ARGS / 8, q, q + 8); for (let i = 0; i < 8; i++) u64[q + ARGS / 8 + 8 + i] = u64[q + 38 + 2 * i]; return q * 8 + ARGS; },
      argsX() { const q = this.q; u64.copyWithin(q + ARGS / 8, q, q + 8); return q * 8 + ARGS; },
      stackArg(i: number) { return u64[Number(u64[this.q + 31]) / 8 + i]; },
      waitFor: (done: Promise<unknown> | null, at: bigint | undefined, resume: any, deadline?: bigint): Wait => ({ __wait: true, done, at, resume, deadline }),
      jump: () => { throw new Error("owner: HostCpu.jump is not supported in the owner realm"); },
      never: () => { throw new Error("owner: HostCpu.never is not supported in the owner realm"); },
      block: () => { throw new Error("owner: HostCpu.block (a kernel wait from a host function) is not supported in the owner realm"); },
      call: (fn: bigint | number, ...a: (bigint | number)[]) => rt.guestCall(BigInt(fn), a),
    };
    return cpu;
  }
  private store(ctx: number, r: any): void { if (typeof r === "bigint") this.u64[ctx / 8] = BigInt.asUintN(64, r); else if (typeof r === "number") this.u64[ctx / 8] = BigInt.asUintN(64, BigInt(r)); }
  private wake(ctx: number): void { const cell = new Int32Array(this.memory.buffer, ctx + CELL, 1); Atomics.store(cell, 0, 1); Atomics.notify(cell, 0); }
  // A wait a handler returned: the calling thread stays blocked until `done` has settled and time `at` has come (or the
  // deadline passed), then resume runs here and its result is the call's
  private arm(ctx: number, cpu: any, w: Wait): void {
    let over = false;
    const go = (timedOut: boolean) => {
      if (over) return; over = true;
      let r: any;
      try { r = w.resume(cpu, timedOut); } catch (e) { this.log(`[RED] owner: a host function failed after its wait: ${(e as Error).message}`); r = 0; }
      if (r && r.__wait) this.arm(ctx, cpu, r); else { this.store(ctx, r); this.wake(ctx); }
    };
    const timed = () => { const ms = w.at === undefined ? 0 : Number(w.at - nowNs()) / 1e6; if (ms > 0.05) setTimeout(() => go(false), ms); else go(false); };
    if (w.done) w.done.then(timed, timed); else timed();
    if (w.deadline !== undefined) setTimeout(() => go(true), Math.max(0, Number(w.deadline - nowNs()) / 1e6));
  }
  private hostCall(h: number, ctx: number): number {
    this.hostCalls++;
    const cpu = this.fast ?? (this.fast = this.cpu(ctx)); cpu.q = ctx / 8;
    const r = this.rt.handlers[h](cpu);
    if (r && r.__wait) { this.hostPending++; new Int32Array(this.memory.buffer, ctx + CELL, 1)[0] = 0; this.arm(ctx, this.cpu(ctx), r); return PENDING; }
    this.store(ctx, r);
    return DONE;
  }
  // A host function called from inside the owner (RtGfx's native-image helpers call NVN entry points): on a scratch block
  private nestCtx = 0;
  nested(h: number, args: (bigint | number)[]): bigint {
    if (!this.nestCtx) this.nestCtx = this.lowAlloc(0x1000);
    const dv = new DataView(this.memory.buffer), ctx = this.nestCtx;
    new Uint8Array(this.memory.buffer, ctx, 0x400).fill(0);
    args.forEach((a, i) => dv.setBigUint64(ctx + 8 * i, BigInt.asUintN(64, BigInt(a)), true));
    const r = this.rt.handlers[h](this.cpu(ctx));
    if (r && r.__wait) throw new Error("owner: a nested host call wanted to wait");
    this.store(ctx, r);
    return new DataView(this.memory.buffer).getBigUint64(ctx, true);
  }
  // The code of the host function `name`: kind << 24 | id, 0 when no module here answers it
  lookup(name: string): number { const id = this.fsIds.get(name); if (id) return KIND_FS << 24 | id; const h = this.rt?.byName.get(name); return h ? KIND_HOST << 24 | h : 0; }
  // One host call on the context block of the calling guest thread (x0..x7 at its start). DONE: x0 holds the result.
  // PENDING: the thread waits on the block's cell. RETRY: the same call again after a moment, registers as they were.
  call(code: number, ctx: number): number {
    const t0 = performance.now();
    try {
      if (code >>> 24 === KIND_HOST) { const h0 = performance.now(); try { return this.hostCall(code & 0xFFFFFF, ctx); } finally { this.hostNs += (performance.now() - h0) * 1e6; } }
      if (code >>> 24 === KIND_VIDEO) return this.videoCall(ctx);
      if (code >>> 24 === 4) { const dv = new DataView(this.memory.buffer); (this.gfx as any)?.x.gfx_note_flush?.(dv.getBigUint64(ctx, true), dv.getBigUint64(ctx + 8, true)); return DONE; }   // host code wrote guest memory
      if (code >>> 24 !== KIND_FS) throw new Error("owner: no module of kind " + (code >>> 24));
      this.stats.fsCalls++;
      const id = code & 0xFFFFFF, dv = new DataView(this.memory.buffer), shown = this.shown.get(id) ?? 0, name = shown < 6 ? this.fsNames.get(id) ?? "" : "";
      const a1 = Number(dv.getBigUint64(ctx + 8, true)), a3 = Number(dv.getBigUint64(ctx + 24, true)), a4 = Number(dv.getBigUint64(ctx + 32, true)), a0 = Number(dv.getBigUint64(ctx, true));
      const r: bigint = this.fs.x.fs_call(id, ctx);
      if (name && /OpenFile|ReadFile|MountRom/.test(name)) {   // the first calls, for the log: that real data comes back
        this.shown.set(id, shown + 1);
        const u8 = new Uint8Array(this.memory.buffer), str = (p: number) => { let e = p; while (u8[e] && e < p + 200) e++; return new TextDecoder().decode(u8.slice(p, e)); };
        if (/OpenFile/.test(name)) this.log(`fs: OpenFile("${str(a1)}") = 0x${BigInt.asUintN(64, r).toString(16)}`);
        else if (/ReadFile/.test(name)) this.log(`fs: ReadFile(${a4} bytes) = 0x${BigInt.asUintN(64, r).toString(16)}, read ${a0 ? Number(new DataView(this.memory.buffer).getBigUint64(a0, true)) : "?"}; begins ${[...u8.slice(a3, a3 + 16)].map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
        else this.log(`fs: ${name}("${str(a0)}") = 0x${BigInt.asUintN(64, r).toString(16)}`);
      }
      if (r === FS_RETRY) { this.stats.fsRetry++; return RETRY; }
      if (fsIsPending(r)) { this.stats.fsPending++; new Int32Array(this.memory.buffer, ctx + CELL, 1)[0] = 0; this.waiting.set(fsToken(r), ctx); return PENDING; }
      new DataView(this.memory.buffer).setBigUint64(ctx, BigInt.asUintN(64, r), true);
      return DONE;
    } catch (e) {
      this.log(`[RED] owner: host call ${code >>> 24}/${code & 0xFFFFFF} failed: ${(e as Error).stack ?? e}`);
      new DataView(this.memory.buffer).setBigUint64(ctx, 0n, true);
      return DONE;
    } finally { if (code >>> 24 === KIND_FS) this.stats.fsNs += (performance.now() - t0) * 1e6; }
  }
}

export async function startOwner(memory: WebAssembly.Memory, c: OwnerConfig): Promise<{ owner: Owner; exefs: string }> {
  const rom = await romStorage(c);
  c.log(`owner: RomFS ${rom.root} of ${c.tree.name}: ${rom.files} files, ${(rom.bytes / 1073741824).toFixed(2)} GB, tables built in ${rom.ms.toFixed(0)} ms`);
  const o = new Owner(memory, rom.storage, c);
  c.log(`owner: nxweb's fs module answers ${o.names().length} nn::fs names`);
  o.startGfx(c, memory.buffer.byteLength / 65536);
  return { owner: o, exefs: rom.exefs };
}
export { sharedBuild };
