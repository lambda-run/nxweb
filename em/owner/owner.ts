// nxem: the owner realm. nxweb's file system (and, next, its graphics recorder) are AssemblyScript modules whose
// state lives in their instance's wasm globals, so each exists once. Here they live in the realm of the Emscripten
// module's main thread (node's main thread, the page), which stays in its event loop (PROXY_TO_PTHREAD) and can
// therefore also do what is asynchronous (opening the game container, storage, later WebGPU). Guest threads are
// pthreads: a host call that belongs to one of these modules is proxied here synchronously (kernel/nx_owner.js,
// Emscripten's `__proxy: 'sync'`) with the calling thread's context block, in arrival order.
// nxweb's own files are used as they are: src/glue/fs_host.ts (FsHost), the .nup reader and the RomFS device of
// src/prepare/host, fs_dev_node.ts for the saves under Node.
import { FsHost, FS_RETRY, DEV, fsIsPending, fsToken, type FsStorage } from "../../src/glue/fs_host.ts";
import { range } from "../../src/glue/rt_layout.ts";
import { sharedBuild } from "../../src/glue/wasm_shared.ts";
import type { PrepTree } from "../../src/prepare/host/tree.ts";
import { PrepStorage } from "../../src/prepare/host/romdev.ts";
import { romDevice } from "./rom.ts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { RtGfx } from "../../src/glue/rt_gfx.ts";
import { nvn2Items, sdkVersionIn } from "../../src/glue/rt_runtime.ts";
import { STUBS } from "../../src/glue/rt_layout.ts";
// @ts-ignore (a plain module, also a command-line tool)
import { globalsToMemory } from "../tools/globals_to_memory.mjs";
// @ts-ignore
import { lockFreeTable } from "../tools/gfx_audit.mjs";
// @ts-ignore
import { dynamicAudit, auditLine } from "../tools/gfx_dynaudit.mjs";
import { instantiate } from "../../src/glue/wasm_abi.ts";
import { VCODEC, type VideoBackend, type VideoPicture, type VideoSink } from "../../src/glue/video_host.ts";

export const KIND_FS = 1, KIND_HOST = 2, KIND_VIDEO = 3;   // 3: the AV1 decoder of kernel/nx_video.c   // nxweb's fs module; a host function nxweb's glue registers (RtGfx: nvnBootstrapLoader, every NVN entry point, nv::)
export const DONE = 0, PENDING = 1, RETRY = 2;
const LOW_BASE = 0x1C000000, LOW_END = 0x1FF00000;   // host allocations that must be below 4 GB (test/p4_boot.c stages the module files below this, up to 0x1C00_0000)
// The recorder shared with the guest threads (tools/globals_to_memory.mjs): its globals are in the memory at GFX_GLOBALS,
// the build for the other threads' instances at GFX_MOD, and at NXG the words both sides use (kernel/nx_gfx.c):
//   +0 the recorder's lock (0 free, 1 the owner, else a thread)   +4 threads waiting for it   +8 the holder's request to
//   the owner: 0 none, 1 asked, 2 answered   +12 its kind (0 gfx_exec, 1 gfx_proc_address, 2 gfx_arena_more)
//   +16 +24 f64 arguments   +32 f64 result   +40 bytes at GFX_MOD   +44 1: guest threads call the recorder themselves
//   +48 bytes of static scratch every instance has for itself (0: none; kernel/nx_guest.js sets the instance's nx_tls)
// The fs module shared the same way: its globals at FS_GLOBALS, the build for the other threads at FS_MOD, its words at NXF:
//   +0 lock   +4 waiters   +8 the holder's request (0, 1 asked, 2 answered)   +12 its kind (0 dev_open, 1 dev_size, 2 dev_read,
//   3 dev_write, 4 dev_flush, 5 dev_remove, 6 save_failed, 7 arena_more)   +16 i64 result   +24 bytes at FS_MOD
//   +28 1: guest threads call the module themselves   +32 six i64 arguments   +80 i64 the caller's context block
export const NXW = 0x1FF1F200;   // the fs worker's words (fs_worker.ts)
export const NXF = 0x1FF1F100, FS_GLOBALS = 0x1FF18000, FS_MOD = 0x1FFA0000, FS_MOD_MAX = 0x20000;
export const NXG = 0x1FF1F000, GFX_GLOBALS = 0x1FF10000, GFX_MOD = 0x1FF20000, GFX_MOD_MAX = 0x80000;
const CELL = 0x3F0;   // in the caller's context block (0x400 bytes, the CPU state ends at 0x330): the word a pending call's completion sets

// What the platform (owner_node.ts, owner_web.ts) gives the owner
export interface OwnerConfig {
  tree: PrepTree;                       // the game: a .nup container as a folder (src/prepare/host/nup.ts NupTree)
  prep: PrepWasm;                       // nxweb's prepare module: RomFS tables, SHA-256
  fsModule: WebAssembly.Module;         // fs64.wasm and gfx64.wasm, rewritten for the shared memory (wasm_shared.ts) and compiled
  gfxModule: WebAssembly.Module;
  fsShare?: { globals: { addr: number; init: Uint8Array }[]; secondary: Uint8Array; direct: boolean };    // the same for fsModule
  gfxShare?: { globals: { addr: number; init: Uint8Array }[]; secondary: Uint8Array; direct: boolean; plain?: Uint8Array; lockFree?: boolean; asyncSubmit?: boolean; streamWrites?: boolean; getters?: boolean; tls?: { base: number; span: number; consts: number } | null; lockTable?: Uint8Array; lockLine?: string; realAudit?: boolean; promote?: string[] };   // realAudit (?lfaudit=1): the first real calls of the entry points the dynamic audit left under the lock are watched; promote: the names that audit cleared (lockfree_real.ts)   // lockTable: the dynamic audit's verdict by NVN id (lockFreeAudit below); without it nothing is lock-free   // plain: the binary before the transform (the audit reads its global.set); lockFree false: every direct call under the lock   // gfxModule is the globals-in-memory build: its initial values, the build for the guest threads' instances, and whether they are to use it
  saves: FsStorage;
  programId: bigint;
  scratch: number;                      // 8 KB of the memory nothing else uses
  malloc: (n: number) => number;
  modules: () => { name: string; base: number; imageSize: number; ro: { addr: number; size: number } }[];   // the loaded code modules (kernel/nx_proc.c), once main() has loaded them
  log: (line: string) => void;
  video?: (sink: VideoSink) => VideoBackend;   // the browser's video decoder (src/glue/video_webcodecs.ts); omitted: no pictures
  nativeImage?: (handle: number) => { mem: number; size: number; w: number; h: number; stride: number } | null;   // nn::codec's picture of a native image handle (hle_codec_video.c)
  skipMovie?: boolean;                  // ?skipmovie=1, a test aid: story movies end after their first clusters (rom.ts)
  gfx?: Record<string, unknown>;        // RtGfx options: device, canvas, nextFrame, requestDevice (the page); omitted: the null replayer
}

// The game's RomFS out of the container without unpacking it: the tables are built once from the listing
// (src/prepare/romfs_build.ts, as the prepare step's Index stage does), a read is a read of the container.
export async function romStorage(c: OwnerConfig): Promise<{ storage: FsStorage; files: number; bytes: number; root: string; ms: number; exefs: string; dev: unknown }> {
  const r = await romDevice(c.tree, c.prep, { skipMovie: c.skipMovie, log: c.log });
  return { storage: new PrepStorage(r.dev, new Map(), c.saves), files: r.files, bytes: r.bytes, root: r.root, ms: r.ms, exefs: r.exefs, dev: r.dev };
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
  guestNs(): bigint { const f = (globalThis as any).NXGUESTNS; return f ? f() : nowNs(); }   // the guest's clock (kernel/nx_proc.c nx_guest_ns_d): what the game's own tick reads count on
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
  private openIds = new Set<number>(); private t00 = performance.now();   // the ids of nn::fs::OpenFile*: a movie file's opening is logged
  private waiting = new Map<number, number>();   // fs token -> the context block of the thread that waits
  private log: (line: string) => void;
  private cfg!: OwnerConfig;
  private low = LOW_BASE;
  stats = { fsCalls: 0, fsPending: 0, fsRetry: 0, fsNs: 0 };

  constructor(memory: WebAssembly.Memory, storage: FsStorage, c: OwnerConfig) {
    this.memory = memory; this.log = c.log; this.cfg = c;
    const pages = memory.buffer.byteLength / 65536, fsh = c.fsShare;
    this.fl = new Int32Array(memory.buffer, NXF, 8); this.fl64 = new BigInt64Array(memory.buffer, NXF, 11);
    if (fsh) {
      if (fsh.secondary.length > FS_MOD_MAX) throw new Error("owner: the fs module's build for the guest threads is larger than its room");
      const u8 = new Uint8Array(memory.buffer);
      for (const g of fsh.globals) { u8.fill(0, g.addr, g.addr + 16); u8.set(g.init, g.addr); }
      u8.set(fsh.secondary, FS_MOD); this.fl[6] = fsh.secondary.length;
    }
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
    { const x0: any = this.fs.x, out: any = {};   // every call into the module under its lock
      for (const k of Object.keys(x0)) { const fn = x0[k]; out[k] = typeof fn === "function" ? (...a: any[]) => { this.fsLock(); try { return fn(...a); } finally { this.fsUnlock(); } } : fn; }
      (this.fs as any).x = out; }
    const x = this.fs.x, arena = range("fs arena");
    x.fs_init(arena.lo, arena.hi - arena.lo);
    x.fs_set_program_id(c.programId);
    const enc = new TextEncoder();
    for (const n of this.fs.names()) {   // every name is looked up as a loader would: the module learns from it what the game imports (src/glue/rt_fs.ts)
      new Uint8Array(memory.buffer, c.scratch + 0x1000, 4096).set(enc.encode(n.name + "\0"));
      if (x.fs_lookup(c.scratch + 0x1000) !== n.id) throw new Error(`owner: fs_lookup(${n.name}) does not give ${n.id}`);
      this.fsIds.set(n.name, n.id); this.fsNames.set(n.id, n.name); if (/2fs8OpenFileE/.test(n.name)) this.openIds.add(n.id);
    }
    x.fs_set_account_save(-1);
    if (fsh?.direct) { Atomics.store(this.fl, 7, 1); c.log(`owner: the fs module's ${fsh.globals.length} globals are in the memory at 0x${FS_GLOBALS.toString(16)}: guest threads call it in their own instance under its lock; the owner keeps the storage (the dev_* imports) and the completions`); }
  }
  // ---- the fs module's lock and its holder's request, as the recorder's below
  private fl!: Int32Array; private fl64!: BigInt64Array; private flDepth = 0; private flHeld = false; private flLent = false;
  flStats = { served: 0, ms: 0 };
  fsLock(): void {
    if (this.flDepth++ || this.flLent) return;
    while (Atomics.compareExchange(this.fl, 0, 0, 1) !== 0) this.svc();
    this.flHeld = true;
  }
  fsUnlock(): void {
    if (--this.flDepth || !this.flHeld) return;
    this.flHeld = false;
    Atomics.store(this.fl, 0, 0); if (Atomics.load(this.fl, 1)) Atomics.notify(this.fl, 0, 1);
  }
  romDev: unknown = null;   // the RomFS device: its ids are told to the fs worker (NXW), which then reads for the guest threads
  private fsSvc(): boolean {
    const g = this.fl;
    if (!g || Atomics.load(g, 2) !== 1) return false;
    const a = this.fl64, im = this.fs.imports, N = (i: number) => Number(a[4 + i]), B = (i: number) => a[4 + i], kind = g[3], ctx = Number(a[10]), was = this.flLent, t0 = performance.now();
    let r: any = 0, tok = 0; const top = this.secIn("fs storage for a guest thread");
    this.flLent = true;
    try {
      switch (kind) {
        case 0: r = im.dev_open(N(0), B(1), tok = N(2)); break;
        case 1: r = im.dev_size(N(0)); break;
        case 2: r = im.dev_read(N(0), B(1), N(2), N(3), tok = N(4));
          if (this.romDev && (this.fs as any).devs.get(N(0)) === this.romDev) { const w = new Int32Array(this.memory.buffer, NXW, 8), n = w[2]; let have = false; for (let i = 0; i < n; i++) if (w[3 + i] === N(0)) have = true; if (!have && n < 4) { w[3 + n] = N(0); Atomics.store(w, 2, n + 1); } }
          break;
        case 3: r = im.dev_write(N(0), B(1), N(2), N(3)); break;
        case 4: r = im.dev_flush(N(0), tok = N(1)); break;
        case 5: r = im.dev_remove(N(0), B(1), tok = N(2)); break;
        case 6: im.save_failed(N(0)); break;
        case 7: r = im.arena_more(N(0)); break;
      }
      // a storage call in flight: its completion (FsHost.park -> completed) wakes the thread that made the fs call
      if (r === DEV.PENDING && (kind === 0 || kind === 2 || kind === 4 || kind === 5)) { this.stats.fsPending++; this.waiting.set(tok, ctx); }
    } catch (e) { this.log(`[RED] owner: the fs module's request ${kind} from a guest thread failed: ${(e as Error).stack ?? e}`); r = DEV.IO; }
    this.flLent = was; this.flStats.served++; this.flStats.ms += performance.now() - t0; this.secOut();
    a[2] = BigInt(r ?? 0);
    Atomics.store(g, 2, 2); Atomics.notify(g, 2);
    return true;
  }
  // the requests of the threads that hold a module's lock (they are inside the module, waiting): true when one was served
  svc(): boolean { const d = this.drainRing(), a = this.gfxSvc(), b = this.fsSvc(); return d || a || b; }
  // The batches guest threads left in the ring (kernel/nx_guest.js gfx_exec), in order. While one runs the replayer may
  // call into the recorder, which takes the lock: lock() says what happens when the holder waits for the owner then.
  private draining = false; ringStats = { batches: 0, ms: 0, borrowed: 0, keys: 0, keysBad: 0 };
  drainRing(): boolean {
    const R = (globalThis as any).NXGFXRING as number | undefined;
    if (!R || this.draining || !this.gfx) return false;
    const i32 = new Int32Array(this.memory.buffer, R, 4), u32 = new Uint32Array(this.memory.buffer);
    if (Atomics.load(i32, 0) === Atomics.load(i32, 1)) return false;
    this.draining = true; const t0 = performance.now(); let n = 0; const top = this.secIn("ring batches (replayer)");
    try {
      for (let head = Atomics.load(i32, 0); head !== Atomics.load(i32, 1); ) {
        const len = u32[(R + 16 + head) / 4];
        if (len === 0xFFFFFFFF) { head = 0; Atomics.store(i32, 0, 0); continue; }
        this.ringKeys(R + 16 + head + 8, len);
        try { this.gfx.env.gfx_exec(R + 16 + head + 8, len); } catch (e) { this.log(`[RED] owner: a batch from the ring failed: ${(e as Error).stack ?? e}`); }
        head += 8 + Math.ceil(len / 8) * 8 + u32[(R + 16 + head) / 4 + 1]; Atomics.store(i32, 0, head); n++;      // (+4: the bytes of texels the guest copied after the batch)
      }
    } finally { this.draining = false; this.secOut(); }
    this.ringStats.batches += n; this.ringStats.ms += performance.now() - t0;
    return n > 0;
  }
  // A batch from the ring runs later than it was recorded. Its records are self-contained but for H_PIPELINE_CREATE (7),
  // which carries the address of its key: that is the pipeline cache's own entry (src/gfx/pipeline.ts: written once when
  // the pipeline is first asked for, never moved, changed or freed; the replayer keeps the same address for the
  // pipeline's life). Checked here for every such record: the entry is in use and its key still has the hash stored
  // beside it when the batch runs (keysBad counts the ones that do not).
  private ringKeys(p: number, n: number): void {
    const u32 = new Uint32Array(this.memory.buffer);
    for (let q = p; q + 8 <= p + n; ) { const op = u32[q / 4], sz = u32[q / 4 + 1]; if (sz < 8) break;
      if (op === 7) { const k = u32[q / 4 + 3]; let h = 0x811c9dc5; for (let i = 0; i < 384; i += 4) { h ^= u32[(k + i) / 4]; h = Math.imul(h, 0x01000193); h ^= h >>> 15; } h = (h >>> 0) || 1;
        this.ringStats.keys++; if (u32[(k + 404) / 4] !== 1 || u32[(k + 400) / 4] !== h) { if (this.ringStats.keysBad++ < 4) this.log(`[RED] owner: a pipeline-create record from the ring points at a key record (0x${k.toString(16)}) that is not as it was recorded`); } }
      q += sz; }
  }
  // ---- the recorder's lock, owner side. The owner cannot block, so it spins, and while it does it serves the request
  // of the thread that holds the lock (that thread is inside the recorder, waiting for gfx_exec). While such a request
  // is served the recorder is the holder's: what the replayer calls of it then needs no lock (`lent`).
  private gl!: Int32Array; private glf!: Float64Array; private glDepth = 0; private glHeld = false; private lent = false;
  glStats: any = { locks: 0, spins: 0, served: 0, execMs: 0, heldMs: 0, busyRetries: 0 }; private glAt = 0; private busyTries = 0;   // heldMs: the owner's own holds of the recorder's lock (its handlers, the replayer's calls into the recorder)
  lock(): void {
    if (this.glDepth++ || this.lent) return;
    const g = this.gl; this.glStats.locks++;
    while (Atomics.compareExchange(g, 0, 0, 1) !== 0) {
      // a batch from the ring is running and the replayer wants the recorder, whose lock a guest thread holds while it
      // waits for the owner (a flush that must wait): that thread is not in the recorder's code now, so the recorder is
      // used as it is; its request is answered when the ring is empty, which keeps the stream's order
      if (this.draining && Atomics.load(g, 2) === 1) { this.ringStats.borrowed++; return; }
      this.glStats.spins++; this.svc();
    }
    this.glHeld = true; this.glAt = performance.now();
  }
  unlock(): void {
    if (--this.glDepth || !this.glHeld) return;
    this.glHeld = false; this.glStats.heldMs += performance.now() - this.glAt;
    const g = this.gl; Atomics.store(g, 0, 0); if (Atomics.load(g, 1)) Atomics.notify(g, 0, 1);
  }
  // The lock holder's request, if there is one: true when one was served
  private gfxSvc(): boolean {
    const g = this.gl;
    if (!g || this.draining || Atomics.load(g, 2) !== 1) return false;
    this.drainRing();   // what was handed over before this request comes first
    const f = this.glf, env = this.gfx!.env, was = this.lent, t0 = performance.now(); let r = 0;
    const top = this.secIn(g[3] === 0 ? "flush for a guest thread (replayer)" : "recorder import " + g[3]);
    this.lent = true;
    try {
      if (g[3] === 0) env.gfx_exec(f[2], f[3]);
      else if (g[3] === 1) r = Number(env.gfx_proc_address(f[2]));
      else if (g[3] === 2) r = Number(env.gfx_arena_more(f[2]));
    } catch (e) { this.log(`[RED] owner: the recorder's request ${g[3]} from a guest thread failed: ${(e as Error).stack ?? e}`); }
    this.lent = was; this.glStats.served++; this.glStats.execMs += performance.now() - t0; this.secOut();
    f[4] = r;
    Atomics.store(g, 2, 2); Atomics.notify(g, 2);
    return true;
  }
  // the code of a stub a guest thread may answer in its own instance of the recorder: (NVN id + 1) | abi << 16, else 0
  // bits 24, 25: without the recorder's lock (1), and only while the command buffer in x0 has room (3): tools/gfx_audit.mjs
  private lockFree: Uint8Array | null = null;
  stubDirect(id: number): number {
    const d = this.cfg.gfxShare?.direct ? this.gfx?.direct.get(STUBS.base + 4 * id) ?? 0 : 0;
    return d && this.lockFree ? d | (this.lockFree[(d & 0xFFFF) - 1] ?? 0) << 24 : d;
  }
  lowAlloc(n: number): number { const a = this.low; if (a + n > LOW_END) return 0; this.low = Math.ceil((a + n) / 0x1000) * 0x1000; return a; }
  // nxweb's NVN recorder (gfx64.wasm) and its glue (src/glue/rt_gfx.ts), with the null replayer: the host stream is
  // counted, and a present is the first-frame mark. `device` / `canvas` make it the real replayer (the page).
  startGfx(c: OwnerConfig, pages: number): void {
    const o: any = c.gfx ?? {};
    const rt = this.rt = new RtShim(this.memory, { memory_size: () => pages, memory_grow: (n: number) => n ? -1 : pages }, c, this);
    const t0 = performance.now(), sh = c.gfxShare;
    this.gl = new Int32Array(this.memory.buffer, NXG, 13); this.glf = new Float64Array(this.memory.buffer, NXG, 6);
    if (sh) {
      if (sh.secondary.length > GFX_MOD_MAX) throw new Error("owner: the recorder's build for the guest threads is larger than its room");
      const u8 = new Uint8Array(this.memory.buffer);
      for (const g of sh.globals) { u8.fill(0, g.addr, g.addr + 16); u8.set(g.init, g.addr); }
      u8.set(sh.secondary, GFX_MOD); this.gl[10] = sh.secondary.length; this.gl[12] = sh.tls?.span ?? 0;
    }
    const wrapExports = (x: any) => { const out: any = {}; for (const k of Object.keys(x)) { const fn = x[k]; out[k] = typeof fn === "function" ? (...a: any[]) => { this.lock(); try { return fn(...a); } finally { this.unlock(); } } : fn; } return out; };
    this.gfx = new RtGfx(rt as any, c.gfxModule, { unpaced: !o.device, shaderWait: false, wrapExports, ...o,   /* (o: the platform's options: the page sets profile and shaderWait, owner_web.ts) */ onPresent: (n: number) => { this.presents = n; if (n === 1) { this.firstPresentMs = performance.now() - t0; this.log(`gfx: FIRST PRESENT (nvnQueuePresentTexture reached the host stream), ${(this.firstPresentMs / 1000).toFixed(1)} s after the recorder started`); } } });
    if (c.nativeImage) this.gfx.nativeImageOf = c.nativeImage;
    const host: any = this.gfx.host, account = host.account.bind(host), exec = host.exec.bind(host);
    host.account = (p: number, n: number) => { this.drainRing(); this.hostStream.calls++; this.hostStream.bytes += n; return account(p, n); };
    host.exec = (p: number, n: number) => { this.drainRing(); this.hostStream.calls++; this.hostStream.bytes += n; const t0 = performance.now(); try { return exec(p, n); } finally { this.batchDone(p, n, performance.now() - t0); } };   // (the owner's own flushes too come after what is in the ring)
    // What a present's time on the owner is made of (report().presentSteps): the replayer's present is timed in its
    // steps from outside (the canvas's next texture, the blit, the flush with of it queue.submit, the image events
    // into the recorder); the rest of a flush is the encoder's finish and the uniform writes before it.
    { const ps = this.presentSteps, present0 = host.present.bind(host), now = () => performance.now();
      const timed = (obj: any, name: string, key: string) => { const f = obj[name]; if (typeof f !== "function") return; obj[name] = function (this: any, ...a: any[]) { if (!ps.inside) return f.apply(this, a); const t = now(); try { return f.apply(this, a); } finally { ps.cur[key] = (ps.cur[key] ?? 0) + now() - t; } }; };
      timed(host, "blit", "blit"); timed(host, "flush", "flush"); timed(host, "imageEvent", "imageEvent"); timed(host, "captureEnd", "captureEnd");
      host.present = (dv: DataView, p: number) => {
        const ctx = host.context, q = host.device?.queue;
        try { if (ctx && !ctx.__nxTimed) { timed(ctx, "getCurrentTexture", "getCurrentTexture"); ctx.__nxTimed = true; } if (q && !q.__nxTimed) { timed(q, "submit", "queueSubmit"); q.__nxTimed = true; } } catch { /* not wrappable here */ }
        ps.inside = true; ps.cur = {}; const t = now();
        try { present0(dv, p); } finally { ps.inside = false; const ms = now() - t; ps.n++; ps.ms += ms; if (ms > ps.max) ps.max = ms;
          for (const k of Object.keys(ps.cur)) { const o = ps.steps[k] ??= { ms: 0, max: 0 }; o.ms += ps.cur[k]; if (ps.cur[k] > o.max) o.max = ps.cur[k]; }
          if (ms > 8) { ps.over8++; if (ps.slow.length < 8) ps.slow.push(`${ms.toFixed(1)} ms: ` + Object.entries(ps.cur).map(([k, v]) => `${k} ${(v as number).toFixed(1)}`).join(", ")); } }
      }; }
    // Without the lock: what the static audit AND the dynamic audit both let through (lockFreeAudit below, made by the
    // platform before the module was built: the static scratch it found is per instance in this build)
    if (sh?.direct && sh.lockFree !== false) {
      try {
        const x: any = this.gfx.x;
        if (!sh.lockTable) throw new Error("no dynamic audit of this recorder build");
        if (sh.lockTable.length !== x.nvn_count()) throw new Error("the dynamic audit is of another recorder build");
        if (!x.kit_trace_enable) throw new Error("the recorder has no kit_trace_enable (its state machines' trace ring is written on every record)");
        x.kit_trace_enable(0);   // the one write to shared state on a record's fast path
        this.lockFree = sh.lockTable;
        // A recording command goes without the lock only while its buffer has 32 KB of room (kernel/nx_gfx.c), which is
        // more than any record of a fixed size. One whose record grows with a count or carries data (the plural binds
        // and sets, UpdateUniformBuffer, the constants) could need more and reach the record allocator's slow path,
        // which is shared: those stay under the lock whatever the audits say.
        { const names = this.nvnNames(), VAR = /^nvnCommandBuffer(Bind\w+s(Deferred)?|Set(Viewports|Scissors|DepthRanges)|UpdateUniformBuffer|Push\w+|\w*Multi\w+|SetProgramSubroutines|BindCoverageModulationTable)$/; let n = 0;
          for (let id = 0; id < names.length; id++) if (sh.lockTable[id] === 3 && VAR.test(names[id])) { sh.lockTable[id] = 0; n++; }
          this.varSize = VAR; if (n) this.log(`owner: ${n} recording commands whose record's size depends on a count stay under the recorder's lock (the 32 KB room check covers fixed-size records only)`); }
        // Getters that only read their arguments or an object's fields (src/gfx/dispatch.ts: one `return load<...>` each, read
        // there for this list). The static audit rejects them because they are cases of the one big dispatch function,
        // which writes globals in other cases. They were 25 % of the title's NVN calls, each under the lock, behind
        // whichever thread held it through a flush. ?lfgetters=0: under the lock as before.
        if (sh.getters !== false) { const names = this.nvnNames(), PURE = new Set(["nvnEventGetValue", "nvnDeviceGetTextureHandle", "nvnDeviceGetImageHandle", "nvnDeviceGetTexelFetchHandle", "nvnDeviceGetSeparateTextureHandle", "nvnDeviceGetSeparateSamplerHandle",
            "nvnTextureGetFlags", "nvnTextureGetTarget", "nvnTextureGetWidth", "nvnTextureGetHeight", "nvnTextureGetDepth", "nvnTextureGetLevels", "nvnTextureGetFormat", "nvnTextureGetSamples",
            "nvnMemoryPoolGetFlags", "nvnMemoryPoolGetSize", "nvnMemoryPoolMap", "nvnBufferMap", "nvnBufferGetAddress", "nvnBufferGetMemoryPool", "nvnBufferGetMemoryOffset", "nvnBufferGetSize"]); let n = 0;
          for (let id = 0; id < names.length; id++) if (!sh.lockTable[id] && PURE.has(names[id])) { sh.lockTable[id] = 1; n++; }
          this.log(`owner: ${n} getters that only read their arguments or an object's fields are answered without the recorder's lock`); }
        // the real-call audit: its candidates are what the static audit lets through and the dynamic audit did not
        if (sh.plain && (sh.realAudit || sh.promote?.length)) {
          const names = this.nvnNames(), st = lockFreeTable(sh.plain, (id: number) => names[id], names.length), tab = sh.lockTable;
          if (sh.promote?.length) { const want = new Set(sh.promote); let n = 0; for (let id = 0; id < names.length; id++) if (!tab[id] && st.table[id] && want.has(names[id]) && !(st.table[id] === 3 && this.varSize?.test(names[id]))) { tab[id] = st.table[id]; n++; }
            this.log(`owner: ${n} more entry points go without the recorder's lock: the real-call audit of this recorder build cleared them (owner/lockfree_real.ts; ?lfreal=0: under the lock)`); }
          if (sh.realAudit) {
            const N = 12, blk = c.malloc(64 + 32 * names.length), f = new Float64Array(this.memory.buffer, blk, 8), u32 = new Uint32Array(this.memory.buffer, blk + 64, 8 * names.length), stat = range("gfx static"), arena = range("gfx arena");
            new Uint8Array(this.memory.buffer, blk, 64 + 32 * names.length).fill(0);
            let sHi = stat.lo; { const a64 = new BigUint64Array(this.memory.buffer, stat.lo, (stat.hi - stat.lo) / 8); for (let i = a64.length - 1; i >= 0; i--) if (a64[i]) { sHi = stat.lo + 8 * i; break; } }
            f[0] = stat.lo; f[1] = Math.min(stat.hi, (sHi + 0x20000) & ~0xFFFF); f[2] = GFX_GLOBALS; f[3] = GFX_GLOBALS + Math.max(16, sh.globals.length * 16); f[4] = arena.lo; f[5] = Math.min(arena.hi, arena.lo + x.gfx_arena_bytes()); f[6] = names.length; f[7] = N;
            let n = 0; for (let id = 0; id < names.length; id++) if (!tab[id] && st.table[id]) { u32[8 * id] = N; n++; }
            this.lfa = { blk, names, n };
            new Float64Array(this.memory.buffer, NXG + 56, 1)[0] = blk;
            this.log(`owner: lfaudit=1: the first ${N} real calls of each of ${n} entry points (let through by the static audit, left under the lock by the dynamic one) are watched: static data 0x${f[0].toString(16)}-0x${f[1].toString(16)}, the globals block, the arena's ${((f[5] - f[4]) / 1048576).toFixed(0)} MB`);
          }
        }
        this.log(`owner: ${sh.lockLine ?? "recorder audit"}; guest threads call those without the recorder's lock${sh.tls ? `; ${sh.tls.consts} address constants of the module now go through the instance's scratch block (${sh.tls.span} bytes)` : ""}`);
      } catch (e) { this.log(`[RED] owner: recorder audit failed, every direct call stays under the lock: ${(e as Error).message}`); }
    }
    if (sh?.direct && sh.asyncSubmit && (globalThis as any).NXGFXRING) { new Int32Array(this.memory.buffer, (globalThis as any).NXGFXRING, 4)[3] = 1; this.log("owner: a guest thread's submission is handed to the replayer through a ring and does not wait for it (asyncsubmit)"); }
    if (sh?.direct && sh.streamWrites) { const x: any = this.gfx.x; if (x.gfx_stream_writes) { x.gfx_stream_writes(1); this.log("owner: UpdateUniformBuffer / CopyBufferToBuffer bytes travel in the stream and the replayer writes guest memory (stream writes; ?streamwrites=0: the recorder writes and flushes, the caller waits)"); } else this.log("owner: this recorder build has no stream writes (gfx_stream_writes): every UpdateUniformBuffer makes its thread wait for the replayer (?gfxown=1 has them)"); }
    if (sh?.direct) { Atomics.store(this.gl, 11, 1); this.log(`owner: the recorder's ${sh.globals.length} globals are in the memory at 0x${GFX_GLOBALS.toString(16)}: every guest thread calls it in its own instance under one lock; the owner keeps the replayer (gfx_exec) and the calls that wait or pace`); }
    this.log(`owner: nxweb's NVN recorder is up (${this.gfx.x.nvn_count()} entry points, ${o.device ? "WebGPU replayer" : "null replayer: the host stream is counted"}); it answers ${rt.byName.size} names and hands out the rest by address`);
  }
  // waits of a program's stages (owner_web.ts): calls that waited, waiting now, ms in all and the longest, waits that ran out; what is on its way where
  shaderWait = { waits: 0, waiting: 0, ms: 0, maxMs: 0, timeouts: 0, off: false, notWaited: 0,   /* notWaited: calls that returned because a stage went to the translator */ storeReads: 0, translating: 0, translated: 0, storeWrites: 0 };
  private varSize: RegExp | null = null;
  private lfa: { blk: number; names: string[]; n: number } | null = null; private nvnNameList: string[] | null = null;
  nvnNames(): string[] { if (!this.nvnNameList) { const x: any = this.gfx!.x, u8 = new Uint8Array(this.memory.buffer), out: string[] = []; for (let id = 0, n = x.nvn_count(); id < n; id++) { const p = Number(x.nvn_name(id)); let e = p; while (u8[e]) e++; out.push(String.fromCharCode(...u8.subarray(p, e))); } this.nvnNameList = out; } return this.nvnNameList; }
  // the real-call audit so far: per candidate that was called, its audited calls and the words they changed
  lfAudit(): any { const a = this.lfa; if (!a) return null; const u32 = new Uint32Array(this.memory.buffer, a.blk + 64, 8 * a.names.length), f = new Float64Array(this.memory.buffer, a.blk + 64, 4 * a.names.length), out: any = { candidates: a.n, called: 0, clean: [] as string[], dirty: [] as string[] };
    for (let id = 0; id < a.names.length; id++) { const q = 8 * id, calls = u32[q + 1]; if (!calls) continue; out.called++;
      if (!u32[q + 2] && !u32[q + 3] && !u32[q + 4]) out.clean.push(`${a.names[id]}:${calls}${u32[q + 5] ? "r" + u32[q + 5] : ""}`); else out.dirty.push(`${a.names[id]}:${calls} s${u32[q + 2]} g${u32[q + 3]} a${u32[q + 4]} @0x${f[4 * id + 3].toString(16)}`); }
    return out; }
  // NVN calls by entry point since the start: on the calling thread (kernel/nx_gfx.c counts by id) without or under the lock, and on the owner
  private ownerNvn = new Map<string, number>();
  nvnCalls(): any { const M: any = (globalThis as any).Module, g = this.gfx; if (!g || !M?._nx_gfx_id_calls) return null;
    const names = this.nvnNames(), c = new Uint32Array(this.memory.buffer, Number(M._nx_gfx_id_calls()), 1024), rows: [string, number, string][] = []; let free = 0, lock = 0, owner = 0;
    for (let id = 0; id < names.length && id < 1024; id++) { const n = Atomics.load(c, id); if (!n) continue; const lf = this.lockFree ? this.lockFree[id] : 0; if (lf) free += n; else lock += n; rows.push([names[id], n, lf === 1 ? "free" : lf === 3 ? "free with room" : "lock"]); }
    for (const [nm, n] of this.ownerNvn) { owner += n; rows.push([nm, n, "owner"]); }
    rows.sort((a, b) => b[1] - a[1]);
    return { onThreadWithoutLockTable: free, onThreadUnderLock: lock, onOwner: owner, top: rows.slice(0, 40) }; }
  names(): string[] { return [...this.fsIds.keys(), ...(this.rt ? this.rt.byName.keys() : [])]; }
  // ---- video: one request of mav1_* (kernel/nx_video.c). A decode waits for the completion of its packet number.
  private uvTmp: Uint16Array | null = null;
  private videoBack: VideoBackend | null = null; private videoWait = new Map<string, number>(); videoStats = { packets: 0, pictures: 0 };
  private videoCall(ctx: number): number {
    const dv = new DataView(this.memory.buffer), n = (i: number) => Number(dv.getBigUint64(ctx + 8 * i, true));
    const op = n(0), dec = n(1), set0 = (v: number) => new DataView(this.memory.buffer).setBigUint64(ctx, BigInt(v), true);
    if (!this.videoBack) {
      if (!this.cfg.video) { if (op === 1) this.log("[RED] nn::codec: no video decoder in this environment: movies give no pictures"); set0(0); return DONE; }
      // (a picture of before the decoder's last reset is not the game's any more: the generation says so)
      this.videoBack = this.cfg.video({ log: l => this.log(l), picture: (d, gen, seq, pic) => { if (gen === (this.vgen.get(d) ?? 0)) this.videoDone(d, seq, pic); else this.vpStats.stale++; } });
    }
    const b = this.videoBack;
    const gen = this.vgen.get(dec) ?? 0;
    if (op === 1) { this.vgen.set(dec, 0); this.vpDrop(dec, true); const name = b.open(dec, VCODEC.AV1, 0, 0); if (!name) this.log("[RED] nn::codec: the browser has no AV1 decoder (WebCodecs)"); set0(name ? 1 : 0); return DONE; }
    if (op === 3) { this.vgen.set(dec, gen + 1); b.reset(dec, gen + 1); this.vpDrop(dec, false); for (const [k, c] of [...this.videoWait]) if (k.startsWith(dec + ":")) { this.videoWait.delete(k); new DataView(this.memory.buffer).setBigUint64(c, 0n, true); this.wake(c); } set0(0); return DONE; }
    if (op === 4) { b.close(dec); this.vpDrop(dec, true); this.vgen.delete(dec); set0(0); return DONE; }
    const seq = dv.getBigUint64(ctx + 48, true);
    // ops 5 and 6, the pipeline (kernel/nx_video.c NX_VPIPE): a packet goes to the decoder and the call answers with the
    // oldest finished picture, or with none while fewer than 4 packets are inside; 6 (end of stream) asks for what is left
    if (op === 5 || op === 6) {
      const v = this.vpOf(dec);
      new Int32Array(this.memory.buffer, ctx + CELL, 1)[0] = 0;
      if (op === 5) { this.videoStats.packets++; this.acct.video.packets++; if (b.decode(dec, gen, seq, new Uint8Array(this.memory.buffer, n(2), n(3)), false) === 1) { v.pending++; if (v.pending + v.done.length > this.vpStats.maxInside) this.vpStats.maxInside = v.pending + v.done.length; } }
      else if (v.pending > 0 && !v.flushing) { v.flushing = true; b.decode(dec, gen, seq, null, true); }
      if (v.done.length) { this.vpAnswer(dec, ctx); return DONE; }
      if (op === 5 ? v.pending >= 4 : v.pending > 0) { v.waiter = ctx; return PENDING; }
      set0(0); return DONE;
    }
    this.videoStats.packets++; this.acct.video.packets++;
    new Int32Array(this.memory.buffer, ctx + CELL, 1)[0] = 0;
    this.videoWait.set(dec + ":" + seq, ctx);
    const r = b.decode(dec, gen, seq, new Uint8Array(this.memory.buffer, n(2), n(3)), false);
    if (r === 1) return PENDING;
    this.videoWait.delete(dec + ":" + seq); set0(0);
    return DONE;
  }
  private vp = new Map<number, { done: { seq: bigint; pic: VideoPicture }[]; pending: number; waiter: number; flushing: boolean; last: bigint }>();
  private vgen = new Map<number, number>();   // a decoder's generation: one more at each reset
  vpStats = { answered: 0, outOfOrder: 0, stale: 0, dropped: 0, resets: 0, maxInside: 0 };   // the pipeline's pictures: handed over, of those not after the one before (by packet number), of an earlier generation, thrown away at a reset
  private vpOf(dec: number) { let v = this.vp.get(dec); if (!v) this.vp.set(dec, v = { done: [], pending: 0, waiter: 0, flushing: false, last: -1n }); return v; }
  // a reset or the end of a decoder: what its pipeline holds is not wanted any more, and a call that waits there ends with no picture
  private vpDrop(dec: number, gone: boolean): void {
    const v = this.vp.get(dec); if (!v) return;
    this.vpStats.resets++; this.vpStats.dropped += v.done.length;
    v.done = []; v.pending = 0; v.flushing = false; v.last = -1n;
    if (v.waiter) { const c = v.waiter; v.waiter = 0; new DataView(this.memory.buffer).setBigUint64(c, 0n, true); this.wake(c); }
    if (gone) this.vp.delete(dec);
  }
  // the oldest finished picture into the caller's buffer (x0 = 1, its packet's number at +40), or x0 = 0
  private vpAnswer(dec: number, ctx: number): void {
    const v = this.vpOf(dec), e = v.done.shift();
    if (!e) { new DataView(this.memory.buffer).setBigUint64(ctx, 0n, true); return; }
    this.vpStats.answered++;
    if (e.seq <= v.last) { if (this.vpStats.outOfOrder++ < 4) this.log(`[RED] nn::codec: decoder ${dec}'s pipeline hands over the picture of packet ${e.seq} after that of packet ${v.last}`); }
    v.last = e.seq;
    // (the packet's number is written BEFORE the caller is woken: written after, the woken thread read its buffer's size
    // there as the packet number (wrong timestamps), or had already made its next request in the same block, whose
    // buffer size then was the packet number: "a picture does not fit the buffer", the dropped picture)
    this.videoDone1(dec, e.seq, e.pic, ctx, true);
  }
  private videoDone(dec: number, seq: bigint, pic: VideoPicture | null): void {
    const v = this.vp.get(dec);
    if (v) {   // the pipeline: every packet's outcome arrives here in order, a picture or none
      v.pending = Math.max(0, v.pending - 1); if (v.pending === 0) v.flushing = false;
      if (pic) { this.acct.video.pictures++; v.done.push({ seq, pic }); }
      if (v.waiter && (v.done.length || v.pending === 0)) { const c = v.waiter; v.waiter = 0; this.vpAnswer(dec, c); this.wake(c); }
      return;
    }
    const ctx = this.videoWait.get(dec + ":" + seq);
    if (pic) this.acct.video.pictures++;
    if (ctx === undefined) return;
    const top = this.secIn("codec: a picture into guest memory"); try { this.videoDone1(dec, seq, pic, ctx); } finally { this.secOut(); }
  }
  private videoDone1(dec: number, seq: bigint, pic: VideoPicture | null, ctx: number, pipe = false): void {
    this.videoWait.delete(dec + ":" + seq);
    const dv = new DataView(this.memory.buffer), u8 = new Uint8Array(this.memory.buffer), buf = Number(dv.getBigUint64(ctx + 32, true)), cap = Number(dv.getBigUint64(ctx + 40, true));
    let ok = 0;
    if (pic && pic.w * pic.h * 3 / 2 <= cap) {
      const { w, h } = pic, cw = (w + 1) >> 1, ch = (h + 1) >> 1;
      // luma: one copy when the rows are packed, else a copy per row. Chroma: U and V are interleaved into a buffer of
      // this realm first (16 bits per pair, one store each) and copied in one piece: the loop that wrote the shared
      // memory byte by byte took 46 ms a picture on the owner thread (measured 2026-11-13), most of the movie's stutter
      if (pic.yStride === w) u8.set(pic.y.subarray(0, w * h), buf); else for (let y = 0; y < h; y++) u8.set(pic.y.subarray(y * pic.yStride, y * pic.yStride + w), buf + y * w);
      const rows = Math.min(ch, h >> 1), pairs = Math.min(cw, w >> 1), need = rows * (w >> 1);
      if (!this.uvTmp || this.uvTmp.length < need) this.uvTmp = new Uint16Array(need);
      const t16 = this.uvTmp, U = pic.u, V = pic.v, half = w >> 1;
      for (let y = 0; y < rows; y++) { const pu = y * pic.uvStride, o = y * half; for (let x = 0; x < pairs; x++) t16[o + x] = U[pu + x] | V[pu + x] << 8; }
      u8.set(new Uint8Array(t16.buffer, 0, need * 2), buf + w * h);
      dv.setBigUint64(ctx + 8, BigInt(w), true); dv.setBigUint64(ctx + 16, BigInt(h), true); dv.setBigUint64(ctx + 24, BigInt(pic.matrix), true); dv.setBigUint64(ctx + 32, BigInt(pic.fullRange ? 1 : 0), true);
      ok = 1; if (!this.videoStats.pictures++) this.log(`[codec] first AV1 picture ${w}x${h} handed to the game`);
    } else if (pic) this.log(`[RED] nn::codec: a ${pic.w}x${pic.h} picture does not fit the buffer (room ${cap} bytes at 0x${buf.toString(16)}; the call's op ${Number(dv.getBigUint64(ctx + 0, true))}, decoder ${Number(dv.getBigUint64(ctx + 8, true))}, packet ${seq})`);
    if (pipe) dv.setBigUint64(ctx + 40, seq, true);
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
  private wake(ctx: number): void { const pk = this.parkAt.get(ctx); if (pk) { this.parkAt.delete(ctx); this.reqOf(pk.nm).parked += performance.now() - pk.at; }
    const cell = new Int32Array(this.memory.buffer, ctx + CELL, 1); Atomics.store(cell, 0, 1); Atomics.notify(cell, 0); }
  // A wait a handler returned: the calling thread stays blocked until `done` has settled and time `at` has come (or the
  // deadline passed), then resume runs here and its result is the call's
  private arm(ctx: number, cpu: any, w: Wait): void {
    let over = false;
    const go = (timedOut: boolean) => {
      if (over) return; over = true;
      let r: any;
      const top = this.secIn("a handler's step after its wait");
      this.lock();
      try { r = w.resume(cpu, timedOut); } catch (e) { this.log(`[RED] owner: a host function failed after its wait: ${(e as Error).message}`); r = 0; } finally { this.unlock(); this.secOut(); }
      if (r && r.__wait) this.arm(ctx, cpu, r); else { this.store(ctx, r); this.wake(ctx); }
    };
    const timed = () => { const ms = w.at === undefined ? 0 : Number(w.at - nowNs()) / 1e6; if (ms > 0.05) setTimeout(() => go(false), ms); else go(false); };
    if (w.done) w.done.then(timed, timed); else timed();
    if (w.deadline !== undefined) setTimeout(() => go(true), Math.max(0, Number(w.deadline - nowNs()) / 1e6));
  }
  private hostCall(h: number, ctx: number): number {
    this.hostCalls++;
    const cpu = this.fast ?? (this.fast = this.cpu(ctx)); cpu.q = ctx / 8;
    let r: any;
    this.drainRing();
    // The recorder's lock is a guest thread's for now: the owner does not wait for it (it spun here for up to 65 ms with
    // every other request behind it): the caller makes the call again in a moment. After 20 refusals in a row it waits.
    if (this.glDepth === 0 && !this.lent && Atomics.load(this.gl, 0) !== 0 && Atomics.load(this.gl, 2) !== 1 && this.busyTries < 20) { this.busyTries++; this.glStats.busyRetries = (this.glStats.busyRetries ?? 0) + 1; return RETRY; }
    this.busyTries = 0;
    this.lock();   // a handler is one step of the recorder for the other threads, as it was when every call came here
    try { r = this.rt.handlers[h](cpu); } finally { this.unlock(); }
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
  // ---- where the owner thread's wall-clock time goes (report(); the page prints it every 10 s). A section is what one
  // entry into the owner did, by name; what no section covers is `outside` (tasks of the page, the decoder's and the
  // GPU's callbacks, the shader workers' messages) or idle: the lag probe tells the two apart.
  private acct = { t0: performance.now(), sec: new Map<string, { n: number; ms: number; max: number }>(), depth: 0, at: 0, name: "", long: new Map<string, { n: number; ms: number }>(),
    req: new Map<string, { n: number; queued: number; work: number; parked: number; parks: number }>(), lag: { n: 0, sum: 0, max: 0 }, video: { packets: 0, pictures: 0 }, probe: false };
  private secIn(name: string): boolean { const a = this.acct; if (a.depth++) return false; a.at = performance.now(); a.name = name; return true; }
  private secOut(): void { const a = this.acct; /* every secIn has its secOut; only the outermost is a section */ if (--a.depth) return; const d = performance.now() - a.at; let s = a.sec.get(a.name); if (!s) a.sec.set(a.name, s = { n: 0, ms: 0, max: 0 }); s.n++; s.ms += d; if (d > s.max) s.max = d;
    if (d > 8) { let l = a.long.get(a.name); if (!l) a.long.set(a.name, l = { n: 0, ms: 0 }); l.n++; l.ms += d; } }
  private reqOf(name: string) { let r = this.acct.req.get(name); if (!r) this.acct.req.set(name, r = { n: 0, queued: 0, work: 0, parked: 0, parks: 0 }); return r; }
  private hname = new Map<number, string>();
  private nameOfCode(code: number): string {
    const k = code >>> 24, h = code & 0xFFFFFF;
    if (k === KIND_FS) return "fs:" + (this.fsNames.get(h) ?? h); if (k === KIND_VIDEO) return "codec"; if (k === 4) return "guest-wrote"; if (k !== KIND_HOST) return "kind" + k;
    let n = this.hname.get(h);
    if (n === undefined) { n = ""; for (const [nm, hh] of this.rt.byName) if (hh === h) n = nm; if (!n) for (const [id, hh] of this.rt.late) if (hh === h) n = this.lateNames.get(id) ?? ""; this.hname.set(h, n = n || "host#" + h); }
    return n;
  }
  // Everything since the last report(reset = true): ms unless said otherwise
  report(reset = false): any {
    const a = this.acct, now = performance.now(), wall = now - a.t0, r1 = (v: number) => +v.toFixed(1);
    if (!a.probe) { a.probe = true; let due = performance.now() + 100; const tick = () => { const late = performance.now() - due; a.lag.n++; a.lag.sum += late; if (late > a.lag.max) a.lag.max = late; due = performance.now() + 100; setTimeout(tick, 100); }; setTimeout(tick, 100); }
    let covered = 0; const sections: any = {}; for (const [k, v] of [...a.sec].sort((x, y) => y[1].ms - x[1].ms)) { covered += v.ms; sections[k] = { n: v.n, ms: r1(v.ms), pctOfWall: r1(100 * v.ms / wall), maxMs: r1(v.max) }; }
    const requests: any = {}; for (const [k, v] of [...a.req].sort((x, y) => (y[1].queued + y[1].work + y[1].parked) - (x[1].queued + x[1].work + x[1].parked)).slice(0, 14)) requests[k] = { n: v.n, queuedBeforeOwnerStartedMs: r1(v.queued), ownerWorkedMs: r1(v.work), parkedWaits: v.parks, parkedMs: r1(v.parked) };
    const long: any = {}; for (const [k, v] of a.long) long[k] = { n: v.n, ms: r1(v.ms) };
    const g: any = this.gfx, decs: any[] = []; try { for (const [id, st] of (this.videoBack as any)?.decs ?? []) decs.push({ id, queue: st.d?.decodeQueueSize, state: st.d?.state }); } catch { /* not the WebCodecs back end */ }
    const out = { wallMs: r1(wall), ownerBusyPct: r1(100 * covered / wall), outsideOrIdleMs: r1(wall - covered), sections, replayerExecMs: g ? r1(g.times.execMs - ((this as any).execSeen0 ?? 0)) : 0, synchronousStretchesOver8ms: long, requests,
      eventLoopLag: { probes: a.lag.n, meanMs: a.lag.n ? r1(a.lag.sum / a.lag.n) : 0, maxMs: r1(a.lag.max) },
      video: { packetsIn: a.video.packets, picturesOut: a.video.pictures, perSecondIn: r1(a.video.packets * 1000 / wall), perSecondOut: r1(a.video.pictures * 1000 / wall), decoders: decs, hardwareAcceleration: (globalThis as any).NXVDEC ?? "prefer-software", pipeline: { ...this.vpStats }, handed: this.videoStats.pictures },
      replayerBatches: Object.fromEntries([...this.rep.kinds].map(([k, v]) => [k, { n: v.n, ms: r1(v.ms), maxMs: r1(v.max) }])), replayerSlowBatches: this.rep.slow.slice(),
      presentSteps: { n: this.presentSteps.n, ms: r1(this.presentSteps.ms), maxMs: r1(this.presentSteps.max), over8ms: this.presentSteps.over8, steps: Object.fromEntries(Object.entries(this.presentSteps.steps).map(([k, v]) => [k, { ms: r1(v.ms), maxMs: r1(v.max) }])), slow: this.presentSteps.slow.slice() },
      nvnCalls: this.nvnCalls(), lfAudit: this.lfAudit(), frameWork: reset ? this.frameWork() : null,
      ring: this.ringStats, shaderWait: { ...this.shaderWait, ms: r1(this.shaderWait.ms), maxMs: r1(this.shaderWait.maxMs) }, flushCauses: this.flushCauses(), presents: this.presents };
    if (reset) { const ps = this.presentSteps; ps.n = 0; ps.ms = 0; ps.max = 0; ps.over8 = 0; ps.steps = {}; ps.slow = []; this.rep.kinds.clear(); this.rep.slow = []; a.t0 = now; a.sec.clear(); a.long.clear(); a.req.clear(); a.lag = { n: 0, sum: 0, max: 0 }; a.video = { packets: 0, pictures: 0 }; (this as any).execSeen0 = g ? g.times.execMs : 0; }
    return out;
  }
  call(code: number, ctx: number, treq = 0): number {
    const nm = this.nameOfCode(code), q = this.reqOf(nm), top = this.secIn(nm), w0 = performance.now(); q.n++;
    if (nm.charCodeAt(0) === 110 && nm.startsWith("nvn")) this.ownerNvn.set(nm, (this.ownerNvn.get(nm) ?? 0) + 1);
    if (treq > 0) { const queued = performance.timeOrigin + w0 - treq; if (queued > 0 && queued < 60000) q.queued += queued; }
    try { const r = this.call1(code, ctx); if (r === PENDING) { q.parks++; this.parkAt.set(ctx, { nm, at: performance.now() }); } return r; }
    finally { q.work += performance.now() - w0; this.secOut(); }
  }
  private parkAt = new Map<number, { nm: string; at: number }>();
  // What the replayer's time went to, from outside it: every batch is timed whole and counted under what it holds
  // (the host stream's record types, nxweb src/gfx/hostops.ts): a present, texels uploaded, textures or pipelines made,
  // copies; the slow ones (over 8 ms) are kept with their record counts.
  private rep = { kinds: new Map<string, { n: number; ms: number; max: number }>(), slow: [] as { ms: number; bytes: number; records: string }[] };
  private presentSteps: { inside: boolean; cur: Record<string, number>; n: number; ms: number; max: number; over8: number; steps: Record<string, { ms: number; max: number }>; slow: string[] } = { inside: false, cur: {}, n: 0, ms: 0, max: 0, over8: 0, steps: {}, slow: [] };
  // What the game asks for per presented frame (report().frameWork, the status line): the host stream's draws, passes
  // and flushes, the game's submits and command buffers (the calls counted by id on the calling threads), and the time
  // of the recorder's entry points without the waits for the owner: nvnQueueSubmitCommands' is the submit's lowering.
  private work = { batches: 0, bytes: 0, draws: 0, passes: 0, flushes: 0, pipelines: 0, texUploads: 0, memWrites: 0, memDirty: 0 }; private workLast: any = null; private workLine = "";
  frameWork(): any { const M: any = (globalThis as any).Module, g = this.gfx; if (!g) return null;
    const names = this.nvnNames(), cur: any = { ...this.work, presents: this.presents, calls: null as Uint32Array | null, ns: null as Float64Array | null };
    if (M?._nx_gfx_id_calls && M?._nx_gfx_id_ns) { cur.calls = new Uint32Array(this.memory.buffer, Number(M._nx_gfx_id_calls()), 1024).slice(); cur.ns = Float64Array.from(new BigUint64Array(this.memory.buffer, Number(M._nx_gfx_id_ns()), 1024), v => Number(v)); }
    const last = this.workLast; this.workLast = cur; if (!last) return null;
    const f = Math.max(1, cur.presents - last.presents), per = (k: string) => +((cur[k] - last[k]) / f).toFixed(1), out: any = { presents: cur.presents - last.presents, drawsPerPresent: per("draws"), passesPerPresent: per("passes"), flushesPerPresent: per("flushes"), batchesPerPresent: per("batches"), streamKBPerPresent: +((cur.bytes - last.bytes) / f / 1024).toFixed(1), pipelinesMade: cur.pipelines - last.pipelines, texUploadsPerPresent: per("texUploads"), streamWritesPerPresent: per("memWrites"), memDirtyPerPresent: per("memDirty") };
    if (cur.calls && last.calls) { const idOf = (n: string) => names.indexOf(n), dc = (n: string) => { const i = idOf(n); return i < 0 ? 0 : cur.calls[i] - last.calls[i]; }, dms = (i: number) => (cur.ns[i] - last.ns[i]) / 1e6;
      const sub = idOf("nvnQueueSubmitCommands");
      out.submitsPerPresent = +(dc("nvnQueueSubmitCommands") / f).toFixed(1); out.commandBuffersPerPresent = +(dc("nvnCommandBufferBeginRecording") / f).toFixed(1);
      out.loweringMsPerPresent = sub < 0 ? 0 : +(dms(sub) / f).toFixed(2); out.loweringUsPerDraw = sub < 0 || cur.draws === last.draws ? 0 : +(dms(sub) * 1000 / (cur.draws - last.draws)).toFixed(1);
      const rows: [string, number, number][] = []; for (let i = 0; i < names.length && i < 1024; i++) { const ms = dms(i); if (ms > 0) rows.push([names[i], +(ms / f).toFixed(2), cur.calls[i] - last.calls[i]]); }
      out.recorderMsPerPresentTop = rows.sort((a, b) => b[1] - a[1]).slice(0, 12).map(r => `${r[0]} ${r[1]} ms (${r[2]} calls)`); }
    this.workLine = ` · per present: ${out.drawsPerPresent} draws, ${out.submitsPerPresent ?? "?"} submits, ${out.commandBuffersPerPresent ?? "?"} command buffers, ${out.passesPerPresent} passes, lowering ${out.loweringMsPerPresent ?? "?"} ms`;
    return out; }
  frameWorkLine(): string { return this.workLine; }
  // What the guest threads' recorder instances handed over since the last call, by cause (kernel/nx_guest.js gfx_exec):
  // per present, and for the ones that waited for the owner the ms waited per present
  private fcLast: Uint32Array | null = null; private fcPresents = 0; private fcLine = "";
  flushCauses(): any { const M: any = (globalThis as any).Module; if (!M?._nx_gfx_fc) return null;
    const cur = new Uint32Array(this.memory.buffer, Number(M._nx_gfx_fc()), 32).slice(), last = this.fcLast, f = Math.max(1, this.presents - this.fcPresents); this.fcLast = cur; this.fcPresents = this.presents;
    if (!last) return null;
    const NAME = ["ring: submission end", "ring: stream buffer full", "WAITED: texels in the batch", "WAITED: cut inside a submission", "WAITED: no room in the ring", "WAITED: ring off", "WAITED: entry point address", "WAITED: more arena", "(cut inside a submission) then the recorder wrote guest memory", "(cut) then a texture-to-buffer copy", "(cut) then other"];
    const out: any = {}, parts: string[] = []; let waited = 0, waitedMs = 0;
    for (let c = 0; c < NAME.length; c++) { const n = cur[2 * c] - last[2 * c], us = cur[2 * c + 1] - last[2 * c + 1]; if (!n) continue; out[NAME[c]] = { perPresent: +(n / f).toFixed(1), waitMsPerPresent: +(us / 1000 / f).toFixed(1) }; if (c >= 2 && c <= 7) { waited += n; waitedMs += us / 1000; } }
    out.waitedPerPresent = +(waited / f).toFixed(1); out.waitedMsPerPresent = +(waitedMs / f).toFixed(1);
    const pp = (c: number) => ((cur[2 * c] - last[2 * c]) / f).toFixed(1);
    this.fcLine = ` · flushes per present: ${pp(0)}+${pp(1)} in the ring, ${out.waitedPerPresent} waited ${out.waitedMsPerPresent} ms (texels ${pp(2)}, memory writes ${pp(8)}, copies to buffers ${pp(9)}, other cuts ${pp(10)}, ring full ${pp(4)})`;
    return out; }
  flushCauseLine(): string { return this.fcLine; }
  private batchDone(p: number, n: number, ms: number): void {
    const u32 = new Uint32Array(this.memory.buffer), ops = new Map<number, number>(); let texels = 0;
    for (let q = p; q + 8 <= p + n; ) { const op = u32[q / 4], sz = u32[q / 4 + 1]; if (sz < 8) break; ops.set(op, (ops.get(op) ?? 0) + 1); if (op === 24) texels += sz; q += sz; }
    const has = (op: number) => ops.has(op), w = this.work; w.batches++; w.bytes += n; w.draws += (ops.get(14) ?? 0) + (ops.get(15) ?? 0); w.passes += ops.get(3) ?? 0; w.flushes += ops.get(22) ?? 0; w.pipelines += ops.get(7) ?? 0; w.texUploads += ops.get(24) ?? 0; w.memWrites += ops.get(42) ?? 0; w.memDirty += ops.get(23) ?? 0;
    const kind = has(20) ? "with a present" : has(24) ? "with texels uploaded" : has(7) ? "with pipelines made" : has(1) ? "with textures made" : has(17) || has(18) || has(25) ? "with copies" : has(14) || has(15) ? "draws only" : "state only";
    let k = this.rep.kinds.get(kind); if (!k) this.rep.kinds.set(kind, k = { n: 0, ms: 0, max: 0 }); k.n++; k.ms += ms; if (ms > k.max) k.max = ms;
    if (ms > 8 && this.rep.slow.length < 12) { const NAME: Record<number, string> = { 1: "texCreate", 3: "beginPass", 7: "pipelineCreate", 14: "draw", 15: "drawIndexed", 17: "copyB2T", 18: "copyT2T", 19: "snapshot", 20: "present", 21: "fence", 22: "flush", 24: "texData", 25: "copyT2B", 27: "uboData" };
      this.rep.slow.push({ ms: +ms.toFixed(1), bytes: n, records: [...ops].filter(([op]) => NAME[op]).map(([op, c]) => `${NAME[op]} ${c}`).join(", ") + (texels ? `, ${(texels / 1048576).toFixed(1)} MB of texels` : "") }); }
  }
  private call1(code: number, ctx: number): number {
    const t0 = performance.now();
    try {
      if (code >>> 24 === KIND_HOST) { const h0 = performance.now(); try { return this.hostCall(code & 0xFFFFFF, ctx); } finally { this.hostNs += (performance.now() - h0) * 1e6; } }
      if (code >>> 24 === KIND_VIDEO) return this.videoCall(ctx);
      if (code >>> 24 === 4) { const dv = new DataView(this.memory.buffer); (this.gfx as any)?.x.gfx_note_flush?.(dv.getBigUint64(ctx, true), dv.getBigUint64(ctx + 8, true)); return DONE; }   // host code wrote guest memory
      if (code >>> 24 !== KIND_FS) throw new Error("owner: no module of kind " + (code >>> 24));
      this.stats.fsCalls++;
      const id = code & 0xFFFFFF, dv = new DataView(this.memory.buffer), shown = this.shown.get(id) ?? 0, name = shown < 6 ? this.fsNames.get(id) ?? "" : "";
      const a1 = Number(dv.getBigUint64(ctx + 8, true)), a3 = Number(dv.getBigUint64(ctx + 24, true)), a4 = Number(dv.getBigUint64(ctx + 32, true)), a0 = Number(dv.getBigUint64(ctx, true));
      if (this.openIds.has(id)) { const u8 = new Uint8Array(this.memory.buffer); let e = a1; while (u8[e] && e < a1 + 200) e++; if (e - a1 > 5 && u8[e - 1] === 0x6D && u8[e - 2] === 0x62 && u8[e - 5] === 0x2E) this.log(`fs: movie file ${new TextDecoder().decode(u8.slice(a1, e))} opened, ${((performance.now() - this.t00) / 1000).toFixed(0)} s after the owner started`); }
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
  const o = new Owner(memory, rom.storage, c); o.romDev = rom.dev;
  c.log(`owner: nxweb's fs module answers ${o.names().length} nn::fs names`);
  o.startGfx(c, memory.buffer.byteLength / 65536);
  return { owner: o, exefs: rom.exefs };
}
export { sharedBuild };
// gfx64.wasm / fs64.wasm (already the shared build) as the globals-in-memory build and what goes with it (OwnerConfig.gfxShare, fsShare)
// statics: ranges of the module's static memory that every instance gets for itself (the dynamic audit's scratch)
export function gfxShared(wasm: Uint8Array, direct: boolean, base = GFX_GLOBALS, statics: { addr: number; len: number }[] = []): { wasm: Uint8Array; share: NonNullable<OwnerConfig["gfxShare"]> } {
  const first = globalsToMemory(wasm, { base, statics }), second = globalsToMemory(wasm, { base, secondary: true, statics });
  if (first.size > 0x7000) throw new Error("owner: the module has more globals than their block holds");
  return { wasm: first.wasm, share: { globals: first.globals, secondary: second.wasm, direct, plain: wasm, tls: first.tls } };
}
// The lock-free verdict for a recorder binary (gfx64.wasm as built): tools/gfx_dynaudit.mjs runs it alone on a small
// memory of its own. It takes seconds, so the platform may keep the answer by the binary's hash (load / save).
export async function lockFreeAudit(raw: Uint8Array, key: string, log: (l: string) => void, load?: (k: string) => Promise<string | null>, save?: (k: string, v: string) => Promise<void>): Promise<{ table: Uint8Array; statics: { addr: number; len: number }[]; line: string } | null> {
  try {
    const kept = load ? await load(key).catch(() => null) : null;
    if (kept) { const j = JSON.parse(kept); return { table: Uint8Array.from(j.table), statics: j.statics, line: j.line + " (kept from an earlier run of this recorder build)" }; }
    const d = dynamicAudit(raw, { sharedBuild, instantiate, range }), line = auditLine(d), statics = d.statics;
    if (save) await save(key, JSON.stringify({ table: [...d.table], statics, line })).catch(() => {});
    return { table: d.table, statics, line };
  } catch (e) { log(`[RED] owner: the recorder's dynamic audit failed (${(e as Error).message}): every direct call stays under the lock`); return null; }
}
