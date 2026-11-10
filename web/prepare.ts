// web/prepare.html: the prepare step as a page of its own (the integration owner merges it into the main page).
// Main thread. Picks a folder (the directory picker, a dropped directory, or <input webkitdirectory>), runs
// src/prepare's pipeline on it with its manifest in the Origin Private File System, shows the machine's state and
// counts, the detected game and what its profile says will not work, and on Play makes the hand-off message.
import { PrepWasm, type Counts } from "../src/prepare/host/wasm.ts";
import { HandleTree, EntryTree, FileListTree, type PrepTree } from "../src/prepare/host/tree.ts";
import { OpfsStore } from "../src/prepare/host/store.ts";
import { fetchProfiles } from "../src/prepare/host/profiles.ts";
import { Prepare, STAGES, type StageName, type Snapshot, type DetectOut, type ProfileOut, type CodeOut, type IndexOut, type HandOffMessage } from "../src/prepare/host/prepare.ts";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
// Test hook (test/prepare/browser.mts): ?hold=<stage>:<point> makes the run wait there for ever, so that the
// page can be reloaded in the middle of a stage.
const hold = params.get("hold");
const STAGE_TEXT: Record<StageName, string> = { detect: "Detect", index: "Index the RomFS", profile: "Profile", code: "Code modules", shaders: "Shaders" };
const fmtBytes = (n: number) => n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + " GB" : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const log = (line: string) => { const el = $("log"); el.textContent += line + "\n"; el.scrollTop = el.scrollHeight; };

let wasmModule: Promise<WebAssembly.Module> | undefined;
let prep: Prepare | null = null, storeDir = "", lastRun: { skipped: StageName[]; ran: StageName[] } = { skipped: [], ran: [] };
const profiles = fetchProfiles("profiles/");

// ---- the last folder's handle, kept so that a reload can go on without picking again (File System Access only) ----
const idb = (): Promise<IDBDatabase> => new Promise((res, rej) => { const r = indexedDB.open("nxweb-prepare", 1); r.onupgradeneeded = () => r.result.createObjectStore("handles"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function remember(handle: unknown | null): Promise<void> {
  try { const db = await idb(); await new Promise<void>((res, rej) => { const t = db.transaction("handles", "readwrite"); if (handle) t.objectStore("handles").put(handle, "last"); else t.objectStore("handles").delete("last"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); db.close(); } catch { /* no IndexedDB: no resume button */ }
}
async function remembered(): Promise<any | null> {
  try { const db = await idb(); const h = await new Promise<any>((res, rej) => { const r = db.transaction("handles").objectStore("handles").get("last"); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); db.close(); return h; } catch { return null; }
}

// ---- drawing: machine state plus counts, nothing parsed from text ----
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
  if (s === "code") { const k = o as CodeOut; return `${k.modules.map(m => m.name).join(", ")}; ${k.cuts} cuts applied`; }
  return "translated on demand in the page and cached; nothing to do ahead";
}
function draw(snap: Snapshot): void {
  const m = $("machine"); m.dataset.state = snap.state; m.textContent = snap.state + (snap.reason ? ` (${snap.reason})` : "");
  $("error").textContent = snap.state === "Failed" ? snap.error : "";
  const busy = !["Idle", "Ready", "Failed", "Cancelled"].includes(snap.state);
  ($("cancel") as HTMLButtonElement).disabled = !busy;
  ($("play") as HTMLButtonElement).disabled = snap.state !== "Ready";
  ($("forget") as HTMLButtonElement).disabled = busy || !prep;
  $("stages").innerHTML = STAGES.map(s => {
    const st = snap.manifest.stages[s].state, skipped = st === "done" && lastRun.skipped.includes(s);
    return `<tr data-stage="${s}" data-state="${st}" data-skipped="${skipped ? 1 : 0}"><td>${STAGE_TEXT[s]}</td><td class="st">${skipped ? "kept" : st}</td><td class="info">${stageLine(s, snap)}</td>` +
      `<td class="act"><button data-redo="${s}" ${busy || st === "pending" ? "disabled" : ""} title="Do this stage again">redo</button></td></tr>`;
  }).join("");
  const det = snap.manifest.stages.detect.output as DetectOut | null, prof = snap.manifest.stages.profile.output as ProfileOut | null;
  if (det) {
    $("game").innerHTML = `<dl><dt>Title ID</dt><dd id="titleid">${det.titleId}</dd><dt>Version</dt><dd id="version">${det.version}${prof?.display ? ` (${esc(prof.display)})` : ""} of ${det.versions.join(", ")}</dd>` +
      `<dt>Profile</dt><dd id="profile">${prof ? (prof.found ? `${esc(prof.name)}${prof.registered ? "" : " (not a build the profile was made on)"}` : "no profile: provisional") : "…"}</dd>` +
      `<dt>Code modules</dt><dd>${det.modules.map(x => `${x.name} <span class="mute">${x.buildId}</span>`).join("<br>")}</dd>` +
      (det.dlc.length ? `<dt>Add-on content</dt><dd>${det.dlc.map(d => `${d.index} <span class="mute">${d.titleId}</span>`).join(", ")}</dd>` : "") +
      (prof?.warnings.length ? `<dt>Notes</dt><dd id="warnings">${prof.warnings.map(esc).join("<br>")}</dd>` : "") + `</dl>`;
  }
  const needs = prof?.needs ?? [], unc = prof?.unconverted ?? [];
  $("needsbox").hidden = !prof || (!needs.length && !unc.length && prof.found);
  $("needs").innerHTML = prof && !prof.found ? "<li>Nothing is known about this game: it has no profile. It is started with values read from its files.</li>"
    : needs.map(n => `<li data-key="${esc(n.key)}"><b>${esc(n.key)}</b> <span class="mute">${esc(n.value)}</span><br>${esc(n.what)}</li>`).join("");
  $("unconverted").textContent = unc.length ? `Patches of nxnative that were not converted for this game: ${unc.map(u => u.kind).join(", ")}.` : "";
}

async function start(tree: PrepTree, redo?: StageName): Promise<void> {
  if (prep && !["Idle", "Ready", "Failed", "Cancelled"].includes(prep.w.state)) return;
  $("handoff").textContent = "";
  wasmModule ??= WebAssembly.compileStreaming(fetch("wasm/prepare.wasm"));
  storeDir = "nxweb-prepare-" + tree.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (!prep || prep.o.tree !== tree) {
    prep = new Prepare({ wasm: new PrepWasm(await wasmModule, log), tree, store: new OpfsStore(storeDir), profiles, onChange: draw,
      at: p => p === hold ? new Promise<void>(() => {}) : undefined });
  }
  (window as any).nxwebPrepare = prep;
  (window as any).nxwebLastRun = null;
  try {
    const res = redo ? await prep.redo(redo) : await prep.run();
    lastRun = res;
    (window as any).nxwebLastRun = res;
    draw(prep.snapshot());
  } catch (e) { log("[RED] prepare: " + (e instanceof Error ? e.message : e)); $("error").textContent = String(e instanceof Error ? e.message : e); }
}

// ---- picking ----
$("pick").addEventListener("click", async () => {
  const picker = (window as any).showDirectoryPicker;
  if (!picker) { ($("dirinput") as HTMLInputElement).click(); return; }
  let h: any;
  try { h = await picker.call(window, { id: "nxweb-game", mode: "read" }); } catch { return; }   // closed without choosing
  await remember(h);
  await start(new HandleTree(h));
});
$("resume").addEventListener("click", async () => {
  const h = await remembered();
  if (!h) return;
  try { if (h.queryPermission && await h.queryPermission({ mode: "read" }) !== "granted" && await h.requestPermission({ mode: "read" }) !== "granted") { log("the browser did not give the folder back: choose it again"); return; } } catch { /* an OPFS handle has no permission to ask */ }
  await start(new HandleTree(h));
});
$("dirinput").addEventListener("change", async ev => {
  const files = (ev.target as HTMLInputElement).files;
  if (files && files.length) await start(new FileListTree(files));
});
const drop = $("drop");
drop.addEventListener("dragover", ev => { ev.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async ev => {
  ev.preventDefault(); drop.classList.remove("over");
  const item = (ev as DragEvent).dataTransfer?.items?.[0] as any;
  if (!item) return;
  // File System Access where the browser has it (the handle survives a reload), else the entry API every browser has
  if (item.getAsFileSystemHandle) {
    const h = await item.getAsFileSystemHandle();
    if (h?.kind === "directory") { await remember(h); await start(new HandleTree(h)); return; }
    log("that is a file: drop the game's folder"); return;
  }
  const e = item.webkitGetAsEntry?.();
  if (e?.isDirectory) await start(new EntryTree(e)); else log("that is a file: drop the game's folder");
});
$("cancel").addEventListener("click", () => prep?.cancel());
$("stages").addEventListener("click", ev => {
  const s = (ev.target as HTMLElement).dataset?.redo as StageName | undefined;
  if (s && prep) void start(prep.o.tree, s);
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
  const h = await prep.handoff(), msg: HandOffMessage = await h.message();
  (window as any).nxwebHandOff = msg;
  $("handoff").textContent = `handed off: ${msg.modules.length} code modules (${msg.cuts.length} cuts applied), RomFS of ${msg.rom?.files.length ?? 0} files, ${msg.aoc.length} add-on contents, saves under ${msg.saveId}`;
  window.dispatchEvent(new CustomEvent("nxweb:handoff", { detail: msg }));
});

draw({ state: "Idle", reason: "", error: "", counts: { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, files: 0, modules: 0, cuts: 0, romFiles: 0, romDirs: 0, aoc: 0, skipped: 0, ran: 0 },
  stages: { detect: "pending", index: "pending", profile: "pending", code: "pending", shaders: "pending" }, manifest: Prepare.blank("") });
void remembered().then(h => { if (h) { const b = $("resume"); b.hidden = false; b.textContent = `Resume ${h.name}`; } });
if (!(window as any).showDirectoryPicker) $("pick").title = "This browser has no directory picker: the file input is used";
(window as any).nxwebPrepareReady = true;
