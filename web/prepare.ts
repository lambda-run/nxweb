// web/prepare.html: "Open a game". Main thread; a page of its own and the frame at the top of web/index.html.
// Takes a .nup container or a folder of extracted game files (a picker, a drop, or a file input when the pickers are
// refused, as in a sandboxed frame), says in plain words what something else is, runs src/prepare's pipeline with
// its manifest in the Origin Private File System, shows a verdict as soon as Detect and Profile know enough, the
// stages with their counts and times, and on Play makes the hand-off message.
import { PrepWasm, type Counts } from "../src/prepare/host/wasm.ts";
import { HandleTree, EntryTree, FileListTree, type PrepTree } from "../src/prepare/host/tree.ts";
import { NupTree, blobBytes } from "../src/prepare/host/nup.ts";
import { OpfsStore } from "../src/prepare/host/store.ts";
import { fetchProfiles } from "../src/prepare/host/profiles.ts";
import { Prepare, STAGES, type StageName, type Snapshot, type DetectOut, type ProfileOut, type CodeOut, type IndexOut, type HandOffMessage, type PrepResult } from "../src/prepare/host/prepare.ts";
import { verdictFor, failureSentence, explainFile, type Verdict } from "../src/prepare/host/verdict.ts";
import { A64Scanner, scanHeadline, scanLines } from "../src/glue/a64_scan.ts";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
// Test hook (test/prepare/browser.mts): ?hold=<stage>:<point> makes the run wait there for ever, so that the
// page can be reloaded in the middle of a stage.
const hold = params.get("hold");
// Test hook: ?unpack=<bytes> makes the steps a code module is unpacked in that small (default 4 MB)
const unpackStep = Number(params.get("unpack")) || undefined;
const STAGE_TEXT: Record<StageName, string> = { detect: "Checking the files", index: "Building the file index", profile: "Finding this game's settings", code: "Preparing the code", shaders: "Shaders" };
const STATE_TEXT: Record<string, string> = { pending: "waiting", running: "working…", done: "done", failed: "failed", cancelled: "cancelled" };
const fmtBytes = (n: number) => n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + " GB" : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";
const fmtTime = (ms: number) => ms < 950 ? `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)} s` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round(ms % 60_000 / 1000)} s`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const log = (line: string) => { const el = $("log"); el.textContent += line + "\n"; el.scrollTop = el.scrollHeight; };
const embedded = (() => { try { return !!window.frameElement; } catch { return window.parent !== window; } })();
if (embedded) document.documentElement.classList.add("embedded");

let wasmModule: Promise<WebAssembly.Module> | undefined;
let hasher: PrepWasm | undefined;
let prep: Prepare | null = null, storeDir = "", lastRun: { skipped: StageName[]; ran: StageName[] } = { skipped: [], ran: [] };
const profiles = fetchProfiles("profiles/");
const compiled = () => wasmModule ??= WebAssembly.compileStreaming(fetch("wasm/prepare.wasm"));
// The instruction scan of the Code stage: the translator's own binary (the one the game will be translated with) on
// a memory of its own. Its hash is part of the stage's key. Without it (not built, an old binary) the stage runs
// as before and says nothing about instructions.
let scannerP: Promise<{ scan: A64Scanner; key: string } | undefined> | undefined;
const scanner = () => scannerP ??= (async () => {
  try {
    const r = await fetch("wasm/translator.wasm");
    if (!r.ok) throw new Error(`wasm/translator.wasm: HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).subarray(0, 12), b => b.toString(16).padStart(2, "0")).join("");
    return { scan: new A64Scanner(bytes), key };
  } catch (e) { log(`the instruction scan is not available: ${(e as Error).message}`); return undefined; }
})();

// ---- the last game's handle (a file or a folder), kept so that a reload can go on without picking again (File System Access only) ----
const idb = (): Promise<IDBDatabase> => new Promise((res, rej) => { const r = indexedDB.open("nxweb-prepare", 1); r.onupgradeneeded = () => r.result.createObjectStore("handles"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function remember(handle: unknown | null): Promise<void> {
  try { const db = await idb(); await new Promise<void>((res, rej) => { const t = db.transaction("handles", "readwrite"); if (handle) t.objectStore("handles").put(handle, "last"); else t.objectStore("handles").delete("last"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); db.close(); } catch { /* no IndexedDB: no resume button */ }
}
async function remembered(): Promise<any | null> {
  try { const db = await idb(); const h = await new Promise<any>((res, rej) => { const r = db.transaction("handles").objectStore("handles").get("last"); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); db.close(); return h; } catch { return null; }
}

// ---- something that is not a game, or a container that cannot be opened: what it is and what to do ----
function showExplain(title: string, text: string, developer = "", tech = ""): void {
  $("explaintitle").textContent = title; $("explaintext").textContent = text;
  $("explaindev").textContent = developer; $("explaindev").hidden = !developer;
  $("explaintech").textContent = tech; $("explainmore").hidden = !tech;
  $("explain").hidden = false;
  log(`not opened: ${title}. ${text}${tech ? ` [${tech}]` : ""}`);
  $("explain").scrollIntoView({ block: "nearest" });
}
const hideExplain = () => { $("explain").hidden = true; };

// ---- drawing: machine state plus counts, nothing parsed from text ----
const started: Partial<Record<StageName, number>> = {};      // when the page first saw a stage running
let runStarted = 0, runEnded = 0;
let iconFor = "", iconUrl = "";
function stageLine(s: StageName, snap: Snapshot): string {
  const rec = snap.manifest.stages[s], c: Counts = snap.counts, o = rec.output as any;
  if (rec.state === "running") {
    if (s === "detect") return `${c.files} files seen`;
    if (s === "index") return `${c.romFiles} files, ${c.romDirs} directories (${c.done} of ${c.total} trees)`;
    if (s === "code") return `module ${c.done} of ${c.total}, ${fmtBytes(c.bytesDone)} of ${fmtBytes(c.bytesTotal)}, ${c.cuts} cuts`;
    return "";
  }
  if (rec.state === "failed") return esc(rec.error ?? "");
  if (rec.state !== "done" || !o) return "";
  if (s === "detect") { const d = o as DetectOut; return `${d.layout} layout; ${d.modules.length} code modules; versions ${d.versions.join(", ")}; ${d.dlc.length} add-on contents`; }
  if (s === "index") { const i = o as IndexOut; return `${i.rom.files} files, ${i.rom.dirs} directories, ${fmtBytes(i.rom.bytes)}, read in place${i.aoc.length ? `; ${i.aoc.length} add-on contents` : ""}`; }
  if (s === "profile") { const p = o as ProfileOut; return p.found ? `${esc(p.name)} (${p.id}${p.by === "build" ? ", found by main's build ID" : ""})${p.registered ? "" : "; not a registered build"}` : "no profile: provisional"; }
  if (s === "code") {
    const k = o as CodeOut, head = k.scan ? scanHeadline(k.scan) : "";
    return `${k.modules.map(m => m.name).join(", ")}; ${k.cuts} cuts applied` + (head ? `<br><b id="scanline" class="warn">${esc(head)}</b>` : "");
  }
  return "translated on demand in the page and cached; nothing to do ahead";
}
// how far a running stage is, 0..1, or -1 when it has no measure
function fraction(s: StageName, c: Counts): number {
  if (s === "code" && c.bytesTotal > 0) return Math.min(1, c.bytesDone / c.bytesTotal);
  if (s === "index" && c.total > 0) return Math.min(1, c.done / c.total);
  return -1;
}
function drawVerdict(snap: Snapshot): void {
  const det = snap.manifest.stages.detect.output as DetectOut | null, profRec = snap.manifest.stages.profile, prof = profRec.state === "done" ? profRec.output as ProfileOut | null : null;
  const box = $("verdict");
  box.hidden = !det;
  if (!det) return;
  const npdmName = det.npdm.name && det.npdm.name !== "Application" ? det.npdm.name : "";
  $("gamename").textContent = prof?.name && prof.name !== "Application" ? prof.name : det.control?.name ?? (npdmName || snap.manifest.folder.replace(/\.nup$/i, ""));
  const display = prof?.display ?? det.control?.displayVersion, vname = (v: number) => v === 0 ? "base game" : `update ${v}`;
  const sub = $("gamesub"), pick = det.versions.length > 1 ? `<select id="versionpick" aria-label="Version to start">${det.versions.map(v => `<option value="${v}"${v === det.version ? " selected" : ""}>${vname(v)}</option>`).join("")}</select>` : esc(vname(det.version));
  const subHtml = `${esc(snap.manifest.folder)} · ${display ? `version ${esc(display)} · ` : ""}${pick}${det.dlc.length ? ` · ${det.dlc.length} add-on${det.dlc.length === 1 ? "" : "s"}` : ""}`;
  if (sub.dataset.html !== subHtml) { sub.innerHTML = subHtml; sub.dataset.html = subHtml; }
  // the icon a container carries
  const key = det.control?.icon && prep ? `${storeDir}|${det.root}` : "";
  if (key !== iconFor) {
    iconFor = key;
    const img = $("gameicon") as HTMLImageElement; img.hidden = true;
    if (iconUrl) { URL.revokeObjectURL(iconUrl); iconUrl = ""; }
    if (key && prep?.o.tree.control) void prep.o.tree.control(det.root).then(c => { if (c?.icon && iconFor === key) { iconUrl = URL.createObjectURL(new Blob([c.icon as BlobPart], { type: c.iconType })); img.src = iconUrl; img.hidden = false; } }).catch(() => {});
  }
  let v: Verdict | null = null;
  if (prof) v = verdictFor(det, prof);
  box.dataset.level = v?.level ?? "pending";
  $("verdicthead").textContent = v ? v.headline + (v.level === "maybe" ? ":" : ".") : "Looking at this game…";
  $("verdictreason").textContent = v ? (v.level === "maybe" ? "no profile for this game, running with defaults." : v.reason) : "";
  // the instruction scan of the Code stage, once it is done: a gap in plain words, the table under the details
  const codeRec = snap.manifest.stages.code, scans = codeRec.state === "done" ? (codeRec.output as CodeOut | null)?.scan ?? [] : [];
  const scanHead = scanHeadline(scans);
  const gaps = [...(v?.gaps ?? []), ...(scanHead ? [`${scanHead}: the game stops if it reaches one.`] : [])];
  $("gaps").innerHTML = gaps.map(g => `<li>${esc(g)}</li>`).join("");
  $("vdetails").innerHTML = (v?.details ?? []).map(d => `<li>${esc(d)}</li>`).join("") +
    (scans.length ? `<li id="scantable">instructions the translator does not have yet (a scan of each module's code with the translator's own decoder; opcode classes and offsets only):<pre>${esc(scans.flatMap(s => scanLines(s.module, s.scan)).join("\n"))}</pre></li>` : "");
  const play = $("play") as HTMLButtonElement;
  play.disabled = snap.state !== "Ready";
  play.textContent = v?.level === "no" ? "Try anyway" : "Play";
  play.classList.toggle("primary", v?.level !== "no");
  play.title = v?.level === "no" ? "It will probably stop early. The report from the attempt is still useful." : "";
  // the technical details
  $("game").innerHTML = `<dl><dt>Title ID</dt><dd id="titleid">${det.titleId}</dd><dt>Version</dt><dd id="version">${det.version}${prof?.display ? ` (${esc(prof.display)})` : ""} of ${det.versions.join(", ")}</dd>` +
    `<dt>Profile</dt><dd id="profile">${prof ? (prof.found ? `${esc(prof.name)}${prof.registered ? "" : " (not a build the profile was made on)"}` : "no profile: provisional") : "…"}</dd>` +
    `<dt>Code modules</dt><dd>${det.modules.map(x => `${x.name} <span class="mute">${x.buildId}</span>`).join("<br>")}</dd>` +
    (det.dlc.length ? `<dt>Add-on content</dt><dd>${det.dlc.map(d => `${d.index} <span class="mute">${d.titleId}</span>`).join(", ")}</dd>` : "") +
    (prof?.graphics ? `<dt>Graphics</dt><dd id="graphics" data-api="${prof.graphics.api}">${prof.graphics.api === "nvn" ? "NVN" : prof.graphics.api === "gl" ? "OpenGL (not drawn by nxweb)" : prof.graphics.api === "vulkan" ? "Vulkan (not drawn by nxweb)" : "not known from main's imports"}</dd>` : "") +
    (prof?.layout ? `<dt>Memory</dt><dd id="layout" data-fit="${prof.layout.fit}" data-mem64="${prof.layout.mem64 ? prof.layout.mem64.fit : ""}">${prof.layout.fit === "profile" ? "fits as the profile reserves it" : prof.layout.fit === "pool" ? "fits what the game can commit" : prof.layout.mem64 ? esc(prof.layout.mem64.sentence) : "does not fit a 32-bit memory"}` +
      (prof.layout.note ? `<br><span class="mute">${esc(prof.layout.note)}</span>` : "") + `</dd>` : "") +
    (prof?.warnings.length ? `<dt>Notes</dt><dd id="warnings">${prof.warnings.map(esc).join("<br>")}</dd>` : "") + `</dl>`;
  const needs = prof?.needs ?? [], unc = prof?.unconverted ?? [];
  $("needsbox").hidden = !prof || (!needs.length && !unc.length && prof.found);
  $("needs").innerHTML = prof && !prof.found ? "<li>Nothing is known about this game: it has no profile. It is started with values read from its files.</li>"
    : needs.map(n => `<li data-key="${esc(n.key)}"><b>${esc(n.key)}</b> <span class="mute">${esc(n.value)}</span><br>${esc(n.what)}</li>`).join("");
  $("unconverted").textContent = unc.length ? `Patches of nxnative that were not converted for this game: ${unc.map(u => u.kind).join(", ")}.` : "";
}
function draw(snap: Snapshot): void {
  const m = $("machine"); m.dataset.state = snap.state; m.textContent = snap.state + (snap.reason ? ` (${snap.reason})` : "");
  const failed = snap.state === "Failed";
  $("errorbox").hidden = !failed;
  $("error").textContent = failed ? snap.error : "";
  $("errorsentence").textContent = failed ? failureSentence(snap.reason as any, snap.error) : "";
  const busy = !["Idle", "Ready", "Failed", "Cancelled"].includes(snap.state);
  ($("cancel") as HTMLButtonElement).disabled = !busy;
  ($("forget") as HTMLButtonElement).disabled = busy || !prep;
  $("progress").hidden = !prep && snap.state === "Idle";
  const now = Date.now();
  $("stages").innerHTML = STAGES.map(s => {
    const rec = snap.manifest.stages[s], st = rec.state, skipped = st === "done" && lastRun.skipped.includes(s);
    if (st === "running") started[s] ??= now; else delete started[s];
    const f = st === "running" ? fraction(s, snap.counts) : -1;
    const time = st === "running" ? fmtTime(now - started[s]!) : st === "done" && !skipped && rec.ms !== undefined ? fmtTime(rec.ms) : "";
    return `<div class="stage" data-stage="${s}" data-state="${st}" data-skipped="${skipped ? 1 : 0}"><div class="sthead"><span class="label">${STAGE_TEXT[s]}</span><span class="st">${skipped ? "done (kept from last time)" : STATE_TEXT[st]}</span>` +
      `<span class="time" data-time="${s}">${time}</span><button class="quiet" data-redo="${s}" ${busy || st === "pending" ? "disabled" : ""} title="Do this step again">Redo</button></div>` +
      (st === "running" ? `<div class="bar${f < 0 ? " busy" : ""}" role="progressbar" aria-label="${STAGE_TEXT[s]}"${f < 0 ? "" : ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(f * 100)}"`}><i${f < 0 ? "" : ` style="width:${(f * 100).toFixed(1)}%"`}></i></div>` : "") +
      `<div class="info">${stageLine(s, snap)}</div></div>`;
  }).join("");
  drawVerdict(snap);
  tick();
}
// the times that move while a stage runs (the rows themselves are drawn on a change of state or count)
function tick(): void {
  const now = Date.now();
  for (const s of STAGES) if (started[s]) { const el = document.querySelector(`[data-time="${s}"]`); if (el) el.textContent = fmtTime(now - started[s]!); }
  $("elapsed").textContent = runStarted ? fmtTime((runEnded || now) - runStarted) : "";
}
setInterval(tick, 250);

async function start(tree: PrepTree, o: { redo?: StageName; version?: number } = {}): Promise<PrepResult | null> {
  if (prep && !["Idle", "Ready", "Failed", "Cancelled"].includes(prep.w.state)) return null;
  $("handoff").textContent = "";
  hideExplain();
  storeDir = "nxweb-prepare-" + tree.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (!prep || prep.o.tree !== tree || (o.version !== undefined && prep.o.version !== o.version)) {
    prep = new Prepare({ wasm: new PrepWasm(await compiled(), log), tree, store: new OpfsStore(storeDir), profiles, onChange: draw, version: o.version,
      unpackStep, at: p => p === hold ? new Promise<void>(() => {}) : undefined, scanner: await scanner() });
  }
  (window as any).nxwebPrepare = prep;
  (window as any).nxwebLastRun = null;
  runStarted = Date.now(); runEnded = 0;
  try {
    const res = o.redo ? await prep.redo(o.redo) : await prep.run();
    lastRun = res; runEnded = Date.now();
    // a folder that holds one .nup and no game files: the container is what was meant
    const inside = res.state === "Failed" && res.reason === "layout" ? (tree as { filesMatching?: (re: RegExp) => { path: string; file: File }[] }).filesMatching?.(/^[^/]+\.nup$/i) ?? [] : [];
    if (inside.length === 1) { log(`the folder holds ${inside[0].path}: opening that`); prep = null; return await openFile(inside[0].file); }
    (window as any).nxwebLastRun = res;
    draw(prep.snapshot());
    return res;
  } catch (e) { runEnded = Date.now(); const msg = String(e instanceof Error ? e.message : e); log("[RED] prepare: " + msg); $("errorbox").hidden = false; $("errorsentence").textContent = failureSentence("internal"); $("error").textContent = msg; return null; }
}

// ---- a file: a NUP container is opened; anything else is explained ----
async function openFile(file: File, handle?: unknown): Promise<PrepResult | null> {
  if (prep && !["Idle", "Ready", "Failed", "Cancelled"].includes(prep.w.state)) return null;
  hideExplain();
  let head: Uint8Array;
  try { head = new Uint8Array(await file.slice(0, 0x200).arrayBuffer()); }
  catch (e) { showExplain("This file could not be read", "The browser was not allowed to read it, or it moved. Choose it again.", "", `${file.name}: ${(e as Error).message}`); return null; }
  const x = explainFile(file.name, head, file.size);
  const begins = Array.from(head.subarray(0, 8), b => b.toString(16).padStart(2, "0")).join(" ");
  if (x.kind !== "nup") { showExplain(x.title, x.text, x.developer, `${file.name}, ${file.size.toLocaleString("en-US")} bytes, begins ${begins || "(nothing)"}`); (window as any).nxwebExplained = x.kind; return null; }
  let tree: NupTree;
  try {
    hasher ??= new PrepWasm(await compiled());
    const h = hasher;
    tree = await NupTree.open(blobBytes(file, false), file.name, { sha256: b => h.sha256(b), log });
  } catch (e) {
    const reason = (e as { reason?: string }).reason, msg = (e as Error).message;
    showExplain("This .nup file can't be opened", reason === "read" ? failureSentence("read", msg) : /no base game/.test(msg) ? "It holds an update or add-on without the game itself. Pack the base game and its update into one .nup." : "It is not a NUP container nxweb can read, or it is damaged.", "", msg);
    (window as any).nxwebExplained = "bad-nup";
    return null;
  }
  for (const n of tree.notes) log(`${file.name}: ${n}`);
  await remember(handle ?? null);
  showResume(handle ? file.name : "");
  return start(tree);
}
const showResume = (name: string) => { const b = $("resume"); b.hidden = !name; b.textContent = name ? `Continue with ${name}` : "Continue"; };

// ---- picking: the File System Access pickers where they work, the file inputs where they do not (a browser
// without them, or a sandboxed or cross-origin frame, where calling them throws) ----
const refused = (e: unknown) => (e as { name?: string })?.name !== "AbortError";       // AbortError: the person closed the dialog
$("pickfile").addEventListener("click", async () => {
  const picker = (window as any).showOpenFilePicker;
  if (picker) {
    try { const [h] = await picker.call(window, { id: "nxweb-game-file", multiple: false }); await openFile(await h.getFile(), h); return; }
    catch (e) { if (!refused(e)) return; log(`the file picker is not available here (${(e as Error).name}): using the file input`); }
  }
  ($("fileinput") as HTMLInputElement).click();
});
$("pick").addEventListener("click", async () => {
  const picker = (window as any).showDirectoryPicker;
  if (picker) {
    let h: any;
    try { h = await picker.call(window, { id: "nxweb-game", mode: "read" }); }
    catch (e) { if (!refused(e)) return; log(`the folder picker is not available here (${(e as Error).name}): using the file input`); }
    if (h) { await remember(h); showResume(h.name); await start(new HandleTree(h)); return; }
  }
  ($("dirinput") as HTMLInputElement).click();
});
$("resume").addEventListener("click", async () => {
  const h = await remembered();
  if (!h) return;
  try { if (h.queryPermission && await h.queryPermission({ mode: "read" }) !== "granted" && await h.requestPermission({ mode: "read" }) !== "granted") { showExplain("The browser did not give the game back", "Choose the file or folder again.", "", "permission to read was not granted"); return; } } catch { /* an OPFS handle has no permission to ask */ }
  if (h.kind === "file") {
    let f: File;
    try { f = await h.getFile(); } catch (e) { showExplain("The game file is not where it was", "Choose it again.", "", (e as Error).message); return; }
    await openFile(f, h);
  } else await start(new HandleTree(h));
});
$("fileinput").addEventListener("change", async ev => {
  const input = ev.target as HTMLInputElement, files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) await openFile(files.find(f => /\.nup$/i.test(f.name)) ?? files[0]);
});
$("dirinput").addEventListener("change", async ev => {
  const files = (ev.target as HTMLInputElement).files;
  if (files && files.length) { await remember(null); showResume(""); await start(new FileListTree(files)); }
});

// ---- a drop: on the drop area, or anywhere on the main page (web/main.ts passes the event's DataTransfer on) ----
const dropBox = $("drop");
function takeDrop(dt: DataTransfer | null | undefined): void {
  dropBox.classList.remove("over");
  const items = Array.from(dt?.items ?? []).filter(i => i.kind === "file") as any[];
  if (!items.length) { const f = dt?.files?.[0]; if (f) void openFile(f); return; }
  // what the items give must be asked for before the event is over
  const got = items.map(item => ({ handle: item.getAsFileSystemHandle ? Promise.resolve(item.getAsFileSystemHandle()).catch(() => null) : Promise.resolve(null), entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile?.() ?? null as File | null }));
  void (async () => {
    const all = await Promise.all(got.map(async g => ({ ...g, h: await g.handle as any })));
    const name = (g: typeof all[number]) => g.h?.name ?? g.entry?.name ?? g.file?.name ?? "";
    const isDir = (g: typeof all[number]) => g.h ? g.h.kind === "directory" : !!g.entry?.isDirectory;
    const one = all.find(g => !isDir(g) && /\.nup$/i.test(name(g))) ?? all.find(isDir) ?? all[0];
    if (all.length > 1 && !isDir(one) && !/\.nup$/i.test(name(one))) {
      showExplain("Several files were dropped", "Drop one .nup file, or the game's folder itself (not the files inside it).", "", all.map(name).join(", ")); (window as any).nxwebExplained = "several"; return;
    }
    // File System Access where the browser has it (the handle survives a reload), else the entry API every browser has
    if (one.h?.kind === "directory") { await remember(one.h); showResume(one.h.name); await start(new HandleTree(one.h)); return; }
    if (one.h?.kind === "file") { await openFile(await one.h.getFile(), one.h); return; }
    if (one.entry?.isDirectory) { await remember(null); showResume(""); await start(new EntryTree(one.entry)); return; }
    if (one.file) await openFile(one.file);
  })();
}
dropBox.addEventListener("dragover", ev => { ev.preventDefault(); dropBox.classList.add("over"); });
dropBox.addEventListener("dragleave", () => dropBox.classList.remove("over"));
document.addEventListener("dragover", ev => ev.preventDefault());
document.addEventListener("drop", ev => { ev.preventDefault(); takeDrop((ev as DragEvent).dataTransfer); });
(window as any).nxwebDrop = takeDrop;
(window as any).nxwebDragOver = (on: boolean) => dropBox.classList.toggle("over", on);

$("cancel").addEventListener("click", () => prep?.cancel());
$("stages").addEventListener("click", ev => {
  const s = (ev.target as HTMLElement).dataset?.redo as StageName | undefined;
  if (s && prep) void start(prep.o.tree, { redo: s });
});
$("gamesub").addEventListener("change", ev => {
  const sel = ev.target as HTMLSelectElement;
  if (sel.id === "versionpick" && prep) void start(prep.o.tree, { version: Number(sel.value) });
});
$("forget").addEventListener("click", async () => {
  if (!prep) return;
  await OpfsStore.destroy(storeDir); await remember(null);
  prep = null; lastRun = { skipped: [], ran: [] };
  location.reload();
});
// Play: the hand-off. The message is plain data and Blobs (references to the user's files and to the cut modules in
// OPFS); whoever runs the game listens for "nxweb:handoff" and posts it to the Worker.
$("play").addEventListener("click", async () => {
  if (!prep) return;
  try {
    const h = await prep.handoff(), msg: HandOffMessage = await h.message();
    (window as any).nxwebHandOff = msg;
    $("handoff").textContent = `handed off: ${msg.modules.length} code modules (${msg.cuts.length} cuts applied), RomFS of ${msg.rom?.sizes.length ?? 0} files, ${msg.aoc.length} add-on contents, saves under ${msg.saveId}`;
    window.dispatchEvent(new CustomEvent("nxweb:handoff", { detail: msg }));
  } catch (e) { const msg = String(e instanceof Error ? e.message : e); log("[RED] prepare: " + msg); $("handoff").textContent = "could not start: " + msg; }
});

draw({ state: "Idle", reason: "", error: "", counts: { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, files: 0, modules: 0, cuts: 0, romFiles: 0, romDirs: 0, aoc: 0, skipped: 0, ran: 0 },
  stages: { detect: "pending", index: "pending", profile: "pending", code: "pending", shaders: "pending" }, manifest: Prepare.blank("") });
void remembered().then(h => { if (h) showResume(h.name); });
if (!(window as any).showDirectoryPicker) $("pick").title = "This browser has no folder picker: the file input is used";
// in the main page's frame: the frame is as tall as its content
if (embedded) {
  const fit = () => { try { const f = window.frameElement as HTMLElement | null; if (f) f.style.height = Math.ceil(document.querySelector("main")!.getBoundingClientRect().height) + 2 + "px"; } catch { /* another origin: the parent keeps its height */ } };
  new ResizeObserver(fit).observe(document.querySelector("main")!); fit();
}
(window as any).nxwebPrepareReady = true;
