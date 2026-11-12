// npm run prepare:browser. web/prepare.html in headless Chromium (Playwright), as far as automation reaches:
//   - the directory picker: the page's button calls showDirectoryPicker(); the test makes that return a directory
//     of the Origin Private File System that it filled with a synthetic game (a headless browser has no picker
//     dialog). Everything after the call is the real path: FileSystemDirectoryHandle, getFile(), OPFS.
//   - a dropped directory: a drop event whose DataTransfer item gives that handle (getAsFileSystemHandle).
//   - <input webkitdirectory>: Playwright sets a real folder of the disk on it (FileList, webkitRelativePath).
//   - the manifest in OPFS; a page reload in the middle of a stage and the resume after it (the handle kept in
//     IndexedDB); cancel; redo; a malformed folder.
//   - Play: the hand-off message posted to a Worker that starts the game in the runtime (test/prepare/web/worker.ts).
// Not reachable from automation: the picker dialog itself, a real drag from the desktop (webkitGetAsEntry: its
// reader loop is tested in Node with stand-in entries, prepare:test).
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, WASM } from "../../src/prepare/host/build.mts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { buildPreparePage, servePrepare } from "../../web/prepare_build.mts";
import * as rth from "../runtime/harness.mts";
import { SCRATCH, guest, npdm, blob, fnv64, writeTree, version, prefixed, bnsh, sarc, yaz0, type Files } from "./synth.mts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeNup, tlv, nacp, KIND, T, STANDALONE } from "./nup_synth.mts";
import { writeFileSync, mkdirSync } from "node:fs";

process.chdir(ROOT);
try {
  let fresh = true; try { (await import("../../src/runtime/host/build.mts")).checkBuilt(); } catch { fresh = false; }
  if (!fresh) rth.build();
  buildPreparePage();   // after the runtime's build: the page's instruction scan uses its translator.wasm
  if (!existsSync(join(rth.GUESTS, "fsg.nso")) || !existsSync(join(rth.GUESTS, "fsg_zbic.nso"))) rth.buildModules();
  buildSync({ entryPoints: ["test/prepare/web/worker.ts"], bundle: true, format: "iife", outfile: "build/prepare/web/worker.js", logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] prepare:browser: the build failed"); process.exit(1); }

const APP = 0x0100AAAA0000B000n, APP_HEX = "0100AAAA0000B000", DS = "01004AB00A260000";
const b0 = blob(60_000, 7), b1 = blob(100_003, 8);
const dlcId = (APP + 0x1002n).toString(16);
const gameFiles: Files = { ...prefixed("base/", version({ programId: APP, blob: b0 })), ...prefixed("updates/65536/", version({ programId: APP, blob: b1, extra: { "exefs/sdk": guest("two_lib") } })),
  ...prefixed(`dlc/${dlcId}/0/romfs/`, { "pack/a.bin": blob(3000, 3), "pack/b.bin": blob(17, 4), "c.txt": "dlc" }) };
const fsgOut = (b: Uint8Array) => `MountRom: 0x0\nopen a file that is not there: 0x202\nrom:/data/blob.bin: ${b.length} bytes of ${b.length}, fnv64 ${fnv64(b)}\nEnsureSaveData: 0x0\nMountSaveData: 0x0\nsave:/counter.bin is not there yet\nCreateFile: 0x0\nwrote 1: rc=0x0\nCommit: 0x0\n`;
// a folder on disk for the <input webkitdirectory> path: a title the converted profiles know (no game file: the runtime's guest)
const diskDir = writeTree(join(SCRATCH, "browser-input", "DarkGame"), version({ programId: BigInt("0x" + DS), blob: b0, rom: { "dvdbnd0.bdt": "marker", "data/blob.bin": b0 } }));

const { server, url } = await servePrepare(0, u => {
  if (u === "/test-worker.js") return { body: readFileSync(join(ROOT, "build", "prepare", "web", "worker.js")), type: "text/javascript" };
  const m = /^\/rtwasm\/(\w+)\.wasm$/.exec(u);
  return m ? { body: readFileSync(join(rth.OUT, m[1] + ".wasm")), type: "application/wasm" } : null;
});
const { chromium } = createRequire(import.meta.url)("playwright");
const channel = process.env.PREPARE_BROWSER_CHANNEL ?? "chromium";
// A persistent context (a profile directory), not Playwright's default off-the-record one: in Chromium 153 a
// FileSystemDirectoryHandle of the OPFS read back from IndexedDB takes the whole browser down in an off-the-record
// context (found here; the page keeps the picked folder's handle there for its Resume button).
const profileDir = join(SCRATCH, "pw-profile-" + Date.now().toString(36));
const ctx = await chromium.launchPersistentContext(profileDir, { headless: true, ...(channel === "shell" ? {} : { channel }) });
const browser = { version: () => ctx.browser()?.version() ?? "", close: () => ctx.close() };
let failed = 0, ran = 0;
const results: string[] = [];
const run = async (name: string, fn: () => Promise<string | void>) => {
  ran++; const t0 = Date.now();
  try { const info = await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)` + (info ? "\n       " + info : "")); }
  catch (e) { failed++; console.log(`[RED] FAIL ${name}\n${e instanceof Error ? e.stack : e}`); }
};
const eq = (a: unknown, b: unknown, what: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const tag = Date.now().toString(36), folder = `Game-${tag}`;
try {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const open = async (query = "") => { await page.goto(`${url}prepare.html${query}`); await page.waitForFunction(() => (window as any).nxwebPrepareReady === true); };
  await open();
  const info = await page.evaluate(() => ({ isolated: (self as any).crossOriginIsolated, picker: typeof (window as any).showDirectoryPicker, opfs: !!(navigator as any).storage?.getDirectory }));
  console.log(`browser: Chromium ${browser.version() || await page.evaluate(() => (/Chrome\/([\d.]+)/.exec(navigator.userAgent) ?? ["", "?"])[1])} (${channel === "shell" ? "chrome-headless-shell" : "channel " + channel + ", headless"}), crossOriginIsolated=${info.isolated}, showDirectoryPicker=${info.picker}, OPFS=${info.opfs}`);

  // the synthetic game, written into an OPFS directory: the stand-in for the folder a player picks
  const putGame = (root: string, files: Files, dirs: string[] = []) => page.evaluate(async ({ root, files, dirs }: { root: string; files: [string, string][]; dirs: string[] }) => {
    const top = await (navigator as any).storage.getDirectory();
    try { await top.removeEntry(root, { recursive: true }); } catch { /* not there */ }
    const base = await top.getDirectoryHandle(root, { create: true });
    const dirOf = async (parts: string[]) => { let d = base; for (const p of parts) d = await d.getDirectoryHandle(p, { create: true }); return d; };
    for (const d of dirs) await dirOf(d.split("/"));
    for (const [path, b64] of files) {
      const parts = path.split("/"), name = parts.pop()!, d = await dirOf(parts);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close();
    }
  }, { root, files: Object.entries(files).map(([p, c]) => [p, Buffer.from(c as Uint8Array | string).toString("base64")] as [string, string]), dirs });
  await putGame(folder, gameFiles, ["updates/65536/romfs/empty"]);
  // showDirectoryPicker gives that directory (set again after every navigation)
  const fakePicker = (root: string) => page.evaluate((root: string) => { (window as any).pickerCalls = 0; (window as any).showDirectoryPicker = async () => { (window as any).pickerCalls++; return (await (navigator as any).storage.getDirectory()).getDirectoryHandle(root); }; }, root);
  const state = () => page.evaluate(() => document.getElementById("machine")!.dataset.state);
  // the run the page started has returned (the machine reaches its end state a moment before the page has the result)
  const until = (...states: string[]) => page.waitForFunction((s: string[]) => s.includes(document.getElementById("machine")!.dataset.state!) && !!(window as any).nxwebLastRun, states, { timeout: 60000 });
  const stages = () => page.evaluate(() => [...document.querySelectorAll("#stages .stage")].map(r => `${(r as HTMLElement).dataset.stage}:${(r as HTMLElement).dataset.state}${(r as HTMLElement).dataset.skipped === "1" ? "(kept)" : ""}`));
  const lastRun = () => page.evaluate(() => { const r = (window as any).nxwebLastRun; return r ? { state: r.state, ran: r.ran, skipped: r.skipped, reason: r.reason } : null; });
  const manifest = (dir: string) => page.evaluate(async (dir: string) => {
    try { const d = await (await (navigator as any).storage.getDirectory()).getDirectoryHandle(dir); return JSON.parse(await (await (await d.getFileHandle("manifest.json")).getFile()).text()); } catch { return null; }
  }, dir);
  const storeFiles = (dir: string) => page.evaluate(async (dir: string) => { const out: string[] = []; try { const d = await (await (navigator as any).storage.getDirectory()).getDirectoryHandle(dir); for await (const [n] of d.entries()) out.push(n); } catch { /* none */ } return out.sort(); }, dir);
  const storeDir = "nxweb-prepare-" + folder;

  await run("the directory picker: the button calls showDirectoryPicker, the folder is prepared, the page shows the five stages done with their counts, the game, and 'no profile: provisional'; the manifest is in OPFS", async () => {
    await fakePicker(folder);
    await page.click("#pick");
    await until("Ready", "Failed");
    eq(await state(), "Ready", "state: " + await page.textContent("#error"));
    eq(await page.evaluate(() => (window as any).pickerCalls), 1, "picker calls");
    eq(await stages(), ["detect:done", "index:done", "profile:done", "code:done", "shaders:done"], "stages");
    eq([await page.textContent("#titleid"), (await page.textContent("#version"))!.trim(), await page.textContent("#profile")], [APP_HEX, "65536 of 0, 65536", "no profile: provisional"], "game");
    const rows = await page.evaluate(() => [...document.querySelectorAll("#stages .stage .info")].map(td => td.textContent));
    if (!/^base layout; 2 code modules; versions 0, 65536; 1 add-on contents$/.test(rows[0]!)) throw new Error("detect row: " + rows[0]);
    if (!/^2 files, 3 directories, [\d.]+ KB, read in place; 1 add-on contents$/.test(rows[1]!)) throw new Error("index row: " + rows[1]);
    if (rows[3] !== "main, sdk; 0 cuts applied") throw new Error("code row: " + rows[3]);
    const m = await manifest(storeDir);
    eq([m.format, m.folder, m.machine, Object.values(m.stages).map((s: any) => s.state), m.stages.detect.output.titleId, m.stages.detect.output.version], [3, folder, "Ready", ["done", "done", "done", "done", "done"], APP_HEX, 65536], "manifest");
    eq(await storeFiles(storeDir), [`aoc2.index`, `aoc2.tables`, "manifest.json", "rom.index", "rom.tables"], "what is stored: tables and the manifest, no copy of any game file");
    eq(await page.evaluate(() => !(document.getElementById("play") as HTMLButtonElement).disabled), true, "Play is enabled");
    return `manifest in OPFS ${storeDir}: 5 stages done, input hashes ${Object.values(m.stages).map((s: any) => s.input.slice(0, 8)).join(" ")}`;
  });

  await run("Play: the hand-off message goes to a Worker, which starts the game in the runtime: it mounts the RomFS of the picked folder (the newest update's) through FileReaderSync and prints its checksum; the add-on content reads back", async () => {
    const r = await page.evaluate(async () => {
      const got = new Promise<any>(res => window.addEventListener("nxweb:handoff", ev => res((ev as CustomEvent).detail), { once: true }));
      document.getElementById("play")!.click();
      const msg = await got;
      const w = new Worker("/test-worker.js");
      const out = await new Promise<any>((res, rej) => { w.onmessage = ev => res(ev.data); w.onerror = e => rej(new Error(e.message)); w.postMessage({ handoff: msg }); });
      w.terminate();
      return { out, text: document.getElementById("handoff")!.textContent, shape: { modules: msg.modules.map((m: any) => [m.name, m.file instanceof Blob, m.cuts]), rom: msg.rom.files.length, romBlobs: msg.rom.files.every((f: any) => f instanceof File), aoc: msg.aoc.map((a: any) => a.index), saveId: msg.saveId, shaders: { ...msg.shaders, prewarm: msg.shaders.prewarm && { found: msg.shaders.prewarm.found, failed: msg.shaders.prewarm.failed } }, provisional: msg.profile.provisional, hooks: msg.hooks.length } };
    });
    if (!r.out.ok) throw new Error(r.out.error);
    eq(r.shape, { modules: [["main", true, 0], ["sdk", true, 0]], rom: 2, romBlobs: true, aoc: [2], saveId: "nxweb-save-" + APP_HEX, shaders: { mode: "on-demand", chain: "nxweb-shaders-9/page", store: "nxweb-shaders", prewarm: { found: 0, failed: 0 } }, provisional: true, hooks: 0 }, "message");
    eq([r.out.kind, r.out.code, r.out.red, r.out.romSync], ["exit", 0, [], true], "run");
    eq(r.out.stdout, "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\n" + fsgOut(b1) + "lib: fini_array[0]\nlib: DT_FINI\n", "stdout");
    let sum = 0; for (const f of ["c.txt", "pack/a.bin", "pack/b.bin"]) { const b = gameFiles[`dlc/${dlcId}/0/romfs/${f}`]; for (const v of typeof b === "string" ? Buffer.from(b) : b) sum = (sum * 31 + v) >>> 0; }
    eq(r.out.aoc, [{ index: 2, files: 3, bytes: 3020, sum, sync: true }], "add-on content");
    return `${r.text}; in the Worker the guest printed the update's ${b1.length}-byte blob's checksum`;
  });

  await run("a second run on the unchanged folder keeps all five stages (by their input hashes); redo of one stage runs that stage", async () => {
    await page.click("#pick"); await page.waitForFunction(() => (window as any).nxwebLastRun?.skipped.length === 5, null, { timeout: 60000 });
    eq(await lastRun(), { state: "Ready", ran: [], skipped: ["detect", "index", "profile", "code", "shaders"] }, "second run");
    eq(await stages(), ["detect:done(kept)", "index:done(kept)", "profile:done(kept)", "code:done(kept)", "shaders:done(kept)"], "stages");
    await page.click('#stages button[data-redo="index"]');
    await page.waitForFunction(() => (window as any).nxwebLastRun?.ran.length === 1, null, { timeout: 60000 });
    eq(await lastRun(), { state: "Ready", ran: ["index"], skipped: ["detect", "profile", "code", "shaders"] }, "redo index");
  });

  await run("a page reload in the middle of the Code stage: the manifest in OPFS says Code is running; after the reload the page offers the folder again (its handle from IndexedDB), and the resumed run keeps what was finished and runs Code", async () => {
    // make Code have work: a module's time changes nothing in its bytes, but Code looks again
    await page.evaluate(async ({ root }: { root: string }) => {
      const d = await (await (await (await (await (navigator as any).storage.getDirectory()).getDirectoryHandle(root)).getDirectoryHandle("updates")).getDirectoryHandle("65536")).getDirectoryHandle("exefs");
      const h = await d.getFileHandle("sdk"), b = await (await h.getFile()).arrayBuffer();
      await new Promise(r => setTimeout(r, 20));
      const w = await h.createWritable(); await w.write(b); await w.close();
    }, { root: folder });
    await open("?hold=code:work"); await fakePicker(folder);
    eq(await page.textContent("#resume"), "Continue with " + folder, "the resume button");
    await page.click("#pick");
    await page.waitForFunction(() => document.querySelector('#stages [data-stage="code"]')?.getAttribute("data-state") === "running", null, { timeout: 60000 });
    eq(await state(), "Code", "held in Code");
    const during = await manifest(storeDir);
    eq([during.machine, Object.values(during.stages).map((s: any) => s.state)], ["Code", ["done", "done", "done", "running", "done"]], "the manifest while Code runs");
    await open();   // the reload: the page that was preparing is gone
    eq(await state(), "Idle", "after the reload");
    eq(await page.isVisible("#resume"), true, "resume is offered");
    await page.click("#resume");
    await until("Ready", "Failed");
    eq(await lastRun(), { state: "Ready", ran: ["code"], skipped: ["detect", "index", "profile", "shaders"] }, "the resumed run");
    const after = await manifest(storeDir);
    eq([after.machine, Object.values(after.stages).map((s: any) => s.state)], ["Ready", ["done", "done", "done", "done", "done"]], "the manifest after");
    return "Detect (done by the page that was reloaded), Index, Profile and Shaders were kept; Code, which the reload interrupted, ran";
  });

  await run("a reload in the middle of Index on a folder never prepared before: the next page's run starts Index again and finishes", async () => {
    const f2 = folder + "-b";
    await putGame(f2, prefixed("base/", version({ programId: APP, blob: b0 })));
    await open("?hold=index:work"); await fakePicker(f2);
    await page.click("#pick");
    await page.waitForFunction(() => document.querySelector('#stages [data-stage="index"]')?.getAttribute("data-state") === "running", null, { timeout: 60000 });
    const during = await manifest("nxweb-prepare-" + f2);
    eq([during.machine, during.stages.detect.state, during.stages.index.state, during.stages.code.state], ["Index", "done", "running", "pending"], "manifest");
    await open(); await page.click("#resume"); await until("Ready", "Failed");
    eq(await lastRun(), { state: "Ready", ran: ["index", "profile", "code", "shaders"], skipped: ["detect"] }, "the resumed run");
    return "resumed from the handle in IndexedDB without the picker";
  });

  await run("a dropped directory (a drop event whose item gives a FileSystemDirectoryHandle): prepared like a picked one; a dropped code file is explained, not prepared", async () => {
    const f3 = folder + "-c";
    await putGame(f3, version({ programId: APP, blob: b0 }));
    await open();
    const drop = (root: string, kind: string) => page.evaluate(async ({ root, kind }: { root: string; kind: string }) => {
      const top = await (navigator as any).storage.getDirectory();
      const h = kind === "directory" ? await top.getDirectoryHandle(root) : await (await top.getDirectoryHandle(root)).getDirectoryHandle("exefs").then((d: any) => d.getFileHandle("main"));
      const ev = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: { items: [{ kind: "file", getAsFileSystemHandle: async () => h }] } });
      document.getElementById("drop")!.dispatchEvent(ev);
    }, { root, kind });
    await drop(f3, "file");
    await page.waitForFunction(() => (window as any).nxwebExplained === "nso");
    eq([await page.isVisible("#explain"), await page.textContent("#explaintitle")], [true, "This is one code file of a game, not the whole game"], "a single code file is explained");
    eq(await state(), "Idle", "a file changes nothing");
    await drop(f3, "directory");
    await until("Ready", "Failed");
    eq([await state(), await page.textContent("#titleid"), (await page.textContent("#version"))!.trim()], ["Ready", APP_HEX, "0 of 0"], "the dropped folder (exefs/ and romfs/ directly in it)");
  });

  await run("<input webkitdirectory> with a real folder of the disk: a title the converted profiles know is found by its title ID; the page lists what will not work for it; cancel and a malformed folder", async () => {
    await open();
    await page.setInputFiles("#dirinput", diskDir);
    await until("Ready", "Failed");
    eq(await state(), "Ready", "state: " + await page.textContent("#error"));
    eq(await page.textContent("#titleid"), DS, "title");
    const prof = await page.textContent("#profile");
    if (prof !== "DARK SOULS: REMASTERED (not a build the profile was made on)") throw new Error("profile: " + prof);
    const needs = await page.evaluate(() => [...document.querySelectorAll("#needs li")].map(li => (li as HTMLElement).dataset.key));
    eq(needs, [], "what will not work: nothing (its 3.25 GB heap region is no need any more: by the runtime's layout rule it fits)");
    eq(await page.isVisible("#needsbox"), false, "no list");
    eq(await page.getAttribute("#layout", "data-fit"), "profile", "the address-space verdict, the runtime's");
    const fitText = await page.textContent("#layout");
    if (fitText !== "fits as the profile reserves it") throw new Error("layout text: " + fitText);
    const m = await manifest("nxweb-prepare-DarkGame");
    eq([m.stages.profile.output.id, m.stages.profile.output.apply.mem_used, m.stages.profile.output.cuts.length], [DS, "0x6e00000", 0], "profile output");
    await open();
    // a malformed folder: the exefs folder itself
    await page.setInputFiles("#dirinput", join(diskDir, "exefs"));
    await until("Ready", "Failed");
    eq(await state(), "Failed", "the exefs folder");
    const err = await page.textContent("#error");
    if (!/this is an exefs folder .* pick the folder above it/.test(err!)) throw new Error("error text: " + err);
    eq(await page.evaluate(() => document.getElementById("machine")!.textContent), "Failed (layout)", "the machine's reason");
    return `needs: ${needs.join(", ") || "none"}; memory: ${fitText}; the exefs folder alone: ${err}`;
  });

  await run("cancel from the page: a run held in the Code stage is cancelled, the manifest records it, the next run finishes", async () => {
    const f4 = folder + "-d";
    await putGame(f4, version({ programId: APP, blob: b0 }));
    await open(); await fakePicker(f4);
    // cancel as soon as Code is running: the click is queued by the page before the stage's next step
    await page.evaluate(() => { new MutationObserver(() => { if (document.querySelector('#stages [data-stage="code"]')?.getAttribute("data-state") === "running") (document.getElementById("cancel") as HTMLButtonElement).click(); }).observe(document.getElementById("stages")!, { childList: true, subtree: true }); });
    await page.click("#pick");
    await until("Ready", "Failed", "Cancelled");
    eq(await state(), "Cancelled", "state");
    const m = await manifest("nxweb-prepare-" + f4);
    eq([m.machine, m.stages.code.state, m.stages.profile.state], ["Cancelled", "cancelled", "done"], "manifest");
    await open(); await page.click("#resume"); await until("Ready", "Failed");
    eq(await lastRun(), { state: "Ready", ran: ["code", "shaders"], skipped: ["detect", "index", "profile"] }, "after the cancel");
  });


  // ---- a NUP container: one file, chosen through the page ----
  const nupDir = join(SCRATCH, "browser-nup"); mkdirSync(nupDir, { recursive: true });
  const part = (v: Files, prefix: string) => Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith(prefix)).map(([k, x]) => [k.slice(prefix.length), x]));
  const pkg = (kind: number, v: Files, more: object = {}) => ({ kind, titleId: APP, exefs: part(v, "exefs/"), romfs: part(v, "romfs/"), ...more });
  const ICON = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));   // a 1x1 PNG
  const nupName = `Container-${tag}.nup`, nupFile = join(nupDir, nupName);
  const nupOut = writeNup([pkg(KIND.base, version({ programId: APP, blob: b0 }), { meta: tlv([[T.NACP, nacp("Container Test", "", "2.5.0", "nxweb tests")], [T.ICON, ICON]]) }),
    pkg(KIND.update, version({ programId: APP, blob: b1, extra: { "exefs/sdk": guest("two_lib") } }), { version: 65536 }),
    { kind: KIND.addon, titleId: APP + 0x1002n, romfs: { "pack/a.bin": blob(3000, 3), "pack/b.bin": blob(17, 4), "c.txt": "dlc" } }]);
  writeFileSync(nupFile, nupOut.bytes);
  const explained = () => page.evaluate(() => ({ kind: (window as any).nxwebExplained, shown: !document.getElementById("explain")!.hidden, title: document.getElementById("explaintitle")!.textContent, text: document.getElementById("explaintext")!.textContent }));

  await run("a .nup chosen through the page (<input type=file>): the container is prepared like a folder, the verdict card shows the name and 'Might start' before Play; Play: in the Worker the guest reads its RomFS out of the container (zstd frames decompressed there, checked against their SHA-256) and runs; the DLC reads back", async () => {
    await open();
    await page.setInputFiles("#fileinput", nupFile);
    await until("Ready", "Failed");
    eq(await state(), "Ready", "state: " + await page.textContent("#error"));
    eq(await stages(), ["detect:done", "index:done", "profile:done", "code:done", "shaders:done"], "stages");
    eq([await page.textContent("#titleid"), (await page.textContent("#version"))!.trim(), await page.getAttribute("#verdict", "data-level"), (await page.textContent("#verdictline"))!.trim(), await page.textContent("#play")],
      [APP_HEX, "65536 of 0, 65536", "maybe", "Might start: no profile for this game, running with defaults.", "Play"], "the verdict card");
    eq(await page.isVisible("#verdict"), true, "the card is shown");
    const r = await page.evaluate(async () => {
      const got = new Promise<any>(res => window.addEventListener("nxweb:handoff", ev => res((ev as CustomEvent).detail), { once: true }));
      document.getElementById("play")!.click();
      const msg = await got;
      const w = new Worker("/test-worker.js");
      const out = await new Promise<any>((res, rej) => { w.onmessage = ev => res(ev.data); w.onerror = e => rej(new Error(e.message)); w.postMessage({ handoff: msg }); });
      w.terminate();
      return { out, shape: { modules: msg.modules.map((m: any) => [m.name, m.file instanceof Blob]), blobs: msg.rom.files.length, files: msg.rom.sizes.length, nup: [msg.rom.nup.name, msg.rom.nup.file instanceof File, msg.rom.nup.file.size], aoc: msg.aoc.map((a: any) => [a.index, !!a.image.nup]) } };
    });
    if (!r.out.ok) throw new Error(r.out.error);
    eq(r.shape, { modules: [["main", true], ["sdk", true]], blobs: 0, files: 2, nup: [nupName, true, nupOut.bytes.length], aoc: [[2, true]] }, "message: the container's one File, no copy of any game file");
    eq([r.out.kind, r.out.code, r.out.red, r.out.romSync, r.out.lines], ["exit", 0, [], true, []], "run");
    eq(r.out.stdout, "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\n" + fsgOut(b1) + "lib: fini_array[0]\nlib: DT_FINI\n", "stdout");
    let sum = 0; for (const f of ["c.txt", "pack/a.bin", "pack/b.bin"]) { const b = gameFiles[`dlc/${dlcId}/0/romfs/${f}`]; for (const v of typeof b === "string" ? Buffer.from(b) : b) sum = (sum * 31 + v) >>> 0; }
    eq(r.out.aoc, [{ index: 2, files: 3, bytes: 3020, sum, sync: true }], "add-on content");
    if (!(r.out.reader.inflated >= 1 && r.out.reader.verified >= 1)) throw new Error("the Worker's reader: " + JSON.stringify(r.out.reader));
    // version 0 from the card's picker: the base game, with the name, version and icon of its control data
    await page.selectOption("#versionpick", "0");
    await page.waitForFunction(() => (window as any).nxwebLastRun && document.getElementById("version")!.textContent!.trim().startsWith("0 "), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById("gameicon")!.hidden && (document.getElementById("gameicon") as HTMLImageElement).naturalWidth === 1);
    eq([await page.textContent("#gamename"), (await page.textContent("#gamesub"))!.includes("version 2.5.0")], ["Container Test", true], "the NACP's name and display version");
    return `${nupName} (${nupOut.bytes.length} bytes): the guest printed the update's blob checksum; reader in the Worker ${JSON.stringify(r.out.reader)}`;
  });

  await run("a .nup dropped on the page (a file handle): prepared, its handle kept, and after a reload 'Continue with' opens it again without a picker and keeps all five stages; showOpenFilePicker gives the same", async () => {
    // the container as a file of OPFS: the stand-in for a file handle from a drop or the picker
    const b64 = Buffer.from(nupOut.bytes).toString("base64");
    const put = () => page.evaluate(async ({ name, b64 }: { name: string; b64: string }) => { const top = await (navigator as any).storage.getDirectory(); const w = await (await top.getFileHandle(name, { create: true })).createWritable(); await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close(); }, { name: nupName, b64 });
    await open(); await put();
    await page.evaluate(async (name: string) => {
      const h = await (await (navigator as any).storage.getDirectory()).getFileHandle(name);
      const ev = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: { items: [{ kind: "file", getAsFileSystemHandle: async () => h }] } });
      document.body.dispatchEvent(ev);
    }, nupName);
    await until("Ready", "Failed");
    eq(await state(), "Ready", "the dropped container");
    await open();
    eq([await page.isVisible("#resume"), await page.textContent("#resume")], [true, "Continue with " + nupName], "after the reload");
    await page.click("#resume");
    await until("Ready", "Failed");
    eq(await lastRun(), { state: "Ready", ran: [], skipped: ["detect", "index", "profile", "code", "shaders"] }, "continued: nothing is done twice");
    await open();
    await page.evaluate((name: string) => { (window as any).showOpenFilePicker = async () => [await (await (navigator as any).storage.getDirectory()).getFileHandle(name)]; }, nupName);
    await page.click("#pickfile");
    await until("Ready", "Failed");
    eq(await state(), "Ready", "through showOpenFilePicker");
  });

  await run("where the pickers are refused (a sandboxed frame: they throw SecurityError) or missing, each button falls back to its file input by itself; closing a picker (AbortError) does nothing", async () => {
    await open();
    const clicks = () => page.evaluate(() => (window as any).inputClicks);
    await page.evaluate(() => {
      (window as any).inputClicks = [];
      for (const id of ["fileinput", "dirinput"]) document.getElementById(id)!.addEventListener("click", ev => { (window as any).inputClicks.push(id); ev.preventDefault(); });
      const refuse = async () => { throw new DOMException("Cross origin sub frames aren't allowed to show a file picker.", "SecurityError"); };
      (window as any).showOpenFilePicker = refuse; (window as any).showDirectoryPicker = refuse;
    });
    await page.click("#pickfile"); await page.waitForFunction(() => (window as any).inputClicks.length === 1);
    await page.click("#pick"); await page.waitForFunction(() => (window as any).inputClicks.length === 2);
    eq(await clicks(), ["fileinput", "dirinput"], "refused pickers");
    await page.evaluate(() => { (window as any).inputClicks = []; const abort = async () => { throw new DOMException("The user aborted a request.", "AbortError"); }; (window as any).showOpenFilePicker = abort; (window as any).showDirectoryPicker = abort; });
    await page.click("#pickfile"); await page.click("#pick"); await page.waitForTimeout(150);
    eq(await clicks(), [], "a closed picker");
    await page.evaluate(() => { (window as any).showOpenFilePicker = undefined; (window as any).showDirectoryPicker = undefined; });
    await page.click("#pickfile"); await page.click("#pick"); await page.waitForFunction(() => (window as any).inputClicks.length === 2);
    eq(await clicks(), ["fileinput", "dirinput"], "no pickers");
    eq(await state(), "Idle", "nothing was started");
  });

  await run("what is not a game is explained in plain words instead of failing: an encrypted package (.nsp), a zip, an nxnative RomFS.img, a damaged and a truncated .nup, an update without its game; a folder that holds one .nup opens it; a profile with a 9 GB pool, which does not fit a 32-bit memory, is said to run in the 64-bit memory mode with what that may cost, and Play starts it on a 64-bit memory", async () => {
    const f = (name: string, bytes: Uint8Array | string) => { const p = join(nupDir, name); writeFileSync(p, bytes); return p; };
    const head = (s: string, at = 0) => { const b = new Uint8Array(4096); b.set(Buffer.from(s, "latin1"), at); return b; };
    const cases: [string, string, RegExp, RegExp][] = [
      [f("Game.nsp", head("PFS0")), "package", /^This is an encrypted game package$/, /^nxweb can't open those yet\. Convert it to a \.nup or an extracted folder with the tool you dumped it with\.$/],
      [f("Game.xci", head("HEAD", 0x100)), "package", /encrypted game package/, /Convert it/],
      [f("Game.zip", head("PK\u0003\u0004")), "zip", /zip archive/, /Unpack it first/],
      [f("RomFS.img", head("DMROMFS1")), "nxnative-romfs", /made by nxnative/, /not its code/],
      [f("readme.txt", "hello"), "unknown", /doesn't know this kind of file/, /opens \.nup files and folders/],
      [f("damaged.nup", (() => { const b = nupOut.bytes.slice(); b[nupOut.tocOff + 60] ^= 1; return b; })()), "bad-nup", /This \.nup file can't be opened/, /damaged or incomplete\. Copy or download it again/],
      [f("truncated.nup", nupOut.bytes.subarray(0, nupOut.bytes.length - 5000)), "bad-nup", /can't be opened/, /damaged or incomplete/],
      [f("update-only.nup", writeNup([pkg(KIND.update, version({ programId: APP }), { version: 65536 })]).bytes), "bad-nup", /can't be opened/, /update or add-on without the game itself/],
    ];
    await open();
    const seen: string[] = [];
    for (const [path, kind, title, text] of cases) {
      await page.evaluate(() => { (window as any).nxwebExplained = null; });
      await page.setInputFiles("#fileinput", path);
      await page.waitForFunction(() => !!(window as any).nxwebExplained);
      const x = await explained();
      if (x.kind !== kind || !x.shown || !title.test(x.title!) || !text.test(x.text!)) throw new Error(`${path}: ${JSON.stringify(x)}`);
      eq(await state(), "Idle", path);
      seen.push(`${path.split("/").pop()}: ${x.title}`);
    }
    // a folder with one .nup in it
    const holder = join(nupDir, "holder"); rmSync(holder, { recursive: true, force: true }); mkdirSync(holder, { recursive: true }); writeFileSync(join(holder, nupName), nupOut.bytes); writeFileSync(join(holder, "notes.txt"), "x");
    await page.setInputFiles("#dirinput", holder);
    await until("Ready", "Failed");
    eq(await state(), "Ready", "the folder's container: " + await page.textContent("#error") + " | " + await page.textContent("#log"));
    eq([await state(), await page.textContent("#titleid"), await page.isVisible("#explain")], ["Ready", APP_HEX, false], "the folder's container");
    // a title whose profile reserves a 9 GB pool
    const big = BigInt("0x0400A3A01EE4C000");
    const short = f("TooBig.nup", writeNup([{ kind: KIND.update, titleId: big, version: 131072, flags: STANDALONE, exefs: part(version({ programId: big, main: "big" }), "exefs/"), romfs: { "a.bin": "a" } }]).bytes);
    await open(); await page.setInputFiles("#fileinput", short);
    await until("Ready", "Failed");
    // it does not fit a 32-bit memory; by the same layout rule it fits a 64-bit one: the verdict says the mode and
    // what it may cost, and Play starts it there
    eq([await page.getAttribute("#verdict", "data-level"), (await page.textContent("#verdictline"))!.trim(), await page.textContent("#play"), await page.isEnabled("#play"), await page.getAttribute("#layout", "data-fit"), await page.getAttribute("#layout", "data-mem64")],
      ["ok", "Should start. nxweb has settings for this game, but some things it uses are not built yet.", "Play", true, "short", "profile"], "the verdict");
    const mem = (await page.textContent("#layout"))!, all = (await page.textContent("#gaps"))!;
    if (!/runs in 64-bit memory mode: heap 8\.9 GB, alias 0\.3 GB, pool 9\.0 GB \(as the profile reserves them\); the tab may come to use up to 9\.\d GB of real memory/.test(mem)) throw new Error("the Memory row: " + mem);
    if (!/It needs more memory than most games: it runs in 64-bit memory mode, and the tab may come to use up to 9\.\d GB of real memory/.test(all)) throw new Error("the verdict's list: " + all);
    const played = await page.evaluate(async () => {
      const got = new Promise<any>(res => window.addEventListener("nxweb:handoff", ev => res((ev as CustomEvent).detail), { once: true }));
      document.getElementById("play")!.click();
      const msg = await got, w = new Worker("/test-worker.js");
      const out = await new Promise<any>((res, rej) => { w.onmessage = ev => res(ev.data); w.onerror = e => rej(new Error(e.message)); w.postMessage({ handoff: msg, layout: true }); });
      w.terminate();
      return out;
    });
    if (!played.ok) throw new Error(played.error);
    eq([played.kind, played.code, played.red, played.mem64, /\.m64\./.test(played.cacheKey)], ["exit", 0, [], true, true], "the game started from the hand-off: a 64-bit memory, and a translation cache key of its own");
    const lines = (played.stdout as string).split("\n");
    eq([lines[1].replace(/base=.*/, "base"), lines[4], lines[6], lines[7]], ["SetHeapSize(0x18ce00000): rc=0x0 base", "heap top (+0x18cdff000): 0 of 512 words wrong; 4 GB lower reads 0x0",
      "MapPhysicalMemory at the alias region's end - 64 MB (above 8 GB: yes): rc=0x0", "alias mapping: 0 of 2048 words wrong; 4 GB lower reads 0x0"], "what the guest did with its 9 GB pool");
    seen.push(`a 9 GB-pool title: ${played.choice}; played on a linear memory of ${(played.memoryBytes / 2 ** 30).toFixed(2)} GB of address space`);
    const notes = await page.textContent("#warnings");
    if (!/no base game in this NUP/.test(notes!)) throw new Error("notes: " + notes);
    return seen.join(" | ");
  });

  const N = Number(process.env.PREPARE_BROWSER_FILES ?? 5000);
  await run("ZBIC modules in the page (NSO flag bit 7, the segment compression of system 22.0.0 on): a folder whose main and sdk are ZBIC compressed is prepared and plays in the Worker, the modules handed over as the files they are; so does the same game as a .nup; a module is unpacked in steps between which the page draws (the Code bar moves inside the module) and takes a Cancel", async () => {
    const zgame = version({ programId: APP, blob: b0, main: "fsg_zbic", extra: { "exefs/sdk": guest("two_lib_zbic") } });
    const sizes = [guest("fsg_zbic").length, guest("two_lib_zbic").length];
    for (const g of ["fsg_zbic", "two_lib_zbic"]) eq(new DataView(guest(g).buffer).getUint32(0x0C, true) & 0x87, 0x87, `${g}.nso: three ZBIC segments`);
    const want = "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\n" + fsgOut(b0) + "lib: fini_array[0]\nlib: DT_FINI\n";
    const play = async () => {
      const r = await page.evaluate(async () => {
        const got = new Promise<any>(res => window.addEventListener("nxweb:handoff", ev => res((ev as CustomEvent).detail), { once: true }));
        document.getElementById("play")!.click();
        const msg = await got;
        const w = new Worker("/test-worker.js");
        const out = await new Promise<any>((res, rej) => { w.onmessage = ev => res(ev.data); w.onerror = e => rej(new Error(e.message)); w.postMessage({ handoff: msg }); });
        w.terminate();
        return { out, modules: msg.modules.map((m: any) => [m.name, m.file.size, m.cuts]) };
      });
      if (!r.out.ok) throw new Error(r.out.error);
      eq(r.modules, [["main", sizes[0], 0], ["sdk", sizes[1], 0]], "the modules of the message: the ZBIC files, not copies");
      eq([r.out.kind, r.out.code, r.out.red], ["exit", 0, []], "run");
      eq(r.out.stdout, want, "stdout");
    };
    // a folder
    const fz = folder + "-z";
    await putGame(fz, prefixed("base/", zgame));
    await open(); await fakePicker(fz); await page.click("#pick"); await until("Ready", "Failed");
    eq(await state(), "Ready", "folder: " + await page.textContent("#error"));
    eq((await page.evaluate(() => [...document.querySelectorAll("#stages .stage .info")].map(td => td.textContent)))[3], "main, sdk; 0 cuts applied", "code row");
    await play();
    // a container
    const zfile = join(nupDir, `Zbic-${tag}.nup`);
    writeFileSync(zfile, writeNup([pkg(KIND.base, zgame)]).bytes);
    await open(); await page.setInputFiles("#fileinput", zfile); await until("Ready", "Failed");
    eq(await state(), "Ready", "container: " + await page.textContent("#error"));
    await play();
    // steps of 256 bytes: the bar of the Code stage takes several values while the one module is unpacked and hashed
    const one = prefixed("base/", version({ programId: APP, blob: b0, main: "fsg_zbic" }));
    const watch = (cancelAt: number | null) => page.evaluate((cancelAt: number | null) => {
      const seen = (window as any).codeBar = [] as string[];
      new MutationObserver(() => {
        const v = document.querySelector('#stages [data-stage="code"] .bar')?.getAttribute("aria-valuenow");
        if (v == null || seen.includes(v)) return;
        seen.push(v);
        if (cancelAt !== null && seen.filter(x => x !== "0").length === cancelAt) (document.getElementById("cancel") as HTMLButtonElement).click();
      }).observe(document.getElementById("stages")!, { childList: true, subtree: true, attributes: true });
    }, cancelAt);
    await putGame(fz + "s", one);
    await open("?unpack=256"); await fakePicker(fz + "s"); await watch(null); await page.click("#pick"); await until("Ready", "Failed");
    eq(await state(), "Ready", "in small steps: " + await page.textContent("#error"));
    const bar = await page.evaluate(() => (window as any).codeBar as string[]);
    if (bar.length < 8 || bar.some((v, i) => i > 0 && Number(v) < Number(bar[i - 1]))) throw new Error("the Code bar while one module is unpacked in steps of 256 bytes: " + bar.join(" "));
    // and a Cancel clicked when the bar has moved three times is taken before the module is done
    await putGame(fz + "c", one);
    await open("?unpack=256"); await fakePicker(fz + "c"); await watch(3); await page.click("#pick"); await until("Ready", "Failed", "Cancelled");
    eq(await state(), "Cancelled", "state after a Cancel between two steps");
    const m = await manifest("nxweb-prepare-" + fz + "c");
    eq([m.machine, m.stages.code.state, m.stages.profile.state], ["Cancelled", "cancelled", "done"], "manifest");
    const at = await page.evaluate(() => (window as any).codeBar as string[]);
    await open(); await page.click("#resume"); await until("Ready", "Failed");
    eq(await lastRun(), { state: "Ready", ran: ["code", "shaders"], skipped: ["detect", "index", "profile"] }, "after the cancel");
    return `fsg_zbic.nso ${sizes[0]} bytes, two_lib_zbic.nso ${sizes[1]} bytes (${rth.haveZbic() ? "the reference codec's" : "elf2nso.py's own: the zbic package is not installed"}); in steps of 256 bytes the bar showed ${bar.join(", ")} %; cancelled at ${at.at(-1)} %`;
  });

  await run(`listing latency of the directory device's source in the browser: a folder of ${N} files (PREPARE_BROWSER_FILES) in OPFS listed through FileSystemDirectoryHandle (entries() and getFile() for every file), then read`, async () => {
    await open();
    const r = await page.evaluate(async ({ N, root }: { N: number; root: string }) => {
      const top = await (navigator as any).storage.getDirectory();
      try { await top.removeEntry(root, { recursive: true }); } catch { /* not there */ }
      const base = await top.getDirectoryHandle(root, { create: true });
      const exefs = await base.getDirectoryHandle("exefs", { create: true }); void exefs;
      const romfs = await base.getDirectoryHandle("romfs", { create: true });
      let t0 = performance.now(), seed = 5;
      const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
      const dirs: any[] = [romfs];
      for (let i = 0; i < Math.round(N / 20); i++) dirs.push(await dirs[rnd(Math.min(dirs.length, 40))].getDirectoryHandle("d" + i, { create: true }));
      for (let i = 0; i < N; i += 50) await Promise.all(Array.from({ length: Math.min(50, N - i) }, async (_, k) => {
        const w = await (await dirs[(i + k) % dirs.length].getFileHandle(`f${i + k}.bin`, { create: true })).createWritable();
        const b = new Uint8Array(200 + ((i + k) % 700)); b.fill((i + k) & 255); await w.write(b); await w.close();
      }));
      const made = performance.now() - t0;
      return { made };
    }, { N, root: folder + "-big" });
    // through the page itself: its picker path lists the folder; with no main.npdm in it Detect refuses it right after the listing
    const t = await page.evaluate(async ({ root }: { root: string }) => {
      const h = await (await (navigator as any).storage.getDirectory()).getDirectoryHandle(root);
      (window as any).showDirectoryPicker = async () => h;
      const t0 = performance.now();
      document.getElementById("pick")!.click();
      await new Promise<void>(res => { const iv = setInterval(() => { const s = document.getElementById("machine")!.dataset.state!; if (s !== "Idle" && s !== "Detect") { clearInterval(iv); res(); } }, 5); });
      return { toDetectEnd: performance.now() - t0, state: document.getElementById("machine")!.dataset.state, error: document.getElementById("error")!.textContent };
    }, { root: folder + "-big" });
    eq(t.state, "Failed", "an exefs without main.npdm");
    const files = await page.evaluate(() => (window as any).nxwebPrepare.w.count("files"));
    eq(files, N, "files listed");
    // reads of whole files through the Files the listing kept (the main thread's asynchronous path)
    const rd = await page.evaluate(async () => {
      const tree = (window as any).nxwebPrepare.o.tree, l = await tree.list(), pick = [];
      let seed = 9; for (let i = 0; i < 500; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; pick.push(l.files[(seed >>> 8) % l.files.length]); }
      const t0 = performance.now(); let bytes = 0;
      for (const f of pick) bytes += (await tree.read(f.path, 0, f.size)).length;
      return { ms: performance.now() - t0, bytes };
    });
    return `${N} files written to OPFS in ${(r.made / 1000).toFixed(1)} s; listed (entries() and getFile() of every file) and refused by Detect in ${t.toDetectEnd.toFixed(0)} ms: ${(t.toDetectEnd / N * 1000).toFixed(0)} us a file; 500 whole-file reads (Blob.slice().arrayBuffer(), main thread): ${(rd.ms / 500 * 1000).toFixed(0)} us a file`;
  });

  await run("the instruction scan in the page: a game whose main holds an instruction the translator does not have gets a line in the Code stage's row, a sentence on the verdict card, the table under its technical details and the scan in the hand-off; the other games' rows say nothing", async () => {
    // the runtime's hello guest with an SVE word where it sets its exit code (the cut module the prepare module writes: an NSO again)
    const pw = new PrepWasm(new WebAssembly.Module(readFileSync(WASM)));
    const hello = guest("hello"), plain = pw.cut(hello, []); if (!("bytes" in plain)) throw new Error("hello cannot be rewritten");
    const dv = new DataView(plain.bytes.buffer), fo = dv.getUint32(0x10, true), mo = dv.getUint32(0x14, true), sz = dv.getUint32(0x18, true);
    let at = -1; for (let i = 0; i + 4 <= sz; i += 4) if (dv.getUint32(fo + i, true) === 0x52800540) { at = mo + i; break; }   // mov w0, #42
    if (at < 0) throw new Error("no mov w0,#42 in hello");
    const planted = pw.cut(hello, [{ off: at, orig: "40058052", new: "00306004" }]); if (!("bytes" in planted)) throw new Error("the word could not be planted");
    const root = `Scan-${tag}`;
    await putGame(root, { "exefs/main": planted.bytes, "exefs/main.npdm": npdm({ programId: APP + 0x7000n }), "romfs/a.txt": "a" });
    await open(); await fakePicker(root);
    await page.click("#pick");
    await until("Ready", "Failed");
    eq(await state(), "Ready", "state: " + await page.textContent("#error"));
    const line = "1 kind of instruction in this game is not supported yet";
    eq(await page.textContent("#scanline"), line, "the line in the Code stage's row");
    const rows = await page.evaluate(() => [...document.querySelectorAll("#stages .stage .info")].map(td => td.textContent));
    eq(rows[3], "main; 0 cuts applied" + line, "code row");
    const gaps = await page.evaluate(() => [...document.querySelectorAll("#gaps li")].map(li => li.textContent));
    eq(gaps.filter(g => g!.includes("not supported yet")), [line + ": the game stops if it reaches one."], "the verdict card's sentence");
    const table = (await page.textContent("#scantable pre"))!;
    if (!new RegExp(`^\\s+1  SVE \\(any\\)  \\(first at 0x${at.toString(16)}\\)$`, "m").test(table)) throw new Error("the table under the details: " + table);
    if (!/main: 1 kind of instruction not supported, 1 words in all:/.test(table)) throw new Error("the table's summary: " + table);
    const m = await manifest("nxweb-prepare-" + root), sc = m.stages.code.output.scan;
    eq([sc.length, sc[0].module, sc[0].scan.unsupported, sc[0].scan.kinds.filter((k: any) => k.instruction).map((k: any) => [k.name, k.count, k.first])], [1, "main", 1, [["SVE (any)", 1, [at]]]], "the scan in the manifest");
    const msg = await page.evaluate(async () => {
      const got = new Promise<any>(res => window.addEventListener("nxweb:handoff", ev => res((ev as CustomEvent).detail), { once: true }));
      document.getElementById("play")!.click();
      const d = await got; return d.scan.map((s: any) => [s.module, s.scan.unsupported]);
    });
    eq(msg, [["main", 1]], "the scan in the hand-off message");
    // a game without such words: its row is as it was, its manifest holds a scan that found nothing
    const clean = await manifest(storeDir);
    eq([clean.stages.code.output.scan.length >= 1, clean.stages.code.output.scan.every((s: any) => s.scan.unsupported === 0)], [true, true], "the first game's scan");
    return table.split("\n").filter(l => l).join(" | ");
  });

  await run("the Shaders stage in the page: a game whose RomFS holds BNSH containers (loose and in a Yaz0 SARC) has its stages found by the scan Worker and translated by the runtime's own in-page translator into the runtime's Cache Storage under <key>/<chain>; failures by reason and unread kinds in the row; a second prepare of another folder with the same shaders is all store hits", async () => {
    const mx = join(SCRATCH, "maxwell");
    execFileSync("python3", [join(ROOT, "tools", "shaders", "maxwell_asm.py"), mx], { stdio: "ignore" });
    const load = (n: string) => ({ control: new Uint8Array(readFileSync(join(mx, n + ".ctl"))), code: new Uint8Array(readFileSync(join(mx, n + ".code"))) });
    const vs = load("vs_quad_ubo"), ps = load("ps_tex_tint"), ps2 = load("ps_ops");
    const key = (x: { control: Uint8Array; code: Uint8Array }) => createHash("sha256").update(x.control.subarray(0, 0x880)).update(x.code).digest("hex").slice(0, 16);
    const translator = existsSync(join(ROOT, "build", "web", "shader_worker.js")) && existsSync(join(ROOT, "build", "web", "shaders", "nx_naga.wasm"));
    const root = `Shaders-${tag}`;
    const files: Files = { "exefs/main": guest("hello"), "exefs/main.npdm": npdm({ programId: APP + 0x8000n }),
      "romfs/shader/a.bnsh": bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps }]]),
      "romfs/shader/b.szs": yaz0(sarc({ "b.bnsh": bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps2 }]]) })),
      "romfs/shader/c.bars": new Uint8Array([0x42, 0x41, 0x48, 0x53, ...new Uint8Array(60)]) };
    await page.evaluate(async () => { await caches.delete("nxweb-shaders"); });
    await putGame(root, files);
    await open(); await fakePicker(root);
    await page.click("#pick");
    await page.waitForFunction(() => ["Ready", "Failed"].includes(document.getElementById("machine")!.dataset.state!) && !!(window as any).nxwebLastRun, undefined, { timeout: 240000 });
    eq(await state(), "Ready", "state: " + await page.textContent("#error"));
    const out = (await manifest("nxweb-prepare-" + root)).stages.shaders.output.prewarm;
    const row = (await page.evaluate(() => [...document.querySelectorAll("#stages .stage .info")].map(td => td.textContent)))[4]!;
    eq([out.found, out.files, out.byStage, out.notRead.map((n: any) => n.reason), out.containers], [3, 4, { vs: 1, ps: 2 }, ["BAHS (agl / gsys shader archives)"], { bnsh: 2, glslc: 0, sarc: 1, yaz0: 1, zstd: 0 }], "the stage's output");
    if (!row.startsWith("3 shader stages found in 4 files (2 BNSH, 1 SARC, 1 YAZ0)") || !row.includes("not read: BAHS (agl / gsys shader archives) (1)")) throw new Error("shaders row: " + row);
    if (!translator) { eq([out.chain, out.untranslated], [null, 3], "scan only"); return `no build/web/shader_worker.js (web:build): scanned only; row: ${row}`; }
    const xlateFailed = out.failures.filter((f: any) => !/^a compute|^bindings/.test(f.reason)).reduce((n: number, f: any) => n + f.count, 0);
    eq([out.chain, out.translated + out.cached + xlateFailed], ["nxweb-shaders-9/page", 3], `every stage translated or failed with a reason (${JSON.stringify(out.failures)})`);
    const cached = await page.evaluate(async (ids: string[]) => { const c = await caches.open("nxweb-shaders"); const o: Record<string, number> = {}; for (const id of ids) { const r = await c.match("/shader-cache/" + encodeURIComponent(id)); o[id] = r ? ((await r.json()).wgsl as string).length : 0; } return o; }, [vs, ps, ps2].map(x => `${key(x)}/nxweb-shaders-4/page`));
    const stored = Object.values(cached).filter(n => n > 0).length;
    eq(stored, out.translated, `the translations in the runtime's store (${JSON.stringify(cached)})`);
    // the same shaders in another folder: the store answers, the translator is not asked
    const root2 = root + "-again";
    await putGame(root2, { ...files, "exefs/main.npdm": npdm({ programId: APP + 0x9000n }) });
    await open(); await fakePicker(root2);
    await page.click("#pick");
    await page.waitForFunction(() => ["Ready", "Failed"].includes(document.getElementById("machine")!.dataset.state!) && !!(window as any).nxwebLastRun, undefined, { timeout: 240000 });
    eq(await state(), "Ready", "the second folder: " + await page.textContent("#error") + " " + JSON.stringify(await lastRun()));
    const again = (await manifest("nxweb-prepare-" + root2)).stages.shaders.output.prewarm;
    eq([again.translated, again.cached], [0, out.translated], "a second folder: store hits");
    return `row: ${row}; ${stored} WGSL translations in Cache Storage nxweb-shaders`;
  });

  if (errors.length) { failed++; console.log(`[RED] page errors: ${errors.join(" | ")}`); }
  // what the tests stored
  await page.evaluate(async (tag: string) => { const top = await (navigator as any).storage.getDirectory(); const names: string[] = []; for await (const [n] of top.entries()) if (n.includes(tag) || /^nxweb-prepare-(DarkGame|exefs|holder|Game\.|RomFS|readme|damaged|truncated|update-only|TooBig)/.test(n)) names.push(n); for (const n of names) await top.removeEntry(n, { recursive: true }); }, tag);
} finally { await browser.close().catch(() => {}); server.close(); rmSync(profileDir, { recursive: true, force: true }); }
console.log(`\nprepare:browser: ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
