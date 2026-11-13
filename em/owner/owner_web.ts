// nxem: the owner realm in a page (the Emscripten module's main thread = the page's main thread). The game is the
// user's .nup file (read where it lies, asynchronously: the fs module's calls pend and the owner completes them),
// nxweb's built modules come from the nxweb page beside this one (../wasm/), the replayer is nxweb's WebGPU replayer
// on the page's canvas, shaders are translated by nxweb's shader Workers and kept in its store (same origin, so a
// profile that ran the AssemblyScript page has them already).
import { MemStorage, FS_KIND, type FsStorage } from "../../src/glue/fs_host.ts";
import { gfxSettingsFor } from "../../src/glue/rt_process.ts";
// the game's profile (the one title this page starts: programId below), as nxweb's page applies it: its graphics switches
import gameProfile from "../../src/prepare/profiles/0400486024DEC000.json";
import { REAL_AUDIT } from "./lockfree_real.ts";
import { OpfsStorage } from "../../src/glue/fs_dev_opfs.ts";
import { GfxHost } from "../../src/glue/gfx_host.ts";
import { RtShaders, workerTranslator, webShaderStore } from "../../src/glue/rt_shaders.ts";
import { NupTree, blobBytes } from "../../src/prepare/host/nup.ts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { WebCodecsVideo } from "../../src/glue/video_webcodecs.ts";
import { startOwner, sharedBuild, gfxShared, lockFreeAudit, FS_GLOBALS, GFX_GLOBALS, type Owner, type OwnerConfig } from "./owner.ts";

export interface PageSide {
  file: File;                                            // the .nup
  canvas: HTMLCanvasElement;
  root: string;                                          // the nxweb page's folder (its wasm/, shader_worker.js, shaders/), e.g. "../"
  writeFile: (path: string, bytes: Uint8Array) => void;  // into the Emscripten file system, for main()
  mkdir: (path: string) => void;
  stage: (text: string) => void;
  modulesList: string[];                                 // the code modules to load, in order
  nativeImage: OwnerConfig["nativeImage"];
  fsDirect?: boolean;    // true (?fsdirect=1): guest threads call the fs module in their own instance
  fsWorker?: boolean;    // true (?fsworker=1): fsdirect, and a dedicated worker reads the RomFS for them (fs_worker.ts)
  vdec?: string | null;
  skipMovie?: boolean;     // ?skipmovie=1 (a test aid): story movies end after their first clusters
  search?: string;         // the page's location.search: the replayer reads ?gfxcapture= (and gfxcapto / logto, gfxcapname) from it; the worker has no query of its own
  gfxProfile?: boolean;    // false (?gfxprofile=0): the recorder without the game profile's switches (render_cond, tex_flush_upload, tex_dirty_upload, gpu_timestamps), as it was until 2026-11-13
  shaderWait?: boolean;    // false (?shaderwait=0): a program's stages are not waited for (its draws are dropped while they compile, and a pipeline that failed then stays failed), as it was
  saves?: string | null;   // ?saves=mem / new
  gfxAsync?: boolean;      // true (?asyncsubmit=1): a submission does not wait for the replayer
  gfxLockFree?: boolean;   // false (?lockfree=0): every direct NVN call takes the recorder's lock
  gfxRealAudit?: boolean;  // true (?lfaudit=1): the real-call audit of the entry points the dynamic audit left under the lock
  gfxRealPromote?: boolean; // false (?lfreal=0): what that audit cleared stays under the lock
  gfxDirect?: boolean;   // false (?gfxdirect=0): every NVN call goes to the owner thread, as before
  pace: string | null;                                   // 'timer': never requestAnimationFrame
  ndve: boolean;                                         // nxweb's stand-in for nn::ndve's movie upscaler (GfxHost.ndveBypass): its dispatches cannot run on WebGPU yet
}

export async function start(memory: WebAssembly.Memory, malloc: (n: number) => number, log: (line: string) => void, modules: OwnerConfig["modules"], p: PageSide): Promise<Owner> {
  const pages = memory.buffer.byteLength / 65536, abs = (u: string) => new URL(p.root + u, location.href).href;
  const bytes = async (u: string) => { const r = await fetch(abs(u)); if (!r.ok) throw new Error(`owner: ${u}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
  // (prefer-hardware gave no decoder at all on a Mac without AV1 hardware: no-preference lets the browser fall back)
  if (p.vdec === "hardware") { (globalThis as any).NXVDEC = "no-preference"; log("page: vdec=hardware: the AV1 decoder is asked for with hardwareAcceleration no-preference (hardware where there is one, else software)"); }
  if ((p as any).vpipe) (globalThis as any).NXVLATENCY = false;
  p.stage("runtime modules");
  const prepModule = await WebAssembly.compile(await bytes("wasm/prepare.wasm") as unknown as BufferSource), prep = new PrepWasm(prepModule, log);
  const sha256 = (b: Uint8Array) => prep.sha256(b);
  const shared = async (n: string) => WebAssembly.compile(sharedBuild(await bytes(`wasm/${n}64.wasm`), pages) as unknown as BufferSource);
  // ?lockfree=1: the recorder's audit first (kept in the browser's store by the binary's hash: it takes seconds)
  const gfxRaw = await bytes("wasm/gfx64.wasm");
  const kv = { load: async (k: string) => { const r = await (await caches.open("nxem-a64")).match("/em-gfx-audit/" + k); return r ? await r.text() : null; }, save: async (k: string, v: string) => { await (await caches.open("nxem-a64")).put("/em-gfx-audit/" + k, new Response(v)); } };
  const audit = p.gfxLockFree === true && p.gfxDirect !== false ? await lockFreeAudit(gfxRaw, "v1-" + sha256(gfxRaw), log, typeof caches !== "undefined" ? kv.load : undefined, typeof caches !== "undefined" ? kv.save : undefined) : null;
  const g = gfxShared(sharedBuild(gfxRaw, pages), p.gfxDirect !== false, GFX_GLOBALS, audit?.statics ?? []);
  // (without ?fsdirect=1 the fs module is the plain shared build, exactly as before: the direct path has not run at game scale yet)
  const fsPlain = sharedBuild(await bytes("wasm/fs64.wasm"), pages), f = p.fsDirect === true || p.fsWorker === true ? gfxShared(fsPlain, true, FS_GLOBALS) : { wasm: fsPlain, share: undefined };
  const [fsModule, gfxModule] = await Promise.all([WebAssembly.compile(f.wasm as unknown as BufferSource), WebAssembly.compile(g.wasm as unknown as BufferSource)]);
  for (const n of ["translator64.shared", "helpers64.shared", "loader64"]) p.writeFile(`/rt/${n}.wasm`, await bytes(`wasm/${n}.wasm`));
  // the translation cache: its blobs out of the Cache API into /cache, where the translator thread reads them (kernel/nx_guest.js)
  p.stage("translation cache");
  p.mkdir("/cache");
  try {
    const c = await caches.open("nxem-a64"); let n = 0, total = 0;
    for (const req of await c.keys()) { const r = await c.match(req); if (!r) continue; const b = new Uint8Array(await r.arrayBuffer()); p.writeFile("/cache/" + decodeURIComponent(new URL(req.url).pathname.split("/").pop()!), b); n++; total += b.length; }
    log(n ? `page: translation cache: ${n} entries, ${(total / 1048576).toFixed(1)} MB from the browser's store` : "page: no translation cache yet: this run translates everything (it is stored about 30 s after the start, and again every 2 minutes)");
  } catch (e) { log(`[RED] page: the translation cache could not be read (${(e as Error).message})`); }
  p.stage("game container");
  const tree = await NupTree.open(blobBytes(p.file, false), p.file.name, { sha256, log });
  p.stage("WebGPU device");
  let device: any = null, gpuInfo = "no WebGPU here: the null replayer (nothing is drawn)";
  const requestDevice = async () => {
    const gpu = (navigator as any).gpu, adapter = gpu ? await gpu.requestAdapter() : null;
    if (!adapter) return null;
    const desc = GfxHost.deviceDescriptor(adapter), d = await adapter.requestDevice(desc);
    gpuInfo = "WebGPU: " + (adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "adapter") + `; ${desc.requiredFeatures.length} features`;
    return d;
  };
  try { device = await requestDevice(); } catch (e) { gpuInfo = `no WebGPU device (${(e as Error).message}): the null replayer`; }
  log("page: " + gpuInfo);
  if (device) log(`page: the game profile's graphics switches are ${p.gfxProfile === false ? "off (gfxprofile=0)" : "on (bits " + gfxSettingsFor((gameProfile as any).apply).bits + ": render_cond, tex_flush_upload, tex_dirty_upload, gpu_timestamps)"}; a program's shaders are ${p.shaderWait !== false ? "waited for" : "not waited for (shaderwait=0)"}`);
  if (device) log(p.ndve ? "page: ndve=bypass: nxweb's bilinear stand-in shows the movie pictures in place of nn::ndve's upscaler (the default here; ?ndve=off for the game's own dispatches)" : "page: ndve=off: the game's own nn::ndve dispatches (the movie stays black where WebGPU cannot run them)");
  // The display frame the replayer paces acquire / present by. requestAnimationFrame stops in a hidden tab or a
  // background window, and a hidden page's timers are slowed too, so the 16 ms are counted by messages the page sends
  // itself (as nxweb's ?pace=timer does): always with ?pace=timer, and whenever the document is hidden; a visible page
  // uses requestAnimationFrame with the timer behind it (50 ms) in case it is hidden while it waits.
  const ch = new MessageChannel(), waiting: { at: number; fn: () => void }[] = [];
  ch.port1.onmessage = () => {
    const now = performance.now();
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].at <= now) { const x = waiting[i]; waiting.splice(i, 1); x.fn(); }
    if (waiting.length) ch.port2.postMessage(0);
  };
  const spinTimer = (fn: () => void, ms: number) => { waiting.push({ at: performance.now() + ms, fn }); if (waiting.length === 1) ch.port2.postMessage(0); };
  const nextFrame = () => new Promise<void>(res => {
    if (p.pace === "timer" || typeof requestAnimationFrame !== "function" || (typeof document !== "undefined" && document.hidden)) { spinTimer(res, 16); return; }
    // (the 50 ms timer is for a page whose display frames do not come although it is not hidden: an occluded window.
    // A game held at exactly 20 frames a second is that: frameSource counts which of the two ended each wait)
    let done = false; const fs = (globalThis as any).NXFRAMESRC ??= { raf: 0, timer: 0 };
    requestAnimationFrame(() => { if (!done) { done = true; fs.raf++; res(); } }); spinTimer(() => { if (!done) { done = true; fs.timer++; res(); } }, 50);
  });
  log(p.pace === "timer" ? "page: pace=timer: display frames from a 16 ms message timer (not requestAnimationFrame)" : "page: display frames from requestAnimationFrame while the page is visible, from a 16 ms message timer while it is hidden (?pace=timer: always the timer)");
  // Saves: container files in the origin's private file system (nxem-saves/save.nxsv, device.nxsv), so a save of one
  // run is there in the next ("Continue"). They need synchronous access handles: a worker (the default; ?owner=page
  // keeps saves in memory). ?saves=mem: in memory as before; ?saves=new: the stored saves are deleted first.
  let saves: FsStorage = new MemStorage();
  if (p.saves === "mem") log("page: saves=mem: saves are kept in memory and end with the page");
  else if (typeof document !== "undefined" || !(navigator as any).storage?.getDirectory) log("page: saves are kept in memory and end with the page (the owner is on the page, or there is no private file system here: synchronous file handles need a worker)");
  else {
    try {
      const o = new OpfsStorage("nxem-saves");
      if (p.saves === "new") { await o.remove(FS_KIND.SAVE, 0n); await o.remove(FS_KIND.DEVICE_SAVE, 0n); }
      if (await o.preopen(FS_KIND.SAVE) && await o.preopen(FS_KIND.DEVICE_SAVE)) {
        const sz = (k: number) => { const d = o.open(k, 0n) as any; return typeof d?.size === "function" ? d.size() : 0; };
        saves = o; log(`page: saves are stored in the browser (private file system, nxem-saves): save ${sz(FS_KIND.SAVE)} bytes, device save ${sz(FS_KIND.DEVICE_SAVE)} bytes from earlier runs${p.saves === "new" ? " (saves=new: deleted first)" : ""}`);
      } else { o.close(); log("[RED] page: the stored saves could not be opened (another tab of this page has them?): saves are kept in memory and end with the page"); }
    } catch (e) { log(`[RED] page: no stored saves (${(e as Error).message}): saves are kept in memory and end with the page`); }
  }
  const c: OwnerConfig = {
    video: WebCodecsVideo.available() ? sink => new WebCodecsVideo(sink) : undefined, nativeImage: p.nativeImage,
    tree, prep, fsModule, gfxModule, gfxShare: { ...g.share, lockFree: !!audit, lockTable: audit?.table, lockLine: audit?.line, asyncSubmit: p.gfxAsync === true, realAudit: p.gfxRealAudit === true, promote: audit && p.gfxRealPromote !== false && REAL_AUDIT.key === sha256(gfxRaw) ? REAL_AUDIT.names : [] }, fsShare: f.share, saves, skipMovie: p.skipMovie === true, programId: 0x0400486024DEC000n, scratch: 0x1FF00000, malloc, modules, log,
    gfx: device ? { profile: p.gfxProfile === false ? undefined : gfxSettingsFor((gameProfile as any).apply), shaderWait: p.shaderWait !== false, capture: p.search || false, ndve: p.ndve ? "bypass" : undefined, device, canvas: p.canvas, nextFrame, requestDevice: async () => { device = await requestDevice(); return device; } } : undefined,
  };
  p.stage("RomFS index");
  const { owner, exefs } = await startOwner(memory, c);
  if (p.fsWorker === true) {
    try {
      const fw = new Worker(new URL("fs_worker.js", location.href).href);
      fw.onmessage = (e: MessageEvent) => { if (e.data && e.data.line) log(e.data.line); };
      fw.onerror = (e: any) => log(`[RED] page: the fs worker failed (${e.message ?? e}): RomFS reads stay with the owner`);
      fw.postMessage({ start: true, memory, file: p.file, prep: prepModule, skipMovie: p.skipMovie === true });
      log("page: fsworker=1: guest threads call the fs module themselves (fsdirect) and a dedicated worker reads the game file for them");
    } catch (e) { log(`[RED] page: no fs worker (${(e as Error).message}): RomFS reads stay with the owner`); }
  }
  if (device && owner.gfx) {
    owner.gfx.host.fitCanvas = true;
    let translator: any;
    try {
      if ((await fetch(abs("shaders/xlate_wasm/_framework/dotnet.js"), { method: "HEAD" })).ok && (await fetch(abs("shaders/nx_naga.wasm"), { method: "HEAD" })).ok)
        translator = workerTranslator({ worker: abs("shader_worker.js"), framework: abs("shaders/xlate_wasm/_framework"), naga: abs("shaders/nx_naga.wasm"), subgroups: GfxHost.hasSubgroups(device) });
    } catch { /* none */ }
    new RtShaders(owner.gfx, { translator, store: typeof caches !== "undefined" ? webShaderStore() : undefined });
    log(translator ? "page: shaders are translated in the page (nxweb's shader Workers) and kept in its store" : "[RED] page: nxweb's shader translator is not beside this page: only stored shaders are used");
  }
  p.stage("code modules");
  if (!exefs) throw new Error("owner: no exefs/ in the container");
  const l = await tree.list();
  for (const n of p.modulesList) {
    const f = l.files.find(x => x.path === exefs + n);
    if (!f) throw new Error(`owner: ${exefs}${n} is not in the container`);
    p.writeFile(`/exefs/${n}`, await tree.read(f.path, 0, f.size));
  }
  p.stage("starting");
  return owner;
}
