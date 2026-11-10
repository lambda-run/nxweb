// The page's Worker: the whole runtime (translator, loader, kernel, graphics recorder and WebGPU replayer) and the
// run loop. Slices are synchronous; runAsync() returns to this Worker's event loop between them and while every
// guest thread waits, so messages (pause, stop, input) and WebGPU completions are handled.
import { Runtime, FAULT_NAMES, type RuntimeModules } from "../src/glue/rt_runtime.ts";
import { RtGfx } from "../src/glue/rt_gfx.ts";
import { RtInput, registerVi, registerHid } from "../src/glue/rt_hle.ts";
import { demoShaders } from "../test/runtime/gfx_cases.ts";
import { webCacheStore } from "../src/glue/a64_host.ts";
import { RtShaders, workerTranslator, webShaderStore, type ShaderTranslator } from "../src/glue/rt_shaders.ts";
import { RtFs } from "../src/glue/rt_fs.ts";
import { MemStorage, FS_KIND, type FsStorage } from "../src/glue/fs_host.ts";
import { OpfsStorage } from "../src/glue/fs_dev_opfs.ts";
import { attachHle } from "../src/glue/hle_rt.ts";
import type { HleHost } from "../src/glue/hle_host.ts";

const post = (m: any) => (self as any).postMessage(m);
let mods: RuntimeModules | undefined, device: any = null, gpuInfo = "no WebGPU: the null replayer (nothing is drawn)", canvas: any = null;
let rt: Runtime | undefined, gfx: RtGfx | undefined, modules = "", ratio: number | undefined, running = false;
const input = new RtInput();
let pending: { text: string; kind: string }[] = [];
const log = (text: string, kind = text.startsWith("[RED] ") ? "red" : "") => { pending.push({ text, kind }); };

async function init() {
  const mod = async (n: string) => WebAssembly.compileStreaming(fetch(`wasm/${n}.wasm`));
  const [r, kernel, loader, translator, helpers, g, fsm, hlem] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs", "hle"].map(mod));
  mods = { rt: r, kernel, loader, translator, helpers, gfx: g, fs: fsm, hle: hlem };
  // the in-page shader translator, when the build put its files beside the page (build/web/shaders)
  try { if ((await fetch("shaders/xlate_wasm/_framework/dotnet.js", { method: "HEAD" })).ok && (await fetch("shaders/nx_naga.wasm", { method: "HEAD" })).ok)
    shaderTranslator = workerTranslator({ worker: "shader_worker.js", framework: new URL("shaders/xlate_wasm/_framework", location.href).href, naga: new URL("shaders/nx_naga.wasm", location.href).href }); } catch { /* none */ }
  const gpu = (navigator as any).gpu, adapter = gpu ? await gpu.requestAdapter() : null;
  if (adapter) { device = await adapter.requestDevice(); gpuInfo = "WebGPU: " + (adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "adapter"); }
  log("page: runtime modules compiled; " + gpuInfo);
}
const ready = init().catch(e => log("[RED] page: " + (e?.message ?? e)));

let shaderTranslator: ShaderTranslator | undefined, shaderLookup: RtShaders | undefined, hle: HleHost | undefined, fsys: RtFs | undefined, cacheNote = "", fsNote = "";
// Where a program's saves live in the Origin Private File System: by program. The program id is in files this page
// does not read yet (NPDM), so the main module's id (the NSO header's 32 bytes at 0x40) names the program.
const programKey = (main: Uint8Array) => Array.from(main.subarray(0x40, 0x48), b => b.toString(16).padStart(2, "0")).join("");
async function storageFor(main: Uint8Array, rom: Blob | undefined): Promise<FsStorage> {
  try {
    const st = new OpfsStorage("saves-" + programKey(main));
    if (rom) st.setRom(rom);
    // opened ahead, so that no mount has to wait; refused when another tab holds them (the mount is read-only then)
    const ok = await st.preopen(FS_KIND.SAVE) && await st.preopen(FS_KIND.DEVICE_SAVE);
    fsNote = `saves in OPFS under saves-${programKey(main)}${ok ? "" : " (held by another tab: read-only)"}${rom ? `, rom device ${rom.size} bytes` : ", no RomFS image"}`;
    return st;
  } catch (e: any) {
    const mem = new MemStorage();
    fsNote = `no OPFS here (${e?.message ?? e}): saves are kept in memory and lost with the page` + (rom ? "; the RomFS image is not attached (it needs a Worker's synchronous reads)" : "");
    return mem;
  }
}
async function load(files: { name: string; bytes: Uint8Array }[], shaders: [string, any][], frames: number, r: number | undefined, o: { nxsl?: Uint8Array; rom?: Blob } = {}) {
  await ready;
  if (!mods) return;
  // the process before this one ends here: its threads, its translated code and its graphics objects are released
  if (rt) { await endProcess(rt); await runDone; }
  ratio = r; stdoutSeen = 0; last = undefined;
  const storage = await storageFor(files[0].bytes, o.rom);
  const me = rt = new Runtime(mods, { clock: "wall", log: l => log(l), cache: typeof caches !== "undefined" ? webCacheStore() : undefined });
  const ticks: (() => boolean)[] = [];
  gfx = new RtGfx(me, mods.gfx!, { device: device ?? undefined, canvas: device ? canvas : undefined, nextFrame: () => new Promise(res => (self as any).requestAnimationFrame(res)),
    onPresent: () => { for (let i = ticks.length - 1; i >= 0; i--) if (!ticks[i]()) ticks.splice(i, 1); } });
  // shaders: a library the user gave first, then translation in the page (stored by key and chain version)
  try { shaderLookup = new RtShaders(gfx, { library: o.nxsl, translator: shaderTranslator, store: typeof caches !== "undefined" ? webShaderStore() : undefined }); }
  catch (e: any) { log("[RED] page: the shader library was refused: " + (e?.message ?? e)); shaderLookup = new RtShaders(gfx, { translator: shaderTranslator }); }
  // the SDK take-overs: vsync events tick at every present; the input box, the web view, shared fonts and native
  // images have no page side yet (the table answers as nxnative does without a window, in the log)
  hle = attachHle(me, mods.hle!, { config: { opmode: 1 }, front: { vsync: tick => { ticks.push(tick); } } });
  fsys = new RtFs(me, mods.fs!, storage);
  for (const [key, info] of shaders) if (gfx.registerShader(key, info) < 0) log(`[RED] page: shader ${key} was not accepted`);
  const h = hle; registerVi(me); registerHid(me, input, { handheld: () => h.x.hle_opmode() === 0 });
  const g = gfx; input.frame = () => g.stats.frames;
  me.register({ name: "demo_frames", fn: () => frames });
  if (!me.loadNso(files)) { status(); return; }
  modules = me.modules.map(m => `${m.name} 0x${m.base.toString(16)}+0x${m.imageSize.toString(16)}`).join(", ") + `; ${me.set!.unresolved.length} unresolved imports`;
  const got = await me.cacheLoad();
  cacheNote = got.units ? `${got.units} translated units from the cache (${(got.bytes / 1e6).toFixed(1)} MB)` : "no translation cache entry yet";
  // new translations are stored a little after the start, and again when the process is stopped
  setTimeout(() => { if (rt === me && !me.disposed) me.cacheSave(); }, 5000);
  status();
  go(me);
}
let runDone: Promise<void> = Promise.resolve();
// what the process translated is stored, then it is killed and everything it held is released
async function endProcess(p: Runtime): Promise<void> {
  if (!p.disposed) { try { await p.cacheSave(); } catch { /* the cache is an optimisation */ } }
  p.kill();
}
function go(me: Runtime): void {
  if (running) return;
  running = true;
  runDone = (async () => {
    try { await me.runAsync(); } catch (e: any) { log("[RED] page: the run loop threw: " + (e?.stack ?? e)); }
    running = false;
    status();
  })();
}

// ---- what the page shows, four times a second ----
let stdoutSeen = 0, last: { t: number; frames: number; units: number; loop: number; host: number; exec: number } | undefined;
function status() {
  const sh = shaderLookup?.stats;
  const more = rt ? `${cacheNote}; ${rt.a64.units.length} units, ${rt.a64.translatedInsns} instructions translated now; shaders: ${sh ? `${sh.registered} ready (${sh.fromLibrary} library, ${sh.fromStore} stored, ${sh.translated} translated), ${sh.failed} failed` : "–"}${shaderTranslator ? "" : ", no in-page translator"}; ${fsNote}${fsys ? `, ${fsys.stats.calls} nn::fs calls` : ""}` : "";
  const m: any = { type: "status", more, state: rt?.state ?? "Empty", frames: gfx?.stats.frames ?? 0, nvnCalls: gfx?.stats.nvnCalls ?? 0, waiting: rt?.waitingOutside ?? 0, modules, gpu: gpuInfo };
  if (rt) {
    // why it stopped: the data the process machine's Stopped state carries (kind << 32 | value), read from the runtime core
    const kind = rt.r.rt_stop_kind(), value = rt.r.rt_stop_value();
    m.stopKind = ["", "exit", "break", "fault", "killed"][kind]; m.stopValue = value | 0; m.faultName = kind === 3 ? FAULT_NAMES[value] : "";
    const out = rt.stdout();
    if (out.length > stdoutSeen) { for (const l of out.slice(stdoutSeen).split("\n")) if (l) log(l, "out"); stdoutSeen = out.length; }
    const now = { t: performance.now(), frames: gfx!.stats.frames, units: rt.units, loop: rt.stats.runMs, host: rt.times.hostMs, exec: gfx!.times.execMs };
    if (last && now.t > last.t && rt.state === "Running") {
      const dt = (now.t - last.t) / 1000, df = now.frames - last.frames;
      m.fps = df / dt; m.ups = (now.units - last.units) / dt;
      if (ratio !== undefined) { m.ips = m.ups * ratio; m.ratio = ratio; }
      if (df > 0) {
        const loop = (now.loop - last.loop) / df, host = (now.host - last.host) / df, exec = (now.exec - last.exec) / df;
        m.split = `translated code ${(loop - host).toFixed(2)} ms, host calls ${(host - exec).toFixed(2)} ms, WebGPU ${exec.toFixed(2)} ms, idle ${Math.max(0, dt * 1000 / df - loop).toFixed(2)} ms`;
      }
    }
    last = now;
  }
  post(m);
  if (pending.length) { post({ type: "log", lines: pending }); pending = []; }
}
setInterval(status, 250);

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === "init") canvas = m.canvas;
    else if (m.type === "demo") {
      const [nso, info] = await Promise.all([fetch("demo/cube.nso").then(r => r.arrayBuffer()), fetch("demo/demo.json").then(r => r.json())]);
      await load([{ name: "cube", bytes: new Uint8Array(nso) }], await demoShaders(), 0, info.instructionsPerUnit);
    } else if (m.type === "load") {
      let shaders: [string, any][] = [];
      if (m.shaders) { try { shaders = Object.entries(JSON.parse(m.shaders)); } catch (e: any) { log("[RED] page: the shader library is not JSON: " + e.message); } }
      await load(m.files, shaders, 0, undefined, { nxsl: m.nxsl, rom: m.rom });
    } else if (m.type === "pause") rt?.requestPause();
    else if (m.type === "resume") { if (rt && rt.state === "Paused") go(rt); }
    else if (m.type === "stop") { if (rt) await endProcess(rt); status(); }
    else if (m.type === "input") input.set(m.pad);
  } catch (e: any) { log("[RED] page: " + (e?.stack ?? e)); }
};
