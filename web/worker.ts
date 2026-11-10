// The page's Worker: the whole runtime (translator, loader, kernel, graphics recorder and WebGPU replayer) and the
// run loop. Slices are synchronous; runAsync() returns to this Worker's event loop between them and while every
// guest thread waits, so messages (pause, stop, input) and WebGPU completions are handled.
import { Runtime, FAULT_NAMES, type RuntimeModules } from "../src/glue/rt_runtime.ts";
import { RtGfx } from "../src/glue/rt_gfx.ts";
import { RtInput, registerVi, registerHid } from "../src/glue/rt_hle.ts";
import { demoShaders } from "../test/runtime/gfx_cases.ts";

const post = (m: any) => (self as any).postMessage(m);
let mods: RuntimeModules | undefined, device: any = null, gpuInfo = "no WebGPU: the null replayer (nothing is drawn)", canvas: any = null;
let rt: Runtime | undefined, gfx: RtGfx | undefined, modules = "", ratio: number | undefined, running = false;
const input = new RtInput();
let pending: { text: string; kind: string }[] = [];
const log = (text: string, kind = text.startsWith("[RED] ") ? "red" : "") => { pending.push({ text, kind }); };

async function init() {
  const mod = async (n: string) => WebAssembly.compileStreaming(fetch(`wasm/${n}.wasm`));
  const [r, kernel, loader, translator, helpers, g] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx"].map(mod));
  mods = { rt: r, kernel, loader, translator, helpers, gfx: g };
  const gpu = (navigator as any).gpu, adapter = gpu ? await gpu.requestAdapter() : null;
  if (adapter) { device = await adapter.requestDevice(); gpuInfo = "WebGPU: " + (adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "adapter"); }
  log("page: runtime modules compiled; " + gpuInfo);
}
const ready = init().catch(e => log("[RED] page: " + (e?.message ?? e)));

async function load(files: { name: string; bytes: Uint8Array }[], shaders: [string, any][], frames: number, r: number | undefined) {
  await ready;
  if (!mods) return;
  // the process before this one ends here: its threads, its translated code and its graphics objects are released
  if (rt) { rt.kill(); await runDone; }
  ratio = r; stdoutSeen = 0; last = undefined;
  const me = rt = new Runtime(mods, { clock: "wall", log: l => log(l) });
  gfx = new RtGfx(me, mods.gfx!, { device: device ?? undefined, canvas: device ? canvas : undefined, nextFrame: () => new Promise(res => (self as any).requestAnimationFrame(res)) });
  for (const [key, info] of shaders) if (gfx.registerShader(key, info) < 0) log(`[RED] page: shader ${key} was not accepted`);
  registerVi(me); registerHid(me, input);
  const g = gfx; input.frame = () => g.stats.frames;
  me.register({ name: "demo_frames", fn: () => frames });
  if (!me.loadNso(files)) { status(); return; }
  modules = me.modules.map(m => `${m.name} 0x${m.base.toString(16)}+0x${m.imageSize.toString(16)}`).join(", ") + `; ${me.set!.unresolved.length} unresolved imports`;
  status();
  go(me);
}
let runDone: Promise<void> = Promise.resolve();
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
  const m: any = { type: "status", state: rt?.state ?? "Empty", frames: gfx?.stats.frames ?? 0, nvnCalls: gfx?.stats.nvnCalls ?? 0, waiting: rt?.waitingOutside ?? 0, modules, gpu: gpuInfo };
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
      await load(m.files, shaders, 0, undefined);
    } else if (m.type === "pause") rt?.requestPause();
    else if (m.type === "resume") { if (rt && rt.state === "Paused") go(rt); }
    else if (m.type === "stop") { rt?.kill(); status(); }
    else if (m.type === "input") input.set(m.pad);
  } catch (e: any) { log("[RED] page: " + (e?.stack ?? e)); }
};
