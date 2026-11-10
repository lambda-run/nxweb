// npm run prepare:test [-- <filter>]. Node. Builds the prepare module, makes synthetic game folders (synth.mts:
// the runtime's test guests as code modules, an npdm made here, RomFS trees) and runs the prepare step on them:
// every layout variant and the malformed ones, resume after a kill at each stage, stage skipping by hash, profile
// selection, registered cuts applied and refused, and the whole pipeline ending in a process that runs in the
// runtime's Node harness (test/runtime/harness.mts, used as it is).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, utimesSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, WASM, build } from "../../src/prepare/host/build.mts";
import { PrepWasm, STATES, REASONS, type Cut } from "../../src/prepare/host/wasm.ts";
import { MemTree, EntryTree, FileListTree, isJunk } from "../../src/prepare/host/tree.ts";
import { NodeTree } from "../../src/prepare/host/tree_node.ts";
import { MemStore } from "../../src/prepare/host/store.ts";
import { NodeStore } from "../../src/prepare/host/store_node.ts";
import { memProfiles, type Profile, type ProfileSource } from "../../src/prepare/host/profiles.ts";
import { nodeProfiles } from "../../src/prepare/host/profiles_node.ts";
import { Prepare, STAGES, SHADER_CHAIN, type StageName, type DetectOut, type ProfileOut, type CodeOut, type IndexOut, type Manifest } from "../../src/prepare/host/prepare.ts";
import { detectLayout, pickVersion } from "../../src/prepare/host/detect.ts";
import { DirRomDevice, treeSource } from "../../src/prepare/host/romdev.ts";
import { FS_KIND, DEV, MemStorage } from "../../src/glue/fs_host.ts";
import { NodeStorage } from "../../src/glue/fs_dev_node.ts";
import { SHADER_CHAIN as RT_SHADER_CHAIN } from "../../src/glue/rt_shaders.ts";
import { Runtime } from "../../src/glue/rt_runtime.ts";
import { RtFs } from "../../src/glue/rt_fs.ts";
import { loadDefs } from "../../src/kit/host/defs.mts";
import * as rth from "../runtime/harness.mts";
import { SCRATCH, guest, npdm, blob, fnv64, writeTree, version, prefixed, synthTree, lsRows, python, bnsh, type Files } from "./synth.mts";

process.chdir(ROOT);
try {
  build();
  // the runtime's modules and test guests: its own harness builds them (and refuses stale ones)
  let fresh = true; try { rth.loadEnv; (await import("../../src/runtime/host/build.mts")).checkBuilt(); } catch { fresh = false; }
  if (!fresh || process.env.PREPARE_RT_BUILD === "1") rth.build();
  if (!existsSync(join(rth.GUESTS, "fsg.nso")) || !existsSync(join(rth.GUESTS, "hello.nso")) || process.env.PREPARE_RT_BUILD === "1") rth.buildModules();
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] prepare:test: the build failed"); process.exit(1); }
mkdirSync(SCRATCH, { recursive: true });
const module = new WebAssembly.Module(readFileSync(WASM));
const env = rth.loadEnv();
const newWasm = (lines?: string[]) => new PrepWasm(module, l => lines?.push(l));

const tests: { name: string; fn: () => Promise<string[] | void> | string[] | void }[] = [];
const test = (name: string, fn: () => Promise<string[] | void> | string[] | void) => tests.push({ name, fn });
const APP = 0x0100AAAA0000B000n, APP_HEX = "0100AAAA0000B000";
const dirOf = (name: string) => join(SCRATCH, name);
const noProfiles = memProfiles([]);
class Kill extends Error {}

// One prepare over a real directory and a store that outlives it
interface Run { prep: Prepare; lines: string[]; tree: NodeTree; store: NodeStore }
function prepare(dir: string, o: { profiles?: ProfileSource; version?: number; at?: (p: string) => void | Promise<void>; store?: string } = {}): Run {
  const lines: string[] = [], tree = new NodeTree(dir), store = new NodeStore(o.store ?? dir + ".store");
  return { prep: new Prepare({ wasm: newWasm(lines), tree, store, profiles: o.profiles ?? noProfiles, version: o.version, at: o.at }), lines, tree, store };
}
const freshStore = (dir: string) => rmSync(dir + ".store", { recursive: true, force: true });
function game(name: string, files: Files, dirs: string[] = []): string { const d = writeTree(dirOf(name), files, dirs); freshStore(d); return d; }
// Run a prepared game in the runtime: what the fs guest prints
async function play(r: Run, saves = new MemStorage()): Promise<{ stdout: string; kind?: string; code?: number; red: string[]; reads: number }> {
  const h = await r.prep.handoff();
  const rt = new Runtime(env.mods), storage = h.storage(saves);
  new RtFs(rt, env.mods.fs!, storage, { programId: BigInt("0x" + h.programId) });
  rt.register({ name: "test_mode", fn: () => 0 }); rt.register({ name: "test_written", fn: () => {} });
  const files = [];
  for (const m of h.modules) files.push({ name: m.name, bytes: await m.bytes() });
  assert.ok(rt.loadNso(files), "load failed: " + rt.red.join(" | "));
  const res = await rt.runAsync();
  const out = { stdout: rt.stdout(), kind: res.stop?.kind, code: res.stop?.code, red: [...rt.red], reads: (h.rom as DirRomDevice).stats.fileReads };
  rt.dispose();
  return out;
}
const fsgHead = (b: Uint8Array, mount = "MountRom: ") => `${mount}0x0\nopen a file that is not there: 0x202\nrom:/data/blob.bin: ${b.length} bytes of ${b.length}, fnv64 ${fnv64(b)}\nEnsureSaveData: 0x0\nMountSaveData: 0x0\n`;
const fsgFirst = (b: Uint8Array, mount?: string) => fsgHead(b, mount) + "save:/counter.bin is not there yet\nCreateFile: 0x0\nwrote 1: rc=0x0\nCommit: 0x0\n";

// Where a byte pattern lies in a module's image (offset from the module's start): through the module's own NSO
// rewrite with no cuts, which stores the segments plainly
function imageOffsets(w: PrepWasm, nso: Uint8Array, pattern: Uint8Array): number[] {
  const r = w.cut(nso, []); assert.ok("bytes" in r);
  const b = r.bytes, dv = new DataView(b.buffer), out: number[] = [];
  for (let s = 0; s < 3; s++) {
    const fo = dv.getUint32(0x10 + 16 * s, true), mo = dv.getUint32(0x14 + 16 * s, true), sz = dv.getUint32(0x18 + 16 * s, true);
    outer: for (let i = 0; i + pattern.length <= sz; i++) { for (let k = 0; k < pattern.length; k++) if (b[fo + i + k] !== pattern[k]) continue outer; out.push(mo + i); }
  }
  return out;
}
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ascii = (s: string) => new TextEncoder().encode(s);
function profileFor(nso: Uint8Array, titleId: string, cuts: Cut[], more: Partial<Profile> = {}, rowMore: Record<string, string> = {}): Profile {
  const bid = newWasm().nsoBuildId(nso.subarray(0, 0x100))!;
  return { source: "test", title_id: titleId, name: "Test Game", builds: [{ version: 0, tag: "v0", display: "1.0.0", modules: { main: bid, ...rowMore } }], apply: { title_id: titleId, program_id: titleId, name: "Test Game", modules: "main sdk", app_pool: "0xCD500000", sys_resource: "0x0" },
    needs: [], dropped: [], cuts: cuts.length ? { [bid]: { module: "main", cuts } } : {}, unconverted: [], ...more };
}

// =================================================================================================== bytes
test("sha256 of the module equals node:crypto's, for sizes around the block boundaries", () => {
  const w = newWasm();
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) { const b = blob(n, n + 1); assert.equal(w.sha256(b), createHash("sha256").update(b).digest("hex"), `${n} bytes`); }
});

test("main.npdm: program ID, system resource, 64-bit flag, stack size; files that are not an NPDM are refused with their reason", () => {
  const lines: string[] = [], w = newWasm(lines);
  const n = w.npdm(npdm({ programId: 0x0100152000022000n, sysResource: 0x1000000, stackSize: 0x80000, name: "Game" }));
  assert.ok(!("error" in n));
  assert.deepEqual([n.titleId, n.sysResource, n.is64, n.stackSize, n.name], ["0100152000022000", 0x1000000, true, 0x80000, "Game"]);
  const n32 = w.npdm(npdm({ programId: 1n << 60n, is64: false })); assert.ok(!("error" in n32) && !n32.is64 && n32.titleId === "1000000000000000");
  const bad: [Uint8Array, RegExp][] = [
    [npdm({ programId: APP, magic: "NPDM" }), /is not an NPDM \(192 bytes, magic 0x4d44504e\)/],
    [new Uint8Array(40), /is not an NPDM \(40 bytes/],
    [npdm({ programId: APP, aciMagic: "ACID" }), /no ACI0 section at 0x80/],
    [npdm({ programId: APP, aciOffset: 0xB0 }), /no ACI0 section at 0xb0/],
    [npdm({ programId: APP }).subarray(0, 0x90), /no ACI0 section/],
  ];
  for (const [b, re] of bad) { const r = w.npdm(b); assert.ok("error" in r && re.test(r.error), "error" in r ? r.error : "accepted"); assert.match(r.error, /^\[RED\] prepare: /); }
  assert.equal(lines.filter(l => l.startsWith("[RED] ")).length, bad.length);
});

test("NSO build IDs: every test guest's ID is the one the loader reports; a damaged module is found before anything runs", () => {
  const lines: string[] = [], w = newWasm(lines);
  const ids = new Set<string>();
  for (const g of ["hello", "fsg", "two_main", "two_lib", "threads"]) {
    const b = guest(g), id = w.nsoBuildId(b.subarray(0, 0x100)), full = w.nsoCheck(b);
    assert.ok(id && /^[0-9a-f]{32}$/.test(id)); assert.ok(!("error" in full)); assert.equal(full.buildId, id);
    assert.equal(id, hexOf(b.subarray(0x40, 0x50)));
    ids.add(id);
  }
  assert.equal(ids.size, 5);
  assert.equal(w.nsoBuildId(new Uint8Array(0x100)), null);
  const cutShort = guest("fsg").subarray(0, 0x400); const r1 = w.nsoCheck(cutShort); assert.ok("error" in r1 && /past the end of the file/.test(r1.error), JSON.stringify(r1));
  const flipped = guest("fsg").slice(); flipped[flipped.length - 20] ^= 0x40;
  const r2 = w.nsoCheck(flipped); assert.ok("error" in r2 && /(SHA-256|decompress)/.test(r2.error), JSON.stringify(r2));
  return [`fsg ${w.nsoBuildId(guest("fsg").subarray(0, 0x100))}`];
});

// =================================================================================================== layouts
const listOf = async (files: Files, dirs: string[] = []) => { const t = new MemTree(); for (const [p, c] of Object.entries(files)) t.set(p, typeof c === "string" ? ascii(c) : c); for (const d of dirs) t.mkdir(d); return t; };
async function memRun(files: Files, o: { version?: number; dirs?: string[]; profiles?: ProfileSource } = {}) {
  const lines: string[] = [], tree = await listOf(files, o.dirs), store = new MemStore();
  const prep = new Prepare({ wasm: newWasm(lines), tree, store, profiles: o.profiles ?? noProfiles, version: o.version });
  return { prep, res: await prep.run(), lines, store, tree };
}
const V = (rom: Files, o: Partial<Parameters<typeof version>[0]> = {}) => version({ programId: APP, rom, ...o });
const R = (tag: string): Files => ({ "which.txt": tag, "data/blob.bin": blob(5000, tag.length) });

test("layouts: base/, flat, base + updates (newest by default, --version picks), update only, a base without its own RomFS; DLC listed with its index", async () => {
  const info: string[] = [];
  const check = async (what: string, files: Files, want: { kind: string; version: number; root: string; versions: number[]; dlc?: number[] }, o: { version?: number; dirs?: string[] } = {}) => {
    const r = await memRun(files, o);
    assert.equal(r.res.state, "Ready", `${what}: ${r.res.error}`);
    const d = r.prep.out<DetectOut>("detect");
    assert.deepEqual({ kind: d.layout, version: d.version, root: d.root, versions: d.versions, dlc: d.dlc.map(x => x.index) }, { dlc: [], ...want }, what);
    assert.equal(d.titleId, APP_HEX);
    // the RomFS that was indexed is the chosen version's, whole
    const ix = r.prep.out<IndexOut>("index");
    assert.equal(ix.rom.root, want.root + "romfs/");
    info.push(`${what}: ${d.layout}, version ${d.version} of [${d.versions}], RomFS ${ix.rom.root} (${ix.rom.files} files)`);
    return r;
  };
  await check("base/", prefixed("base/", V(R("base"))), { kind: "base", version: 0, root: "base/", versions: [0] });
  await check("exefs/ and romfs/ directly", V(R("flat")), { kind: "flat", version: 0, root: "", versions: [0] });
  const three = { ...prefixed("base/", V(R("base"))), ...prefixed("updates/65536/", V(R("update 1"))), ...prefixed("updates/131072/", V({ ...R("update 2"), "new/only-in-2.bin": "x" })) };
  const newest = await check("base + two updates", three, { kind: "base", version: 131072, root: "updates/131072/", versions: [0, 65536, 131072] });
  assert.equal(newest.prep.out<IndexOut>("index").rom.files, 3, "the update's RomFS is its own tree, not laid over the base's");
  await check("base + two updates, version 65536", three, { kind: "base", version: 65536, root: "updates/65536/", versions: [0, 65536, 131072] }, { version: 65536 });
  await check("base + two updates, version 0", three, { kind: "base", version: 0, root: "base/", versions: [0, 65536, 131072] }, { version: 0 });
  await check("an update alone", prefixed("updates/458752/", V(R("update"))), { kind: "update only", version: 458752, root: "updates/458752/", versions: [458752] });
  const baseNoRom = { "base/exefs/main": guest("fsg"), "base/exefs/main.npdm": npdm({ programId: APP }), ...prefixed("updates/65536/", V(R("update"))) };
  await check("a base without a RomFS and an update with one", baseNoRom, { kind: "base", version: 65536, root: "updates/65536/", versions: [0, 65536] });
  await check("flat with updates beside it", { ...V(R("flat")), ...prefixed("updates/65536/", V(R("update"))) }, { kind: "flat", version: 65536, root: "updates/65536/", versions: [0, 65536] });
  const dlcId = (n: bigint) => (APP + 0x1000n + n).toString(16);
  const withDlc = { ...prefixed("base/", V(R("base"))), ...prefixed(`dlc/${dlcId(1n)}/0/romfs/`, { "dlc.txt": "one" }), ...prefixed(`dlc/${dlcId(7n).toUpperCase()}/romfs/`, { "dlc.txt": "seven", "a/b.bin": blob(300) }) };
  const d = await check("base + two DLC", withDlc, { kind: "base", version: 0, root: "base/", versions: [0], dlc: [1, 7] });
  assert.deepEqual(d.prep.out<IndexOut>("index").aoc.map(a => [a.index_, a.files, a.root]), [[1, 1, `dlc/${dlcId(1n)}/0/romfs/`], [7, 2, `dlc/${dlcId(7n).toUpperCase()}/romfs/`]]);
  // an empty RomFS folder is still a RomFS (a program without a data section)
  await check("an empty romfs/", { "exefs/main": guest("fsg"), "exefs/main.npdm": npdm({ programId: APP }) }, { kind: "flat", version: 0, root: "", versions: [0] }, { dirs: ["romfs"] });
  // desktop litter is not game data
  const litter = await check("with .DS_Store files", { ...V(R("flat")), ".DS_Store": "x", "romfs/.DS_Store": "x", "romfs/data/._blob.bin": "x" }, { kind: "flat", version: 0, root: "", versions: [0] });
  assert.equal(litter.prep.out<IndexOut>("index").rom.files, 4);   // MemTree lists what it is given; the trees of real folders leave such files out (tree.ts isJunk; the pipeline test)
  return info;
});

test("malformed folders: each is refused in Detect with its reason, the machine ends Failed(reason), nothing is stored but the manifest", async () => {
  const info: string[] = [];
  const dlcId = (n: bigint) => (APP + 0x1000n + n).toString(16);
  const base = prefixed("base/", V(R("base")));
  const cases: [string, Files, string, RegExp, { version?: number; dirs?: string[] }?][] = [
    ["an empty folder", {}, "layout", /the folder is empty/],
    ["game packages", { "Game [0100AAAA0000B000][v0].nsp": "PFS0", "prod.keys": "x" }, "layout", /packages are not opened here \(no NSP \/ XCI \/ NCA decryption, no keys\); extract the game first/],
    ["the exefs folder itself", { "main": guest("fsg"), "main.npdm": npdm({ programId: APP }), "sdk": guest("two_lib") }, "layout", /this is an exefs folder .* pick the folder above it/],
    ["exefs without romfs", { "exefs/main": guest("fsg"), "exefs/main.npdm": npdm({ programId: APP }) }, "layout", /exefs\/ is there but romfs\/ is not beside it/],
    ["base/exefs without any romfs", { "base/exefs/main": guest("fsg"), "base/exefs/main.npdm": npdm({ programId: APP }) }, "layout", /base\/exefs is there but no RomFS/],
    ["romfs without exefs", { "romfs/a.bin": "x" }, "layout", /a RomFS folder is there but no exefs\/main\.npdm/],
    ["one folder too high", prefixed("MyGame/", V(R("x"))), "layout", /one folder further down, in MyGame\/: pick that folder/],
    ["unrelated files", { "notes.txt": "hello", "pics/a.png": "x" }, "layout", /no game files found; expected base\/exefs\/main\.npdm/],
    ["updates without a whole version", { "updates/65536/exefs/main.npdm": npdm({ programId: APP }), "updates/65536/exefs/main": guest("fsg") }, "layout", /updates\/ holds 65536 but none has both/],
    ["the newest update has no romfs", { ...base, ...prefixed("updates/65536/", V(R("u1"))), "updates/131072/exefs/main": guest("fsg"), "updates/131072/exefs/main.npdm": npdm({ programId: APP }) }, "version", /updates\/131072\/: no exefs\/main, exefs\/main\.npdm and romfs/],
    ["a version that is not there", { ...base, ...prefixed("updates/65536/", V(R("u1"))) }, "version", /no updates\/196608 \(have: 65536\)/, { version: 196608 }],
    ["version 0 without a base", prefixed("updates/65536/", V(R("u1"))), "version", /no base game \(base\/\), only updates 65536/, { version: 0 }],
    ["main.npdm is not an NPDM", { ...V(R("x")), "exefs/main.npdm": "this is not an npdm, it is text of some length to pass the size check ................................................................................................................" }, "npdm", /exefs\/main\.npdm: main\.npdm is not an NPDM/],
    ["no ACI0 section", { ...V(R("x")), "exefs/main.npdm": npdm({ programId: APP, aciMagic: "XXXX" }) }, "npdm", /no ACI0 section/],
    ["a program ID that is not a base title", V(R("x"), { programId: APP + 1n }), "npdm", /base program ID 0100AAAA0000B001 is not a base title ID/],
    ["an update of another program", { ...base, ...prefixed("updates/65536/", version({ programId: APP + 0x10000n, rom: R("u") })) }, "npdm", /updates\/65536\/: program ID 0100AAAA0001B000, the base is 0100AAAA0000B000/],
    ["a 32-bit program", V(R("x"), { is64: false }), "arch", /32-bit ARM code/],
    ["main is not an NSO", { ...V(R("x")), "exefs/main": blob(4096) }, "module", /exefs\/main is not an NSO \(4096 bytes\)/],
    ["main is missing", { "exefs/main.npdm": npdm({ programId: APP }), "exefs/sdk": guest("two_lib"), "romfs/a": "x" }, "version", /no exefs\/main, exefs\/main\.npdm and romfs/],
    ["a DLC folder that is not a title ID", { ...base, "dlc/extras/0/romfs/a": "x" }, "dlc", /dlc\/extras: not a DLC title ID/],
    ["a DLC of another game", { ...base, [`dlc/${(APP + 0x21000n).toString(16)}/0/romfs/a`]: "x" }, "dlc", /is not a DLC of 0100AAAA0000B000/],
    ["the application's own ID as a DLC", { ...base, [`dlc/${(APP + 0x1000n).toString(16)}/0/romfs/a`]: "x" }, "dlc", /is not a DLC of/],
    ["a DLC with two RomFS folders", { ...base, [`dlc/${dlcId(2n)}/0/romfs/a`]: "x", [`dlc/${dlcId(2n)}/1/romfs/a`]: "x" }, "dlc", /expected one <n>\/romfs folder, found 2/],
    ["a DLC without a RomFS folder", { ...base, [`dlc/${dlcId(2n)}/readme.txt`]: "x" }, "dlc", /expected one <n>\/romfs folder, found 0/],
  ];
  for (const [what, files, reason, re, o] of cases) {
    const r = await memRun(files, o);
    assert.equal(r.res.state, "Failed", `${what}: ${r.res.state}`);
    assert.equal(r.res.reason, reason, `${what}: ${r.res.error}`);
    assert.match(r.res.error!, re, what);
    assert.deepEqual([r.prep.w.state, r.prep.w.reason], ["Failed", reason], what);
    assert.ok(r.lines.some(l => l.startsWith("[RED] prepare: detect: ")), what + ": no red line");
    assert.deepEqual([...r.store.blobs.keys()], ["manifest.json"], what);
    const m = JSON.parse(Buffer.from(r.store.blobs.get("manifest.json")!).toString()) as Manifest;
    assert.deepEqual([m.machine, m.reason, m.stages.detect.state, m.stages.detect.reason], ["Failed", reason, "failed", reason], what);
    info.push(`${what}: ${reason}`);
  }
  // a Failed prepare starts again once the folder is right
  const tree = new MemTree(), store = new MemStore(), w = newWasm();
  const prep = new Prepare({ wasm: w, tree, store, profiles: noProfiles });
  assert.equal((await prep.run()).state, "Failed");
  for (const [p, c] of Object.entries(V(R("now right")))) tree.set(p, typeof c === "string" ? ascii(c) : c);
  assert.equal((await prep.run()).state, "Ready");
  info.push(`${cases.length} malformed folders; a Failed run starts again and ends Ready once the folder is right`);
  return [info.slice(-1)[0], info.slice(0, -1).join("; ")];
});

test("a path RomFS cannot hold is refused in Index (a name over 0x300 bytes), and a file where the list needs a directory", async () => {
  const long = "n".repeat(0x301);
  const r = await memRun({ ...V({ ["data/" + long]: "x", "ok.txt": "y" }) });
  assert.deepEqual([r.res.state, r.res.reason], ["Failed", "romfs"]);
  assert.match(r.res.error!, /a name longer than 0x300 bytes/);
  const w = newWasm();
  const dup = w.romTables([{ path: "a", size: 1 }, { path: "a/b", size: 1 }]); assert.ok("error" in dup && /a file is where a directory is needed/.test(dup.error));
  const twice = w.romTables([{ path: "a/b", size: 1 }, { path: "a/b", size: 2 }]); assert.ok("error" in twice && /is listed twice/.test(twice.error));
  for (const p of ["a//b", "a/./b", "../b", "a/"]) { const x = w.romTables([{ path: p, size: 1 }]); assert.ok("error" in x, p); }
  const ok = w.romTables([{ path: "a/" + "n".repeat(0x300), size: 1 }]); assert.ok(!("error" in ok));
});

test("a dropped directory as FileSystemDirectoryEntry (webkitGetAsEntry), with stand-in entries: readEntries is called until it gives nothing (it returns at most 100 a call), files and directories are listed; a file list of <input webkitdirectory> loses its first path component", async () => {
  // stand-ins with the API's shape: no browser object is involved here (the real ones run in prepare:browser where automation can make them)
  const file = (name: string, bytes: Uint8Array) => ({ name, isDirectory: false, isFile: true, file: (ok: (f: unknown) => void) => ok({ size: bytes.length, lastModified: 5, slice: (a: number, b: number) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }) }) });
  let calls = 0;
  const dir = (name: string, kids: unknown[]): unknown => ({ name, isDirectory: true, isFile: false, createReader: () => { let at = 0; return { readEntries: (ok: (b: unknown[]) => void) => { calls++; const b = kids.slice(at, at + 100); at += b.length; setTimeout(() => ok(b), 0); } }; } });
  const many = Array.from({ length: 250 }, (_, i) => file(`f${i}.bin`, Uint8Array.of(i & 255, 1, 2)));
  const root = dir("Game", [dir("exefs", [file("main", blob(300)), file("main.npdm", npdm({ programId: APP }))]), dir("romfs", [...many, dir("empty", []), file(".DS_Store", blob(4))])]);
  const t = new EntryTree(root), l = await t.list();
  assert.equal(t.name, "Game");
  assert.equal(l.files.length, 252); assert.deepEqual(l.dirs, ["exefs", "romfs", "romfs/empty"]);
  assert.equal(calls, 2 + 2 + 4 + 1, "root and exefs: a batch and the empty one; romfs (252 entries): 100, 100, 52, none; empty: none");
  assert.deepEqual(await t.read("romfs/f77.bin", 1, 2), Uint8Array.of(1, 2));
  assert.ok(isJunk("romfs/.DS_Store") && isJunk("a/._x") && isJunk("Thumbs.db") && !isJunk("romfs/.hidden") && !isJunk("data/DS_Store"));
  const fl = new FileListTree([{ name: "main", size: 3, lastModified: 1, webkitRelativePath: "MyGame/exefs/main" }, { name: "a.bin", size: 9, lastModified: 2, webkitRelativePath: "MyGame/romfs/data/a.bin" }] as unknown as File[]);
  const l2 = await fl.list();
  assert.equal(fl.name, "MyGame"); assert.deepEqual(l2.files.map(f => f.path), ["exefs/main", "romfs/data/a.bin"]); assert.deepEqual(l2.dirs, ["exefs", "romfs", "romfs/data"]);
});

// =================================================================================================== RomFS device
test("the RomFS device over a directory: tools/mkromfs.py's independent reader finds in the virtual image exactly what it finds in the image it built from the same tree (every entry through links and hash tables, every file's SHA-256)", async () => {
  const s = synthTree("romdev", ["--seed", "21", "--files", "400", "--dirs", "60", "--depth", "6", "--max-size", "9000", "--max-name", "48"]);
  const tree = new NodeTree(s.dir), l = await tree.list(), w = newWasm();
  const entries = [...l.dirs.map(d => ({ path: d, size: 0, dir: true })), ...l.files.map(f => ({ path: f.path, size: f.size }))];
  const t0 = performance.now(), r = w.romTables(entries), ms = performance.now() - t0;
  assert.ok(!("error" in r), JSON.stringify(r));
  const dev = new DirRomDevice({ tables: r.tables, starts: r.starts, sizes: Float64Array.from(l.files.map(f => f.size)), size: r.size }, treeSource(tree, l.files.map(f => f.path)));
  // the whole virtual image, read in odd-sized pieces that straddle tables, padding and files
  const img = new Uint8Array(dev.size());
  for (let at = 0, n = 1; at < img.length; at += n, n = (n * 7 + 13) % 5003 + 1) { const len = Math.min(n, img.length - at); assert.equal(dev.readSync!(at, img.subarray(at, at + len)), DEV.OK); }
  const dumped = join(SCRATCH, "romdev.virtual.img");
  writeFileSync(dumped, img);
  assert.deepEqual(lsRows(python(["ls", dumped])), lsRows(s.ls));
  // the asynchronous path gives the same bytes; a read past the end is refused
  const a = await dev.readAsync(r.dataOffset - 40, 5000); assert.deepEqual(a, img.subarray(r.dataOffset - 40, r.dataOffset - 40 + 5000));
  assert.equal(dev.readSync!(dev.size() - 4, new Uint8Array(8)), DEV.IO);
  await assert.rejects(dev.readAsync(dev.size(), 1));
  tree.close();
  return [`${r.files} files and ${r.dirs} directories: tables ${r.tables.length} bytes built in ${ms.toFixed(1)} ms; virtual image ${dev.size()} bytes; mkromfs.py's reader lists the same ${lsRows(s.ls).length} entries with the same hashes`];
});

// =================================================================================================== cuts
test("a registered cut applied: the cut module is an NSO the loader accepts, the code runs changed (exit code 42 -> 7, the text it prints), the build ID stays", async () => {
  const w = newWasm(), hello = guest("hello");
  const mov = imageOffsets(w, hello, Uint8Array.of(0x40, 0x05, 0x80, 0x52));          // mov w0, #42
  const str = imageOffsets(w, hello, ascii("hello from an NSO"));
  assert.equal(mov.length, 1, "one mov w0,#42 in hello"); assert.equal(str.length, 1);
  const cuts: Cut[] = [
    { off: mov[0], orig: "40058052", new: "e0008052", why: "the exit code: mov w0,#42 -> mov w0,#7" },
    { off: str[0] + 6, orig: hexOf(ascii("from")), new: hexOf(ascii("FROM")), why: "the greeting (read-only data)" },
    { off: str[0] + 7, orig: hexOf(ascii("ROM")), new: hexOf(ascii("rom")), why: "a cut that asserts what the cut before it wrote (nxnative applies them in order)" },
  ];
  const r = w.cut(hello, cuts);
  assert.ok("bytes" in r, JSON.stringify(r)); assert.equal(r.applied, 3);
  assert.equal(hexOf(r.bytes.subarray(0x40, 0x60)), hexOf(hello.subarray(0x40, 0x60)), "build ID");
  const run = (bytes: Uint8Array) => { const rt = new Runtime(env.mods); assert.ok(rt.loadNso([{ name: "hello", bytes }]), rt.red.join("|")); const res = rt.run(); const o = [res.stop?.kind, res.stop?.code, rt.stdout(), rt.red.length]; rt.dispose(); return o; };
  assert.deepEqual(run(hello), ["exit", 42, "hello from an NSO\nx0=0 main thread handle=0x1001\n", 0]);
  assert.deepEqual(run(r.bytes), ["exit", 7, "hello From an NSO\nx0=0 main thread handle=0x1001\n", 0]);
  // the cut module's hashes are checked by the loader: a byte changed after the cut is refused
  const bad = r.bytes.slice(); bad[bad.length - 9] ^= 1;
  const rt = new Runtime(env.mods); assert.equal(rt.loadNso([{ name: "hello", bytes: bad }]), false); assert.ok(rt.red.some(l => /SHA-256/.test(l)));
  return [`mov w0,#42 at +0x${mov[0].toString(16)}, the string at +0x${str[0].toString(16)}; ${hello.length} -> ${r.bytes.length} bytes (stored segments, three hashes)`];
});

test("a cut whose original bytes do not match is refused: the red line shows what the module has, nothing is produced; so are cuts outside the module and malformed lists", () => {
  const lines: string[] = [], w = newWasm(lines), hello = guest("hello");
  const mov = imageOffsets(w, hello, Uint8Array.of(0x40, 0x05, 0x80, 0x52))[0];
  const good: Cut = { off: mov, orig: "40058052", new: "e0008052" };
  const r = w.cut(hello, [good, { off: mov + 4, orig: "deadbeef", new: "1f2003d5" }]);
  assert.ok("error" in r); assert.equal(r.index, 1); assert.equal(r.code, -4);
  assert.match(r.error, new RegExp(`^\\[RED\\] prepare: cut original bytes mismatch 0x${(mov + 4).toString(16)}: the module has [0-9a-f]{8}, the cut expects deadbeef \\(cut 1\\): this is not the build the cut was made for; nothing was changed$`));
  const again = w.cut(hello, [{ ...good, orig: "e0008052", new: "40058052" }]); assert.ok("error" in again && again.index === 0, "the refused run left the module as it was");
  const info = w.nsoCheck(hello); assert.ok(!("error" in info));
  const out = w.cut(hello, [{ off: 0x7FFFFFF0, orig: "00", new: "01" }]); assert.ok("error" in out && out.code === -3 && /lies outside the module/.test(out.error));
  const edge = w.cut(hello, [{ off: 0xFFFFFFFF, orig: "0000", new: "0101" }]); assert.ok("error" in edge && edge.code === -3);
  const uneven = w.cut(hello, [{ off: mov, orig: "4005", new: "e0008052" }]); assert.ok("error" in uneven && uneven.code === -2);
  const notNso = w.cut(blob(5000), [good]); assert.ok("error" in notNso && notNso.code === -1);
  assert.ok(lines.filter(l => l.startsWith("[RED] ")).length >= 5);
  return [r.error];
});

// =================================================================================================== the pipeline
test("the whole pipeline on a folder: Detect, Index, Profile (by title ID, with a registered cut), Code, Shaders, Ready; handed to the runtime, the game mounts its RomFS from the folder and runs with the cut", async () => {
  const b = blob(), fsg = guest("fsg"), w0 = newWasm();
  const at = imageOffsets(w0, fsg, ascii("MountRom: "));
  assert.equal(at.length, 1);
  const profiles = memProfiles([profileFor(fsg, APP_HEX, [{ off: at[0], orig: hexOf(ascii("MountRom")), new: hexOf(ascii("MountROM")), why: "test" }], { needs: [{ key: "fps_target", value: "60", what: "frame rate" }] }, { sdk: "00".repeat(16) })]);
  const dir = game("pipeline", { ...prefixed("base/", version({ programId: APP, blob: b, extra: { "exefs/rtld": guest("two_lib"), "exefs/sdk": guest("two_lib"), "exefs/subsdk0": guest("host_lib") } })), "base/romfs/.DS_Store": "desktop litter", "base/romfs/data/._blob.bin": "more", "base/exefs/.DS_Store": "x" }, ["base/romfs/empty"]);
  const seen: string[] = [];
  const r = prepare(dir, { profiles, at: p => { seen.push(p); } });
  const states: string[] = [];
  (r.prep.o as any).onChange = (s: any) => { if (states.at(-1) !== s.state) states.push(s.state); };
  const res = await r.prep.run();
  assert.deepEqual([res.state, res.ran, res.skipped], ["Ready", [...STAGES], []], res.error);
  assert.deepEqual(states, ["Detect", "Index", "Profile", "Code", "Shaders", "Ready"]);
  assert.deepEqual(seen, STAGES.flatMap(s => s === "shaders" ? [`${s}:begin`, `${s}:work`, `${s}:end`] : s === "code" ? [`${s}:begin`, `${s}:work`, `${s}:work`, `${s}:end`] : [`${s}:begin`, `${s}:work`, `${s}:end`]));
  const det = r.prep.out<DetectOut>("detect"), prof = r.prep.out<ProfileOut>("profile"), code = r.prep.out<CodeOut>("code");
  assert.deepEqual(det.modules.map(m => m.name), ["rtld", "main", "subsdk0", "sdk"]);
  assert.deepEqual(prof.load, ["main", "sdk"], "the profile's modules, in its order: rtld is the loader's part, subsdk0 is not listed");
  assert.deepEqual([prof.found, prof.by, prof.registered, prof.display, prof.cuts.length], [true, "title", false, "1.0.0", 1]);
  assert.deepEqual(prof.unregistered, ["sdk"]);
  assert.deepEqual(code.modules.map(m => [m.name, m.from, m.cuts]), [["main", "store", 1], ["sdk", "folder", 0]]);
  const c = r.prep.w.counts();
  assert.deepEqual([c.cuts, c.modules, c.romFiles, c.romDirs, c.ran, c.skipped], [1, 2, 2, 3, 5, 0], "2 RomFS files: what a desktop leaves in a folder (.DS_Store, ._*) is not game data");
  assert.deepEqual(det.other, []);
  const h = await r.prep.handoff();
  assert.deepEqual([h.titleId, h.version, h.saveId, h.shaders.mode, h.shaders.chain, h.hooks.length, h.cuts.length, h.profile.needs[0].key], [APP_HEX, 0, "nxweb-save-" + APP_HEX, "on-demand", RT_SHADER_CHAIN, 0, 1, "fps_target"]);
  assert.equal(SHADER_CHAIN, RT_SHADER_CHAIN);
  const saves = new NodeStorage({ saveDir: dir + ".saves" }); rmSync(dir + ".saves", { recursive: true, force: true }); mkdirSync(dir + ".saves");
  const p = await play(r, saves);
  assert.deepEqual([p.kind, p.code, p.red], ["exit", 0, []]);
  // the profile's second module (the runtime's library guest standing in for sdk) was loaded too: its initializers ran before main, its finalizers after
  assert.equal(p.stdout, "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\n" + fsgFirst(b, "MountROM: ") + "lib: fini_array[0]\nlib: DT_FINI\n");
  // without the profile the same folder runs uncut, provisional
  freshStore(dir);
  const r2 = prepare(dir); assert.equal((await r2.prep.run()).state, "Ready");
  const prof2 = r2.prep.out<ProfileOut>("profile");
  assert.deepEqual([prof2.found, prof2.provisional, prof2.load], [false, true, ["main", "subsdk0", "sdk"]]);
  assert.match(prof2.warnings[0], /^no profile: provisional/);
  r.tree.close(); r2.tree.close();
  return [`states ${states.join(" > ")}`, `the guest printed ${JSON.stringify(p.stdout.split("\n")[0])} and read ${b.length} bytes of rom:/data/blob.bin through ${p.reads} file reads of the folder device`];
});

test("update layering and DLC: the newest update's RomFS is what the game reads (whole, never over the base's); each DLC's RomFS is an add-on content device at its index, checked by mkromfs.py's reader", async () => {
  const b0 = blob(40_000, 1), b1 = blob(50_001, 2);
  const dlc1 = (APP + 0x1001n).toString(16), dlc3 = (APP + 0x1003n).toString(16);
  const dir = game("layers", { ...prefixed("base/", version({ programId: APP, blob: b0, rom: { "data/blob.bin": b0, "base-only.txt": "gone in the update" } })),
    ...prefixed("updates/65536/", version({ programId: APP, rom: { "data/blob.bin": b1, "hello.txt": "new" } })),
    ...prefixed(`dlc/${dlc1}/0/romfs/`, { "pack/a.bin": blob(3000, 3), "pack/b.bin": blob(17, 4) }), ...prefixed(`dlc/${dlc3}/0/romfs/`, { "c.bin": blob(70_000, 5) }) });
  const r = prepare(dir); assert.equal((await r.prep.run()).state, "Ready");
  const p = await play(r); assert.equal(p.stdout, fsgFirst(b1)); assert.deepEqual(p.red, []);
  const base = prepare(dir, { version: 0 }); assert.equal((await base.prep.run()).state, "Ready");
  assert.deepEqual(base.prep.out<DetectOut>("detect").version, 0);
  const pb = await play(base); assert.equal(pb.stdout, fsgFirst(b0));
  const h = await r.prep.handoff();
  assert.deepEqual([...h.aoc.keys()], [1, 3]);
  const storage = h.storage(new MemStorage());
  assert.equal(storage.open(FS_KIND.ROM, 0n), h.rom); assert.equal(storage.open(FS_KIND.AOC, 3n), h.aoc.get(3)); assert.equal(storage.open(FS_KIND.AOC, 2n), DEV.NOT_FOUND);
  const info: string[] = [];
  for (const [i, tid] of [[1, dlc1], [3, dlc3]] as const) {
    const dev = h.aoc.get(i) as DirRomDevice, img = new Uint8Array(dev.size());
    assert.equal(dev.readSync!(0, img), DEV.OK);
    const f = join(SCRATCH, `layers.aoc${i}.img`), ref = join(SCRATCH, `layers.aoc${i}.ref.img`); writeFileSync(f, img);
    python(["build", join(dir, "dlc", tid, "0", "romfs"), ref]);
    assert.deepEqual(lsRows(python(["ls", f])), lsRows(python(["ls", ref])));
    info.push(`add-on content ${i}: ${lsRows(python(["ls", f])).length} entries`);
  }
  r.tree.close(); base.tree.close();
  return [`update 65536: the game read its ${b1.length}-byte blob; version 0: the base's ${b0.length}-byte blob`, info.join("; ")];
});

test("stage skipping by hash: an unchanged folder skips all five stages; a touched RomFS file runs Index only; a changed one runs Index and what follows from its tables; a new profile cut runs Profile and Code; redo(stage) runs that stage", async () => {
  const b = blob(), fsg = guest("fsg");
  const dir = game("skip", prefixed("base/", version({ programId: APP, blob: b })));
  const go = async (o: Parameters<typeof prepare>[1] = {}) => { const r = prepare(dir, o); const res = await r.prep.run(); assert.equal(res.state, "Ready", res.error); r.tree.close(); return { ...r, res }; };
  const first = await go(); assert.deepEqual([first.res.ran, first.res.skipped], [[...STAGES], []]);
  const second = await go(); assert.deepEqual([second.res.ran, second.res.skipped], [[], [...STAGES]]);
  assert.deepEqual([second.prep.w.count("skipped"), second.prep.w.count("ran"), second.prep.w.count("romFiles"), second.prep.w.count("modules")], [5, 0, 2, 1], "a skipped stage still gives its counts");
  assert.equal((await play(second)).stdout, fsgFirst(b), "a prepare that skipped everything hands off the same game");
  // only the time of a RomFS file: the listing differs, the tables do not
  const f = join(dir, "base/romfs/hello.txt"), st = statSync(f); utimesSync(f, st.atime, new Date(st.mtimeMs + 5000));
  const touched = await go(); assert.deepEqual([touched.res.ran, touched.res.skipped], [["index"], ["detect", "profile", "code", "shaders"]]);
  // a RomFS file's size: Index, and Profile sees new tables (its marker check reads the listing)
  writeFileSync(f, "a longer hello from a folder\n");
  const changed = await go(); assert.deepEqual([changed.res.ran, changed.res.skipped], [["index", "profile"], ["detect", "code", "shaders"]]);
  // a code module's time: Detect and Code look again, and find the same build
  const m = join(dir, "base/exefs/main"), mst = statSync(m); utimesSync(m, mst.atime, new Date(mst.mtimeMs + 5000));
  const code = await go(); assert.deepEqual([code.res.ran, code.res.skipped], [["detect", "code"], ["index", "profile", "shaders"]]);
  // the profile gains a cut
  const at = imageOffsets(newWasm(), fsg, ascii("MountRom: "))[0];
  const profiles = memProfiles([profileFor(fsg, APP_HEX, [{ off: at, orig: hexOf(ascii("MountRom")), new: hexOf(ascii("MountROM")) }])]);
  const cut = await go({ profiles }); assert.deepEqual([cut.res.ran, cut.res.skipped], [["profile", "code"], ["detect", "index", "shaders"]]);
  assert.equal((await play(cut)).stdout, fsgFirst(b, "MountROM: "));
  const same = await go({ profiles }); assert.deepEqual(same.res.ran, []);
  // redo: one call
  const info: string[] = [];
  for (const s of STAGES) {
    const r = prepare(dir, { profiles }); const res = await r.prep.redo(s); r.tree.close();
    assert.equal(res.state, "Ready"); assert.deepEqual(res.ran, [s], `redo(${s})`);
    info.push(`redo(${s}): ran ${res.ran}, skipped ${res.skipped.length}`);
  }
  // another version asked for: Detect runs, and everything that depends on which version it is
  const other = prepare(dir, { profiles, version: 0 }); const ro = await other.prep.run(); other.tree.close();
  assert.deepEqual(ro.ran, ["detect"], "version 0 is what the newest-by-default was here: only Detect's input names the request");
  return ["unchanged: 5 skipped; touched RomFS file: index; resized RomFS file: index, profile; touched module: detect, code; new cut: profile, code", info.join("; ")];
});

test("resume after a kill at each stage, at each of its points: the manifest shows the stage running, the next run skips what was finished, runs the rest and ends Ready with the same hand-off", async () => {
  const b = blob(), fsg = guest("fsg");
  const at0 = imageOffsets(newWasm(), fsg, ascii("MountRom: "))[0];
  const profiles = memProfiles([profileFor(fsg, APP_HEX, [{ off: at0, orig: hexOf(ascii("MountRom")), new: hexOf(ascii("MountROM")) }])]);
  const dlc = (APP + 0x1002n).toString(16);
  const files = { ...prefixed("base/", version({ programId: APP, blob: b })), ...prefixed(`dlc/${dlc}/0/romfs/`, { "x.bin": blob(999) }) };
  const info: string[] = [];
  let n = 0;
  for (const [si, s] of STAGES.entries()) for (const point of ["begin", "work", "end"]) {
    const dir = game(`kill-${s}-${point}`, files);
    const dead = prepare(dir, { profiles, at: p => { if (p === `${s}:${point}`) throw new Kill(); } });
    await assert.rejects(dead.prep.run(), Kill); dead.tree.close();
    const m = JSON.parse(readFileSync(join(dir + ".store", "manifest.json"), "utf8")) as Manifest;
    assert.deepEqual(STAGES.map(x => m.stages[x].state), STAGES.map((x, i) => i < si ? "done" : i === si ? "running" : "pending"), `${s}:${point}`);
    assert.equal(m.machine, STATES[si + 1], "the manifest names the stage the dead run was in");
    // a new page: a new module instance, a new tree, the same store
    const next = prepare(dir, { profiles }); const res = await next.prep.run();
    assert.equal(res.state, "Ready", res.error);
    assert.deepEqual([res.skipped, res.ran], [STAGES.slice(0, si), STAGES.slice(si)], `${s}:${point}`);
    const p = await play(next); assert.equal(p.stdout, fsgFirst(b, "MountROM: "), `${s}:${point}`); next.tree.close();
    n++;
    if (point === "work") info.push(`killed in ${s}: resumed with ${res.skipped.length} skipped, ${res.ran.length} run`);
  }
  // killed twice in a row, in different stages
  const dir = game("kill-twice", files);
  const a = prepare(dir, { profiles, at: p => { if (p === "code:work") throw new Kill(); } }); await assert.rejects(a.prep.run(), Kill);
  const c = prepare(dir, { profiles, at: p => { if (p === "shaders:end") throw new Kill(); } }); await assert.rejects(c.prep.run(), Kill);
  const d = prepare(dir, { profiles }); const res = await d.prep.run(); assert.deepEqual([res.state, res.ran], ["Ready", ["shaders"]]);
  a.tree.close(); c.tree.close(); d.tree.close();
  return [`${n} kill points (5 stages x begin, work, end), each resumed to Ready and run in the runtime`, info.join("; ")];
});

test("cancel: a prepare cancelled in any stage ends Cancelled with that stage recorded, the same object starts again and finishes; cancel when nothing runs does nothing", async () => {
  const b = blob();
  const info: string[] = [];
  for (const [si, s] of STAGES.entries()) {
    const dir = game(`cancel-${s}`, prefixed("base/", version({ programId: APP, blob: b })));
    let r!: Run;
    r = prepare(dir, { at: p => { if (p === `${s}:work`) r.prep.cancel(); } });
    const res = await r.prep.run();
    assert.deepEqual([res.state, r.prep.w.state, res.skipped, res.ran], ["Cancelled", "Cancelled", [], STAGES.slice(0, si)]);
    const m = JSON.parse(readFileSync(join(dir + ".store", "manifest.json"), "utf8")) as Manifest;
    assert.deepEqual([m.machine, m.stages[s].state], ["Cancelled", "cancelled"]);
    (r.prep.o as any).at = undefined;
    const again = await r.prep.run();
    assert.deepEqual([again.state, again.skipped, again.ran], ["Ready", STAGES.slice(0, si), STAGES.slice(si)]);
    r.tree.close();
    info.push(`${s}: cancelled, then ${again.ran.length} stages run`);
  }
  const dir = game("cancel-idle", prefixed("base/", version({ programId: APP, blob: b })));
  const r = prepare(dir); r.prep.cancel(); assert.equal(r.prep.w.state, "Idle");
  assert.equal((await r.prep.run()).state, "Ready"); r.prep.cancel(); assert.equal(r.prep.w.state, "Ready");
  await assert.rejects(r.prep.redo("nothing" as StageName).then(() => { throw new Error("x"); }), /x/);   // an unknown stage name changes no record
  const p = r.prep.run(); await assert.rejects(r.prep.run(), /a run is in progress/); await p;
  assert.equal(r.prep.w.x.kit_refused_total(), 0, "the guards never offered the machine an event it refuses");
  r.tree.close();
  return [info.join("; ")];
});

test("profile selection: by title ID from the converted nxnative profiles (a build they do not register gets no cuts and says so); by main's build ID under another title ID; none: provisional; a registered cut that does not match stops the prepare", async () => {
  const info: string[] = [];
  const db = nodeProfiles(), idx = await db.index();
  assert.ok(Object.keys(idx.games).length >= 150, "the converted profiles");
  // DARK SOULS: REMASTERED's title ID with a main that is not its build
  const ds = "01004AB00A260000";
  const dir = game("profile-title", prefixed("base/", version({ programId: BigInt("0x" + ds), blob: blob(2000), rom: { "dvdbnd0.bdt": "marker", "data/blob.bin": blob(2000) } })));
  const r = prepare(dir, { profiles: db }); const res = await r.prep.run(); assert.equal(res.state, "Ready", res.error);
  const p = r.prep.out<ProfileOut>("profile");
  assert.deepEqual([p.found, p.by, p.id, p.name, p.registered, p.cuts.length, p.provisional], [true, "title", ds, "DARK SOULS: REMASTERED", false, 0, false]);
  assert.deepEqual(p.load, ["main"]);
  assert.equal(p.apply.mem_used, "0x6e00000"); assert.equal(p.apply.pad_layout, "full");
  assert.ok(p.needs.some(n => n.key === "address_space" && /3\.25 GB heap region/.test(n.what)));
  assert.equal(p.warnings.length, 1); assert.match(p.warnings[0], /not a build the profile was made on \(main [0-9a-f]{32}; the profile's builds: v196608 main df3766a2bb651a3e822828abf10b6f7b\): the per-build cuts do not reach it/);
  info.push(`by title: ${p.name}; ${p.warnings[0]}`);
  r.tree.close();
  // without its marker the profile warns
  const dir2 = game("profile-marker", prefixed("base/", version({ programId: BigInt("0x" + ds), blob: blob(2000) })));
  const r2 = prepare(dir2, { profiles: db }); await r2.prep.run(); r2.tree.close();
  assert.ok(r2.prep.out<ProfileOut>("profile").warnings.some(w => /the RomFS has no dvdbnd0\.bdt/.test(w)));
  // the same main under a title ID no profile has
  const fsg = guest("fsg"), other = "0100BBBB0000C000";
  const mem = memProfiles([profileFor(fsg, other, [], { apply: { title_id: other, program_id: other, name: "Regional", modules: "main", op_mode: "handheld" } })]);
  const r3 = prepare(game("profile-build", prefixed("base/", version({ programId: APP, blob: blob(2000) }))), { profiles: mem }); assert.equal((await r3.prep.run()).state, "Ready"); r3.tree.close();
  const p3 = r3.prep.out<ProfileOut>("profile");
  assert.deepEqual([p3.found, p3.by, p3.id, p3.registered, p3.apply.program_id, p3.apply.op_mode], [true, "build", other, true, APP_HEX, "handheld"]);
  assert.match(p3.warnings[0], /title ID 0100AAAA0000B000 has no profile; main's build is 0100BBBB0000C000's/);
  info.push("by build ID: a profile of another title ID, with this title's program ID");
  // none
  const r4 = prepare(game("profile-none", prefixed("base/", version({ programId: APP, blob: blob(2000), sysResource: 0x1000000 }))), { profiles: db }); assert.equal((await r4.prep.run()).state, "Ready"); r4.tree.close();
  const p4 = r4.prep.out<ProfileOut>("profile");
  assert.deepEqual([p4.found, p4.provisional, p4.apply.sys_resource, p4.apply.app_pool, p4.needs.length], [false, true, "0x1000000", "0xCD500000", 0]);
  info.push("none: provisional (sys_resource from main.npdm, the default pool)");
  // a registered cut on the wrong bytes: nxnative aborts the rewrite, so does the Code stage
  const wrong = memProfiles([profileFor(fsg, APP_HEX, [{ off: 0x40, orig: "ffffffff", new: "1f2003d5", why: "not this build's bytes" }])]);
  const dir5 = game("profile-mismatch", prefixed("base/", version({ programId: APP, blob: blob(2000) })));
  const r5 = prepare(dir5, { profiles: wrong }); const res5 = await r5.prep.run(); r5.tree.close();
  assert.deepEqual([res5.state, res5.reason, r5.prep.w.state, r5.prep.w.reason, res5.ran], ["Failed", "cut", "Failed", "cut", ["detect", "index", "profile"]]);
  assert.match(res5.error!, /base\/exefs\/main \(build [0-9a-f]{32}\): cut original bytes mismatch 0x40: the module has [0-9a-f]{8}, the cut expects ffffffff/);
  assert.equal(existsSync(join(dir5 + ".store", "code", "main.nso")), false, "no cut module was stored");
  await assert.rejects(r5.prep.handoff(), /no hand-off in Failed/);
  // the SDK's cuts reach a module of their build whatever the game: a profile-less game with that sdk build
  const sdkId = newWasm().nsoBuildId(guest("two_lib").subarray(0, 0x100))!;
  const lib = guest("two_lib"), w = newWasm(), first4 = (() => { const z = w.cut(lib, []); assert.ok("bytes" in z); const dv = new DataView(z.bytes.buffer); return hexOf(z.bytes.subarray(dv.getUint32(0x10, true), dv.getUint32(0x10, true) + 4)); })();
  const sdkDb = memProfiles([], { source: "test", cuts: { [sdkId]: { module: "sdk", cuts: [{ off: 0, orig: first4, new: first4, why: "identity" }] } }, unconverted: [] });
  const r6 = prepare(game("profile-sdk", prefixed("base/", version({ programId: APP, blob: blob(2000), extra: { "exefs/sdk": lib } }))), { profiles: sdkDb }); assert.equal((await r6.prep.run()).state, "Ready"); r6.tree.close();
  assert.deepEqual(r6.prep.out<ProfileOut>("profile").cuts.map(c => [c.module, c.from, c.cuts.length]), [["sdk", "sdk", 1]]);
  assert.deepEqual(r6.prep.out<CodeOut>("code").modules.map(m => [m.name, m.from, m.cuts]), [["main", "folder", 0], ["sdk", "store", 1]]);
  info.push("a mismatching registered cut: Failed(cut), nothing stored; an SDK cut applies by the sdk module's build ID");
  return info;
});

test("the converted profiles: every file is what tools/prepare/convert_profiles.py writes today; every cut's bytes are well formed; counts", () => {
  const dir = join(ROOT, "src", "prepare", "profiles");
  const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const idx = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  let cuts = 0, builds = 0;
  for (const f of [...Object.keys(idx.games), "_sdk"]) {
    const p = JSON.parse(readFileSync(join(dir, f + ".json"), "utf8"));
    assert.match(p.source, /MIT, Copyright \(c\) 2026 seedds/);
    for (const [bid, c] of Object.entries(p.cuts ?? {}) as [string, { module: string; cuts: Cut[] }][]) {
      assert.match(bid, /^[0-9a-f]{32}$/); builds++;
      for (const x of c.cuts) { assert.ok(Number.isInteger(x.off) && x.off >= 0 && /^([0-9a-f]{2})+$/.test(x.orig) && x.orig.length === x.new.length && /^[0-9a-f]+$/.test(x.new), `${f} ${bid}`); cuts++; }
    }
  }
  assert.equal(cuts, rep.conversion.converted_cuts + rep.conversion.sdk_converted);
  assert.deepEqual(rep.problems, []);
  const nx = process.env.NXNATIVE ?? "/home/user/nxnative";
  let check = "SKIPPED: no nxnative checkout (NXNATIVE): the files were not compared with a fresh conversion";
  if (existsSync(join(nx, "dm", "games"))) check = execFileSync("python3", [join(ROOT, "tools", "prepare", "convert_profiles.py"), "--check", "--nxnative", nx], { encoding: "utf8" }).trim();
  return [`${rep.profiles} profiles; (profile, key) pairs a ${rep.pairs_per_class.a}, b ${rep.pairs_per_class.b}, c ${rep.pairs_per_class.c}; ${cuts} cuts in ${builds} builds`, check];
});

test("the prepare machine as the module drives it: its states and events are the table's, and a run in progress refuses Start", () => {
  const def = loadDefs().find(d => d.name === "prepare")!;
  assert.deepEqual(def.states, [...STATES]);
  assert.deepEqual(def.data!.Failed.values, REASONS.slice(1));
  const lines: string[] = [], w = newWasm(lines);
  assert.equal(w.state, "Idle"); assert.equal(w.stageEnd(false), false); assert.equal(w.fail("layout"), false); assert.equal(w.cancel(), false);
  assert.ok(w.start()); assert.equal(w.start(), false);
  assert.equal(lines.filter(l => /^\[RED\] kit: prepare#0 refused/.test(l)).length, 4);
  for (const s of ["Index", "Profile", "Code", "Shaders", "Ready"]) { assert.ok(w.stageEnd(s === "Code")); assert.equal(w.state, s); }
  assert.deepEqual([w.count("skipped"), w.count("ran")], [1, 4]);
  assert.ok(w.start()); assert.ok(w.fail("cut")); assert.deepEqual([w.state, w.reason], ["Failed", "cut"]);
  assert.ok(w.start()); assert.equal(w.reason, ""); assert.ok(w.cancel()); assert.equal(w.state, "Cancelled");
});

// =================================================================================================== BNSH
test("the BNSH container scan (the one container format of shader_split.py ported): a synthetic container of hand-assembled Maxwell programs gives every stage with the key the shader chain computes; damaged ones are reported, not followed", () => {
  const mx = join(SCRATCH, "maxwell");
  execFileSync("python3", [join(ROOT, "tools", "shaders", "maxwell_asm.py"), mx], { stdio: "ignore" });
  const corpus = JSON.parse(readFileSync(join(mx, "corpus.json"), "utf8"));
  const load = (n: string) => ({ control: new Uint8Array(readFileSync(join(mx, n + ".ctl"))), code: new Uint8Array(readFileSync(join(mx, n + ".code"))) });
  const vs = load("vs_quad_ubo"), ps = load("ps_tex_tint"), ps2 = load("ps_ops");
  const key = (s: { control: Uint8Array; code: Uint8Array }) => createHash("sha256").update(s.control.subarray(0, 0x880)).update(s.code).digest("hex").slice(0, 16);
  const one = bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps }], [], [{ stage: 0, ...vs }, { stage: 4, ...ps2 }]]);
  const w = newWasm();
  // two containers in one file, with other bytes around them (a container inside an archive member)
  const file = new Uint8Array(333 + one.length + 77 + one.length); file.fill(0x5A); file.set(one, 333); file.set(one, 333 + one.length + 77);
  const r = w.bnsh(file);
  assert.equal(r.containers, 2); assert.equal(r.stages.length, 8);
  assert.deepEqual(r.stages.slice(0, 4).map(s => [s.container, s.variation, s.stage, s.status, s.key]), [[333, 0, "vs", "ok", key(vs)], [333, 0, "ps", "ok", key(ps)], [333, 2, "vs", "ok", key(vs)], [333, 2, "ps", "ok", key(ps2)]]);
  for (const s of r.stages) { assert.deepEqual(file.subarray(s.code[0], s.code[0] + s.code[1]), s.stage === "vs" ? vs.code : s.key === key(ps) ? ps.code : ps2.code); assert.equal(s.control[1], 0x880); }
  // the keys are the chain's own (tools/shaders/maxwell_asm.py writes them beside the programs)
  const chainKeys = JSON.stringify(corpus);
  for (const k of [key(vs), key(ps), key(ps2)]) assert.ok(chainKeys.includes(k), `key ${k} is not in corpus.json`);
  // damaged containers
  const status = (b: Uint8Array) => w.bnsh(b).stages.map(s => s.status);
  const noGrsc = one.slice(); noGrsc[0x60] = 0; assert.deepEqual(status(noGrsc), ["no grsc block"]);
  const wild = one.slice(); new DataView(wild.buffer).setBigUint64(0x80, 0xFFFFFFFFFFn, true); assert.deepEqual(status(wild), ["a pointer leads outside the file"]);
  const cutOff = one.subarray(0, one.length - 100); assert.ok(status(cutOff).includes("a pointer leads outside the file"));
  const swapped = bnsh([[{ stage: 4, ...vs, code: (() => { const c = vs.code.slice(); c[0] = 0x79; return c; })() }]]); assert.deepEqual(status(swapped), ["code area header magic does not match the stage"]);
  const badLen = bnsh([[{ stage: 0, control: vs.control, code: vs.code.subarray(0, vs.code.length - 4) }]]); assert.deepEqual(status(badLen), ["control +0x704 does not match the code area length"]);
  const badCtl = bnsh([[{ stage: 0, control: vs.control.subarray(0, 0x400), code: vs.code }]]); assert.deepEqual(status(badCtl), ["bad control section"]);
  const nvn2 = vs.control.slice(); nvn2[4] = 0xC9; assert.deepEqual(status(bnsh([[{ stage: 0, control: nvn2, code: vs.code }]])), ["NVN2 control section (not read)"]);
  for (let i = 0; i < 300; i++) { const m = one.slice(); let v = i * 2654435761 >>> 0; for (let k = 0; k < 6; k++) { v = (Math.imul(v, 1103515245) + 12345) >>> 0; m[0x60 + (v >>> 8) % (m.length - 0x60)] = v >>> 24; } w.bnsh(m); }   // no trap on 300 mutations
  assert.deepEqual(w.bnsh(new Uint8Array(7)).stages, []);
  return [`2 containers, 8 stages, keys ${key(vs)} (vs), ${key(ps)}, ${key(ps2)} (ps): the keys tools/shaders/maxwell_asm.py computes`];
});

// =================================================================================================== run
const only = process.argv[2];
let failed = 0, ran = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  ran++;
  const t0 = performance.now();
  try { const info = await t.fn(); console.log(`ok   ${t.name} (${(performance.now() - t0).toFixed(0)} ms)` + (info ?? []).map(l => "\n       " + l).join("")); }
  catch (e) { failed++; console.log(`[RED] FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
}
console.log(`\nprepare:test (node ${process.version}): ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
