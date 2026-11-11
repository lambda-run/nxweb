// The page (main thread): controls, the canvas handed to the Worker, input sources (keyboard, every controller of
// the Gamepad API as a source of its own), the page side of the audio device (an AudioContext exists only here),
// the controller applet's prompt, vibration, and the display of what the Worker reports. The process state shown is
// the `process` kit machine's state as the Worker reads it from the runtime core, the tables are the machines' and the
// loader's; nothing here parses log text.
import { AudioDeviceMain } from "../src/glue/audio_device_main.ts";

const $ = (id: string) => document.getElementById(id)!;
// which build this is (build/web/build.json, written by web:build), at the top of the page
fetch("build.json", { cache: "no-store" }).then(r => r.json()).then((b: { commit: string; branch: string; dirty: boolean; date: string; md5: string }) => {
  const el = $("build");
  el.textContent = `${b.commit}${b.dirty ? "+changes" : ""} · ${b.date.slice(0, 16).replace("T", " ")} UTC · md5 ${b.md5.slice(0, 8)}`;
  el.title = `branch ${b.branch}, commit ${b.commit}${b.dirty ? " with uncommitted changes" : ""}, built ${b.date}, md5 of the built files ${b.md5}`;
}, () => { $("build").textContent = "build unknown"; });
const worker = new Worker("worker.js" + location.search);   // (?mem64=1 reaches the worker: every program in the 64-bit memory mode)
const canvas = ($("canvas") as HTMLCanvasElement).transferControlToOffscreen();
worker.postMessage({ type: "init", canvas }, [canvas]);
// The audio device's page side: the context is made when a process first uses nn::audio and runs from the first user
// gesture on (AudioDeviceMain listens for pointerdown, keydown and touchend itself; the click that starts a demo is one)
const audio = new AudioDeviceMain((m, t) => worker.postMessage(m, t ?? []));

// ---- the log: every line, red ones counted, a filter ----
const log = $("log");
let redCount = 0, filter = "";
function addLog(lines: { text: string; kind: string }[]) {
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  for (const l of lines) {
    const s = document.createElement("span"); if (l.kind) s.className = l.kind; s.textContent = l.text + "\n";
    if (filter && !l.text.toLowerCase().includes(filter)) s.classList.add("hide");
    log.append(s);
  }
  while (log.childNodes.length > 2000) log.firstChild!.remove();
  if (atEnd) log.scrollTop = log.scrollHeight;
}
($("onlyred") as HTMLInputElement).onchange = e => { log.classList.toggle("onlyred", (e.target as HTMLInputElement).checked); log.scrollTop = log.scrollHeight; };
($("logfilter") as HTMLInputElement).oninput = e => {
  filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
  for (const s of Array.from(log.children)) s.classList.toggle("hide", !!filter && !(s.textContent ?? "").toLowerCase().includes(filter));
};

const fmt = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(2) + " M" : v >= 1e3 ? (v / 1e3).toFixed(1) + " k" : v.toFixed(0);
const hex = (v: number) => "0x" + v.toString(16);
const MAIN = ["process", "oe_focus", "audio_out", "gfx_device", "guest_clock", "hle_exit", "input_hold", "ctrl_prompt", "pad_slot"];
function cells(tr: HTMLTableRowElement, values: string[], numeric: number[] = []) {
  values.forEach((v, i) => { const td = tr.cells[i] ?? tr.insertCell(); if (td.textContent !== v) td.textContent = v; if (numeric.includes(i)) td.className = "num"; });
  while (tr.cells.length > values.length) tr.deleteCell(-1);
}
function rows(table: HTMLTableElement, n: number): HTMLTableRowElement[] {
  const body = table.tBodies[0];
  while (body.rows.length < n) body.insertRow();
  while (body.rows.length > n) body.deleteRow(-1);
  return Array.from(body.rows);
}
let guardShown = "", running = false;
// The keyboard reaches the game while the focus is in this page and not in a text field; it does not while it is in
// the "Open a game" frame (where Play was pressed) or in the log's filter: then the hint over the picture says so.
const screenBox = $("screen"), canvasEl = $("canvas") as HTMLCanvasElement;
function focusHint(): void {
  const a = document.activeElement;
  $("focushint").hidden = !(running && (a instanceof HTMLIFrameElement || a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || !document.hasFocus()));
}
for (const t of ["focusin", "focusout"]) document.addEventListener(t, () => setTimeout(focusHint, 0));
for (const t of ["blur", "focus"]) addEventListener(t, () => setTimeout(focusHint, 0));
screenBox.addEventListener("pointerdown", () => canvasEl.focus());
$("fullscreen").onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else { await screenBox.requestFullscreen(); canvasEl.focus(); } }
  catch (e: any) { addLog([{ text: `page: fullscreen was refused here (${e?.message ?? e})`, kind: "" }]); }
};
document.addEventListener("fullscreenchange", () => { $("fullscreen").textContent = document.fullscreenElement ? "Leave fullscreen" : "Fullscreen"; });
// The readout on the picture's top right corner: frames per second while a program runs, and the process state when
// it is not Running (Ready, Paused). The button in the control row and F3 hide it; the choice is remembered.
let feedReport = "";   // ?logto=: the address the next report goes to (not to the clipboard)
let hudOn = true, hudFps = "–", hudState = "Empty", hudMore = "";
try { hudOn = localStorage.getItem("nxweb-fps") !== "0"; } catch { /* no storage here: shown */ }
function drawHud(): void {
  const live = hudState === "Running" || hudState === "Paused" || hudState === "Ready", run = hudState === "Running";
  $("hud").hidden = !(hudOn && live);
  if ($("hudnum").textContent !== hudFps) $("hudnum").textContent = hudFps;
  $("hudfps").hidden = !run;
  $("hudmore").hidden = !run; if ($("hudmore").textContent !== hudMore) $("hudmore").textContent = hudMore;
  $("hudstate").hidden = run;
  if ($("hudstate").textContent !== hudState) $("hudstate").textContent = hudState;
  $("fpstoggle").setAttribute("aria-pressed", hudOn ? "true" : "false");
}
function toggleHud(): void {
  hudOn = !hudOn;
  try { localStorage.setItem("nxweb-fps", hudOn ? "1" : "0"); } catch { /* not remembered */ }
  drawHud();
}
$("fpstoggle").onclick = toggleHud;
drawHud();
// "Details for developers": open or closed as it was left
const dev = $("dev") as HTMLDetailsElement;
try { dev.open = localStorage.getItem("nxweb-dev-open") === "1"; } catch { /* no storage here: closed */ }
dev.addEventListener("toggle", () => { try { localStorage.setItem("nxweb-dev-open", dev.open ? "1" : "0"); } catch { /* not remembered */ } });
worker.onmessage = ev => {
  const m = ev.data;
  if (audio.handle(m)) return;
  if (m.type === "log") addLog(m.lines);
  else if (m.type === "status") {
    const st = $("state");
    st.textContent = m.state; st.dataset.state = m.state; st.dataset.fault = m.stopKind === "fault" ? "1" : "0";
    $("why").textContent = m.state !== "Stopped" ? "" : m.stopKind === "exit" ? `exit code ${m.stopValue}` : m.stopKind === "fault" ? `fault: ${m.faultName}` : m.stopKind;
    ($("pause") as HTMLButtonElement).disabled = m.state !== "Running";
    ($("resume") as HTMLButtonElement).disabled = m.state !== "Paused";
    ($("stop") as HTMLButtonElement).disabled = !["Ready", "Running", "Paused"].includes(m.state);
    $("fps").textContent = m.fps === undefined ? "–" : m.fps.toFixed(1);
    hudFps = m.fps === undefined ? "–" : m.fps.toFixed(1); hudState = m.state;
    // under the number: what the number is and where a frame's time goes. "game" is frames the game presents a second; "video" is movie pictures a
    // second while a movie plays (a movie can be slower than the game's frames); then one frame's milliseconds in translated game code, in nxweb's
    // own host calls, in WebGPU calls, and waiting
    hudMore = m.fps === undefined ? "" : `game frames ${m.fps.toFixed(0)}/s${m.video > 0.5 ? ` · video ${m.video.toFixed(0)}/s` : ""}` +
      (m.ms ? `\ncode ${m.ms.code.toFixed(1)} · host ${m.ms.host.toFixed(1)} · gpu ${m.ms.gpu.toFixed(1)} · idle ${m.ms.idle.toFixed(1)} ms` : "");
    drawHud();
    $("ups").textContent = m.ups === undefined ? "–" : fmt(m.ups);
    $("ips").textContent = m.ips === undefined ? "– (not measured for this module: see budget units)" : `${fmt(m.ips)} (budget units × ${m.ratio.toFixed(2)}, the ratio measured for the demo at build time)`;
    $("frames").textContent = `${m.frames}, ${m.nvnCalls}`;
    $("waits").textContent = String(m.waiting);
    $("split").textContent = m.split ?? "–";
    // the Doom demo's own facts, as the guest reports them with every frame
    const d = m.doom;
    $("doomstate").textContent = !d ? "–" : `tic ${d.gametic}: ${d.gamestate === 3 ? "title" : d.gamestate === 0 ? (d.demo ? "attract demo" : d.usergame ? "game" : "level") + `, map ${d.map}, health ${d.health}, bullets ${d.bullets}, at ${d.x}/${d.y}, angle ${Math.round(d.angle / 2 ** 32 * 360)}` : d.gamestate === 1 ? "intermission" : "finale"}${d.menu ? ", menu up" : ""}`;
    $("gpu").textContent = m.gpu ?? "–";
    $("more").textContent = m.more ?? "–";
    $("options").textContent = m.options || "–";
    redCount = m.redTotal ?? 0;
    const rc = $("redcount"); rc.textContent = `${redCount} red`; rc.dataset.red = redCount ? "1" : "0";
    // a red line or a fault: the report button beside the picture
    $("trouble").hidden = !(redCount > 0 || m.stopKind === "fault");
    const was = running;
    running = m.state === "Running"; focusHint();
    // a program that starts: its picture comes into view (a demo button is above it, a game's Play further up)
    if (running && !was) $("player").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    $("player").dataset.idle = m.state === "Empty" ? "1" : "0";   // the picture is small until there is one
    // the guard: what the next run gets, and why
    const g = m.guard, key = JSON.stringify(g);
    if (g && key !== guardShown) {
      guardShown = key;
      ($("guard") as HTMLInputElement).checked = g.next;
      $("guardnote").textContent = (g.auto ? "Turned on because the last run ended in a fault: a guest access below 0x8000000 (a null or host-area pointer) is then a fault at the exact instruction. " : "") +
        (g.byDefault ? "On by default; it costs a few percent of run time." : "Off by default (it costs a few percent of run time); it turns itself on for the run after a fault.") + ` This run: ${g.now ? "on" : "off"}.`;
    }
    // modules: build id, sizes, unresolved imports by name
    const mods: any[] = m.modules ?? [];
    rows($("modtable") as HTMLTableElement, Math.max(1, mods.length)).forEach((tr, i) => {
      const x = mods[i];
      cells(tr, x ? [x.name, x.buildId, hex(x.base), hex(x.imageSize), `${hex(x.text)} / ${hex(x.ro)} / ${hex(x.data)} / ${hex(x.bss)}`, x.unresolved.length ? `${x.unresolved.length}: ${x.unresolved.join(", ")}` : "none"] : ["–", "", "", "", "", ""]);
    });
    const tk = m.takeovers;
    $("takeovers").textContent = tk ? `Take-overs: ${tk.forcedHit} forced names hit by this program, ${tk.forcedNotReferenced} not referenced; ${tk.weakUsed} weak ones fill an import no module defines; ${tk.unresolved} imports unresolved.` : "";
    const hits = tk ? tk.hitNames.join("\n") : "";
    if ($("hitnames").textContent !== hits) $("hitnames").textContent = hits;
    // machines: the main ones first, then the others that were stepped; the rest by name
    if (m.machines) {
      const all: any[] = m.machines, active = all.filter(r => r.live || r.steps || r.taken).sort((a, b) => (MAIN.indexOf(b.name) >= 0 ? 1 : 0) - (MAIN.indexOf(a.name) >= 0 ? 1 : 0) || (MAIN.indexOf(a.name) - MAIN.indexOf(b.name)));
      rows($("machines") as HTMLTableElement, active.length).forEach((tr, i) => {
        const r = active[i];
        tr.className = MAIN.includes(r.name) ? "main" : "";
        tr.dataset.machine = r.name;
        cells(tr, [r.name, r.live || "–", `${r.taken} of ${r.transitions}`, r.last || "–", r.modules || "–"], [2]);
      });
      const idle = all.filter(r => !(r.live || r.steps || r.taken));
      $("idlemachines").textContent = `${idle.length} of ${all.length} machines not stepped by this process`;
      const names = idle.map(r => r.name).join(", ");
      if ($("idlelist").textContent !== names) $("idlelist").textContent = names;
    }
  }
  else if (m.type === "ctrlPrompt") {
    $("ctrltext").textContent = `The game asks for ${m.min}${m.max > m.min ? " to " + m.max : ""} players.`;
    const d = $("ctrlprompt") as HTMLDialogElement;
    if (!d.open) d.showModal();
  }
  else if (m.type === "needwad") $("doomnote").classList.add("ask");                  // Doom was asked for and there is no data file yet
  else if (m.type === "player") players.set(m.source, m.player);
  else if (m.type === "vibration") rumble(m.source, m.low, m.high);
  else if (m.type === "capture") showCapture(m);
  else if (m.type === "report") { if (feedReport) { const to = feedReport; feedReport = ""; void fetch(`${to}/live.report.txt`, { method: "POST", body: m.text }).catch(() => {}); } else void showReport(m.text); }
};
($("demo") as HTMLButtonElement).onclick = () => worker.postMessage({ type: "demo", which: "cube" });
($("demotone") as HTMLButtonElement).onclick = () => worker.postMessage({ type: "demo", which: "tone" });
// Doom: the button is on when the build has the guest (demo/doom.json); the data file is the build's or the user's
let wadFile: Uint8Array | undefined, wadKnown = false;
const doomButton = $("demodoom") as HTMLButtonElement;
function runDoom() {
  doomButton.blur(); canvasEl.focus({ preventScroll: true });   // Enter and the other keys go to the game from now on, not to the button
  if (!wadKnown && !wadFile) { ($("wad") as HTMLInputElement).click(); return; }   // no data file yet: ask for it; choosing one starts the game
  $("doomnote").classList.remove("ask");
  worker.postMessage({ type: "demo", which: "doom", wad: wadFile });
  if (wadFile) { wadKnown = true; wadFile = undefined; }   // the Worker keeps it
}
doomButton.onclick = runDoom;
fetch("demo/doom.json").then(r => r.ok ? r.json() : {}).catch(() => ({})).then((info: { present?: boolean; wad?: boolean }) => {
  doomButton.disabled = !info.present; wadKnown = !!info.wad;
  $("doomnote").textContent = !info.present ? "Doom: not in this build (the engine is fetched by tools/doom/fetch.sh, not included)."
    : (info.wad ? "Doom: the shareware data file is in this build." : "Doom: choose doom1.wad (the shareware data file; it is not included).") +
      " Arrows or WASD move and turn, Z fires (and selects in menus), X opens doors (and goes back in menus), C runs, V changes the weapon (and answers y), Q/E strafe, Enter selects, Backspace is Escape (the menu).";
  ($("wadlabel") as HTMLElement).hidden = !info.present || !!info.wad;   // the chooser only when the build has no data file
  if (info.present && info.wad && new URLSearchParams(location.search).has("doom")) runDoom();
});
$("pause").onclick = () => worker.postMessage({ type: "pause" });
$("resume").onclick = () => worker.postMessage({ type: "resume" });
$("stop").onclick = () => worker.postMessage({ type: "stop" });
($("guard") as HTMLInputElement).onchange = e => worker.postMessage({ type: "guard", on: (e.target as HTMLInputElement).checked });
$("losedevice").onclick = () => worker.postMessage({ type: "loseDevice" });

// ---- the controller applet's prompt ----
const answer = (ok: boolean) => { const d = $("ctrlprompt") as HTMLDialogElement; if (d.open) d.close(); worker.postMessage({ type: "ctrlAnswer", ok }); };
$("ctrlok").onclick = () => answer(true);
$("ctrlclose").onclick = () => answer(false);
($("ctrlprompt") as HTMLDialogElement).addEventListener("cancel", e => { e.preventDefault(); answer(false); });

// ---- frame capture: the pass text and the target images ----
$("capturebtn").onclick = () => worker.postMessage({ type: "capture" });
function showCapture(m: { text: string; images: { name: string; width: number; height: number; format: string; png: Uint8Array | null }[] }) {
  $("capturetext").textContent = m.text;
  const box = $("captureimages");
  for (const img of Array.from(box.querySelectorAll("img"))) URL.revokeObjectURL((img as HTMLImageElement).src);
  box.textContent = "";
  for (const i of m.images) {
    if (!i.png) continue;
    const fig = document.createElement("figure"), img = document.createElement("img"), cap = document.createElement("figcaption");
    img.src = URL.createObjectURL(new Blob([i.png as unknown as BlobPart], { type: "image/png" })); img.alt = i.name; img.width = i.width; img.height = i.height;
    cap.textContent = `${i.name} (${i.width}x${i.height}, ${i.format})`;
    fig.append(img, cap); box.append(fig);
  }
}

// ---- the report: one text block, to the clipboard and into the page ----
$("copyreport").onclick = $("copyreportdev").onclick = () => worker.postMessage({ type: "report", userAgent: navigator.userAgent });
async function showReport(text: string) {
  const box = $("reportbox") as HTMLDetailsElement;
  ($("reporttext") as HTMLTextAreaElement).value = text;
  box.hidden = false; $("trouble").hidden = false;
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch { /* no clipboard permission (a sandboxed frame, or no gesture): the text is in the page */ }
  // the report's text is in one place, with the log (Details for developers): shown there when it could not be copied
  box.open = !copied || dev.open;
  if (!copied) { dev.open = true; box.scrollIntoView({ block: "nearest" }); }
  $("reportnote").textContent = (copied ? `Copied (${text.split("\n").length} lines). Paste it where you report the problem.` : "This browser did not let the page copy by itself: the report is with the log under Details for developers, select it there and copy.") + " It has no game data.";
}

// ---- a game folder: the prepare step (web/prepare.html, in the frame) hands over what it made; Play starts it here ----
const frame = $("prepare") as HTMLIFrameElement;
const hookFrame = () => { try { frame.contentWindow?.addEventListener("nxweb:handoff", ev => {
  const msg = (ev as CustomEvent).detail;
  addLog([{ text: `page: the prepare step handed over ${msg.name} (${msg.titleId}): ${msg.modules.length} code modules, ${msg.cuts.length} cuts applied`, kind: "" }]);
  worker.postMessage({ type: "handoff", msg });
  // the picture is what matters now, and the keyboard goes to it
  $("player").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  canvasEl.focus({ preventScroll: true });
}); } catch { /* the frame is not there */ } };
frame.addEventListener("load", hookFrame);
try { if (frame.contentDocument?.readyState === "complete" && (frame.contentWindow as any)?.nxwebPrepareReady) hookFrame(); } catch { /* not loaded yet */ }

// ---- files ----
let shaderLib: string | undefined, shaderNxsl: Uint8Array | undefined, rom: File | undefined;
async function take(list: FileList | File[]) {
  const files = Array.from(list), nso: { name: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    if (/\.nxsl$/i.test(f.name)) { shaderNxsl = new Uint8Array(await f.arrayBuffer()); addLog([{ text: `page: shader library ${f.name} (${shaderNxsl.length} bytes) will be consulted first at the next load`, kind: "" }]); }
    else if (/\.(romfs|img|istorage)$/i.test(f.name)) { rom = f; addLog([{ text: `page: RomFS image ${f.name} (${f.size} bytes) is the rom device of the next load`, kind: "" }]); }
    else if (/\.wad$/i.test(f.name)) {
      wadFile = new Uint8Array(await f.arrayBuffer());
      addLog([{ text: `page: data file ${f.name} (${wadFile.length} bytes) for Doom`, kind: "" }]);
      if (!doomButton.disabled) runDoom();
    }
    else if (f.name.endsWith(".json")) { shaderLib = await f.text(); addLog([{ text: `page: shader library ${f.name} (${shaderLib.length} bytes) will be used for the next load`, kind: "" }]); }
    else nso.push({ name: f.name.replace(/\.nso$/i, ""), bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  if (!nso.length) return;
  nso.sort((a, b) => Number(b.name === "main") - Number(a.name === "main"));   // the main module first
  // the module files are handed over, not copied: a game's main module is tens to hundreds of megabytes
  worker.postMessage({ type: "load", files: nso, shaders: shaderLib, nxsl: shaderNxsl, rom }, nso.map(f => f.bytes.buffer as ArrayBuffer));
}
($("files") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
($("shaders") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
($("rom") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
($("wad") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
// A drop on the developers' box is module files for the Worker; a drop anywhere else on the page is a game (a .nup
// file or a folder) for "Open a game", which also says what anything else is
const drop = $("drop");
const onDevBox = (e: Event) => e.target instanceof Node && drop.contains(e.target);
const gameFrame = () => { try { return frame.contentWindow as any; } catch { return null; } };
for (const t of ["dragenter", "dragover"]) document.addEventListener(t, e => { e.preventDefault(); const d = onDevBox(e); drop.classList.toggle("over", d); gameFrame()?.nxwebDragOver?.(!d); });
for (const t of ["dragleave", "drop"]) document.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); gameFrame()?.nxwebDragOver?.(false); });
document.addEventListener("drop", e => {
  if (onDevBox(e)) { if (e.dataTransfer?.files.length) void take(e.dataTransfer.files); return; }
  const w = gameFrame();
  if (w?.nxwebDrop) { w.nxwebDrop(e.dataTransfer); $("open").scrollIntoView({ block: "nearest" }); }
  else if (e.dataTransfer?.files.length) void take(e.dataTransfer.files);
});

// ---- input: the keyboard is source 1; every controller is a source of its own, by a stable id ----
const BTN: Record<string, number> = { A: 1, B: 2, X: 4, Y: 8, LS: 16, RS: 32, L: 64, R: 128, ZL: 256, ZR: 512, Plus: 1024, Minus: 2048, Left: 4096, Up: 8192, Right: 16384, Down: 32768 };
const keys = new Set<string>();
const KEY_BTN: Record<string, number> = { KeyZ: BTN.A, KeyX: BTN.B, KeyC: BTN.X, KeyV: BTN.Y, Enter: BTN.Plus, Backspace: BTN.Minus, KeyQ: BTN.L, KeyE: BTN.R };
// the standard gamepad mapping's buttons in NpadButton terms (the Switch's A is the right button, B the bottom one)
const PAD_BTN = [BTN.B, BTN.A, BTN.Y, BTN.X, BTN.L, BTN.R, BTN.ZL, BTN.ZR, BTN.Minus, BTN.Plus, BTN.LS, BTN.RS, BTN.Up, BTN.Down, BTN.Left, BTN.Right];
const KEYBOARD = 1;
// A controller's source id: its id string and index hashed (the same controller in the same port gets its player
// back after a reconnect), never 0 and never the keyboard's
function sourceId(gp: Gamepad): number {
  let h = 0x811c9dc5; for (const c of gp.id + "#" + gp.index) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  h >>>= 0;
  return h <= KEYBOARD ? h + 2 : h;
}
const sent = new Map<number, string>();   // source -> its last state as text
const players = new Map<number, number>();   // source -> the player the Worker gave it (0 = player 1)
const pads = new Map<number, Gamepad>();
function send(source: number, pad: object | null) {
  const s = JSON.stringify(pad);
  if (sent.get(source) === s) return false;
  if (pad) sent.set(source, s); else sent.delete(source);
  worker.postMessage({ type: "input", source, pad });
  return true;
}
// The keyboard's state now, sent when it changed. Called at every key event, not only once per animation frame: a key
// pressed and released between two frames (a quick tap, a page that is busy) is then two states the Worker gets, and
// the take-over table latches the press for the game's next read. Sampled once per frame it was never seen.
function keyboard() {
  const axis = (neg: string[], pos: string[]) => (pos.some(k => keys.has(k)) ? 32767 : 0) - (neg.some(k => keys.has(k)) ? 32767 : 0);
  const kb = { buttons: 0, lx: axis(["ArrowLeft", "KeyA"], ["ArrowRight", "KeyD"]), ly: axis(["ArrowDown", "KeyS"], ["ArrowUp", "KeyW"]), rx: axis(["KeyJ"], ["KeyL"]), ry: axis(["KeyK"], ["KeyI"]) };
  for (const k of keys) kb.buttons |= KEY_BTN[k] ?? 0;
  return { kb, changed: send(KEYBOARD, kb) };
}
function sample() {
  const k = keyboard(), kb = k.kb;
  let changed = k.changed;
  const seen = new Set<number>(), parts = [`keyboard: buttons 0x${kb.buttons.toString(16)}, L ${kb.lx}/${kb.ly}, R ${kb.rx}/${kb.ry}`];
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp || !gp.connected) continue;
    const id = sourceId(gp), p = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, rumble: !!(gp as any).vibrationActuator };
    gp.buttons.forEach((b, i) => { if (b.pressed && PAD_BTN[i]) p.buttons |= PAD_BTN[i]; });
    const dead = (v: number) => Math.abs(v) < 0.12 ? 0 : Math.round(v * 32767);
    p.lx = dead(gp.axes[0] ?? 0); p.ly = -dead(gp.axes[1] ?? 0); p.rx = dead(gp.axes[2] ?? 0); p.ry = -dead(gp.axes[3] ?? 0);
    seen.add(id); pads.set(id, gp);
    if (send(id, p)) changed = true;
    const pl = players.get(id);
    parts.push(`${pl === undefined || pl < 0 ? "controller" : "player " + (pl + 1)} (${gp.id.slice(0, 24)}): buttons 0x${p.buttons.toString(16)}, L ${p.lx}/${p.ly}, R ${p.rx}/${p.ry}${p.rumble ? ", vibration" : ""}`);
  }
  for (const id of [...sent.keys()]) if (id !== KEYBOARD && !seen.has(id)) { send(id, null); pads.delete(id); players.delete(id); changed = true; }   // it went away
  const text = parts.join("; ");
  if (changed || $("pad").textContent !== text) $("pad").textContent = text;
  requestAnimationFrame(sample);
}
addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.code === "F9") { e.preventDefault(); worker.postMessage({ type: "capture" }); return; }
  if (e.code === "F3") { e.preventDefault(); if (!e.repeat) toggleHud(); return; }
  if (!e.repeat) { keys.add(e.code); keyboard(); }
  if (e.code.startsWith("Arrow")) e.preventDefault();
});
addEventListener("keyup", e => { keys.delete(e.code); keyboard(); });
addEventListener("blur", () => { keys.clear(); keyboard(); });
requestAnimationFrame(sample);

// ---- vibration: a player's motors to its controller, where the Gamepad API has an actuator ----
// The table reports a motor state when it changes; an effect of the Gamepad API has a duration, so a state that is
// held is played again every 400 ms until it changes to rest.
const rumbling = new Map<number, { low: number; high: number; timer: number }>();
function rumble(source: number, low: number, high: number) {
  const old = rumbling.get(source);
  if (old) { clearInterval(old.timer); rumbling.delete(source); }
  const play = () => {
    const act = (pads.get(source) as any)?.vibrationActuator;
    if (!act) return;
    try {
      if (low <= 0 && high <= 0) { if (act.reset) void act.reset(); else void act.playEffect("dual-rumble", { duration: 1, strongMagnitude: 0, weakMagnitude: 0 }); }
      else void act.playEffect("dual-rumble", { startDelay: 0, duration: 500, strongMagnitude: Math.min(1, low), weakMagnitude: Math.min(1, high) });
    } catch { /* a controller that went away */ }
  };
  play();
  if (low > 0 || high > 0) rumbling.set(source, { low, high, timer: window.setInterval(play, 400) });
  $("rumble").textContent = `source ${source}: low ${low.toFixed(2)}, high ${high.toFixed(2)}${(pads.get(source) as any)?.vibrationActuator ? "" : " (this controller has no actuator)"}`;
}
(window as any).nxwebTest = { audio, rumbling };
if (new URLSearchParams(location.search).has("demo")) worker.postMessage({ type: "demo", which: "cube" });

// ?logto=<url>: a development feed. Every 10 s the log lines added since the last time are POSTed to <url>/append/live.log and the status line to
// <url>/live.status.json, so whoever develops beside the player reads a session without a pasted report. Off by default; nothing leaves the page without it
{ const to = new URLSearchParams(location.search).get("logto");
  if (to) {
    let sent: Node | null = null;
    let feedTicks = 0;
    setInterval(() => {
      const fresh: string[] = [];
      for (let n = sent ? sent.nextSibling : log.firstChild; n; n = n.nextSibling) { fresh.push(n.textContent ?? ""); sent = n; }
      if (sent && !sent.isConnected) sent = null;   // (the page keeps the last 2000 lines: after a burst the feed goes on from what is there)
      if (fresh.length) void fetch(`${to}/append/live.log`, { method: "POST", body: fresh.join("") }).catch(() => {});
      const st = { when: new Date().toISOString(), state: $("state").textContent, why: $("why").textContent, fps: $("fps").textContent, frames: $("frames").textContent, red: $("redcount").textContent, split: $("split").textContent, hud: hudMore, ups: $("ups").textContent, more: $("more").textContent, build: $("build").textContent };
      void fetch(`${to}/live.status.json`, { method: "POST", body: JSON.stringify(st) }).catch(() => {});
      // and the whole report every third time (30 s): the per-frame draw accounting and the shader keys a frame needed
      if (++feedTicks % 3 === 0 && $("state").textContent === "Running") { feedReport = to; worker.postMessage({ type: "report", userAgent: navigator.userAgent }); }
    }, 10000);
  } }
// ?driver=<url>: a debugging driver (a module that exports run(options)) is imported into the page and started with ?run=<JSON options>.
// Off by default; the driver of the development loop (it opens the remembered game, presses keys, captures frames and posts the report)
{ const q = new URLSearchParams(location.search), u = q.get("driver");
  if (u) import(/* the URL is the developer's own */ u).then(m => m.run(JSON.parse(q.get("run") ?? "{}")), e => addLog([{ text: `page: the driver ${u} could not be loaded (${e?.message ?? e})`, kind: "red" }])); }
