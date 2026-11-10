// The prepare step: a folder of the player's own, already extracted game files becomes what the runtime starts.
// One kit machine (src/prepare/defs/prepare.json) in the prepare module holds the state; this file is its guard and
// the glue to files and storage. Every stage records { state, input, output } in the manifest; a stage whose input
// hash is the one recorded with a finished output is skipped, so a run that was cancelled, failed or lost its tab
// goes on where it stopped, and `redo(stage)` is: forget that record, run. See ../README.md.
import { PrepWasm, type FailReason, type Counts, type PrepState, type Cut, type NpdmInfo } from "./wasm.ts";
import type { PrepTree, TreeListing, TreeFile } from "./tree.ts";
import type { PrepStore } from "./store.ts";
import type { ProfileSource, Profile, ProfileNeed } from "./profiles.ts";
import { PrepError, detectLayout, pickVersion, identityDir, checkDlc, loadOrder, type Layout } from "./detect.ts";
import { DirRomDevice, PrepStorage, treeSource, blobSource, type RomIndex } from "./romdev.ts";
import type { FsDevice, FsStorage } from "../../glue/fs_host.ts";

export const PREPARE_FORMAT = 1;                        // in every input hash: a change of this file's outputs bumps it
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
  warnings: string[];
}
export interface CodeOut { modules: { name: string; buildId: string; from: "folder" | "store"; path: string; size: number; sha256: string; imageSize: number; cuts: number }[]; cuts: number }
export interface ShadersOut { mode: "on-demand"; chain: string; store: string; prewarm: null }

export interface AppliedCut extends Cut { module: string; buildId: string }
// A translator hook at a pc (the other way to express a patch: return a constant, skip a call, call a host
// function). No converted patch needs one yet: the list is always empty in this round.
export interface TranslatorHook { module: string; buildId: string; offset: number; kind: "return" | "skip" | "host"; value?: string; name?: string }
export interface HandOff {
  format: number;
  titleId: string; programId: string; name: string; version: number; displayVersion: string | null;
  profile: { id: string | null; provisional: boolean; registeredBuild: boolean; apply: Record<string, string>; needs: ProfileNeed[] };
  npdm: DetectOut["npdm"];
  modules: { name: string; buildId: string; size: number; cuts: number; bytes(): Promise<Uint8Array> }[];   // load order; main first
  rom: FsDevice | null;
  aoc: Map<number, FsDevice>;
  storage(saves: FsStorage): FsStorage;    // the RomFS and add-on contents in front of the storage that keeps the saves
  saveId: string;                          // the name the saves are kept under (OpfsStorage's directory)
  cuts: AppliedCut[];                      // already applied to the module bytes above
  hooks: TranslatorHook[];
  shaders: ShadersOut;
  // The same as plain data and Blobs, for postMessage to the Worker that runs the game (browser trees and stores)
  message(): Promise<HandOffMessage>;
}
export interface HandOffMessage {
  format: number; titleId: string; programId: string; name: string; version: number; displayVersion: string | null;
  profile: HandOff["profile"]; npdm: DetectOut["npdm"]; saveId: string; cuts: AppliedCut[]; hooks: TranslatorHook[]; shaders: ShadersOut;
  modules: { name: string; buildId: string; cuts: number; file: Blob }[];
  rom: RomMessage | null; aoc: { index: number; image: RomMessage }[];
}
export interface RomMessage { tables: Uint8Array; starts: Float64Array; sizes: Float64Array; size: number; files: Blob[] }
// In the Worker: the devices of a message
export const romFromMessage = (m: RomMessage): DirRomDevice => new DirRomDevice({ tables: m.tables, starts: m.starts, sizes: m.sizes, size: m.size }, blobSource(m.files));
export function storageFromMessage(m: HandOffMessage, saves: FsStorage): FsStorage {
  return new PrepStorage(m.rom ? romFromMessage(m.rom) : null, new Map(m.aoc.map(a => [a.index, romFromMessage(a.image)])), saves);
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
}
class Cancelled extends Error {}
const enc = new TextEncoder(), dec = new TextDecoder();
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
      catch (e) { throw new PrepError("read", `the folder could not be listed: ${(e as Error).message}`); }
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
      const sdkCuts = det.modules.map(m => sdk.cuts[m.buildId] ? [m.buildId, sdk.cuts[m.buildId]] : null).filter(x => x);
      const prof = await stage<ProfileOut>("profile", this.hash(["profile", det.titleId, det.version, det.modules.map(m => [m.name, m.buildId]), det.npdm, profile, sdkCuts, idx.rom.tablesSha]),
        () => this.profile(det, l, profile, pid === det.titleId ? "title" : pid ? "build" : null, sdk.cuts), () => {});
      // ---- Code ----
      const loadFiles = prof.load.map(n => l.files.find(f => f.path === det.exefs + n)!);
      await stage<CodeOut>("code", this.hash(["code", loadFiles.map(fileKey), prof.load.map(n => det.modules.find(m => m.name === n)!.buildId), prof.cuts]), () => this.code(det, prof),
        o => { this.w.setCount("cuts", o.cuts); this.w.setCount("modules", o.modules.length); });
      // ---- Shaders ----
      await stage<ShadersOut>("shaders", this.hash(["shaders", SHADER_CHAIN, SHADER_STORE, det.titleId]), async () => {
        await this.point("shaders:work");
        // translate on demand, cached: nothing is done ahead; the runtime's RtShaders gets this chain and store
        return { mode: "on-demand", chain: SHADER_CHAIN, store: SHADER_STORE, prewarm: null };
      }, () => {});
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
    return { layout: layout.kind, titleId: id.titleId, programId: id.titleId, version: root.startsWith("updates/") ? Number(root.split("/")[1]) : 0, versions: [...(layout.base ? [0] : []), ...layout.updates.map(u => u.version)],
      root, exefs, romfs: root + "romfs/", npdm: { sysResource: own.sysResource, stackSize: own.stackSize, is64: own.is64, name: own.name }, modules, other, dlc };
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

  private async profile(det: DetectOut, l: TreeListing, p: Profile | null, by: "title" | "build" | null, sdk: Record<string, { module: string; cuts: Cut[] }>): Promise<ProfileOut> {
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
    const cuts: ProfileOut["cuts"] = [];
    for (const m of load) {
      const b = bid(m), c = p?.cuts[b] ?? sdk[b];
      if (c && c.cuts.length) cuts.push({ module: m, buildId: b, from: p?.cuts[b] ? `profile ${p.title_id}` : "sdk", cuts: c.cuts.map(x => ({ off: x.off, orig: x.orig, new: x.new, why: x.why })) });
    }
    return { found: !!p, by, id: p?.title_id ?? null, name: p?.name ?? det.npdm.name, provisional: !p, registered, unregistered, display, apply, needs: p?.needs ?? [], unconverted: p?.unconverted ?? [], load, cuts, warnings };
  }

  private async code(det: DetectOut, prof: ProfileOut): Promise<CodeOut> {
    const out: CodeOut = { modules: [], cuts: 0 };
    const mods = prof.load.map(n => det.modules.find(m => m.name === n)!);
    this.w.setCount("total", mods.length); this.w.setCount("bytesTotal", mods.reduce((n, m) => n + m.size, 0));
    for (const m of mods) {
      await this.point("code:work");
      const path = det.exefs + m.name, file = await this.readAll(path, m.size);
      const info = this.w.nsoCheck(file);
      if ("error" in info) throw new PrepError("module", `${path}: ${info.error.replace(/^\[RED\] (loader|prepare): /, "")}`);
      if (info.buildId !== m.buildId) throw new PrepError("module", `${path} changed while it was read`);
      const c = prof.cuts.find(c => c.module === m.name);
      if (c) {
        const r = this.w.cut(file, c.cuts);
        if ("error" in r) throw new PrepError(r.code === -1 ? "module" : "cut", `${path} (build ${m.buildId}): ${r.error.replace(/^\[RED\] (loader|prepare): /, "")}`);
        const name = `code/${m.name}.nso`;
        await this.put(name, r.bytes);
        out.modules.push({ name: m.name, buildId: m.buildId, from: "store", path: name, size: r.bytes.length, sha256: this.w.sha256(r.bytes), imageSize: info.imageSize, cuts: r.applied });
        out.cuts += r.applied; this.w.addCount("cuts", r.applied);
      } else out.modules.push({ name: m.name, buildId: m.buildId, from: "folder", path, size: m.size, sha256: this.w.sha256(file), imageSize: info.imageSize, cuts: 0 });
      this.w.addCount("done", 1); this.w.addCount("bytesDone", m.size); this.changed();
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
    const cuts: AppliedCut[] = prof.cuts.flatMap(c => c.cuts.map(x => ({ ...x, module: c.module, buildId: c.buildId })));
    const base = { format: PREPARE_FORMAT, titleId: det.titleId, programId: prof.apply.program_id ?? det.programId, name: prof.name, version: det.version, displayVersion: prof.display,
      profile: { id: prof.id, provisional: prof.provisional, registeredBuild: prof.registered, apply: prof.apply, needs: prof.needs }, npdm: det.npdm,
      saveId: `nxweb-save-${det.titleId}`, cuts, hooks: [] as TranslatorHook[], shaders: sh };
    const bytes = (m: CodeOut["modules"][number]) => async (): Promise<Uint8Array> => {
      if (m.from === "folder") return tree.read(m.path, 0, m.size);
      const b = await store.get(m.path);
      if (!b) throw new Error(`prepare: ${m.path} is not in the store any more: redo("code")`);
      return b;
    };
    const romMsg = async (r: { index: RomIndex; paths: string[] }): Promise<RomMessage> => {
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
