// The prepare step: a folder of the player's own, already extracted game files becomes what the runtime starts.
// One kit machine (src/prepare/defs/prepare.json) in the prepare module holds the state; this file is its guard and
// the glue to files and storage. Every stage records { state, input, output } in the manifest; a stage whose input
// hash is the one recorded with a finished output is skipped, so a run that was cancelled, failed or lost its tab
// goes on where it stopped, and `redo(stage)` is: forget that record, run. See ../README.md.
import { A64Scanner, SCAN_FORMAT, scanLines, type ModuleScan } from "../../glue/a64_scan.ts";
import { PrepWasm, type FailReason, type Counts, type PrepState, type Cut, type NpdmInfo, type MatchRule, type MatchOutcome } from "./wasm.ts";
import type { PrepTree, TreeListing, TreeFile } from "./tree.ts";
import type { PrepStore } from "./store.ts";
import type { ProfileSource, Profile, ProfileNeed, SdkCuts, Mem64Verdict } from "./profiles.ts";
import { PrepError, detectLayout, pickVersion, identityDir, checkDlc, loadOrder, type Layout } from "./detect.ts";
import { DirRomDevice, PrepStorage, treeSource, blobSource, type RomIndex } from "./romdev.ts";
import { packSource, type NupPack, type NupOptions } from "./nup.ts";
import type { FsDevice, FsStorage } from "../../glue/fs_host.ts";
import { prewarm, PrewarmCancelled, type ShaderPrewarm, type PrewarmOut, type ScanFile } from "./shader_prewarm.ts";
import { isJunk } from "./tree.ts";

export const PREPARE_FORMAT = 3;                        // in every input hash: a change of this file's outputs bumps it
export const SHADER_CHAIN = "nxweb-shaders-1/page";     // src/glue/rt_shaders.ts SHADER_CHAIN (checked by the tests)
export const SHADER_STORE = "nxweb-shaders";            // webShaderStore()'s default name
export const DEFAULT_APP_POOL = "0xCD500000";           // a 4 GB Switch's application pool (nxnative profile_guess.py APP_POOL)
export const STAGES = ["detect", "index", "profile", "code", "shaders"] as const;
export type StageName = typeof STAGES[number];
export interface StageRecord<T = any> {
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  input: string;            // SHA-256 of what the stage depends on
  output: T | null;
  error?: string; reason?: string;
  ms?: number;
}
export interface Manifest { format: number; folder: string; machine: PrepState; reason: string; stages: Record<StageName, StageRecord> }

export interface DetectOut {
  layout: Layout["kind"]; titleId: string; programId: string; version: number; versions: number[]; root: string; exefs: string; romfs: string;
  npdm: { sysResource: number; stackSize: number; is64: boolean; name: string };
  modules: { name: string; size: number; buildId: string }[];    // every NSO of the version's exefs, in load order
  other: string[];                                                // exefs files that are not code modules
  dlc: { titleId: string; index: number; root: string }[];
  // a container's control data for this version (a dump folder has none): the NACP's name and display version
  control: { name: string | null; publisher: string | null; displayVersion: string | null; icon: boolean } | null;
  notes: string[];                                                // what the source says about itself (tree.notes)
}
// Which graphics interface the game's main module imports (nxnative profile_guess.py: nvnBootstrapLoader, Vulkan
// functions, OpenGL through EGL). nxweb draws NVN only.
export type GraphicsApi = "nvn" | "vulkan" | "gl" | "unknown";
const API_NAMES: [GraphicsApi, string[]][] = [["nvn", ["nvnBootstrapLoader"]], ["vulkan", ["vkCreateInstance", "vkCreateDevice"]], ["gl", ["eglInitialize", "eglGetDisplay", "eglCreateContext"]]];
// From the bytes of a module written with stored segments (PrepWasm.cut with no cuts): the names its string table holds
export function graphicsOf(plain: Uint8Array): { api: GraphicsApi; names: string[] } {
  const found: string[] = [], dec = new TextDecoder("latin1"), STEP = 8 << 20, LAP = 64;
  const all = API_NAMES.flatMap(([, n]) => n);
  for (let at = 0; at < plain.length; at += STEP) {
    const s = dec.decode(plain.subarray(at, Math.min(plain.length, at + STEP + LAP)));
    for (const n of all) if (!found.includes(n) && s.includes("\0" + n + "\0")) found.push(n);
  }
  const has = (api: GraphicsApi) => API_NAMES.find(a => a[0] === api)![1].some(n => found.includes(n));
  return { api: has("nvn") ? "nvn" : has("vulkan") ? "vulkan" : has("gl") ? "gl" : "unknown", names: found };
}
export interface TreeOut { root: string; files: number; dirs: number; bytes: number; size: number; tables: string; index: string; tablesSha: string }
export interface IndexOut { rom: TreeOut; aoc: (TreeOut & { index_: number; titleId: string })[] }
export interface ProfileOut {
  found: boolean; by: "title" | "build" | null; id: string | null; name: string; provisional: boolean;
  registered: boolean; unregistered: string[];       // modules whose build no build row of the profile names
  display: string | null;
  apply: Record<string, string>; needs: ProfileNeed[]; unconverted: Profile["unconverted"];
  load: string[];                                    // the modules to load, in order
  cuts: { module: string; buildId: string; from: string; cuts: Cut[] }[];
  // function-matched rules for the modules no registered cut names: the profile's own, then those for every game
  match: { module: string; buildId: string; sets: [MatchRule[], MatchRule[]] }[];
  // the regions the profile reserves and what the runtime's layout rule made of them when the profile was converted
  // (tools/prepare/layout_verdict.mts: "profile" as reserved, "pool" what the pool lets the game commit, "short" not)
  space: { heap_region: number; alias_region: number; stack_region: number } | null;
  layout: { fit: "profile" | "pool" | "short"; note: string; mem64?: Mem64Verdict } | null;   // mem64: short in a 32-bit memory, fits a 64-bit one
  pool: number;                                      // the application pool the game is given (the profile's, or the default)
  graphics: { api: GraphicsApi; names: string[] };   // what main imports to draw with
  warnings: string[];
}
// One module's instruction scan (src/glue/a64_scan.ts): what of its code the translator has no translation for
export interface CodeScan { module: string; buildId: string; scan: ModuleScan }
export interface CodeOut {
  scan?: CodeScan[];                       // when the embedder gave a scanner; the modules as the game ships them, before cuts
  modules: { name: string; buildId: string; from: "folder" | "store"; path: string; size: number; sha256: string; imageSize: number; cuts: number }[]; cuts: number;
  // what became of each function-matched patch, and the cuts that were placed (applied like registered ones)
  matched: (MatchOutcome & { module: string; buildId: string; from: string })[];
  matchCuts: AppliedCut[];
}
// mode: the runtime still translates on demand what is not in the store; prewarm: what the stage's scan found and
// translated ahead (null when the embedder gave no prewarm)
export interface ShadersOut { mode: "on-demand"; chain: string; store: string; prewarm: PrewarmOut | null }

export interface AppliedCut extends Cut { module: string; buildId: string }
// A translator hook at a pc (the other way to express a patch: return a constant, skip a call, call a host
// function). No converted patch needs one yet: the list is always empty in this round.
export interface TranslatorHook { module: string; buildId: string; offset: number; kind: "return" | "skip" | "host"; value?: string; name?: string }
export interface HandOff {
  format: number;
  titleId: string; programId: string; name: string; version: number; displayVersion: string | null;
  profile: { id: string | null; provisional: boolean; registeredBuild: boolean; apply: Record<string, string>; needs: ProfileNeed[]; space: ProfileOut["space"]; layout: ProfileOut["layout"] };
  npdm: DetectOut["npdm"];
  modules: { name: string; buildId: string; size: number; cuts: number; bytes(): Promise<Uint8Array> }[];   // load order; main first
  rom: FsDevice | null;
  aoc: Map<number, FsDevice>;
  storage(saves: FsStorage): FsStorage;    // the RomFS and add-on contents in front of the storage that keeps the saves
  saveId: string;                          // the name the saves are kept under (OpfsStorage's directory)
  cuts: AppliedCut[];                      // already applied to the module bytes above
  hooks: TranslatorHook[];
  scan: CodeScan[];                        // the instruction scan of the Code stage ([] when it was not asked for): for the report
  shaders: ShadersOut;
  // The same as plain data and Blobs, for postMessage to the Worker that runs the game (browser trees and stores)
  message(): Promise<HandOffMessage>;
}
export interface HandOffMessage {
  format: number; titleId: string; programId: string; name: string; version: number; displayVersion: string | null;
  profile: HandOff["profile"]; npdm: DetectOut["npdm"]; saveId: string; cuts: AppliedCut[]; hooks: TranslatorHook[]; shaders: ShadersOut; scan: CodeScan[];
  modules: { name: string; buildId: string; cuts: number; file: Blob }[];
  rom: RomMessage | null; aoc: { index: number; image: RomMessage }[];
}
// files: one Blob per file of a folder; a container sends none and `nup` instead (its one File and the files' records)
export interface RomMessage { tables: Uint8Array; starts: Float64Array; sizes: Float64Array; size: number; files: Blob[]; nup?: NupPack }
// In the Worker: the devices of a message. For a container, `o.sha256` (PrepWasm.sha256) is what its files are
// checked with as they are first read; without it they are read unchecked.
export const romFromMessage = (m: RomMessage, o: Partial<NupOptions> = {}): DirRomDevice =>
  new DirRomDevice({ tables: m.tables, starts: m.starts, sizes: m.sizes, size: m.size }, m.nup ? packSource(m.nup, m.sizes, o) : blobSource(m.files));
export function storageFromMessage(m: HandOffMessage, saves: FsStorage, o: Partial<NupOptions> = {}): FsStorage {
  return new PrepStorage(m.rom ? romFromMessage(m.rom, o) : null, new Map(m.aoc.map(a => [a.index, romFromMessage(a.image, o)])), saves);
}

export interface Snapshot { state: PrepState; reason: string; error: string; counts: Counts; stages: Record<StageName, StageRecord["state"]>; manifest: Manifest }
export interface PrepResult { state: "Ready" | "Failed" | "Cancelled"; reason?: FailReason; error?: string; skipped: StageName[]; ran: StageName[] }
export interface PrepareOptions {
  wasm: PrepWasm; tree: PrepTree; store: PrepStore; profiles: ProfileSource;
  version?: number;                       // the version to prepare; default: the newest update
  onChange?: (s: Snapshot) => void;       // after every state or count change worth showing
  // Tests: called at "<stage>:begin", "<stage>:work" (in the middle of its work) and "<stage>:end" (work done,
  // record not written). May wait; what it throws ends the run without another manifest write (a tab that died).
  at?: (point: string) => void | Promise<void>;
  // How many bytes of a code module are unpacked or hashed between two looks at the page (a redraw, a Cancel):
  // 4 MB when not given, some tens of milliseconds. Between the steps `at` is called with "<stage>:unpack".
  unpackStep?: number;
  // The instruction scan of the Code stage: every code module's text is put to the translator's decoder and the
  // instructions it has no translation for are recorded (CodeOut.scan). `key` names the translator binary (its
  // hash): the stage runs again when it changes, so a recorded scan is never one of an older translator.
  scanner?: { scan: A64Scanner; key: string };
  // The Shaders stage's scan and translation ahead (shader_prewarm.ts): the game's shader containers are found and
  // their stages translated into the runtime's store. Without it the stage records "on demand" and does nothing.
  shaders?: ShaderPrewarm;
}
class Cancelled extends Error {}
const enc = new TextEncoder(), dec = new TextDecoder();
// Let the page draw and take input (a Cancel) before the next piece of a long computation: a task, not a microtask
const breathe = (): Promise<void> => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
const fileKey = (f: TreeFile) => [f.path, f.size, f.mtime];

export class Prepare {
  readonly o: PrepareOptions;
  readonly w: PrepWasm;
  manifest: Manifest;
  private cancelFlag = false;
  private running = false;
  private error = "";
  private listing: TreeListing | null = null;
  constructor(o: PrepareOptions) {
    this.o = o; this.w = o.wasm;
    this.manifest = Prepare.blank(o.tree.name);
  }
  static blank(folder: string): Manifest {
    const st = () => ({ state: "pending" as const, input: "", output: null });
    return { format: PREPARE_FORMAT, folder, machine: "Idle", reason: "", stages: { detect: st(), index: st(), profile: st(), code: st(), shaders: st() } };
  }
  static async readManifest(store: PrepStore): Promise<Manifest | null> {
    const b = await store.get("manifest.json");
    if (!b) return null;
    try { const m = JSON.parse(dec.decode(b)) as Manifest; return m.format === PREPARE_FORMAT && m.stages ? m : null; } catch { return null; }
  }
  private async save(): Promise<void> {
    this.manifest.machine = this.w.state; this.manifest.reason = this.w.reason;
    try { await this.o.store.put("manifest.json", enc.encode(JSON.stringify(this.manifest))); }
    catch (e) { throw new PrepError("storage", `the manifest could not be written: ${(e as Error).message}`); }
  }
  snapshot(): Snapshot {
    const stages = {} as Snapshot["stages"];
    for (const s of STAGES) stages[s] = this.manifest.stages[s].state;
    return { state: this.w.state, reason: this.w.reason, error: this.error, counts: this.w.counts(), stages, manifest: this.manifest };
  }
  private changed(): void { this.o.onChange?.(this.snapshot()); }
  // Ask a running prepare to stop at its next step. The stage it is in is recorded as cancelled.
  cancel(): void { if (this.running) this.cancelFlag = true; }
  private async point(name: string): Promise<void> {
    if (this.cancelFlag) throw new Cancelled();
    await this.o.at?.(name);
    if (this.cancelFlag) throw new Cancelled();
  }
  private hash(v: unknown): string { return this.w.sha256Text(JSON.stringify([PREPARE_FORMAT, v])); }
  private async put(name: string, bytes: Uint8Array): Promise<void> {
    try { await this.o.store.put(name, bytes); } catch (e) { throw new PrepError("storage", `${name} could not be stored: ${(e as Error).message}`); }
  }
  private async readAll(path: string, size: number): Promise<Uint8Array> {
    try { return await this.o.tree.read(path, 0, size); } catch (e) { throw new PrepError("read", `${path} could not be read: ${(e as Error).message}`); }
  }
  out<T>(s: StageName): T { return this.manifest.stages[s].output as T; }

  // Forget a stage's record and run: that stage does its work again, and the later ones if what it gives them changed
  async redo(stage: StageName): Promise<PrepResult> {
    if (this.running) throw new Error("prepare: a run is in progress");
    const m = await Prepare.readManifest(this.o.store) ?? this.manifest;
    m.stages[stage] = { state: "pending", input: "", output: null };
    await this.o.store.put("manifest.json", enc.encode(JSON.stringify(m)));
    return this.run();
  }

  // Run the stages. Resolves when the machine is Ready, Failed or Cancelled.
  async run(): Promise<PrepResult> {
    if (this.running) throw new Error("prepare: a run is in progress");
    if (!this.w.start()) throw new Error(`prepare: the machine refuses Start in ${this.w.state}`);
    this.running = true; this.cancelFlag = false; this.error = "";
    const skipped: StageName[] = [], ran: StageName[] = [];
    let current: StageName = "detect";
    try {
      const old = await Prepare.readManifest(this.o.store);
      this.manifest = old ?? Prepare.blank(this.o.tree.name);
      this.manifest.folder = this.o.tree.name;
      // a stage a dead tab left "running" never finished: it runs again
      for (const s of STAGES) if (this.manifest.stages[s].state === "running") this.manifest.stages[s].state = "pending";
      this.changed();
      // the listing: what every stage's input hash is made from
      try { this.listing = await this.o.tree.list(n => { this.w.setCount("files", n); this.changed(); }); }
      catch (e) { throw e instanceof PrepError ? e : new PrepError("read", `the folder could not be listed: ${(e as Error).message}`); }
      this.w.setCount("files", this.listing.files.length);
      const stage = async <T>(name: StageName, input: string, work: () => Promise<T>, counts: (out: T) => void): Promise<T> => {
        current = name;
        const rec = this.manifest.stages[name];
        if (rec.state === "done" && rec.input === input && rec.output !== null) {
          counts(rec.output as T);
          skipped.push(name);
          if (!this.w.stageEnd(true)) throw new PrepError("internal", `the machine refuses Skip in ${this.w.state}`);
          this.changed();
          return rec.output as T;
        }
        const t0 = Date.now();
        this.manifest.stages[name] = { state: "running", input, output: null };
        await this.save(); this.changed();
        await this.point(name + ":begin");
        const out = await work();
        await this.point(name + ":end");
        counts(out);
        this.manifest.stages[name] = { state: "done", input, output: out, ms: Date.now() - t0 };
        if (!this.w.stageEnd(false)) throw new PrepError("internal", `the machine refuses Done in ${this.w.state}`);
        ran.push(name);
        await this.save(); this.changed();
        return out;
      };
      const l = this.listing;
      // ---- Detect ----
      const layout = detectLayout(l);
      const picked = pickVersion(layout, this.o.version);
      const codeFiles = l.files.filter(f => !/(^|\/)romfs\//.test(f.path));
      const det = await stage<DetectOut>("detect", this.hash(["detect", layout, this.o.version ?? null, codeFiles.map(fileKey)]), () => this.detect(l, layout, picked.root),
        o => { this.w.setCount("modules", o.modules.length); this.w.setCount("aoc", o.dlc.length); });
      // ---- Index ----
      const under = (root: string) => ({ files: l.files.filter(f => f.path.startsWith(root)), dirs: l.dirs.filter(d => d.startsWith(root)) });
      const trees = [{ root: det.romfs, name: "rom" }, ...det.dlc.map(d => ({ root: d.root, name: `aoc${d.index}` }))].map(t => ({ ...t, ...under(t.root) }));
      const idx = await stage<IndexOut>("index", this.hash(["index", trees.map(t => [t.root, t.name, t.dirs, t.files.map(fileKey)])]), () => this.index(det, trees),
        o => { this.w.setCount("romFiles", o.rom.files + o.aoc.reduce((n, a) => n + a.files, 0)); this.w.setCount("romDirs", o.rom.dirs + o.aoc.reduce((n, a) => n + a.dirs, 0)); });
      // ---- Profile ----
      const pidx = await this.o.profiles.index();
      const main = det.modules.find(m => m.name === "main")!;
      const pid = pidx.games[det.titleId] ? det.titleId : pidx.builds[main.buildId] ?? null;
      const profile = pid ? await this.o.profiles.game(pid) : null;
      const sdk = await this.o.profiles.sdk();
      const sdkCuts = [det.modules.map(m => sdk.cuts[m.buildId] ? [m.buildId, sdk.cuts[m.buildId]] : null).filter(x => x), det.modules.map(m => sdk.match_cuts?.[m.name] ?? null)];
      const prof = await stage<ProfileOut>("profile", this.hash(["profile", det.titleId, det.version, det.modules.map(m => [m.name, m.buildId]), det.npdm, det.control, profile, sdkCuts, idx.rom.tablesSha]),
        () => this.profile(det, l, profile, pid === det.titleId ? "title" : pid ? "build" : null, sdk), () => {});
      // ---- Code ----
      const loadFiles = prof.load.map(n => l.files.find(f => f.path === det.exefs + n)!);
      await stage<CodeOut>("code", this.hash(["code", loadFiles.map(fileKey), prof.load.map(n => det.modules.find(m => m.name === n)!.buildId), prof.cuts, prof.match, ...(this.o.scanner ? [["scan", SCAN_FORMAT, this.o.scanner.key]] : [])]), () => this.code(det, prof),
        o => { this.w.setCount("cuts", o.cuts); this.w.setCount("modules", o.modules.length); });
      // ---- Shaders ----
      const pw = this.o.shaders;
      // what the scan reads: main, then the RomFS and the add-on contents' files
      const shMain = pw ? l.files.filter(f => f.path === det.exefs + "main") : [], roots = [det.romfs, ...det.dlc.map(d => d.root)];
      const shRom = pw ? l.files.filter(f => roots.some(r => f.path.startsWith(r)) && !isJunk(f.path)) : [];
      const scanFiles: ScanFile[] = [...shMain.map(f => ({ path: f.path, size: f.size, module: true })), ...shRom.map(f => ({ path: f.path, size: f.size, module: false }))];
      await stage<ShadersOut>("shaders", this.hash(pw ? ["shaders", SHADER_CHAIN, SHADER_STORE, det.titleId, pw.key, [...shMain, ...shRom].map(fileKey)] : ["shaders", SHADER_CHAIN, SHADER_STORE, det.titleId]), async () => {
        await this.point("shaders:work");
        // without a prewarm: translate on demand, cached; the runtime's RtShaders gets this chain and store
        if (!pw) return { mode: "on-demand", chain: SHADER_CHAIN, store: SHADER_STORE, prewarm: null };
        return { mode: "on-demand", chain: SHADER_CHAIN, store: SHADER_STORE, prewarm: await this.prewarmShaders(pw, scanFiles) };
      }, o => { const p = o.prewarm; this.w.setCount("shFound", p?.found ?? 0); this.w.setCount("shTranslated", p ? p.translated + p.cached : 0); this.w.setCount("shFailed", p?.failed ?? 0); });
      await this.save(); this.changed();
      return { state: "Ready", skipped, ran };
    } catch (e) {
      if (e instanceof Cancelled) {
        this.w.cancel();
        const rec = this.manifest.stages[current];
        if (rec.state === "running") rec.state = "cancelled";
        try { await this.save(); } catch { /* the next run starts the stage again either way */ }
        this.changed();
        return { state: "Cancelled", skipped, ran };
      }
      if (e instanceof PrepError) {
        this.error = e.message;
        this.w.log(`[RED] prepare: ${current}: ${e.message}`);
        this.w.fail(e.reason);
        const rec = this.manifest.stages[current];
        this.manifest.stages[current] = { state: "failed", input: rec.input, output: null, error: e.message, reason: e.reason };
        try { await this.save(); } catch { /* storage is what failed */ }
        this.changed();
        return { state: "Failed", reason: e.reason, error: e.message, skipped, ran };
      }
      throw e;   // a test's kill, or a bug: no manifest write, as when the tab is gone
    } finally { this.running = false; }
  }

  // ---- the stages' work ----

  private async prewarmShaders(pw: ShaderPrewarm, files: ScanFile[]): Promise<PrewarmOut> {
    this.w.setCount("total", files.length); this.w.setCount("bytesTotal", files.reduce((n, f) => n + f.size, 0));
    for (const k of ["shFound", "shTranslated", "shFailed"] as const) this.w.setCount(k, 0);
    let last = 0;
    try {
      return await prewarm(pw, files, {
        cancelled: () => this.cancelFlag, log: l => this.w.log(l),
        progress: p => {
          this.w.setCount("done", p.filesDone); this.w.setCount("bytesDone", p.bytesDone);
          this.w.setCount("shFound", p.found); this.w.setCount("shTranslated", p.translated); this.w.setCount("shFailed", p.failed);
          const now = Date.now(); if (now - last >= 100 || p.filesDone === files.length) { last = now; this.changed(); }
        },
      });
    } catch (e) { if (e instanceof PrewarmCancelled) throw new Cancelled(); throw e instanceof PrepError ? e : new PrepError("internal", `the shader scan stopped: ${(e as Error).message}`); }
  }
  private async detect(l: TreeListing, layout: Layout, root: string): Promise<DetectOut> {
    const size = (p: string) => l.files.find(f => f.path === p)!.size;
    const npdmOf = async (r: string): Promise<NpdmInfo> => {
      const p = r + "exefs/main.npdm", n = this.w.npdm(await this.readAll(p, size(p)));
      if ("error" in n) throw new PrepError("npdm", `${p}: ${n.error.replace(/^\[RED\] prepare: /, "")}`);
      return n;
    };
    const id = await npdmOf(identityDir(layout).root);
    if (id.programId & 0xFFFn) throw new PrepError("npdm", `base program ID ${id.titleId} is not a base title ID`);
    await this.point("detect:work");
    const own = root === identityDir(layout).root ? id : await npdmOf(root);
    if (own.programId !== id.programId) throw new PrepError("npdm", `${root || "the folder"}: program ID ${own.titleId}, the base is ${id.titleId}`);
    if (!own.is64) throw new PrepError("arch", `${root}exefs/main.npdm says the program is 32-bit ARM code: only 64-bit programs are translated`);
    const exefs = root + "exefs/";
    const modules: DetectOut["modules"] = [], other: string[] = [];
    for (const f of l.files) {
      if (!f.path.startsWith(exefs) || f.path.indexOf("/", exefs.length) >= 0) continue;
      const name = f.path.slice(exefs.length);
      if (name === "main.npdm") continue;
      const bid = f.size >= 0x100 ? this.w.nsoBuildId(await this.readAll(f.path, 0x100)) : null;
      if (bid === null) {
        if (name === "main") throw new PrepError("module", `${f.path} is not an NSO (${f.size} bytes): the game's main module is damaged or still packed`);
        other.push(name); continue;
      }
      modules.push({ name, size: f.size, buildId: bid });
    }
    if (!modules.some(m => m.name === "main")) throw new PrepError("module", `${exefs}main is missing`);
    const order = ["rtld", ...loadOrder(modules.map(m => m.name))];
    modules.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const dlc = checkDlc(layout, id.programId);
    let control: DetectOut["control"] = null;
    if (this.o.tree.control) { const c = await this.o.tree.control(root); if (c) control = { name: c.name, publisher: c.publisher, displayVersion: c.displayVersion, icon: !!c.icon }; }
    return { layout: layout.kind, titleId: id.titleId, programId: id.titleId, version: root.startsWith("updates/") ? Number(root.split("/")[1]) : 0, versions: [...(layout.base ? [0] : []), ...layout.updates.map(u => u.version)],
      root, exefs, romfs: root + "romfs/", npdm: { sysResource: own.sysResource, stackSize: own.stackSize, is64: own.is64, name: own.name }, modules, other, dlc, control, notes: [...(this.o.tree.notes ?? [])] };
  }

  private async index(det: DetectOut, trees: { root: string; name: string; files: TreeFile[]; dirs: string[] }[]): Promise<IndexOut> {
    const out: TreeOut[] = [];
    this.w.setCount("total", trees.length);
    for (const t of trees) {
      await this.point("index:work");
      const cut = t.root.length;
      const entries = [...t.dirs.filter(d => d.length > cut).map(d => ({ path: d.slice(cut), size: 0, dir: true })), ...t.files.map(f => ({ path: f.path.slice(cut), size: f.size }))];
      const r = this.w.romTables(entries);
      if ("error" in r) throw new PrepError("romfs", `${t.root}: ${r.error.replace(/^\[RED\] prepare: /, "")}`);
      const sizes = t.files.map(f => f.size);
      const index = { root: t.root, paths: t.files.map(f => f.path), sizes, starts: Array.from(r.starts), size: r.size };
      await this.put(`${t.name}.tables`, r.tables);
      await this.put(`${t.name}.index`, enc.encode(JSON.stringify(index)));
      out.push({ root: t.root, files: r.files, dirs: r.dirs, bytes: sizes.reduce((a, b) => a + b, 0), size: r.size, tables: `${t.name}.tables`, index: `${t.name}.index`, tablesSha: this.w.sha256(r.tables) });
      this.w.addCount("done", 1); this.w.addCount("romFiles", r.files); this.w.addCount("romDirs", r.dirs); this.changed();
    }
    return { rom: out[0], aoc: out.slice(1).map((t, i) => ({ ...t, index_: det.dlc[i].index, titleId: det.dlc[i].titleId })) };
  }

  private async profile(det: DetectOut, l: TreeListing, p: Profile | null, by: "title" | "build" | null, sdk: SdkCuts): Promise<ProfileOut> {
    await this.point("profile:work");
    const have = det.modules.map(m => m.name), bid = (n: string) => det.modules.find(m => m.name === n)!.buildId;
    const warnings: string[] = [];
    let load: string[], apply: Record<string, string>, registered = false, unregistered: string[] = [], display: string | null = null;
    if (p) {
      const mainId = bid("main"), row = p.builds.find(b => b.modules.main === mainId);
      const listed = (p.apply.modules ?? "main").split(/\s+/).filter(x => x);
      // nxnative: the modules of the row of main's build, in the order of `modules`; all of `modules` for a build with no row
      load = listed.filter(m => have.includes(m) && (!row || m in row.modules));
      if (!load.includes("main")) throw new PrepError("profile", `profile ${p.title_id} does not list main among its modules`);
      unregistered = load.filter(m => !p.builds.some(b => b.modules[m] === bid(m)));
      registered = !!row && unregistered.length === 0;
      display = row?.display ?? null;
      if (!registered) warnings.push(`not a build the profile was made on (${unregistered.map(m => `${m} ${bid(m)}`).join(", ")}; the profile's builds: ${p.builds.map(b => `${b.tag} main ${b.modules.main ?? "-"}`).join(", ")}): the per-build cuts do not reach it`);
      apply = { ...p.apply };
      if (by === "build") { warnings.push(`title ID ${det.titleId} has no profile; main's build is ${p.title_id}'s (${p.name}): its profile is used, with this title's program ID`); apply.title_id = det.titleId; apply.program_id = det.programId; }
      const marker = p.apply.romfs_marker;
      if (marker && !l.files.some(f => f.path === det.romfs + marker) && !l.dirs.includes(det.romfs + marker)) warnings.push(`the RomFS has no ${marker}, which the profile expects: the game files may be in the wrong place`);
      if (p.apply.sys_resource !== undefined && Number(p.apply.sys_resource) !== det.npdm.sysResource) warnings.push(`the profile says sys_resource ${p.apply.sys_resource}, main.npdm declares 0x${det.npdm.sysResource.toString(16)}`);
    } else {
      load = loadOrder(have);
      apply = { title_id: det.titleId, program_id: det.programId, name: det.npdm.name, modules: load.join(" "), app_pool: DEFAULT_APP_POOL, sys_resource: "0x" + det.npdm.sysResource.toString(16) };
      warnings.push("no profile: provisional values from the game files; nothing is known about this game");
    }
    const cuts: ProfileOut["cuts"] = [], match: ProfileOut["match"] = [];
    for (const m of load) {
      const b = bid(m), c = p?.cuts[b] ?? sdk.cuts[b];
      if (c && c.cuts.length) cuts.push({ module: m, buildId: b, from: p?.cuts[b] ? `profile ${p.title_id}` : "sdk", cuts: c.cuts.map(x => ({ off: x.off, orig: x.orig, new: x.new, why: x.why })) });
      // nxnative: a module whose build has no registered cuts (an empty list is one: the build keeps its code) gets the
      // function-matched rules, the selected profile's and those for every game's module of that name
      const own = p?.match_cuts?.[m] ?? [], wide = sdk.match_cuts?.[m] ?? [];
      if (!c && (own.length || wide.length)) match.push({ module: m, buildId: b, sets: [own, wide] });
    }
    const sp = p?.address_space;
    // what main draws with: its imports, read from the module with its segments unpacked (a module that cannot be
    // unpacked is Code's to refuse)
    let graphics: ProfileOut["graphics"] = { api: "unknown", names: [] };
    try {
      const m = det.modules.find(m => m.name === "main")!, file = await this.readAll(det.exefs + "main", m.size);
      try {
        // unpacked in steps: a main module is tens of megabytes, compressed (LZ4, or ZBIC from system 22.0.0 on)
        const info = await this.w.open(file, async () => { await breathe(); await this.point("profile:unpack"); }, this.o.unpackStep);
        const r = "error" in info ? info : this.w.cut(file, []);
        if ("bytes" in r) graphics = graphicsOf(r.bytes);
      } finally { this.w.close(); }
    } catch (e) { if (!(e instanceof PrepError)) throw e; }
    if (graphics.api === "vulkan" || graphics.api === "gl") warnings.push(`main draws with ${graphics.api === "gl" ? "OpenGL (through EGL)" : "Vulkan"} (it imports ${graphics.names.join(", ")}): nxweb implements NVN only`);
    for (const n of det.notes ?? []) warnings.push(n);
    return { found: !!p, by, id: p?.title_id ?? null, name: p?.name ?? det.control?.name ?? det.npdm.name, provisional: !p, registered, unregistered, display: display ?? det.control?.displayVersion ?? null, apply,
      pool: Number(apply.app_pool ?? DEFAULT_APP_POOL), graphics, needs: p?.needs ?? [], unconverted: p?.unconverted ?? [], load, cuts, match,
      space: sp ? { heap_region: sp.heap_region, alias_region: sp.alias_region, stack_region: sp.stack_region } : null, layout: sp?.fit ? { fit: sp.fit, note: sp.note ?? "", ...(sp.mem64 ? { mem64: sp.mem64 } : {}) } : null, warnings };
  }

  private async code(det: DetectOut, prof: ProfileOut): Promise<CodeOut> {
    const out: CodeOut = { modules: [], cuts: 0, matched: [], matchCuts: [], ...(this.o.scanner ? { scan: [] } : {}) };
    const mods = prof.load.map(n => det.modules.find(m => m.name === n)!);
    this.w.setCount("total", mods.length); this.w.setCount("bytesTotal", mods.reduce((n, m) => n + m.size, 0));
    for (const m of mods) {
      await this.point("code:work");
      const path = det.exefs + m.name, file = await this.readAll(path, m.size);
      try {
      // unpacked and hashed in steps, with the progress row moving inside the module and a Cancel taken between them;
      // the function matching and the cuts below then work on that image instead of unpacking the file again
      const before = this.w.count("bytesDone");
      const info = await this.w.open(file, async (done, total) => {
        this.w.setCount("bytesDone", before + Math.floor(m.size * Math.min(1, done / Math.max(1, total)) * 0.9)); this.changed();
        await breathe(); await this.point("code:unpack");
      }, this.o.unpackStep);
      this.w.setCount("bytesDone", before);
      if ("error" in info) throw new PrepError("module", `${path}: ${info.error.replace(/^\[RED\] (loader|prepare): /, "")}`);
      if (info.buildId !== m.buildId) throw new PrepError("module", `${path} changed while it was read`);
      let c: { cuts: Cut[] } | undefined = prof.cuts.find(c => c.module === m.name);
      const rules = prof.match.find(x => x.module === m.name);
      if (!c && rules) {
        // found by function: a patch that does not match exactly is left out and reported (red for the game's own
        // patches, plain for those tried on every game); what is found is applied below like a registered cut
        const r = this.w.match(file, rules.sets);
        if ("error" in r) throw new PrepError(r.code === -1 ? "module" : "cut", `${path} (build ${m.buildId}): ${r.error.replace(/^\[RED\] (loader|prepare): /, "")}`);
        for (const o of r.outcomes) {
          const from = o.set === 0 ? `profile ${prof.id}` : "every game";
          out.matched.push({ ...o, module: m.name, buildId: m.buildId, from });
          this.w.log(o.matched ? `prepare: ${m.name}: function patch '${o.name}': matched at ${o.offsets.map(x => "0x" + x.toString(16)).join(", ")} (${o.why})`
            : `${o.set === 0 ? "[RED] " : ""}prepare: ${m.name}: function patch '${o.name}' skipped: ${o.why}`);
        }
        if (r.cuts.length) {
          c = { cuts: r.cuts.map(x => ({ off: x.off, orig: x.orig, new: x.new, why: x.why })) };
          out.matchCuts.push(...c.cuts.map(x => ({ ...x, module: m.name, buildId: m.buildId })));
        }
      }
      if (this.o.scanner) {
        // the instruction scan, on the module as the game ships it (before the cuts): the text goes to the
        // translator's decoder in pieces, with the page drawn and a Cancel taken between them
        const si = this.w.scanInput(file);
        if (si) {
          // (the row's bar: unpacking took it to 90 % of this module, the scan takes it on from there)
          const scan = await this.o.scanner.scan.scan(si.text, si.textOff, si.functions, async (done, total) => {
            this.w.setCount("bytesDone", before + Math.floor(m.size * (0.9 + 0.1 * Math.min(1, done / Math.max(1, total))))); this.changed();
            await breathe(); await this.point("code:scan");
          });
          this.w.setCount("bytesDone", before);
          out.scan!.push({ module: m.name, buildId: m.buildId, scan });
          for (const l of scanLines(m.name, scan, 12)) this.w.log("prepare: scan: " + l);
        }
      }
      if (c) {
        const r = this.w.cut(file, c.cuts);
        if ("error" in r) throw new PrepError(r.code === -1 ? "module" : "cut", `${path} (build ${m.buildId}): ${r.error.replace(/^\[RED\] (loader|prepare): /, "")}`);
        const name = `code/${m.name}.nso`;
        await this.put(name, r.bytes);
        out.modules.push({ name: m.name, buildId: m.buildId, from: "store", path: name, size: r.bytes.length, sha256: this.w.sha256(r.bytes), imageSize: info.imageSize, cuts: r.applied });
        out.cuts += r.applied; this.w.addCount("cuts", r.applied);
      } else out.modules.push({ name: m.name, buildId: m.buildId, from: "folder", path, size: m.size, sha256: this.w.sha256(file), imageSize: info.imageSize, cuts: 0 });
      this.w.addCount("done", 1); this.w.addCount("bytesDone", m.size); this.changed();
      } finally { this.w.close(); }
    }
    return out;
  }

  // ---- the hand-off (the machine is Ready) ----
  private async romIndex(t: TreeOut): Promise<{ index: RomIndex; paths: string[] }> {
    const tables = await this.o.store.get(t.tables), ix = await this.o.store.get(t.index);
    if (!tables || !ix) throw new Error(`prepare: ${t.tables} is not in the store any more: redo("index")`);
    const j = JSON.parse(dec.decode(ix)) as { paths: string[]; sizes: number[]; starts: number[]; size: number };
    return { index: { tables, starts: Float64Array.from(j.starts), sizes: Float64Array.from(j.sizes), size: j.size }, paths: j.paths };
  }
  async handoff(): Promise<HandOff> {
    if (this.w.state !== "Ready") throw new Error(`prepare: no hand-off in ${this.w.state}`);
    const det = this.out<DetectOut>("detect"), idx = this.out<IndexOut>("index"), prof = this.out<ProfileOut>("profile"), code = this.out<CodeOut>("code"), sh = this.out<ShadersOut>("shaders");
    const { tree, store } = this.o;
    const rom = await this.romIndex(idx.rom);
    const aocIx = await Promise.all(idx.aoc.map(async a => ({ slot: a.index_, image: await this.romIndex(a) })));
    const romDev = new DirRomDevice(rom.index, treeSource(tree, rom.paths));
    const aoc = new Map<number, FsDevice>(aocIx.map(a => [a.slot, new DirRomDevice(a.image.index, treeSource(tree, a.image.paths))]));
    const cuts: AppliedCut[] = [...prof.cuts.flatMap(c => c.cuts.map(x => ({ ...x, module: c.module, buildId: c.buildId }))), ...(code.matchCuts ?? [])];
    const base = { format: PREPARE_FORMAT, titleId: det.titleId, programId: prof.apply.program_id ?? det.programId, name: prof.name, version: det.version, displayVersion: prof.display,
      profile: { id: prof.id, provisional: prof.provisional, registeredBuild: prof.registered, apply: prof.apply, needs: prof.needs, space: prof.space ?? null, layout: prof.layout ?? null }, npdm: det.npdm,
      saveId: `nxweb-save-${det.titleId}`, cuts, hooks: [] as TranslatorHook[], shaders: sh, scan: code.scan ?? [] };
    const bytes = (m: CodeOut["modules"][number]) => async (): Promise<Uint8Array> => {
      if (m.from === "folder") return tree.read(m.path, 0, m.size);
      const b = await store.get(m.path);
      if (!b) throw new Error(`prepare: ${m.path} is not in the store any more: redo("code")`);
      return b;
    };
    const romMsg = async (r: { index: RomIndex; paths: string[] }): Promise<RomMessage> => {
      if (tree.pack) return { tables: r.index.tables, starts: r.index.starts, sizes: r.index.sizes, size: r.index.size, files: [], nup: tree.pack(r.paths) };
      if (!tree.blob) throw new Error("prepare: this folder's files cannot be sent to a Worker (no Blobs)");
      return { tables: r.index.tables, starts: r.index.starts, sizes: r.index.sizes, size: r.index.size, files: r.paths.map(p => tree.blob!(p)!) };
    };
    return { ...base,
      modules: code.modules.map(m => ({ name: m.name, buildId: m.buildId, size: m.size, cuts: m.cuts, bytes: bytes(m) })),
      rom: romDev, aoc,
      storage: saves => new PrepStorage(romDev, aoc, saves),
      message: async () => ({ ...base,
        modules: await Promise.all(code.modules.map(async m => ({ name: m.name, buildId: m.buildId, cuts: m.cuts,
          file: m.from === "folder" ? tree.blob?.(m.path) ?? new Blob([await bytes(m)() as BlobPart]) : await store.blob?.(m.path) ?? new Blob([await bytes(m)() as BlobPart]) }))),
        rom: await romMsg(rom), aoc: await Promise.all(aocIx.map(async a => ({ index: a.slot, image: await romMsg(a.image) }))) }),
    };
  }
}
