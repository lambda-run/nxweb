// The page (main thread): controls, the canvas handed to the Worker, input sources (keyboard, Gamepad API), and the
// display of what the Worker reports. The process state shown is the `process` kit machine's state as the Worker
// reads it from the runtime core; nothing here parses log text.
const $ = (id: string) => document.getElementById(id)!;
const worker = new Worker("worker.js");
const canvas = ($("canvas") as HTMLCanvasElement).transferControlToOffscreen();
worker.postMessage({ type: "init", canvas }, [canvas]);

const log = $("log");
function addLog(lines: { text: string; kind: string }[]) {
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  for (const l of lines) { const s = document.createElement("span"); if (l.kind) s.className = l.kind; s.textContent = l.text + "\n"; log.append(s); }
  while (log.childNodes.length > 2000) log.firstChild!.remove();
  if (atEnd) log.scrollTop = log.scrollHeight;
}
const fmt = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(2) + " M" : v >= 1e3 ? (v / 1e3).toFixed(1) + " k" : v.toFixed(0);
worker.onmessage = ev => {
  const m = ev.data;
  if (m.type === "log") addLog(m.lines);
  else if (m.type === "status") {
    const st = $("state");
    st.textContent = m.state; st.dataset.state = m.state; st.dataset.fault = m.stopKind === "fault" ? "1" : "0";
    $("why").textContent = m.state !== "Stopped" ? "" : m.stopKind === "exit" ? `exit code ${m.stopValue}` : m.stopKind === "fault" ? `fault: ${m.faultName}` : m.stopKind;
    ($("pause") as HTMLButtonElement).disabled = m.state !== "Running";
    ($("resume") as HTMLButtonElement).disabled = m.state !== "Paused";
    ($("stop") as HTMLButtonElement).disabled = !["Ready", "Running", "Paused"].includes(m.state);
    $("fps").textContent = m.fps === undefined ? "–" : m.fps.toFixed(1);
    $("ups").textContent = m.ups === undefined ? "–" : fmt(m.ups);
    $("ips").textContent = m.ips === undefined ? "– (not measured for this module: see budget units)" : `${fmt(m.ips)} (budget units × ${m.ratio.toFixed(2)}, the ratio measured for the demo at build time)`;
    $("frames").textContent = `${m.frames}, ${m.nvnCalls}`;
    $("waits").textContent = String(m.waiting);
    $("split").textContent = m.split ?? "–";
    $("mods").textContent = m.modules ?? "–";
    $("gpu").textContent = m.gpu ?? "–";
    $("more").textContent = m.more ?? "–";
  }
};
($("demo") as HTMLButtonElement).onclick = () => worker.postMessage({ type: "demo" });
$("pause").onclick = () => worker.postMessage({ type: "pause" });
$("resume").onclick = () => worker.postMessage({ type: "resume" });
$("stop").onclick = () => worker.postMessage({ type: "stop" });

// ---- files ----
let shaderLib: string | undefined, shaderNxsl: Uint8Array | undefined, rom: File | undefined;
async function take(list: FileList | File[]) {
  const files = Array.from(list), nso: { name: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    if (/\.nxsl$/i.test(f.name)) { shaderNxsl = new Uint8Array(await f.arrayBuffer()); addLog([{ text: `page: shader library ${f.name} (${shaderNxsl.length} bytes) will be consulted first at the next load`, kind: "" }]); }
    else if (/\.(romfs|img|istorage)$/i.test(f.name)) { rom = f; addLog([{ text: `page: RomFS image ${f.name} (${f.size} bytes) is the rom device of the next load`, kind: "" }]); }
    else if (f.name.endsWith(".json")) { shaderLib = await f.text(); addLog([{ text: `page: shader library ${f.name} (${shaderLib.length} bytes) will be used for the next load`, kind: "" }]); }
    else nso.push({ name: f.name.replace(/\.nso$/i, ""), bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  if (!nso.length) return;
  nso.sort((a, b) => Number(b.name === "main") - Number(a.name === "main"));   // the main module first
  worker.postMessage({ type: "load", files: nso, shaders: shaderLib, nxsl: shaderNxsl, rom });
}
($("files") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
($("shaders") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
($("rom") as HTMLInputElement).onchange = e => take((e.target as HTMLInputElement).files!);
const drop = $("drop");
for (const t of ["dragenter", "dragover"]) document.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); });
for (const t of ["dragleave", "drop"]) document.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); });
document.addEventListener("drop", e => { if (e.dataTransfer?.files.length) take(e.dataTransfer.files); });

// ---- input: keyboard and the first gamepad, sent when they change ----
const BTN: Record<string, number> = { A: 1, B: 2, X: 4, Y: 8, LS: 16, RS: 32, L: 64, R: 128, ZL: 256, ZR: 512, Plus: 1024, Minus: 2048, Left: 4096, Up: 8192, Right: 16384, Down: 32768 };
const keys = new Set<string>();
const KEY_BTN: Record<string, number> = { KeyZ: BTN.A, KeyX: BTN.B, KeyC: BTN.X, KeyV: BTN.Y, Enter: BTN.Plus, Backspace: BTN.Minus, KeyQ: BTN.L, KeyE: BTN.R };
// the standard gamepad mapping's buttons in NpadButton terms (the Switch's A is the right button, B the bottom one)
const PAD_BTN = [BTN.B, BTN.A, BTN.Y, BTN.X, BTN.L, BTN.R, BTN.ZL, BTN.ZR, BTN.Minus, BTN.Plus, BTN.LS, BTN.RS, BTN.Up, BTN.Down, BTN.Left, BTN.Right];
let last = "";
function sample() {
  const axis = (neg: string[], pos: string[]) => (pos.some(k => keys.has(k)) ? 32767 : 0) - (neg.some(k => keys.has(k)) ? 32767 : 0);
  const p = { buttons: 0, lx: axis(["ArrowLeft", "KeyA"], ["ArrowRight", "KeyD"]), ly: axis(["ArrowDown", "KeyS"], ["ArrowUp", "KeyW"]), rx: axis(["KeyJ"], ["KeyL"]), ry: axis(["KeyK"], ["KeyI"]) };
  for (const k of keys) p.buttons |= KEY_BTN[k] ?? 0;
  let source = keys.size ? "keyboard" : "";
  const gp = navigator.getGamepads?.().find(g => g && g.connected);
  if (gp) {
    gp.buttons.forEach((b, i) => { if (b.pressed && PAD_BTN[i]) p.buttons |= PAD_BTN[i]; });
    const dead = (v: number) => Math.abs(v) < 0.12 ? 0 : Math.round(v * 32767), pick = (a: number, b: number) => Math.abs(a) >= Math.abs(b) ? a : b;
    p.lx = pick(p.lx, dead(gp.axes[0] ?? 0)); p.ly = pick(p.ly, -dead(gp.axes[1] ?? 0)); p.rx = pick(p.rx, dead(gp.axes[2] ?? 0)); p.ry = pick(p.ry, -dead(gp.axes[3] ?? 0));
    source = (source ? source + " + " : "") + "gamepad " + gp.id.slice(0, 24);
  }
  const s = JSON.stringify(p);
  if (s !== last) { last = s; worker.postMessage({ type: "input", pad: p }); $("pad").textContent = `${source || "idle"}: buttons 0x${p.buttons.toString(16)}, L ${p.lx}/${p.ly}, R ${p.rx}/${p.ry}`; }
  requestAnimationFrame(sample);
}
addEventListener("keydown", e => { if (!e.repeat) keys.add(e.code); if (e.code.startsWith("Arrow")) e.preventDefault(); });
addEventListener("keyup", e => keys.delete(e.code));
addEventListener("blur", () => keys.clear());
requestAnimationFrame(sample);
if (new URLSearchParams(location.search).has("demo")) worker.postMessage({ type: "demo" });
