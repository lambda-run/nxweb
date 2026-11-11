// The page's Worker: the whole runtime (translator, loader, kernel, graphics recorder and WebGPU replayer, the
// take-over table, audio, the file system) and the run loop. Slices are synchronous; runAsync() returns to this
// Worker's event loop between them and while every guest thread waits, so messages (pause, stop, input, the audio
// device's reports) and WebGPU completions are handled.
// What the page shows comes from the modules' machines and counters (src/glue/rt_report.ts); no log text is parsed.
import { Runtime, FAULT_NAMES, GUARD_DEFAULT, type RuntimeModules } from "../src/glue/rt_runtime.ts";
import { RtGfx } from "../src/glue/rt_gfx.ts";
import { GfxHost } from "../src/glue/gfx_host.ts";
import { RtInput, KEYBOARD, type PadState } from "../src/glue/rt_input.ts";
import { demoShaders } from "../test/runtime/gfx_cases.ts";
import { webCacheStore, hasMemory64 } from "../src/glue/a64_host.ts";
import { RtShaders, workerTranslator, webShaderStore, type ShaderTranslator } from "../src/glue/rt_shaders.ts";
import { RtFs } from "../src/glue/rt_fs.ts";
import { RtAudio } from "../src/glue/rt_audio.ts";
import { MemStorage, BlobDevice, FS_KIND, type FsStorage } from "../src/glue/fs_host.ts";
import { romfsOfFile } from "../src/glue/fs_romfs_one.ts";
import { OpfsStorage } from "../src/glue/fs_dev_opfs.ts";
import { attachHle } from "../src/glue/hle_rt.ts";
import type { HleHost } from "../src/glue/hle_host.ts";
import { OUT_S } from "../src/glue/audio_host.ts";
import { handoffOptions, type HandoffOptions } from "../src/glue/rt_handoff.ts";
import { layoutFor, nsoImageBytes, CODE_SPARE, SPACE } from "../src/glue/rt_process.ts";
import { storageFromMessage, type HandOffMessage } from "../src/prepare/host/prepare.ts";
import { scanLines } from "../src/glue/a64_scan.ts";
import { PrepWasm } from "../src/prepare/host/wasm.ts";
import { moduleRows, takeovers, machineRows, refusedTotal, reportText, type KitPart, type ModuleRow, type TakeoverSummary } from "../src/glue/rt_report.ts";

const post = (m: any, t: Transferable[] = []) => (self as any).postMessage(m, t);
let mods: RuntimeModules | undefined, device: any = null, gpuInfo = "no WebGPU: the null replayer (nothing is drawn)", canvas: any = null;
let rt: Runtime | undefined, gfx: RtGfx | undefined, ratio: number | undefined, running = false;
let input: RtInput | undefined, audio: RtAudio | undefined;
let pending: { text: string; kind: string }[] = [];
const history: { text: string; kind: string }[] = [];   // the last 400 lines, for the report
let redTotal = 0;
const log = (text: string, kind = text.startsWith("[RED] ") ? "red" : "") => {
  pending.push({ text, kind }); history.push({ text, kind }); if (history.length > 400) history.shift();
  if (kind === "red") redTotal++;
};
// The guard (guest loads and stores below 0x0800_0000 trap instead of reading or corrupting host state). What the
// next process gets: the runtime's default, what the page's box says, or on because the process before it ended in a
// fault (guardAuto): a second run of a crashing program then names the instruction of a wild access exactly.
let guardWanted: boolean = GUARD_DEFAULT, guardAuto = false, guardNow: boolean = GUARD_DEFAULT;

const requestDevice = async (): Promise<any> => {
  const gpu = (navigator as any).gpu, adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) return null;
  // every feature the replayer can use and the adapter's own per-stage limits
  const desc = GfxHost.deviceDescriptor(adapter), d = await adapter.requestDevice(desc);
  gpuInfo = "WebGPU: " + (adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "adapter") +
    `; ${desc.requiredFeatures.length} features (${desc.requiredFeatures.join(", ") || "none"}); per stage: ${d.limits.maxUniformBuffersPerShaderStage} uniform buffers, ${d.limits.maxSampledTexturesPerShaderStage} textures, ${d.limits.maxStorageBuffersPerShaderStage} storage buffers`;
  // where the times in a game's GPU counter reports come from (src/gfx/README.md, "Counter reports")
  gpuInfo += "; GPU times: " + (d.features?.has?.("timestamp-query") ? "WebGPU timestamp queries" : "estimated on the CPU (this device has no timestamp-query)");
  return d;
};
// The modules built for a 64-bit memory (wasm/<name>64.wasm), fetched and compiled when the first process needs them:
// a game whose profile does not fit a 32-bit memory (rt_process.ts layoutChoice; the hand-off's options say so), or
// any program when the page was opened with ?mem64=1 (for measuring the mode)
let mods64: Promise<RuntimeModules> | undefined;
const forceMem64 = new URLSearchParams(self.location?.search ?? "").get("mem64") === "1";
const precise = ({ "1": 1, "2": 2 } as const)[new URLSearchParams(self.location?.search ?? "").get("precise") ?? ""];
// ?ndve=bypass: a bilinear stand-in for nn::ndve's movie network when its dispatches cannot run (diagnostic, src/glue/ndve.ts)
const ndve = new URLSearchParams(self.location?.search ?? "").get("ndve") === "bypass" ? "bypass" as const : undefined;
// ?pace=timer: display frames come from a 16 ms timer in this Worker, not from requestAnimationFrame, which the browser stops for a hidden or covered page
// (runs that nobody watches: the development loop). Off by default: a watched picture should follow the display
const timerPace = new URLSearchParams(self.location?.search ?? "").get("pace") === "timer";
// (a browser also slows a hidden page's timers: the 16 ms are counted by messages to this Worker itself, which it does not slow)
const spinChannel = new MessageChannel();
// One list of waiting callbacks, looked at on every message while it is not empty (several may wait at once: the frame clock and the run loop)
const spinWaiting: { at: number; fn: () => void }[] = [];
spinChannel.port1.onmessage = () => {
  const now = performance.now();
  for (let i = spinWaiting.length - 1; i >= 0; i--) if (spinWaiting[i].at <= now) { const w = spinWaiting[i]; spinWaiting.splice(i, 1); w.fn(); }
  if (spinWaiting.length) spinChannel.port2.postMessage(0);
};
function spinTimer(fn: () => void, ms: number): void { spinWaiting.push({ at: performance.now() + ms, fn }); if (spinWaiting.length === 1) spinChannel.port2.postMessage(0); }
function spinFor(ms: number): Promise<void> { return new Promise(res => spinTimer(res, ms)); }
// ?canvas=off: nothing is presented to the page's canvas (a hidden page's canvas holds every present back); the frames are still drawn, and a frame
// capture shows them. For runs nobody watches
const noCanvas = new URLSearchParams(self.location?.search ?? "").get("canvas") === "off";
// ?shaderdump=<url>: every stage the in-page translator fails on is POSTed there as <url>/sh-<key>.bin (u32 control length, control, code), so the
// chain can be run on it outside the page (debugging; off by default, and the bytes go only where the URL says)
const shaderDump = new URLSearchParams(self.location?.search ?? "").get("shaderdump");
const dumpFailed = shaderDump ? (b: { key: string; control: Uint8Array; code: Uint8Array }) => {
  const body = new Uint8Array(4 + b.control.length + b.code.length);
  new DataView(body.buffer).setUint32(0, b.control.length, true); body.set(b.control, 4); body.set(b.code, 4 + b.control.length);
  void fetch(`${shaderDump}/sh-${b.key}.bin`, { method: "POST", body }).catch(() => {});
} : undefined;
function modules64(): Promise<RuntimeModules> {
  return mods64 ??= (async () => {
    const mod = async (n: string) => WebAssembly.compileStreaming(fetch(`wasm/${n}64.wasm`));
    const [r, kernel, loader, translator, helpers, g, fsm, hlem, aud] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs", "hle", "audio"].map(mod));
    return { rt: r, kernel, loader, translator, helpers, gfx: g, fs: fsm, hle: hlem, audio: aud };
  })();
}
async function init() {
  const mod = async (n: string) => WebAssembly.compileStreaming(fetch(`wasm/${n}.wasm`));
  const [r, kernel, loader, translator, helpers, g, fsm, hlem, aud] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs", "hle", "audio"].map(mod));
  mods = { rt: r, kernel, loader, translator, helpers, gfx: g, fs: fsm, hle: hlem, audio: aud };
  // the in-page shader translator, when the build put its files beside the page (build/web/shaders)
  try { device = await requestDevice(); } catch (e: any) { gpuInfo = "no WebGPU device (" + (e?.message ?? e) + "): the null replayer (nothing is drawn)"; }
  // (after the device: whether it has WebGPU subgroups decides how warp operations are translated)
  try { if ((await fetch("shaders/xlate_wasm/_framework/dotnet.js", { method: "HEAD" })).ok && (await fetch("shaders/nx_naga.wasm", { method: "HEAD" })).ok)
    shaderTranslator = workerTranslator({ worker: "shader_worker.js", framework: new URL("shaders/xlate_wasm/_framework", location.href).href, naga: new URL("shaders/nx_naga.wasm", location.href).href, subgroups: GfxHost.hasSubgroups(device) }); } catch { /* none */ }
  log("page: runtime modules compiled; " + gpuInfo);
}
const ready = init().catch(e => log("[RED] page: " + (e?.message ?? e)));

let lastVideo = 0;
let shaderTranslator: ShaderTranslator | undefined, shaderLookup: RtShaders | undefined, hle: HleHost | undefined, fsys: RtFs | undefined, cacheNote = "", fsNote = "";
let modRows: ModuleRow[] = [], tk: TakeoverSummary | null = null, optionsNote = "", title = "";
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
interface LoadOptions { nxsl?: Uint8Array; rom?: Blob; hooks?: (me: Runtime) => void; name?: string; game?: HandoffOptions; storage?: FsStorage; canvas?: [number, number] }
// the canvas is the size of the image a program presents: 480x270 unless the load says otherwise
const CANVAS: [number, number] = [480, 270];
async function load(files: { name: string; bytes: Uint8Array }[], shaders: [string, any][], r: number | undefined, o: LoadOptions = {}) {
  await ready;
  if (!mods) return;
  scanReport = nextScan; nextScan = undefined;
  // the process before this one ends here: its threads, its translated code and its graphics objects are released
  if (rt) { await endProcess(rt); await runDone; }
  ratio = r; stdoutSeen = 0; last = undefined;
  const [cw, ch] = o.canvas ?? CANVAS;
  if (canvas && (canvas.width !== cw || canvas.height !== ch)) { canvas.width = cw; canvas.height = ch; }
  post({ type: "canvas", width: cw, height: ch });
  const storage = o.storage ?? await storageFor(files[0].bytes, o.rom);
  const guard = guardNow = guardWanted, game = o.game;
  // files given to the page directly: the default layout, unless their images need a larger code region than it has
  const code = files.reduce((a, f) => a + nsoImageBytes(f.bytes) + 0x1000, 0);
  const layout = game?.layout ?? (code + CODE_SPARE > SPACE.codeSize ? layoutFor({ code }) : undefined);
  // a prepared game: its address space, kernel settings and stack from its profile and NPDM (rt_handoff.ts)
  // the memory mode: the layout's (a profile that is short in 32 bits comes with the layout for a 64-bit memory)
  const mem64 = !!layout?.mem64 || forceMem64;
  let set = mods;
  if (mem64) {
    try { if (!hasMemory64()) throw new Error("this browser has no 64-bit WebAssembly memory"); set = await modules64(); }
    catch (e: any) { log(`[RED] page: this program needs the 64-bit memory mode and it cannot be had here (${e?.message ?? e})`); rt = undefined as any; status(); return; }
  }
  const me = rt = new Runtime(set, { timer: timerPace ? spinTimer : undefined, clock: "wall", guard, preciseFaults: precise, log: l => log(l), cache: typeof caches !== "undefined" ? webCacheStore() : undefined,
    layout, mainStackSize: game?.mainStackSize, cutsKey: game?.cutsKey });
  optionsNote = (mem64 ? `64-bit memory mode${game?.choice?.mem64 ? ` (the profile does not fit 4 GB: ${game.choice.sentence})` : " (asked for with ?mem64=1)"}, ` : "") + `wall clock, budget ${me.opts.budget}, host-area guard ${guard ? "on" + (guardAuto ? " (turned on because the run before this one ended in a fault)" : "") : "off"}` +
    (game ? `; layout from the profile (${game.layout.fit}): heap ${(game.layout.heapSize / 2 ** 30).toFixed(2)} GB, alias ${(game.layout.aliasSize / 2 ** 30).toFixed(2)} GB, pool ${(game.layout.appPool / 2 ** 30).toFixed(2)} GB` : "; the default layout");
  for (const n of game?.notes ?? []) log("page: " + n);
  faultSeen = false;
  title = `nxweb report: ${o.name ?? files.map(f => f.name).join(" + ")}`;
  // a lost device: the replayer asks here for a new one (the page's test button destroys the device on purpose)
  gfx = new RtGfx(me, set.gfx!, { device: device ?? undefined, canvas: device && !noCanvas ? canvas : undefined, nextFrame: timerPace ? () => spinFor(16) : () => new Promise(res => (self as any).requestAnimationFrame(res)),
    requestDevice: async () => { device = await requestDevice(); return device; }, profile: game?.gfx, ndve });
  // shaders: a library the user gave first, then translation in the page (stored by key and chain version)
  // a game's picture has the size the game presents (the demos keep the canvas they ask for)
  if (game) { gfx.host.fitCanvas = true; gfx.host.onCanvasSize = (width, height) => post({ type: "canvas", width, height }); }
  try { shaderLookup = new RtShaders(gfx, { library: o.nxsl, translator: shaderTranslator, store: typeof caches !== "undefined" ? webShaderStore() : undefined, onFailed: dumpFailed }); }
  catch (e: any) { log("[RED] page: the shader library was refused: " + (e?.message ?? e)); shaderLookup = new RtShaders(gfx, { translator: shaderTranslator }); }
  // the SDK take-overs, with nn::vi's present side from the graphics glue (vsync events tick at every present). The
  // controller applet's prompt is a dialog of the page, vibration goes to the player's controller; the input box, the
  // web view, shared fonts and native images have no page side yet (the table answers as nxnative does windowless)
  const myInput: { v?: RtInput } = {};
  hle = attachHle(me, set.hle!, { config: { opmode: 1, ...game?.hle }, gfx, front: {
    ctrlPrompt: (min, max, answer) => { ctrlAnswer = answer; post({ type: "ctrlPrompt", min, max }); return true; },
    vibration: s => { const source = myInput.v?.sourceOf(s.player) ?? 0; if (source) post({ type: "vibration", source, low: Math.max(s.motors[0].amplitudeLow, s.motors[1].amplitudeLow), high: Math.max(s.motors[0].amplitudeHigh, s.motors[1].amplitudeHigh) }); },
  } });
  input = myInput.v = new RtInput(hle);
  for (const [source, pad] of sources) input.set(source, pad);   // what is held or connected right now
  const g = gfx, inp = input;
  g.onPresentQueued(f => inp.frame(f));
  audio = new RtAudio(me, set.audio!, { hle, send: (m, t) => post(m, t ?? []) });
  fsys = new RtFs(me, set.fs!, storage, game ? { programId: game.programId } : undefined);
  for (const [key, info] of shaders) if (gfx.registerShader(key, info) < 0) log(`[RED] page: shader ${key} was not accepted`);
  o.hooks?.(me);
  // which transitions each machine takes in this process (the machines table)
  for (const p of kitParts()) p.x.kit_cover_enable(1);
  if (!me.loadNso(files)) { modRows = []; tk = null; status(); return; }
  modRows = moduleRows(me); tk = takeovers(me);
  const got = await me.cacheLoad();
  cacheNote = got.units ? `${got.units} translated units from the cache (${(got.bytes / 1e6).toFixed(1)} MB)` : "no translation cache entry yet";
  // new translations are stored a little after the start, and again when the process is stopped
  setTimeout(() => { if (rt === me && !me.disposed) me.cacheSave(); }, 5000);
  status();
  go(me);
}
let ctrlAnswer: ((ok: boolean) => void) | null = null;
let prepWasm: PrepWasm | undefined;
const sources = new Map<number, PadState | null>();
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
function kitParts(): { name: string; x: KitPart }[] {
  if (!rt) return [];
  const p: { name: string; x: KitPart }[] = [{ name: "runtime", x: rt.r }, { name: "kernel", x: rt.k }, { name: "loader", x: rt.ld.x as unknown as KitPart }];
  if (gfx) p.push({ name: "gfx", x: gfx.x });
  if (fsys) p.push({ name: "fs", x: fsys.x as unknown as KitPart });
  if (hle) p.push({ name: "hle", x: hle.x as unknown as KitPart });
  if (audio) p.push({ name: "audio", x: audio.x as unknown as KitPart });
  return p;
}
const STATES = ["Empty", "Loading", "Ready", "Running", "Paused", "Stopped"];
// The state now of the machines this page can ask: read from each module's own exports
function liveStates(): Record<string, string> {
  const s: Record<string, string> = {};
  if (!rt) return s;
  const kind = rt.r.rt_stop_kind();
  s.process = STATES[rt.r.rt_state()] + (kind ? ` (${["", "exit", "break", "fault", "killed"][kind]} ${kind === 3 ? FAULT_NAMES[rt.r.rt_stop_value()] : rt.r.rt_stop_value() | 0})` : "");
  if (rt.disposed) return s;
  const reasons = rt.k.kernel_clock_reasons();
  s.guest_clock = reasons ? "frozen (reasons " + ["hold", "background", "keyboard"].filter((_, i) => reasons >> i & 1).join(", ") + ")" : "running";
  if (hle) {
    const focus = ["", "InFocus", "OutOfFocus", "Background"];
    s.oe_focus = `the front end reports ${focus[hle.x.hle_focus_front()] ?? "?"}, the game sees ${focus[hle.x.hle_focus_seen()] ?? "?"}`;
    s.hle_exit = hle.exit.state + (hle.exit.reason ? ` (${hle.exit.reason})` : "");
    s.input_hold = hle.holds.length ? "Holding (" + hle.holds.join(", ") + ")" : "Released";
    s.ctrl_prompt = ["Idle", "Asking", "Answered"][hle.x.hle_ctrl_state()] ?? "?";
    s.pad_slot = input && input.players.length ? input.players.map(p => `player ${p.player + 1} Held(source ${p.source})`).join(", ") : "no controller holds a slot (the keyboard is player 1)";
  }
  if (audio) {
    const outs = audio.host.outs();
    s.audio_out = outs.length ? outs.map(o => `#${o.id} ${o.state} (${o.pending} pending)`).join(", ") : "no output open";
    if (audio.device) s.audio_out += `; device ${audio.device.error ? "none (" + audio.device.error + ")" : `${audio.device.rate} Hz over ${audio.device.transport}, context ${audio.device.context}`}`;
  }
  if (gfx) s.gfx_device = (gfx.live ? ["Live", "Lost"][gfx.x.gfx_device_state()] ?? "?" : "none (the null replayer)") + (gfx.stats.deviceLosses ? `, lost ${gfx.stats.deviceLosses} time${gfx.stats.deviceLosses === 1 ? "" : "s"}, restored ${gfx.stats.deviceRestores}` : "");
  return s;
}
function counters(): Record<string, string | number> {
  if (!rt) return {};
  const c: Record<string, string | number> = { slices: rt.stats.slices, SVCs: rt.stats.svcs, "host calls": rt.stats.hostCalls, "budget units": rt.units, "translated units": rt.disposed ? 0 : rt.a64.units.length,
    "instructions translated": rt.a64.translatedInsns, "module loads at run time": rt.stats.moduleLoads, "threads waiting outside the guest": rt.waitingOutside, "kit refusals": rt.disposed ? "-" : refusedTotal(kitParts()) };
  if (!rt.disposed) {
    const l = rt.libcStats.filter(x => x.calls);
    c["libc intrinsic calls"] = l.length ? l.map(x => `${x.name} ${x.calls} (${(x.bytes / 1048576).toFixed(1)} MB)`).join(", ") : "none (no module defines memcpy, strlen, ... or none was called)";
    const sh = shaderLookup?.stats, ws = shaderTranslator?.stats;
    // where in-page shader translation time went (RtShaders, workerTranslator): each stage's own split is its "arrived" log line
    if (sh && ws) c["shader translation in the page"] = `${sh.translated} translated by ${ws.started} of ${ws.workers} Workers in ${ws.batches} batches; at most ${ws.maxQueued} waiting; ` +
      `arrival ${sh.translated + sh.fromStore ? (sh.translateMs / (sh.translated + sh.fromStore)).toFixed(0) : 0} ms on average, ${sh.maxMs.toFixed(0)} ms the slowest; ${sh.prioritized} moved to the front for a draw that waited`;
  }
  if (gfx) Object.assign(c, { frames: gfx.stats.frames, "NVN calls": gfx.stats.nvnCalls, "SyncWait parked / timed out": `${gfx.stats.syncParked} / ${gfx.stats.syncTimeouts}`, "QueueFinish parked": gfx.stats.finishParked });
  if (audio) Object.assign(c, { "nn::audio calls": audio.stats.calls, "audio ticks": audio.stats.ticks, "audio event signals": audio.stats.signals });
  if (fsys) c["nn::fs calls"] = fsys.stats.calls;
  if (input) c["input snapshots published"] = input.publishes;
  return c;
}
let faultSeen = false;
let stdoutSeen = 0, last: { t: number; frames: number; units: number; loop: number; host: number; exec: number } | undefined;
function status() {
  const sh = shaderLookup?.stats;
  const more = rt ? `${cacheNote}; ${rt.disposed ? 0 : rt.a64.units.length} units, ${rt.a64.translatedInsns} instructions translated now; shaders: ${sh ? `${sh.registered} ready (${sh.fromLibrary} library, ${sh.fromStore} stored, ${sh.translated} translated), ${sh.failed} failed, ${sh.readAhead} read ahead, the game waited ${sh.waits} times for ${(sh.waitMs / 1000).toFixed(1)} s` : "–"}${shaderTranslator ? "" : ", no in-page translator"}; ${fsNote}${fsys ? `, ${fsys.stats.calls} nn::fs calls` : ""}` : "";
  const m: any = { type: "status", more, state: rt ? STATES[rt.r.rt_state()] : "Empty", frames: gfx?.stats.frames ?? 0, nvnCalls: gfx?.stats.nvnCalls ?? 0, waiting: rt?.waitingOutside ?? 0, gpu: gpuInfo, options: optionsNote, redTotal, guard: { now: guardNow, next: guardWanted, auto: guardAuto, byDefault: GUARD_DEFAULT },
    modules: modRows, takeovers: tk };
  if (rt && doomState?.rt === rt) m.doom = { ...doomState, rt: undefined };
  if (rt) {
    // why it stopped: the data the process machine's Stopped state carries (kind << 32 | value), read from the runtime core
    const kind = rt.r.rt_stop_kind(), value = rt.r.rt_stop_value();
    m.stopKind = ["", "exit", "break", "fault", "killed"][kind]; m.stopValue = value | 0; m.faultName = kind === 3 ? FAULT_NAMES[value] : "";
    // a fault without the guard: the next run gets it, so that a wild pointer is caught at its instruction
    if (kind === 3 && !faultSeen) {
      faultSeen = true;
      if (!guardNow && !guardWanted) { guardWanted = true; guardAuto = true; log("page: this run ended in a fault with the host-area guard off: the guard is on for the next run, which reports an access below 0x8000000 (a null or host-area pointer) at the exact instruction instead of going on with wrong data"); }
    }
    if (!rt.disposed) m.machines = machineRows(rt.memory, kitParts(), liveStates());
    const out = rt.stdout();
    if (out.length > stdoutSeen) { for (const l of out.slice(stdoutSeen).split("\n")) if (l) log(l, "out"); stdoutSeen = out.length; }
    const now = { t: performance.now(), frames: gfx!.stats.frames, units: rt.units, loop: rt.stats.runMs, host: rt.times.hostMs, exec: gfx!.times.execMs };
    if (last && now.t > last.t && rt.state === "Running") {
      const dt = (now.t - last.t) / 1000, df = now.frames - last.frames;
      m.fps = df / dt; m.ups = (now.units - last.units) / dt;
      const vp = hle?.videoPictures ?? 0; m.video = (vp - lastVideo) / dt; lastVideo = vp;   // movie pictures a second (0: no movie is playing)
      if (ratio !== undefined) { m.ips = m.ups * ratio; m.ratio = ratio; }
      if (df > 0) {
        const loop = (now.loop - last.loop) / df, host = (now.host - last.host) / df, exec = (now.exec - last.exec) / df;
        m.split = `translated code ${(loop - host).toFixed(2)} ms, host calls ${(host - exec).toFixed(2)} ms, WebGPU ${exec.toFixed(2)} ms, idle ${Math.max(0, dt * 1000 / df - loop).toFixed(2)} ms`;
        m.ms = { code: loop - host, host: host - exec, gpu: exec, idle: Math.max(0, dt * 1000 / df - loop) };   // the same, as numbers for the overlay
      }
    }
    last = now;
  }
  post(m);
  if (pending.length) { post({ type: "log", lines: pending }); pending = []; }
}
setInterval(status, 250);
// The bug report: one block of text. Machine states, the modules, counters, the adapter, the options key, the last
// 200 log lines. Nothing of it is read from guest memory: the guest's own output lines are left out.
// which build this is (build.json beside the worker script), for the report
let buildStamp = "unknown";
fetch("build.json", { cache: "no-store" }).then(r => r.json()).then((b: { commit: string; branch: string; dirty: boolean; date: string; md5: string }) => {
  buildStamp = `${b.commit}${b.dirty ? "+changes" : ""} (${b.branch}), built ${b.date}, md5 ${b.md5}`;
}, () => {});
function report(userAgent: string): string {
  const lines = history.filter(l => l.kind !== "out").map(l => l.text);
  const fault = rt && rt.r.rt_stop_kind() === 3 ? rt.stopInfo?.fault?.lines ?? [] : [];
  const live = liveStates();
  return reportText({ title: title || "nxweb report (no program loaded)", build: buildStamp, when: new Date().toISOString(), userAgent, adapter: gpuInfo, optionsKey: rt && !rt.disposed ? rt.a64.optionsKey() : lastOptionsKey || "-", options: optionsNote || "-",
    state: rt ? STATES[rt.r.rt_state()] : "Empty", stop: live.process?.match(/\((.*)\)$/)?.[1] ?? "", fault, modules: modRows, takeovers: tk,
    machines: rt && !rt.disposed ? machineRows(rt.memory, kitParts(), live) : lastMachines, counters: counters(), hot: rt && !rt.disposed ? rt.hotCode() : undefined, idle: rt && !rt.disposed ? rt.idleWaitLines() : undefined, fs: fsys ? fsys.lines() : undefined,
    frames: gfx && rt && !rt.disposed ? gfx.host.ledger.frames : undefined, firstDrawn: gfx && rt && !rt.disposed ? gfx.host.ledger.firstDrawn : undefined,
    shaderKeys: shaderLookup && rt && !rt.disposed ? shaderLookup.reportLines() : undefined, log: lines.slice(-200), redTotal, scan: scanReport });
}
let lastMachines: ReturnType<typeof machineRows> = [], lastOptionsKey = "";
let scanReport: string[] | undefined;   // the instruction scan of the program that is loaded, when the prepare step handed it off (its Code stage)
let nextScan: string[] | undefined;
// what the report says of a process after it was disposed of: its machines as they were at the end
function remember(p: Runtime): void { if (p === rt && !p.disposed) { lastMachines = machineRows(p.memory, kitParts(), liveStates()); lastOptionsKey = p.a64.optionsKey(); } }

// The built-in demos: guests built from test/runtime/src, nothing from any game
// Doom: the doomgeneric engine as a guest (test/doom; built only when the engine is on the build machine). Its data
// file is the build's copy, or the file the user gave the page; here it becomes the one file of a RomFS image.
let doomWad: Uint8Array | undefined;
async function doom(wad?: Uint8Array) {
  if (wad) doomWad = wad;
  const info = await fetch("demo/doom.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));
  if (!info.present) { log("[RED] page: this build has no Doom demo (the engine was not on the build machine: tools/doom/fetch.sh, then npm run web:build)"); return; }
  if (!doomWad && info.wad) doomWad = new Uint8Array(await fetch("demo/doom1.wad").then(r => r.arrayBuffer()));
  if (!doomWad) { log("page: Doom needs its data file: choose doom1.wad (the shareware episode) with the button beside the Doom button, or drop it on the page"); post({ type: "needwad" }); return; }
  if (String.fromCharCode(...doomWad.subarray(0, 4)) !== "IWAD") log(`[RED] page: the data file does not start with "IWAD" (${doomWad.length} bytes): the engine will probably refuse it`);
  const bytes = new Uint8Array(await fetch("demo/doom.nso").then(r => r.arrayBuffer()));
  const rom = new Blob(romfsOfFile("doom1.wad", doomWad) as unknown as BlobPart[]);
  // the process before this one ends first: it holds the save files this one is about to open
  if (rt) { await endProcess(rt); await runDone; }
  // saves in OPFS as for any program; where there is no OPFS the data file is still attached (a Blob read synchronously)
  const storage = await storageFor(bytes, rom);
  if (storage instanceof MemStorage) { storage.setImage(FS_KIND.ROM, 0, new BlobDevice(rom)); fsNote += "; the data file is attached all the same"; }
  await load([{ name: "doom", bytes }], await demoShaders(), info.instructionsPerUnit, { name: "Doom (doomgeneric, doom.nso)", storage, canvas: [1280, 720],
    hooks: me => {
      // the guest tells every frame's game facts (test/doom/guest/dg_nx.c DoomState): the page shows the newest
      me.register({ name: "doom_frame", fn: cpu => { const st = new Int32Array(me.memory.buffer, Number(cpu.x(2)), 10); doomState = { rt: me, gametic: cpu.w(0), gamestate: st[0], menu: !!st[1], demo: !!st[2], usergame: !!st[3], map: st[4], health: st[5], bullets: st[6], x: st[7], y: st[8], angle: st[9] >>> 0 }; return 0; } });
      me.register({ name: "doom_args", fn: () => 0 });
    } });
}
let doomState: { rt: Runtime; gametic: number; gamestate: number; menu: boolean; demo: boolean; usergame: boolean; map: number; health: number; bullets: number; x: number; y: number; angle: number } | undefined;
async function demo(which: string) {
  if (which === "tone") {
    // nn::audio: a 440 Hz tone, five seconds of 5 ms buffers refilled on the buffer-released event
    const nso = await fetch("demo/tone.nso").then(r => r.arrayBuffer());
    await load([{ name: "tone", bytes: new Uint8Array(nso) }], [], undefined, { name: "the audio demo (tone.nso)", hooks: me => me.register({ name: "tone_buffers", fn: () => 1000 }) });
    return;
  }
  const [nso, info] = await Promise.all([fetch("demo/cube.nso").then(r => r.arrayBuffer()), fetch("demo/demo.json").then(r => r.json())]);
  await load([{ name: "cube", bytes: new Uint8Array(nso) }], await demoShaders(), info.instructionsPerUnit, { name: "the built-in demo (cube.nso)", hooks: me => me.register({ name: "demo_frames", fn: () => 0 }) });
}

// The messages that end or make a process take turns: two loads at once would both end the old process, then both
// make one, and the first would run on unseen while the second never starts (run loop already taken)
let turn: Promise<void> = Promise.resolve();
const PROCESS = new Set(["demo", "load", "handoff", "resume", "stop"]);
self.onmessage = (ev: MessageEvent) => {
  if (!PROCESS.has(ev.data?.type) || ev.data.audio) { void handle(ev); return; }
  const mine = turn.then(() => handle(ev));
  turn = mine.catch(() => { /* handle logs its own */ });
};
async function handle(ev: MessageEvent): Promise<void> {
  const m = ev.data;
  try {
    if (m.audio) { audio?.handle(m); rt?.requestWake(); }
    else if (m.type === "init") canvas = m.canvas;
    else if (m.type === "demo" && m.which === "doom") await doom(m.wad);
    else if (m.type === "demo") await demo(m.which ?? "cube");
    else if (m.type === "load") {
      let shaders: [string, any][] = [];
      if (m.shaders) { try { shaders = Object.entries(JSON.parse(m.shaders)); } catch (e: any) { log("[RED] page: the shader library is not JSON: " + e.message); } }
      await load(m.files, shaders, undefined, { nxsl: m.nxsl, rom: m.rom, hooks: me => me.register({ name: "demo_frames", fn: () => 0 }) });
    } else if (m.type === "handoff") {
      // the prepare step's hand-off: code modules as Blobs (cuts applied), the RomFS and add-on contents as devices
      // over the folder's files, saves in OPFS under the hand-off's name
      const msg = m.msg as HandOffMessage, files: { name: string; bytes: Uint8Array }[] = [];
      nextScan = (msg.scan ?? []).flatMap(s => scanLines(s.module, s.scan));   // for the report: what of this game's code the translator does not have
      for (const mod of msg.modules) files.push({ name: mod.name, bytes: new Uint8Array(await mod.file.arrayBuffer()) });
      let saves: FsStorage;
      // a container's files are checked against their SHA-256 as they are first read: the prepare module's hash
      const nup = msg.rom?.nup ?? msg.aoc.find(a => a.image.nup)?.image.nup;
      if (nup) { try { prepWasm ??= new PrepWasm(await WebAssembly.compileStreaming(fetch("wasm/prepare.wasm"))); } catch (e: any) { log(`[RED] page: the prepare module could not be loaded (${e?.message ?? e}): the files of ${nup.name} are read unchecked`); } }
      const from = nup ? `out of ${nup.name} (${(nup.file.size / 2 ** 20).toFixed(1)} MB, read in place)` : "from the folder";
      try { const st = new OpfsStorage(msg.saveId + (new URLSearchParams(self.location?.search ?? "").get("save") ?? "")); /* ?save=<suffix>: another save folder */ await st.preopen(FS_KIND.SAVE); await st.preopen(FS_KIND.DEVICE_SAVE); saves = st; fsNote = `saves in OPFS under ${msg.saveId}, RomFS of ${msg.rom?.sizes.length ?? 0} files ${from}, ${msg.aoc.length} add-on contents`; }
      catch (e: any) { saves = new MemStorage(); fsNote = `no OPFS here (${e?.message ?? e}): saves are kept in memory`; }
      await load(files, [], undefined, { name: `${msg.name} (${msg.titleId}, ${msg.displayVersion ?? "v" + msg.version})`, game: handoffOptions(msg, { codeBytes: files.reduce((a, f) => a + nsoImageBytes(f.bytes) + 0x1000, 0), mem64: "auto" }), storage: storageFromMessage(msg, saves, { sha256: prepWasm ? b => prepWasm!.sha256(b) : undefined, log: l => log(l) }),
        hooks: me => me.register({ name: "demo_frames", fn: () => 0 }) });
    }
    else if (m.type === "pause") rt?.requestPause();
    else if (m.type === "resume") { if (rt && rt.state === "Paused") go(rt); }
    else if (m.type === "stop") { if (rt) { remember(rt); await endProcess(rt); } status(); }
    else if (m.type === "input") {
      // one source's state: the keyboard (source 1) or a controller by its stable id; null: the controller went away
      if (m.pad) sources.set(m.source, m.pad); else sources.delete(m.source);
      const player = input && rt && !rt.disposed ? input.set(m.source, m.pad) : -1;
      if (m.source !== KEYBOARD) post({ type: "player", source: m.source, player });
      rt?.requestWake();
    }
    else if (m.type === "ctrlAnswer") { const a = ctrlAnswer; ctrlAnswer = null; a?.(!!m.ok); }
    else if (m.type === "guard") { guardWanted = !!m.on; guardAuto = false; log(`page: the host-area guard is ${guardWanted ? "on" : "off"} from the next load on`); }
    else if (m.type === "report") post({ type: "report", text: report(m.userAgent ?? "") });
    else if (m.type === "capture") {
      // the next frame as the pass text and its target images (src/gfx/README.md, "Frame capture")
      if (gfx?.live && gfx.host.capturing) { post({ type: "capture", text: `a capture is already waiting for the next present (${gfx.stats.frames} frames presented so far; a game still loading may present none for minutes)`, images: [] }); return; }
      const c = gfx && rt && !rt.disposed ? gfx.captureFrame({ png: true }) : null;
      if (!c) post({ type: "capture", text: "no frame can be captured: " + (gfx?.live ? "no process is running" : "there is no WebGPU device (the null replayer draws nothing)"), images: [] });
      else { rt!.requestWake(); const r = await c; post({ type: "capture", text: r.text, images: r.images.map(i => ({ name: i.name, width: i.width, height: i.height, format: i.format, png: i.png })) }); }
    }
    else if (m.type === "loseDevice") {
      // the page's test button: the GPU device is destroyed under the running process, as a driver reset would
      if (device && gfx?.live) { log("page: destroying the WebGPU device on purpose (the test button): the replayer asks for a new one"); gfx.host.device.destroy(); }
      else log("page: there is no WebGPU device to lose");
    }
  } catch (e: any) { log("[RED] page: " + (e?.stack ?? e)); }
}
