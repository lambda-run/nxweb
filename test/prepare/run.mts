// npm run prepare:test [-- <filter>]. Node. Builds the prepare module, makes synthetic game folders (synth.mts:
// the runtime's test guests as code modules, an npdm made here, RomFS trees) and runs the prepare step on them:
// every layout variant and the malformed ones, resume after a kill at each stage, stage skipping by hash, profile
// selection, registered cuts applied and refused, and the whole pipeline ending in a process that runs in the
// runtime's Node harness (test/runtime/harness.mts, used as it is).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, utimesSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { ROOT, WASM, build } from "../../src/prepare/host/build.mts";
import { PrepWasm, STATES, REASONS, type Cut, type MatchRule, type MatchResult } from "../../src/prepare/host/wasm.ts";
import { settingsFor } from "../../src/glue/rt_process.ts";
import { handoffOptions } from "../../src/glue/rt_handoff.ts";
import { MemTree, EntryTree, FileListTree, isJunk } from "../../src/prepare/host/tree.ts";
import { NodeTree } from "../../src/prepare/host/tree_node.ts";
import { MemStore } from "../../src/prepare/host/store.ts";
import { NodeStore } from "../../src/prepare/host/store_node.ts";
import { memProfiles, type Profile, type ProfileSource } from "../../src/prepare/host/profiles.ts";
import { nodeProfiles } from "../../src/prepare/host/profiles_node.ts";
import { nsoImageBytes } from "../../src/glue/rt_process.ts";
import { graphicsOf } from "../../src/prepare/host/prepare.ts";
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
import { nupTests } from "./nup_tests.mts";
import { A64Scanner, scanHeadline, scanLines } from "../../src/glue/a64_scan.ts";
import { SCRATCH, guest, npdm, blob, fnv64, writeTree, version, prefixed, synthTree, lsRows, python, bnsh, unwindModules, matchImage, withImport, withSymbols, nsoOf, A64, MATCH_TEXT_END, sarc, yaz0 as yaz0Of, glslc, type Files } from "./synth.mts";
import { scanFile, yaz0 } from "../../src/prepare/host/shader_scan.ts";
import { prewarm, threadSource, PrewarmCancelled, reasonOf, type ShaderPrewarm, type PrewarmOut } from "../../src/prepare/host/shader_prewarm.ts";
import type { ShaderTranslator, ShaderStore, Translated } from "../../src/glue/rt_shaders.ts";
import { dynSymbols, hleGaps, hleHeadline, hleLines } from "../../src/glue/hle_scan.ts";
import { NOT_ANSWERED } from "../../src/hle/gen/coverage.ts";

process.chdir(ROOT);
try {
  build();
  // the runtime's modules and test guests: its own harness builds them (and refuses stale ones)
  let fresh = true; try { rth.loadEnv; (await import("../../src/runtime/host/build.mts")).checkBuilt(); } catch { fresh = false; }
  if (!fresh || process.env.PREPARE_RT_BUILD === "1") rth.build();
  if (!existsSync(join(rth.GUESTS, "fsg.nso")) || !existsSync(join(rth.GUESTS, "hello.nso")) || !existsSync(join(rth.GUESTS, "fsg_zbic.nso")) || process.env.PREPARE_RT_BUILD === "1") rth.buildModules();
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
function prepare(dir: string, o: { profiles?: ProfileSource; version?: number; at?: (p: string) => void | Promise<void>; store?: string; scanner?: { scan: A64Scanner; key: string }; shaders?: (tree: NodeTree, w: PrepWasm) => ShaderPrewarm } = {}): Run {
  const lines: string[] = [], tree = new NodeTree(dir), store = new NodeStore(o.store ?? dir + ".store"), wasm = newWasm(lines);
  return { prep: new Prepare({ wasm, tree, store, profiles: o.profiles ?? noProfiles, version: o.version, at: o.at, scanner: o.scanner, shaders: o.shaders?.(tree, wasm) }), lines, tree, store };
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
test("sha256 of the module equals node:crypto's, for sizes around the block boundaries, in one call and in pieces (over 64 KB)", () => {
  const w = newWasm();
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65_535, 65_536, 65_537, 65_591, 65_592, 100_003, 131_072, 131_135, 1_000_001]) { const b = blob(n, n + 1); assert.equal(w.sha256(b), createHash("sha256").update(b).digest("hex"), `${n} bytes`); }
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

test("ZBIC modules (NSO flag bit 7, the segment compression of system 22.0.0 on): build ID, check, unpacked bytes and what main draws with are those of the LZ4 build of the same program; opened in steps a module is unpacked and verified once, with progress, and a Cancel between two steps frees it; the whole pipeline on a folder whose main and sdk are ZBIC: the cut main is stored uncompressed, the uncut sdk is handed to the loader as the ZBIC file it is, the game runs with the cut; a damaged ZBIC main is refused in Code with the loader's reason", async () => {
  const w = newWasm(), z = guest("fsg_zbic"), l = guest("fsg"), flags = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0x0C, true);
  assert.equal(flags(z) & 0xBF, 0xBF, "fsg_zbic.nso: three ZBIC segments, three hashes"); assert.equal(flags(l), 0x3F);
  for (let i = 0; i < 3; i++) assert.equal(Buffer.from(z.subarray(new DataView(z.buffer, z.byteOffset).getUint32(0x10 + 16 * i, true)).subarray(0, 4)).toString(), "ZBIC");
  assert.equal(w.nsoBuildId(z.subarray(0, 0x100)), w.nsoBuildId(l.subarray(0, 0x100)));
  const cz = w.nsoCheck(z), cl = w.nsoCheck(l);
  assert.ok(!("error" in cz) && !("error" in cl), JSON.stringify(cz));
  assert.deepEqual({ ...cz, flags: 0 }, { ...cl, flags: 0 });
  assert.equal(nsoImageBytes(z), cz.imageSize, "the layout's image size, from the header alone");
  // unpacked (a cut list of none): the same stored module from both, and so the same imports for the graphics check
  const uz = w.cut(z, []), ul = w.cut(l, []);
  assert.ok("bytes" in uz && "bytes" in ul);
  assert.equal(flags(uz.bytes), 0x38, "the module written again is stored: no compression flag, no ZBIC flag");
  assert.equal(Buffer.compare(uz.bytes, ul.bytes), 0, "the unpacked module");
  assert.deepEqual(graphicsOf(uz.bytes), graphicsOf(ul.bytes));
  // in steps: several ticks with the work counted up, then match and cut work on the image already unpacked
  const ticks: number[] = [];
  const info = await w.open(z, (done, total) => { ticks.push(done / total); }, 1000);
  assert.deepEqual(info, cz);
  assert.ok(ticks.length > 4 && ticks.every((t, i) => t > 0 && t < 1 && (!i || t >= ticks[i - 1])), `ticks: ${ticks.length}`);
  const used0 = w.x.prep_arena_used();
  assert.deepEqual(w.nsoCheck(z), cz);
  const again = w.cut(z, []);
  assert.ok("bytes" in again && Buffer.compare(again.bytes, uz.bytes) === 0);
  assert.ok(w.x.prep_arena_used() - used0 < cz.imageSize, `a cut on the open module unpacked it again (${w.x.prep_arena_used() - used0} more bytes for an image of ${cz.imageSize})`);
  const at = imageOffsets(w, z, ascii("MountRom: ")); assert.equal(at.length, 1);
  const cuts = [{ off: at[0], orig: hexOf(ascii("MountRom")), new: hexOf(ascii("MountROM")), why: "test" }];
  const c1 = w.cut(z, cuts), c2 = w.cut(z, cuts);       // the first changes the open image: the second must not see that
  assert.ok("bytes" in c1 && "bytes" in c2 && c1.applied === 1 && Buffer.compare(c1.bytes, c2.bytes) === 0, JSON.stringify("error" in c2 ? c2 : ""));
  w.close();
  assert.equal(w.x.prep_arena_used(), 0, "close frees the module");
  // a Cancel between two steps
  class Stop extends Error {}
  let n = 0;
  await assert.rejects(w.open(z, () => { if (++n === 5) throw new Stop(); }, 1000), Stop);
  assert.equal(w.x.prep_arena_used(), 0, "nothing is kept of a module whose opening was stopped");
  assert.deepEqual(w.nsoCheck(z), cz, "and the module works as before");
  // damaged: a bit in the middle of the text stream
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength), bad = z.slice();
  bad[dv.getUint32(0x10, true) + (dv.getUint32(0x60, true) >> 1)] ^= 0x04;
  const RE = /text segment does not (decompress \(damaged ZBIC stream: [^)]+\)|match its SHA-256 in the header)/;
  const o1 = await w.open(bad, undefined, 1000), o2 = w.nsoCheck(bad);
  assert.ok("error" in o1 && RE.test(o1.error) && "error" in o2 && RE.test(o2.error), JSON.stringify([o1, o2]));
  assert.equal(w.x.prep_arena_used(), 0);
  // the pipeline
  const b = blob();
  const profiles = memProfiles([profileFor(z, APP_HEX, cuts, {}, { sdk: "00".repeat(16) })]);
  const dir = game("zbic", prefixed("base/", version({ programId: APP, blob: b, main: "fsg_zbic", extra: { "exefs/sdk": guest("two_lib_zbic") } })));
  const r = prepare(dir, { profiles });
  const res = await r.prep.run();
  assert.deepEqual([res.state, res.ran], ["Ready", [...STAGES]], res.error);
  const code = r.prep.out<CodeOut>("code"), prof = r.prep.out<ProfileOut>("profile");
  assert.deepEqual(code.modules.map(m => [m.name, m.from, m.cuts]), [["main", "store", 1], ["sdk", "folder", 0]]);
  assert.deepEqual([prof.graphics.api, r.prep.out<DetectOut>("detect").modules.map(m => m.buildId)], ["unknown", [cz.buildId, w.nsoBuildId(guest("two_lib").subarray(0, 0x100))]]);
  const h = await r.prep.handoff(), handed = await Promise.all(h.modules.map(m => m.bytes()));
  assert.deepEqual(handed.map(flags).map(f => f & 0x87), [0, 0x87], "main as the stored module the cut wrote, sdk as the ZBIC file of the folder");
  const p = await play(r);
  assert.deepEqual([p.kind, p.code, p.red], ["exit", 0, []]);
  assert.equal(p.stdout, "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\n" + fsgFirst(b, "MountROM: ") + "lib: fini_array[0]\nlib: DT_FINI\n");
  // without a profile both modules reach the loader as ZBIC files
  freshStore(dir);
  const r2 = prepare(dir); assert.equal((await r2.prep.run()).state, "Ready");
  assert.deepEqual(r2.prep.out<CodeOut>("code").modules.map(m => [m.name, m.from]), [["main", "folder"], ["sdk", "folder"]]);
  const p2 = await play(r2);
  assert.deepEqual([p2.kind, p2.code, p2.red], ["exit", 0, []]);
  // a damaged main stops the Code stage
  const dir3 = game("zbic-damaged", prefixed("base/", { ...version({ programId: APP, blob: b }), "exefs/main": bad }));
  const r3 = prepare(dir3), res3 = await r3.prep.run();
  assert.deepEqual([res3.state, res3.reason], ["Failed", "module"]);
  assert.match(res3.error, /^base\/exefs\/main: text segment does not (decompress \(damaged ZBIC stream: [^)]+\)|match its SHA-256 in the header)/);
  r.tree.close(); r2.tree.close(); r3.tree.close();
  return [`fsg_zbic.nso: ${z.length} bytes (LZ4: ${l.length}) for an image of ${cz.imageSize}; ${rth.haveZbic() ? "compressed by the reference codec (the zbic package)" : "the zbic package is not installed: compressed by elf2nso.py itself (--zbic-own)"}`,
    `opened in ${ticks.length + 1} steps of 1000 bytes; the damaged file: ${"error" in o1 ? o1.error.replace(/^\[RED\] (loader|prepare): /, "") : ""}`];
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
  // its 3.25 GB heap region is no "will not work" any more: the verdict is the runtime's layout rule, for which the heap never passes pool - mem_used (3.10 GB here) and so fits
  assert.deepEqual([p.needs.filter(n => n.key === "address_space").length, p.layout, p.space], [0, { fit: "profile", note: "" }, { heap_region: 3.25 * 2 ** 30, alias_region: 0.25 * 2 ** 30, stack_region: 0.25 * 2 ** 30 }]);
  const hd = await r.prep.handoff(), ho = handoffOptions(hd);
  assert.deepEqual([hd.profile.layout?.fit, ho.layout.fit, ho.layout.heapSize, ho.layout.aliasSize, ho.layout.stackSize], ["profile", "profile", 0xCD500000 - 0x6e00000 + 0x100000, 0.25 * 2 ** 30, 0.25 * 2 ** 30], "the process is laid out by the same rule, from the regions in the hand-off");
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
  // function-matched rules: well formed, and counted
  let rules = 0, wide = 0;
  for (const f of [...Object.keys(idx.games), "_sdk"]) {
    const p = JSON.parse(readFileSync(join(dir, f + ".json"), "utf8"));
    for (const rs of Object.values(p.match_cuts ?? {}) as MatchRule[][]) for (const r of rs) {
      f === "_sdk" ? wide++ : rules++;
      assert.ok(r.name && r.functions.length >= 1, f);
      for (const fn of r.functions) {
        assert.ok(fn.size > 0 && fn.size % 4 === 0 && fn.fingerprints.length && fn.fingerprints.every(d => /^[0-9a-f]{64}$/.test(d)) && fn.cuts.length, `${f} ${r.name}`);
        for (const c of fn.cuts) assert.ok(c.off % 4 === 0 && c.orig.length === c.new.length && c.orig.length % 8 === 0 && c.off + c.orig.length / 2 <= fn.size, `${f} ${r.name}`);
      }
    }
  }
  assert.deepEqual([rules, wide], [rep.conversion.converted_match_rules, rep.conversion.converted_wide_match_rules]);
  assert.deepEqual([rep.conversion.match_rules, rep.conversion.wide_match_rules], [rules, wide], "every function-matched rule converted");
  assert.deepEqual(rep.conversion.patch_files_skipped, [], "no patch file of the pinned nxnative needs more than the sandbox has");
  assert.equal(rep.conversion.unconverted.MATCH_CUTS, undefined);
  // the address space: every profile's verdict in the files is what the runtime's rule says now (the same function a process is laid out with)
  const fit = { profile: [] as string[], pool: [] as string[], short: [] as string[] };
  for (const id of Object.keys(idx.games)) {
    const p = JSON.parse(readFileSync(join(dir, id + ".json"), "utf8")) as Profile, sp = p.address_space!;
    const l = settingsFor(p.apply, { space: sp, mem64: false }).layout;
    assert.deepEqual([sp.fit, sp.note, sp.fits, sp.layout], [l.fit, l.note, l.fit !== "short", { heap: l.heapSize, alias: l.aliasSize, stack: l.stackSize, pool: l.appPool }], id);
    assert.equal(p.needs.some(n => n.key === "address_space"), l.fit === "short", `${id}: address_space is a need exactly when the layout is short`);
    fit[l.fit].push(id);
  }
  const sp = rep.address_space;
  assert.deepEqual([sp.profile, sp.pool.map((e: { id: string }) => e.id), sp.short.map((e: { id: string }) => e.id)], [fit.profile, fit.pool, fit.short], "the report names the profiles of each verdict");
  assert.ok(sp.short.every((e: { why: string }) => /the profile reserves heap .* this process has heap/.test(e.why)), "and says why");
  assert.deepEqual([sp.counts, rep.classes.address_space.profiles, sp.rule], [{ profile: fit.profile.length, pool: fit.pool.length, short: fit.short.length, unknown: 0 }, fit.short.length, "src/glue/rt_process.ts layoutFor"]);
  // what is not converted is named with its profiles
  const fs = rep.conversion.unconverted.FRAME_STEP, mfs = rep.conversion.unconverted.MATCH_FRAME_STEP;
  assert.ok(fs.profiles.length === fs.entries && fs.profiles.every((x: string) => /^[0-9A-F]{16}$/.test(x)) && mfs.profiles.every((x: string) => /^[0-9A-F]{16}$/.test(x)));
  const nx = process.env.NXNATIVE ?? "/home/user/nxnative";
  let check = "SKIPPED: no nxnative checkout (NXNATIVE): the files were not compared with a fresh conversion";
  if (existsSync(join(nx, "dm", "games"))) check = execFileSync("python3", [join(ROOT, "tools", "prepare", "convert_profiles.py"), "--check", "--nxnative", nx], { encoding: "utf8" }).trim().split("\n")[0];
  return [`${rep.profiles} profiles; (profile, key) pairs a ${rep.pairs_per_class.a}, b ${rep.pairs_per_class.b}, c ${rep.pairs_per_class.c}; ${cuts} cuts in ${builds} builds; function-matched rules: ${rules} in ${rep.conversion.match_profiles.length} profiles, ${wide} for every game`,
    `address space by the runtime's rule: ${fit.profile.length} fit as reserved, ${fit.pool.length} fit what their pool lets them commit, ${fit.short.length} do not (${fit.short.join(", ")})`,
    `not converted: FRAME_STEP in ${fs.profiles.join(", ")}; MATCH_FRAME_STEP in ${mfs.profiles.join(", ")}`, check];
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

// =================================================================================================== Shaders stage
// The programs tools/shaders/maxwell_asm.py assembles (the BNSH test's), and the key the shader chain computes
function maxwell() {
  const mx = join(SCRATCH, "maxwell");
  if (!existsSync(join(mx, "corpus.json"))) execFileSync("python3", [join(ROOT, "tools", "shaders", "maxwell_asm.py"), mx], { stdio: "ignore" });
  const load = (n: string) => ({ control: new Uint8Array(readFileSync(join(mx, n + ".ctl"))), code: new Uint8Array(readFileSync(join(mx, n + ".code"))) });
  return { vs: load("vs_quad_ubo"), ps: load("ps_tex_tint"), ps2: load("ps_ops"), corpus: readFileSync(join(mx, "corpus.json"), "utf8") };
}
const chainKey = (s: { control: Uint8Array; code: Uint8Array }) => createHash("sha256").update(s.control.subarray(0, 0x880)).update(s.code).digest("hex").slice(0, 16);
// A stand-in for the in-page translator (src/glue/rt_shaders.ts workerTranslator): the keys in `bad` fail with a
// message the way xlate_wasm's do; a compute stage translates (the runtime then refuses it)
function fakeTranslator(bad: Map<string, string> = new Map(), o: { hang?: boolean; seen?: string[] } = {}): ShaderTranslator {
  return { chain: SHADER_CHAIN, translate: async b => {
    o.seen?.push(b.key);
    if (o.hang) return new Promise<Translated>(() => {});
    if (bad.has(b.key)) throw new Error(bad.get(b.key)!.replace("<key>", b.key));
    const stage = (new DataView(b.code.buffer, b.code.byteOffset).getUint32(0, true) === 0x12345679) ? "compute" : "graphics";
    return { wgsl: `// ${b.key}`, reflection: { stage, extra: [] } };
  }, close() {} };
}
const memStore = (): ShaderStore & { m: Map<string, Translated> } => { const m = new Map<string, Translated>(); return { m, async get(id) { return m.get(id) ?? null; }, async put(id, t) { m.set(id, t); } }; };

test("the Shaders stage's scan (shader_scan.ts, after shader_split.py): BNSH loose, in SARC, in Yaz0, in zstd, in zstd in SARC in Yaz0, GLSLC outputs of one and of two stages; the chain's keys; damaged wrappers reported; unread kinds named", () => {
  const { vs, ps, ps2, corpus } = maxwell(), w = newWasm();
  const one = bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps }]]), two = bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps2 }]]);
  const keys = (b: Uint8Array, module = false) => scanFile(w, "f", b, { module }).stages.map(s => `${s.stage}:${s.key}`);
  const kv = `vs:${chainKey(vs)}`, kp = `ps:${chainKey(ps)}`, kp2 = `ps:${chainKey(ps2)}`;
  for (const k of [chainKey(vs), chainKey(ps), chainKey(ps2)]) assert.ok(corpus.includes(k), `key ${k} is not the chain's`);
  // the test's own Yaz0 writer against the reader: literals and back-references
  const plain = new Uint8Array(5000); for (let i = 0; i < plain.length; i++) plain[i] = i % 97 < 40 ? 7 : i * 31;
  assert.deepEqual(yaz0(yaz0Of(plain)), plain);
  assert.deepEqual(keys(one), [kv, kp]);
  assert.deepEqual(keys(sarc({ "a/one.bnsh": one, "b/two.bnsh": two, "c.txt": ascii("nothing") })), [kv, kp, kp2]);
  assert.deepEqual(keys(yaz0Of(one)), [kv, kp]);
  assert.deepEqual(keys(new Uint8Array(zstdCompressSync(one))), [kv, kp]);
  const nested = yaz0Of(sarc({ "x.zs": new Uint8Array(zstdCompressSync(sarc({ "deep/two.bnsh": two }))), "one.bnsh": one }));
  const r = scanFile(w, "Shader/all.szs", nested);
  assert.deepEqual(r.stages.map(s => `${s.stage}:${s.key}`), [kp2.replace("ps", "vs").replace(chainKey(ps2), chainKey(vs)), kp2, kp]);   // vs once: the same key from two places is one stage
  assert.deepEqual(r.containers, { bnsh: 2, glslc: 0, sarc: 2, yaz0: 1, zstd: 1 });
  assert.ok(r.stages[0].where.startsWith("Shader/all.szs/x.zs/deep/two.bnsh#BNSH@0x0#var0"), r.stages[0].where);
  assert.deepEqual(r.stages[1].code, ps2.code);
  // GLSLC: one stage per output (in main's data), two compiled together (by the section headers)
  const g = new Uint8Array(0x300 + 2 * 0x1000); g.fill(0x33); g.set(glslc([vs]), 0x300); g.set(glslc([ps2]), 0x300 + 0x1000);
  assert.deepEqual(keys(g), [kv, kp2]);
  assert.deepEqual(keys(glslc([vs, ps])), [kv, kp]);
  assert.deepEqual(keys(glslc([ps, ps2])), [], "two pixel stages in one program are not one program");
  assert.deepEqual(scanFile(w, "f", g).containers.glslc, 2);
  // a code module: its segments are unpacked and searched; the test guest holds no shaders
  const m = scanFile(w, "exefs/main", guest("fsg"), { module: true });
  assert.deepEqual([m.stages.length, m.unreadable], [0, []]);
  const notNso = scanFile(w, "exefs/main", new Uint8Array(64), { module: true });
  assert.deepEqual(notNso.unreadable.map(u => u.reason), ["the module cannot be unpacked"]);
  // damaged wrappers: reported, the rest of the file still read
  const badSarc = sarc({ "one.bnsh": one }); new DataView(badSarc.buffer).setUint32(0x14 + 12 + 12, 0xFFFFFF, true);
  const reasons = (b: Uint8Array) => scanFile(w, "f", b).unreadable.map(u => u.reason);
  assert.match(reasons(badSarc)[0], /SARC member 0 at …\.\.… of the data lies outside its … bytes/);
  assert.match(reasons(yaz0Of(one).subarray(0, 200))[0], /the Yaz0 stream ends/);
  const zs = new Uint8Array(zstdCompressSync(one)); assert.equal(reasons(zs.subarray(0, zs.length >> 1)).length, 1);
  const bad = sarc({ "ok.bnsh": one, "broken.szs": yaz0Of(two).subarray(0, 100) });
  assert.deepEqual([keys(bad), reasons(bad).length], [[kv, kp], 1]);
  const nvn2 = vs.control.slice(); nvn2[4] = 0xC9;
  assert.deepEqual(reasons(sarc({ "n.bnsh": bnsh([[{ stage: 0, control: nvn2, code: vs.code }]]) })), ["BNSH: NVN2 control section (not read)"]);
  // a SARC whose members overlap a thousand times does not expand without bound
  const bomb = sarc({ a: one }), bd = new DataView(bomb.buffer); bd.setUint16(0x14 + 6, 1000, true);
  assert.ok(scanFile(w, "f", bomb).unreadable.length >= 1);
  // the kinds shader_split.py reads and this scan does not: named, and nothing found in them
  const nr = (b: Uint8Array) => scanFile(w, "f", b).notRead;
  assert.deepEqual(nr(new Uint8Array([...ascii("BAHS"), ...new Uint8Array(60)])), ["BAHS (agl / gsys shader archives)"]);
  assert.deepEqual(nr(new Uint8Array([...ascii("UnityFS\0"), ...new Uint8Array(60)])), ["Unity bundles"]);
  assert.deepEqual(nr(new Uint8Array([0x1F, 0x8B, 0x08, 0, 0, 0])), ["gzip"]);
  assert.deepEqual(nr(blob(4096, 3)), []);
  for (let i = 0; i < 200; i++) { const x = nested.slice(); let v = i * 2654435761 >>> 0; for (let k = 0; k < 4; k++) { v = (Math.imul(v, 1103515245) + 12345) >>> 0; x[16 + (v >>> 8) % (x.length - 16)] = v >>> 24; } scanFile(w, "f", x); }   // no throw on 200 mutations
  return [`BNSH loose/SARC/Yaz0/zstd/nested and GLSLC (one and two stages) give the chain's keys ${chainKey(vs)}, ${chainKey(ps)}, ${chainKey(ps2)}`];
});

test("the Shaders stage's translation ahead (shader_prewarm.ts): each key once to the translator, into the store under <key>/<chain>; failures grouped by the translator's reason; a second run is all store hits; Cancel ends it at once", async () => {
  const { vs, ps, ps2 } = maxwell(), w = newWasm();
  const cs = { control: vs.control.slice(), code: vs.code.slice() }; new DataView(cs.code.buffer).setUint32(0, 0x12345679, true);
  new DataView(cs.control.buffer).setUint32(0x704, cs.code.length, true);
  const files: Record<string, Uint8Array> = {
    "romfs/a.bnsh": bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps }]]),
    "romfs/b.szs": yaz0Of(sarc({ "b.bnsh": bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps2 }]]) })),
    "romfs/c.bnsh": bnsh([[{ stage: 5, ...cs }]]),
    "romfs/d.bars": new Uint8Array([...ascii("BAHS"), ...new Uint8Array(60)]),
  };
  const list = Object.entries(files).map(([path, d]) => ({ path, size: d.length, module: false }));
  const read = async (p: string) => files[p];
  const bad = new Map([[chainKey(ps2), "xlate_wasm: unsupported instruction TXQ.B in <key> (exit 3)"]]);
  const store = memStore(), seen: string[] = [], progress: number[] = [];
  const pw: ShaderPrewarm = { key: "t", source: threadSource(w, read), translators: () => [fakeTranslator(bad, { seen }), fakeTranslator(bad, { seen })], store };
  const out = await prewarm(pw, list, { cancelled: () => false, progress: p => progress.push(p.filesDone) });
  assert.deepEqual(seen.sort(), [chainKey(vs), chainKey(ps), chainKey(ps2), chainKey(cs)].sort());
  assert.deepEqual([out.found, out.translated, out.cached, out.failed, out.untranslated, out.files], [4, 3, 0, 2, 0, 4]);
  assert.deepEqual(out.byStage, { vs: 1, ps: 2, cs: 1 });
  assert.deepEqual(out.failures.map(f => [f.reason, f.count]).sort(), [["a compute stage, which src/gfx does not run", 1], ["xlate_wasm: unsupported instruction TXQ.B in <key>", 1]]);
  assert.deepEqual(out.notRead, [{ reason: "BAHS (agl / gsys shader archives)", count: 1, examples: ["romfs/d.bars"] }]);
  assert.deepEqual([...store.m.keys()].sort(), [chainKey(vs), chainKey(ps), chainKey(cs)].map(k => `${k}/${SHADER_CHAIN}`).sort());
  assert.equal(SHADER_CHAIN, RT_SHADER_CHAIN);
  assert.equal(progress.at(-1), 4);
  // again: what is stored is not translated twice
  seen.length = 0;
  const again = await prewarm(pw, list, { cancelled: () => false, progress: () => {} });
  assert.deepEqual([again.translated, again.cached, again.failed, seen], [0, 3, 2, [chainKey(ps2)]]);
  // no translator in this build: found and counted, nothing stored
  const scanOnly = await prewarm({ ...pw, translators: null, store: memStore() }, list, { cancelled: () => false, progress: () => {} });
  assert.deepEqual([scanOnly.chain, scanOnly.found, scanOnly.untranslated, scanOnly.translated], [null, 4, 4, 0]);
  // Cancel while the translator is busy
  let stop = false; const t0 = performance.now();
  const p = prewarm({ ...pw, store: memStore(), translators: () => [fakeTranslator(bad, { hang: true })] }, list, { cancelled: () => stop, progress: () => {} });
  setTimeout(() => { stop = true; }, 30);
  await assert.rejects(p, PrewarmCancelled);
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(reasonOf("failed at /w/in/0123456789abcdef.ctl for 0123456789abcdef (exit -1)"), "failed at <file> for <key>");
  return [`4 stages found (vs, 2 ps, cs), 3 translated and stored, 2 failed by reason; again: 3 store hits; scan only; Cancel in ${(performance.now() - t0).toFixed(0)} ms`];
});

test("the Shaders stage in the prepare: main and the RomFS scanned, counts in the hand-off, the stage kept by its hash, redone when a file changes; a kill in it resumes", async () => {
  const { vs, ps } = maxwell();
  const files = version({ programId: APP, rom: { "Shader/gfx.szs": yaz0Of(sarc({ "gfx.bnsh": bnsh([[{ stage: 0, ...vs }, { stage: 4, ...ps }]]) })), "data/blob.bin": blob(), "x.bars": new Uint8Array([...ascii("BAHS"), ...new Uint8Array(60)]) } });
  const dir = game("shaders-prewarm", files), store = memStore(), seen: string[] = [];
  const shaders = (tree: NodeTree, w: PrepWasm): ShaderPrewarm => ({ key: "node", source: threadSource(w, (p, n) => tree.read(p, 0, n)), translators: () => [fakeTranslator(new Map(), { seen })], store });
  const dead = prepare(dir, { shaders, at: p => { if (p === "shaders:work") throw new Kill(); } });
  await assert.rejects(dead.prep.run(), Kill); dead.tree.close();
  const a = prepare(dir, { shaders });
  const res = await a.prep.run();
  assert.deepEqual([res.state, res.ran], ["Ready", ["shaders"]]);
  const h = await a.prep.handoff(), p = h.shaders.prewarm as PrewarmOut;
  assert.deepEqual([h.shaders.mode, h.shaders.chain, p.files, p.found, p.translated, p.failed, p.notRead.map(n => n.reason)], ["on-demand", SHADER_CHAIN, 4, 2, 2, 0, ["BAHS (agl / gsys shader archives)"]]);
  assert.deepEqual([a.prep.w.count("shFound"), a.prep.w.count("shTranslated"), a.prep.w.count("shFailed")], [2, 2, 0]);
  assert.equal(store.m.size, 2);
  a.tree.close();
  const b = prepare(dir, { shaders });
  assert.deepEqual((await b.prep.run()).skipped, [...STAGES]); b.tree.close();
  writeFileSync(join(dir, "romfs", "data", "more.bnsh"), bnsh([[{ stage: 0, ...vs }]]));
  seen.length = 0;
  const c = prepare(dir, { shaders });
  const rc = await c.prep.run();
  assert.ok(rc.ran.includes("shaders"));
  assert.deepEqual([(c.prep.out("shaders") as any).prewarm.cached, seen], [2, []]);
  c.tree.close();
  // without a prewarm the stage is what it was
  const d = prepare(game("shaders-none", files));
  await d.prep.run(); assert.deepEqual((await d.prep.handoff()).shaders, { mode: "on-demand", chain: SHADER_CHAIN, store: "nxweb-shaders", prewarm: null }); d.tree.close();
  return [`a kill at shaders:work resumed; 2 stages translated and stored, kept by hash, a new file redoes the stage with 2 store hits`];
});

// =================================================================================================== function-matched cuts
const NX = process.env.NXNATIVE ?? "/home/user/nxnative";
const capstone = (): string | null => { try { return execFileSync("python3", ["-c", "import capstone; print(capstone.__version__)"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
// A module file as the image the loader maps (file-backed part) and where its text ends
function unpack(w: PrepWasm, nso: Uint8Array): { image: Uint8Array; textEnd: number } {
  const r = w.cut(nso, []); assert.ok("bytes" in r, JSON.stringify(r));
  const b = r.bytes, dv = new DataView(b.buffer);
  const seg = [0, 1, 2].map(s => ({ fo: dv.getUint32(0x10 + 16 * s, true), mo: dv.getUint32(0x14 + 16 * s, true), sz: dv.getUint32(0x18 + 16 * s, true) }));
  const image = new Uint8Array(Math.max(...seg.map(s => s.mo + s.sz)));
  for (const s of seg) image.set(b.subarray(s.fo, s.fo + s.sz), s.mo);
  return { image, textEnd: seg[0].mo + seg[0].sz };
}
const wordHex = (w: number) => hexOf(Uint8Array.of(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24));
// A rule for the function at `start` of an image, with cuts at offsets from the image's start (what nxnative's
// `nso_match.py <nso> <offset> <old> <new> <name>` prints for a reviewed cut)
function ruleFor(w: PrepWasm, image: Uint8Array, name: string, cuts: [off: number, orig: string, neu: string][], textEnd = MATCH_TEXT_END): MatchRule {
  const fns = w.fingerprints(image, textEnd).functions, byFn = new Map<number, MatchRule["functions"][number]>();
  for (const [off, orig, neu] of cuts) {
    const f = fns.find(f => f.start <= off && off < f.end); assert.ok(f && f.fingerprint, `a function with a fingerprint at 0x${off.toString(16)}`);
    if (!byFn.has(f.start)) byFn.set(f.start, { size: f.end - f.start, fingerprints: [f.fingerprint], cuts: [] });
    byFn.get(f.start)!.cuts.push({ off: off - f.start, orig, new: neu, why: name });
  }
  return { name, functions: [...byFn.values()] };
}
const matched = (r: ReturnType<PrepWasm["match"]>): MatchResult => { assert.ok(!("error" in r), JSON.stringify(r)); return r as MatchResult; };
// a function that takes an address, calls `target` and returns: 7 words
const caller = (start: number, target: number, data = 0x2200) => [A64.adrp(8, start, data), A64.addi(8, 8, data & 0xFFF), A64.movX0X23, A64.bl(start + 12, target), A64.beq(8), A64.NOP, A64.RET];
const CUT: [string, string] = [wordHex(A64.movX0X23), wordHex(A64.addX0X23)];

test("function-matched cuts on hand-made images: a function is found again after it, its callee and its data moved; changed code, a changed or redirected callee, another import or system call, an ambiguous or damaged match are refused; a patch of several functions applies whole or not at all; of a patch's implementations exactly one must match", () => {
  const w = newWasm(), T = MATCH_TEXT_END, info: string[] = [];
  const leaf = [A64.movz(0, 1), A64.RET];
  const original = matchImage({ 0x100: caller(0x100, 0x500), 0x500: leaf });
  const rule = ruleFor(w, original, "heap", [[0x108, ...CUT]]);
  assert.deepEqual([rule.functions.length, rule.functions[0].size, rule.functions[0].cuts[0].off], [1, 28, 8]);
  const one = (image: Uint8Array, rules: MatchRule[] = [rule]) => { const r = matched(w.match(image, [rules], T)); return { cuts: r.cuts.map(c => [c.off, c.orig, c.new]), why: r.outcomes.map(o => o.why), ok: r.outcomes.map(o => o.matched), r }; };
  // (1) relocation: the function, its callee and the page it addresses all moved
  const moved = matchImage({ 0x800: caller(0x800, 0x1200, 0x2980), 0x1200: leaf }), before = moved.slice();
  const m1 = one(moved);
  assert.deepEqual([m1.cuts, m1.ok, m1.why], [[[0x808, ...CUT]], [true], ["implementation 1 of 1"]]);
  assert.equal(m1.r.cuts[0].why, "heap [function match]");
  assert.deepEqual(moved, before, "matching writes nothing");
  assert.equal(one(original).cuts[0][0], 0x108);
  // (2) the same instructions with one changed: in the function (a register, a branch inside it), in the callee
  for (const [off, word] of [[0x108, 0xAA1603E0], [0x110, A64.beq(4)], [0x500, A64.movz(0, 2)]] as const) {
    const changed = original.slice(); new DataView(changed.buffer).setUint32(off, word, true);
    assert.deepEqual([one(changed).cuts, one(changed).why], [[], ["0 matching functions (need exactly one)"]], `changed at 0x${off.toString(16)}`);
  }
  // (3) the call goes to another function
  assert.deepEqual(one(matchImage({ 0x100: caller(0x100, 0x600), 0x500: leaf, 0x600: [A64.movz(0, 2), A64.RET] })).ok, [false]);
  // (4) a callee that is no function, no import and no system call wrapper: the caller has no fingerprint at all
  assert.equal(w.fingerprints(matchImage({ 0x100: caller(0x100, 0x500) }), T).functions[0].fingerprint, null);
  assert.deepEqual(one(matchImage({ 0x100: caller(0x100, 0x500) })).why, ["0 matching functions (need exactly one)"]);
  // (5) an imported function is its name: the PLT stub and the GOT slot may move, the name may not change
  const imp = (name: string, plt?: number, slot?: number) => withImport(matchImage({ 0x100: caller(0x100, plt ?? 0x1800) }), name, plt, slot);
  const impRule = ruleFor(w, imp("allocate"), "heap", [[0x108, ...CUT]]);
  assert.deepEqual(one(imp("allocate", 0x1900, 0x2800), [impRule]).cuts, [[0x108, ...CUT]]);
  assert.deepEqual(one(imp("free"), [impRule]).ok, [false]);
  assert.notEqual(impRule.functions[0].fingerprints[0], rule.functions[0].fingerprints[0]);
  assert.equal(w.fingerprints(imp("a\"b"), T).functions[0].fingerprint, null, "a name that JSON would escape is not taken");
  // (6) `svc #n; ret` without an unwind entry is the system call n
  const sys = (n: number, at = 0x500, more: number[] = []) => matchImage({ 0x100: caller(0x100, at) }, { [at]: [A64.svc(n), A64.RET, ...more] });
  const sysRule = ruleFor(w, sys(0x2C), "heap", [[0x108, ...CUT]]);
  assert.deepEqual(one(sys(0x2C, 0x700), [sysRule]).cuts, [[0x108, ...CUT]]);
  assert.deepEqual(one(sys(0x2D), [sysRule]).ok, [false]);
  { const longer = sys(0x2C); new DataView(longer.buffer).setUint32(0x504, A64.NOP, true); assert.equal(w.fingerprints(longer, T).functions[0].fingerprint, null, "svc; nop is not a wrapper"); }
  // (7) the low part of an ADRP address is masked only while the register still holds it: after `mov w8, w0` (or a
  // write to x29) the offset of the load is a member offset, and another offset is another function
  for (const [reg, move] of [[8, 0x2A0003E8], [29, 0xAA0003FD]] as const) {
    const words = [A64.adrp(reg, 0x100, 0x2000), move, A64.ldr(0, reg, 8), A64.movX0X23, A64.RET];
    const r7 = ruleFor(w, matchImage({ 0x100: words }), "heap", [[0x10C, ...CUT]]);
    const other = words.slice(); other[2] = A64.ldr(0, reg, 9);
    assert.deepEqual(one(matchImage({ 0x100: other }), [r7]).ok, [false], `x${reg} overwritten: the offset counts`);
    const direct = [A64.adrp(reg, 0x100, 0x2000), A64.NOP, A64.ldr(0, reg, 8), A64.movX0X23, A64.RET], direct2 = direct.slice(); direct2[2] = A64.ldr(0, reg, 9);
    assert.deepEqual(one(matchImage({ 0x100: direct2 }), [ruleFor(w, matchImage({ 0x100: direct }), "heap", [[0x10C, ...CUT]])]).ok, [true], `x${reg} still the address: the offset is its low part`);
  }
  // (8) an ADR inside the function is exact
  { const r8 = ruleFor(w, matchImage({ 0x100: [A64.movX0X23, 0x10000040, A64.NOP, A64.RET] }), "heap", [[0x100, ...CUT]]);
    assert.deepEqual(one(matchImage({ 0x100: [A64.movX0X23, 0x10000020, A64.NOP, A64.RET] }), [r8]).ok, [false]); }
  // (9) two functions that match: ambiguous
  assert.deepEqual(one(matchImage({ 0x100: caller(0x100, 0x500), 0x800: caller(0x800, 0x500), 0x500: leaf })).why, ["2 matching functions (need exactly one)"]);
  // (10) the original bytes are still asserted
  { const r10: MatchRule = { name: "heap", functions: [{ ...rule.functions[0], cuts: [{ off: 8, orig: "00000000", new: CUT[1], why: "heap" }] }] };
    assert.deepEqual(one(original, [r10]).why, ["original bytes differ at 0x108"]); }
  // (11) a patch of several functions: whole or not at all, and the miss is named
  const second = [A64.movX0X23, A64.movz(1, 7), A64.RET], third = [A64.movz(2, 9), A64.movX0X23, A64.RET];
  const both = matchImage({ 0x100: caller(0x100, 0x500), 0x500: leaf, 0x900: second });
  const multi = ruleFor(w, both, "two places", [[0x108, ...CUT], [0x900, ...CUT]]);
  assert.equal(multi.functions.length, 2);
  assert.deepEqual(one(matchImage({ 0x300: caller(0x300, 0x700), 0x700: leaf, 0xA00: second }), [multi]).cuts, [[0x308, ...CUT], [0xA00, ...CUT]]);
  const half = one(matchImage({ 0x300: caller(0x300, 0x700), 0x700: leaf, 0xA00: [A64.movX0X23, A64.movz(1, 8), A64.RET] }), [multi]);
  assert.deepEqual([half.cuts, half.why], [[], ["function 2 of 2 (12 bytes): 0 matching functions (need exactly one); the other 1 matched"]]);
  // (12) implementations of one patch: exactly one must match
  const v2 = ruleFor(w, matchImage({ 0x100: third }), "heap", [[0x104, ...CUT]]);
  const i2 = one(matchImage({ 0x400: third }), [rule, v2]);
  assert.deepEqual([i2.cuts, i2.why], [[[0x404, ...CUT]], ["implementation 2 of 2"]]);
  assert.deepEqual(one(matchImage({ 0x100: caller(0x100, 0x500), 0x500: leaf, 0x400: third }), [rule, v2]).why, ["2 implementations match (need exactly one)"]);
  assert.deepEqual(one(matchImage({ 0x400: second }), [rule, v2]).why, ["0 matching functions (need exactly one)"]);
  // (13) two lists are resolved apart (the game's patches, the patches for every game), each with its outcome
  const two = matched(w.match(matchImage({ 0x100: caller(0x100, 0x500), 0x500: leaf, 0x400: third }), [[rule], [{ ...v2, name: "wide" }, { ...multi, name: "absent" }]], T));
  assert.deepEqual(two.outcomes.map(o => [o.set, o.name, o.matched, o.offsets]), [[0, "heap", true, [0x108]], [1, "wide", true, [0x404]], [1, "absent", false, []]]);
  assert.deepEqual(two.cuts.map(c => [c.set, c.off]), [[0, 0x108], [1, 0x404]]);
  // (14) patches of one list that overlap stop everything (nxnative raises)
  const over = w.match(original, [[rule, { ...rule, name: "again" }]], T);
  assert.ok("error" in over && over.code === -6 && /function patches overlap at 0x108/.test(over.error), JSON.stringify(over));
  assert.ok(!("error" in w.match(original, [[rule], [{ ...rule, name: "again" }]], T)), "in two lists each is found; applying them is where the second one's original bytes fail");
  // (15) images without a usable function table: no rule matches, and why
  const noMod = original.slice(); noMod[0x20] = 0;
  assert.deepEqual(one(noMod).why, ["no MOD0"]);
  const badEnc = original.slice(); badEnc[0x3003] = 0x37;                      // a table encoding that does not exist
  assert.deepEqual(one(badEnc).why, ["cannot read function boundaries"]);
  const conflict = matchImage({ 0x100: caller(0x100, 0x500), 0x500: leaf, 0x600: leaf }); { const dv = new DataView(conflict.buffer); dv.setInt32(0x300C + 16, 0x500 - 0x3000, true); dv.setInt32(0x3240 + 48 + 8, 0x500 - (0x3240 + 48 + 8), true); dv.setUint32(0x3240 + 48 + 12, 12, true); }
  assert.deepEqual(one(conflict).why, ["conflicting function boundaries at 0x500"]);
  const noTable = original.slice(); noTable[0x3000] = 2;                       // not version 1: an empty table, as nxnative reads it
  assert.deepEqual(one(noTable).why, ["0 matching functions (need exactly one)"]);
  // (16) no trap on damaged images: 400 mutations of the unwind data and the dynamic table
  const base = imp("allocate");
  for (let i = 0; i < 400; i++) {
    const m = base.slice(); let v = (i + 1) * 2654435761 >>> 0;
    for (let k = 0; k < 4; k++) { v = (Math.imul(v, 1103515245) + 12345) >>> 0; const area = [[0x20, 0x20], [0x2100, 0x420], [0x3000, 0x300]][v % 3]; m[area[0] + (v >>> 8) % area[1]] = v >>> 24; }
    const r = w.match(m, [[impRule, rule]], T); assert.ok("error" in r || r.outcomes.length === 1);
    w.fingerprints(m, T);
  }
  // (17) a malformed rule list is refused, not read past its end
  assert.ok("error" in w.match(original, [[{ name: "x", functions: [{ size: 6, fingerprints: [rule.functions[0].fingerprints[0]], cuts: rule.functions[0].cuts }] }]], T));
  assert.ok("error" in w.match(original, [[{ name: "x", functions: [{ size: 28, fingerprints: ["zz"], cuts: rule.functions[0].cuts }] }]], T));
  assert.ok("error" in w.match(original, [[{ name: "x", functions: [{ size: 28, fingerprints: rule.functions[0].fingerprints, cuts: [{ off: 28, orig: CUT[0], new: CUT[1] }] }] }]], T), "a cut past its function");
  info.push("17 groups of cases; a relocated function: cut at 0x108 found at 0x808; the fingerprint of the calling function " + rule.functions[0].fingerprints[0].slice(0, 16) + "…");
  return info;
});

test("function fingerprints are nxnative's: every function of the test sources, compiled with unwind tables, has the fingerprint dm/tools/nso_match.py gives it (which uses Capstone); the measured register-write table never answers \"not written\" where Capstone lists a write", () => {
  const w = newWasm(), info: string[] = [];
  const mods = unwindModules();
  assert.ok(mods.length >= 40, `modules with unwind tables: ${mods.length}`);
  const dir = join(SCRATCH, "unwind", "img"); mkdirSync(dir, { recursive: true });
  const mine: { name: string; file: string; fns: ReturnType<PrepWasm["fingerprints"]>["functions"] }[] = [];
  let total = 0, withFp = 0, imports = 0;
  for (const m of mods) {
    const { image, textEnd } = unpack(w, new Uint8Array(readFileSync(m.path))), file = join(dir, m.name + ".bin");
    writeFileSync(file, image); writeFileSync(file + ".end", String(textEnd));
    const f = w.fingerprints(image, textEnd);
    assert.equal(f.error, 0, m.name);
    mine.push({ name: m.name, file, fns: f.functions }); total += f.functions.length; withFp += f.functions.filter(x => x.fingerprint).length;
  }
  assert.ok(total >= 800 && withFp >= 700, `${total} functions, ${withFp} with a fingerprint`);
  // and hand-made images: an import through a PLT, a system call wrapper, an address register overwritten, an inner ADR, a trap word
  const leaf = [A64.movz(0, 1), A64.RET];
  const hand: Record<string, Uint8Array> = {
    call: matchImage({ 0x100: caller(0x100, 0x500), 0x500: leaf, 0x800: caller(0x800, 0x500, 0x2980) }),
    import: withImport(matchImage({ 0x100: caller(0x100, 0x1800), 0x400: caller(0x400, 0x1900) }), "allocate"),
    svc: matchImage({ 0x100: caller(0x100, 0x500), 0x200: caller(0x200, 0x600) }, { 0x500: [A64.svc(0x2C), A64.RET], 0x600: [A64.svc(0x2C), A64.NOP] }),
    clobber: matchImage({ 0x100: [A64.adrp(8, 0x100, 0x2000), 0x2A0003E8, A64.ldr(0, 8, 8), A64.RET], 0x200: [A64.adrp(29, 0x200, 0x2000), 0xAA0003FD, A64.ldr(0, 29, 8), A64.RET], 0x300: [A64.adrp(9, 0x300, 0x2000), A64.NOP, 0xF100043F, A64.ldr(0, 9, 8), A64.RET],
      0x400: [A64.adrp(1, 0x400, 0x2000), 0xF100043F, A64.ldr(0, 1, 8), A64.RET], 0x500: [A64.movX0X23, 0x10000040, A64.NOP, A64.RET], 0x600: [A64.adrp(3, 0x600, 0x2000), 0xE7FFDEFE, A64.addi(3, 3, 0x123), A64.RET] }),
  };
  for (const [name, image] of Object.entries(hand)) {
    const file = join(dir, "hand_" + name + ".bin"); writeFileSync(file, image); writeFileSync(file + ".end", String(MATCH_TEXT_END));
    mine.push({ name: "hand_" + name, file, fns: w.fingerprints(image, MATCH_TEXT_END).functions });
  }
  // every function matches itself, and only itself or its exact copies
  { const m = mine.find(x => x.name === "rt_hello.O2")!, { image, textEnd } = unpack(w, new Uint8Array(readFileSync(mods.find(x => x.name === "rt_hello.O2")!.path)));
    for (const f of m.fns.filter(f => f.fingerprint)) {
      const orig = hexOf(image.subarray(f.start, f.start + 4)), same = m.fns.filter(g => g.fingerprint === f.fingerprint && g.end - g.start === f.end - f.start).length;
      const r = matched(w.match(image, [[{ name: "self", functions: [{ size: f.end - f.start, fingerprints: [f.fingerprint!], cuts: [{ off: 0, orig, new: orig }] }] }]], textEnd));
      assert.deepEqual(r.outcomes[0].matched ? r.cuts.map(c => c.off) : same, same === 1 ? [f.start] : same);
    } }
  const cs = capstone(), haveNx = existsSync(join(NX, "dm", "tools", "nso_match.py"));
  const made = /WRITES_CAPSTONE: string = "([^"]+)"/.exec(readFileSync(join(ROOT, "src", "prepare", "gen", "match_writes.ts"), "utf8"))![1];
  // nso_match.py's fingerprints depend on the Capstone it runs with (which registers it lists as written); the table here is one version's
  if (cs !== made || !haveNx) info.push(`SKIPPED: the comparison with nxnative's nso_match.py needs ${!haveNx ? "the nxnative checkout (NXNATIVE)" : `Capstone ${made}, the version the register-write table was measured from (${cs ? cs + " is installed" : "none is installed"}: pip install capstone==${made})`}; ${total} functions fingerprinted here, ${withFp} with a result`);
  else {
    const lines = execFileSync("python3", [join(ROOT, "tools", "prepare", "match_reference.py"), NX, "-", ...mine.map(m => m.file)], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n");
    assert.equal(lines.length, mine.length);
    let same = 0, none = 0, undecoded = 0; const bad: string[] = [];
    mine.forEach((m, i) => {
      const ref = JSON.parse(lines[i]) as { functions: Record<string, string>; error: string | null };
      assert.equal(ref.error, null, m.name); assert.equal(Object.keys(ref.functions).length, m.fns.length, `${m.name}: the functions of the unwind table`);
      for (const f of m.fns) {
        const r = ref.functions[f.start];
        if (r === undefined) bad.push(`${m.name} +0x${f.start.toString(16)}: not a function for nxnative`);
        else if (r === f.fingerprint) same++;
        else if (r.startsWith("!") && f.fingerprint === null) none++;
        // nxnative refuses a function with a word Capstone does not decode; here it has a fingerprint no rule can hold (README, "Function-matched cuts")
        else if (/^!undecodable function/.test(r)) undecoded++;
        else bad.push(`${m.name} +0x${f.start.toString(16)}: nxnative ${r.slice(0, 40)}, here ${f.fingerprint?.slice(0, 16) ?? "none"}`);
        if (r && !r.startsWith("!")) imports++;
      }
    });
    assert.deepEqual(bad.slice(0, 8), [], `${bad.length} functions differ`);
    assert.ok(same >= 700);
    info.push(`${mine.length} modules (clang -O2 and -Os), ${total} functions: ${same} fingerprints equal to nso_match.py's, ${none} without one on both sides (a branch to code with no identity), ${undecoded} that nxnative refuses for a word Capstone ${cs} does not decode, 0 different`);
  }
  // the register-write table against Capstone, on words it was not made from
  if (cs !== made) info.push(`SKIPPED: the register-write table was measured from Capstone ${made}; ${cs ? "Capstone " + cs + " is installed" : "Capstone is not installed"}`);
  else {
    const truth = join(SCRATCH, "writes.truth"), n = 300_000;
    execFileSync("python3", [join(ROOT, "tools", "prepare", "gen_match_writes.py"), "--truth", String(n), truth, "--seed", "424242"], { stdio: "ignore" });
    const t = readFileSync(truth), dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    let dec = 0, exact = 0, more = 0; const unsound: string[] = [];
    for (let i = 0; i < n; i++) {
      const word = dv.getUint32(8 * i, true), cap = dv.getUint32(8 * i + 4, true);
      if (cap === 0xFFFFFFFF) continue;
      dec++;
      const m = w.writes(word);
      if (cap & ~m) unsound.push(`0x${word.toString(16)}: Capstone 0x${cap.toString(16)}, the table 0x${m.toString(16)}`); else if (m === cap) exact++; else more++;
    }
    assert.deepEqual(unsound.slice(0, 5), []);
    assert.ok(dec > 50_000 && exact > dec * 0.8);
    info.push(`register writes: ${dec} decoded words of ${n} random ones (seed 424242): ${exact} as Capstone ${cs} lists them, ${more} counted as written where Capstone lists less (unmeasured encodings: safe), 0 the other way`);
  }
  return info;
});

test("function-matched cuts in the pipeline: a build no registered cut names gets the profile's patch placed by its function (the code runs changed: exit code 42 -> 7) and the patches for every game are tried; a patch that does not match is left out and said; a build with registered cuts is not matched; the applied cuts are in the hand-off and in the translation cache key", async () => {
  const w = newWasm(), info: string[] = [];
  const mod = unwindModules().find(m => m.name === "rt_hello.O2"); assert.ok(mod, "hello with unwind tables");
  const hello = new Uint8Array(readFileSync(mod.path)), { image, textEnd } = unpack(w, hello);
  const mov = imageOffsets(w, hello, Uint8Array.of(0x40, 0x05, 0x80, 0x52)); assert.equal(mov.length, 1, "one mov w0,#42");
  const rule = ruleFor(w, image, "the exit code", [[mov[0], "40058052", "e0008052"]], textEnd);
  const absent: MatchRule = { name: "not in this build", functions: [{ size: 64, fingerprints: ["ab".repeat(32)], cuts: [{ off: 0, orig: "1f2003d5", new: "1f2003d5", why: "x" }] }] };
  const other = "0100CCCC0000D000";
  const prof = (cuts: Cut[], more: Partial<Profile> = {}, row: Record<string, string> = {}) => profileFor(hello, other, cuts, { apply: { title_id: other, program_id: other, name: "Matched", modules: "main", app_pool: "0xCD500000" }, match_cuts: { main: [rule, absent] }, ...more }, row);
  const sdk = { source: "test", cuts: {}, match_cuts: { main: [{ ...absent, name: "for every game" }] }, unconverted: [] };
  const files = () => ({ "base/exefs/main": hello, "base/exefs/main.npdm": npdm({ programId: BigInt("0x" + other) }), "base/romfs/a.txt": "a" });
  const r = prepare(game("match-pipeline", files()), { profiles: memProfiles([prof([])], sdk) });
  const res = await r.prep.run(); assert.equal(res.state, "Ready", res.error);
  const p = r.prep.out<ProfileOut>("profile"), c = r.prep.out<CodeOut>("code");
  assert.deepEqual([p.cuts.length, p.match.map(m => [m.module, m.sets[0].length, m.sets[1].length])], [0, [["main", 2, 1]]]);
  assert.deepEqual(c.matched.map(m => [m.module, m.from, m.name, m.matched, m.offsets, m.why]), [
    ["main", `profile ${other}`, "the exit code", true, [mov[0]], "implementation 1 of 1"],
    ["main", `profile ${other}`, "not in this build", false, [], "0 matching functions (need exactly one)"],
    ["main", "every game", "for every game", false, [], "0 matching functions (need exactly one)"]]);
  assert.deepEqual(c.modules.map(m => [m.name, m.from, m.cuts]), [["main", "store", 1]]);
  assert.ok(r.lines.some(l => l === `prepare: main: function patch 'the exit code': matched at 0x${mov[0].toString(16)} (implementation 1 of 1)`), r.lines.join("\n"));
  assert.ok(r.lines.some(l => l.startsWith("[RED] prepare: main: function patch 'not in this build' skipped: ")), "the game's own patch that does not match is a red line");
  assert.ok(r.lines.some(l => l.startsWith("prepare: main: function patch 'for every game' skipped: ")), "one tried on every game is a plain line");
  const h = await r.prep.handoff();
  assert.deepEqual(h.cuts.map(x => [x.module, x.off, x.orig, x.new, x.why]), [["main", mov[0], "40058052", "e0008052", "the exit code [function match]"]]);
  assert.deepEqual(Object.keys(handoffOptions(h).cutsKey), ["main"], "a matched cut changes the module's translation cache key");
  const run = async (bytes: Uint8Array) => { const rt = new Runtime(env.mods); assert.ok(rt.loadNso([{ name: "hello", bytes }]), rt.red.join("|")); const o = rt.run(); const out = [o.stop?.kind, o.stop?.code, rt.red.length]; rt.dispose(); return out; };
  assert.deepEqual(await run(hello), ["exit", 42, 0]);
  assert.deepEqual(await run(await h.modules[0].bytes()), ["exit", 7, 0], "the matched cut is in the code that runs");
  r.tree.close();
  // an unchanged folder skips every stage; another rule runs Profile and Code again
  const again = prepare(dirOf("match-pipeline"), { profiles: memProfiles([prof([])], sdk) }); assert.deepEqual((await again.prep.run()).skipped, [...STAGES]); again.tree.close();
  const r2 = prepare(dirOf("match-pipeline"), { profiles: memProfiles([prof([], { match_cuts: { main: [absent] } })], sdk) }); const res2 = await r2.prep.run(); r2.tree.close();
  assert.deepEqual([res2.state, res2.ran, r2.prep.out<CodeOut>("code").modules.map(m => [m.from, m.cuts])], ["Ready", ["profile", "code"], [["folder", 0]]]);
  // a build with registered cuts keeps exactly those: nxnative matches only where no CUTS name the build
  const str = imageOffsets(w, hello, ascii("hello from an NSO"));
  const r3 = prepare(game("match-registered", files()), { profiles: memProfiles([prof([{ off: str[0] + 6, orig: hexOf(ascii("from")), new: hexOf(ascii("FROM")), why: "registered" }])], sdk) });
  assert.equal((await r3.prep.run()).state, "Ready"); r3.tree.close();
  assert.deepEqual([r3.prep.out<ProfileOut>("profile").match, r3.prep.out<CodeOut>("code").matched, (await r3.prep.handoff()).cuts.map(x => x.why)], [[], [], ["registered"]]);
  // a registered cut and a matched one that overlap in one list: Failed(cut), as nxnative stops
  const r4 = prepare(game("match-overlap", files()), { profiles: memProfiles([prof([], { match_cuts: { main: [rule, { ...rule, name: "the same place" }] } })], sdk) });
  const res4 = await r4.prep.run(); r4.tree.close();
  assert.deepEqual([res4.state, res4.reason], ["Failed", "cut"]); assert.match(res4.error!, /function patches overlap at 0x/);
  info.push(`hello with unwind tables: mov w0,#42 at +0x${mov[0].toString(16)} lies in a function of ${rule.functions[0].size} bytes; found by its fingerprint and cut, the game exits with 7`);
  // the converted nxnative rules run on a module they were not made for: nothing matches, nothing is red for the wide ones, the prepare ends Ready
  const db = nodeProfiles(), sdkReal = await db.sdk();
  const r5 = prepare(game("match-real-rules", { ...files(), "base/exefs/sdk": hello }), { profiles: memProfiles([prof([], { apply: { title_id: other, program_id: other, name: "Matched", modules: "main sdk", app_pool: "0xCD500000" } }, { sdk: "00".repeat(16) })], sdkReal) });
  const res5 = await r5.prep.run(); r5.tree.close(); assert.equal(res5.state, "Ready", res5.error);
  const c5 = r5.prep.out<CodeOut>("code"), wideRules = Object.values(sdkReal.match_cuts ?? {}).flat();
  assert.ok(wideRules.length >= 13 && c5.matched.filter(m => m.from === "every game").every(m => !m.matched));
  assert.deepEqual(c5.matched.filter(m => m.from === "every game").map(m => m.module).filter((m, i, a) => a.indexOf(m) === i).sort(), Object.keys(sdkReal.match_cuts ?? {}).filter(k => k === "main" || k === "sdk").sort());
  info.push(`nxnative's ${wideRules.length} rules for every game (modules ${Object.keys(sdkReal.match_cuts ?? {}).join(", ")}) tried on the test module: ${c5.matched.filter(m => m.from === "every game").length} patches, none matches, the prepare ends Ready`);
  return info;
});

// =================================================================================================== the instruction scan
test("the instruction scan of the Code stage: every test source compiled with unwind tables scans clean by its functions; planted words are found with their kind, count and offset, recorded in the Code stage's output, logged and handed off; the stage runs again when the translator binary changes; without a scanner nothing changes", async () => {
  const w = newWasm(), info: string[] = [];
  const scan = new A64Scanner(readFileSync(join(rth.OUT, "translator.wasm")));
  // real compiler output, function by function
  const mods = unwindModules();
  assert.ok(mods.length >= 4, `${mods.length} modules with unwind tables`);
  let words = 0, fns = 0, outside = 0;
  for (const m of mods) {
    const b = new Uint8Array(readFileSync(m.path)), opened = await w.open(b);
    try {
      assert.ok(!("error" in opened), m.name);
      const si = w.scanInput(b); assert.ok(si && si.functions && si.functions.length >= 2, `${m.name}: a function table`);
      const s = await scan.scan(si.text, si.textOff, si.functions);
      assert.deepEqual(s.kinds.filter(k => k.instruction && k.count > 0).map(k => `${m.name}: ${k.count} x ${k.name} at ${k.first.map(o => "0x" + o.toString(16))}`), [], "an instruction of our own test programs is not supported");
      assert.equal(s.words + s.wordsOutside + s.literals, s.textWords); assert.equal(s.functions, si.functions.length / 2);
      words += s.words; fns += s.functions!; outside += s.wordsOutside;
    } finally { w.close(); }
  }
  info.push(`${mods.length} modules of the test sources with unwind tables: ${fns} functions, ${words} words of code, every one translated (${outside} words of text outside the functions)`);
  // planted: an SVE word where hello sets its exit code, a system register read where a function returns
  const hello = new Uint8Array(readFileSync(mods.find(m => m.name === "rt_hello.O2")!.path));
  const mov = imageOffsets(w, hello, Uint8Array.of(0x40, 0x05, 0x80, 0x52)); assert.equal(mov.length, 1);
  const si0 = (await w.open(hello), w.scanInput(hello)!), f0 = Array.from(si0.functions!); w.close();
  const inFn = (o: number) => { for (let i = 0; i < f0.length; i += 2) if (o >= f0[i] && o < f0[i + 1]) return true; return false; };
  const ret = imageOffsets(w, hello, Uint8Array.of(0xC0, 0x03, 0x5F, 0xD6)).find(o => inFn(o) && o !== mov[0]); assert.ok(ret !== undefined && inFn(mov[0]));
  const cutR = w.cut(hello, [{ off: mov[0], orig: "40058052", new: "00306004" }, { off: ret!, orig: "c0035fd6", new: "001038d5" }].sort((a, b) => a.off - b.off)); assert.ok("bytes" in cutR);
  const planted = cutR.bytes, other = "0100CCCC0000E000";
  const files = () => ({ "base/exefs/main": planted, "base/exefs/main.npdm": npdm({ programId: BigInt("0x" + other) }), "base/romfs/a.txt": "a" });
  const r = prepare(game("scan-planted", files()), { scanner: { scan, key: "k1" } });
  const res = await r.prep.run(); assert.equal(res.state, "Ready", res.error);
  const c = r.prep.out<CodeOut>("code");
  assert.equal(c.scan?.length, 1);
  const s = c.scan![0];
  assert.deepEqual([s.module, s.buildId, s.scan.functions, s.scan.unsupported, s.scan.unsupportedWords], ["main", c.modules[0].buildId, f0.length / 2, 2, 2]);
  assert.deepEqual(s.scan.kinds.filter(k => k.instruction).map(k => [k.name, k.count, k.first]).sort(), [["MRS S3_0_C1_C0_0 (SCTLR_EL1)", 1, [ret]], ["SVE (any)", 1, [mov[0]]]]);
  assert.equal(scanHeadline(c.scan!), "2 kinds of instruction in this game are not supported yet");
  assert.ok(r.lines.includes("prepare: scan: main: 2 kinds of instruction not supported, 2 words in all:"), r.lines.join("\n"));
  assert.ok(r.lines.some(l => l.startsWith("prepare: scan:") && l.includes("SVE (any)") && l.includes("0x" + mov[0].toString(16))));
  assert.ok(!r.lines.some(l => l.startsWith("[RED]")), "the scan predicts, it does not fail the prepare: no red line");
  const h = await r.prep.handoff();
  assert.deepEqual(h.scan, c.scan);
  r.tree.close();
  // the same folder and scanner: nothing runs; another translator binary: the Code stage, and only it, runs again
  const again = prepare(dirOf("scan-planted"), { scanner: { scan, key: "k1" } }); assert.deepEqual((await again.prep.run()).skipped, [...STAGES]); again.tree.close();
  const newer = prepare(dirOf("scan-planted"), { scanner: { scan, key: "k2" } }); const res2 = await newer.prep.run(); newer.tree.close();
  assert.deepEqual([res2.state, res2.ran], ["Ready", ["code"]]);
  // without a scanner: no scan in the output, an empty list in the hand-off
  const plain = prepare(game("scan-none", files())); assert.equal((await plain.prep.run()).state, "Ready");
  assert.equal(plain.prep.out<CodeOut>("code").scan, undefined); assert.deepEqual((await plain.prep.handoff()).scan, []); plain.tree.close();
  info.push(...scanLines("main (planted)", s.scan));
  return info;
});

// =================================================================================================== the take-over scan
test("the take-over scan of the Code stage: a synthetic game's dynamic symbols against the list of what nxnative takes over and nxweb does not answer: an HLE_FORCE name is a gap where a module defines or imports it, an HLE name where it is imported and defined nowhere, an answered name never; recorded in the Code stage's output and logged, not red; npm run prepare:scan prints the same and exits 1", async () => {
  const info: string[] = [];
  const forced = NOT_ANSWERED.filter(e => e[3] === 1), weak = NOT_ANSWERED.filter(e => e[3] === 0);
  assert.ok(forced.length >= 2 && weak.length >= 2, "the list has forced and weak names");
  const [f1, f2] = forced, [w1, w2] = weak, answered = "_ZN2nn2fs8MountRomEPKcPvm";
  assert.ok(!NOT_ANSWERED.some(e => e[0] === answered), "nn::fs::MountRom is answered (src/fs)");
  // the parser alone: withImport's one imported symbol, then a table of our own
  assert.deepEqual(dynSymbols(withImport(matchImage({ 0x100: [A64.RET] }), "glClear")), [{ name: "glClear", defined: false }]);
  assert.deepEqual(dynSymbols(new Uint8Array(0x100)), [], "no MOD0: no symbols");
  const img = (syms: { name: string; defined: boolean }[]) => withSymbols(matchImage({ 0x100: [A64.movz(0, 0), A64.RET] }), syms);
  const main = img([{ name: f1[0], defined: false }, { name: w1[0], defined: false }, { name: w2[0], defined: false }, { name: answered, defined: false }, { name: "_ZN4game4mainEv", defined: true }]);
  const sdk = img([{ name: f2[0], defined: true }, { name: w2[0], defined: true }, { name: answered, defined: true }]);
  assert.deepEqual(dynSymbols(main).map(s => s.name), [f1[0], w1[0], w2[0], answered, "_ZN4game4mainEv"]);
  const expect = [
    { module: "main", name: f1[0], demangled: f1[1], file: f1[2], forced: true, defined: false },
    { module: "main", name: w1[0], demangled: w1[1], file: w1[2], forced: false, defined: false },
    { module: "sdk", name: f2[0], demangled: f2[1], file: f2[2], forced: true, defined: true },
  ].sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file) || a.demangled.localeCompare(b.demangled));
  const direct = hleGaps([{ module: "main", symbols: dynSymbols(main) }, { module: "sdk", symbols: dynSymbols(sdk) }]);
  assert.deepEqual(direct, expect, "w2 is defined by sdk: the game's own; the answered name is no gap");
  assert.equal(hleHeadline(direct), "3 SDK functions nxnative replaces are not answered here yet");
  assert.equal(hleHeadline(direct.slice(0, 1)), "1 SDK function nxnative replaces is not answered here yet");
  assert.equal(hleHeadline([]), ""); assert.deepEqual(hleLines([]), []);
  // the same through the Code stage of a synthetic game
  const other = "0100CCCC0000F000";
  const files = () => ({ "base/exefs/main": nsoOf(main, 0x51), "base/exefs/sdk": nsoOf(sdk, 0x52), "base/exefs/main.npdm": npdm({ programId: BigInt("0x" + other) }), "base/romfs/a.txt": "a" });
  const r = prepare(game("hle-scan", files()));
  const res = await r.prep.run(); r.tree.close(); assert.equal(res.state, "Ready", res.error);
  const c = r.prep.out<CodeOut>("code");
  assert.deepEqual(c.modules.map(m => m.name).sort(), ["main", "sdk"]);
  assert.deepEqual(c.hle, expect);
  assert.ok(r.lines.includes("prepare: hle: 3 SDK functions nxnative replaces are not answered here yet:"), r.lines.join("\n"));
  assert.ok(r.lines.some(l => l.startsWith("prepare: hle: main ") && l.includes(f1[1]) && l.includes("dm/" + f1[2].split(",")[0])));
  assert.ok(!r.lines.some(l => l.startsWith("[RED]")), "the scan predicts, it does not fail the prepare");
  const again = prepare(dirOf("hle-scan")); assert.deepEqual((await again.prep.run()).skipped, [...STAGES]); again.tree.close();
  // a game without any: an empty list
  const clean = prepare(game("hle-clean", { ...files(), "base/exefs/main": nsoOf(img([{ name: answered, defined: false }]), 0x53), "base/exefs/sdk": nsoOf(img([]), 0x54) }));
  assert.equal((await clean.prep.run()).state, "Ready"); assert.deepEqual(clean.prep.out<CodeOut>("code").hle, []); clean.tree.close();
  // the CLI: the game folder (the version the prepare picks), the exefs folder, one module
  const cli = (args: string[]) => { try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, "src", "prepare", "host", "scan.mts"), ...args], { cwd: ROOT, encoding: "utf8" }) }; } catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: x.stdout + x.stderr }; } };
  const a = cli([dirOf("hle-scan")]);
  assert.equal(a.code, 1, a.out); assert.ok(a.out.includes("3 SDK functions nxnative replaces are not answered here yet:"), a.out);
  for (const g of expect) assert.ok(a.out.split("\n").some(l => l.includes(g.demangled) && l.trimStart().startsWith(g.module)), `${g.module} ${g.demangled}: ${a.out}`);
  assert.equal(cli([join(dirOf("hle-scan"), "base", "exefs")]).out.split("\n").filter(l => l.includes("not answered here yet")).length, 1);
  const one = cli([join(dirOf("hle-scan"), "base", "exefs", "main")]);
  assert.ok(one.out.includes("3 SDK functions"), "main alone: w2 is defined nowhere it can see");
  const none = cli([dirOf("hle-clean")]); assert.equal(none.code, 0, none.out);
  info.push(`${NOT_ANSWERED.length} names nxnative takes over that nxweb does not answer (${forced.length} forced); the synthetic game:`, ...hleLines(c.hle));
  return info;
});

// =================================================================================================== the converter
test("the profile converter on a synthetic nxnative tree: a patch file that imports what the sandbox does not provide (or uses a builtin it does not have, or fails) is skipped, not fatal: its profile is converted from game.tsv, its patches are marked not converted with the reason, the run lists such files and exits 0; --strict fails; CUTS, MATCH_CUTS and FRAME_STEP of a good file convert as before", () => {
  const nx = join(SCRATCH, "fake-nxnative"), out = join(SCRATCH, "fake-profiles");
  rmSync(nx, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  const tsv = (id: string, name: string, more: string[] = []) => [`title_id\t${id}`, `program_id\t${id}`, `name\t${name}`, "ipa\tx.ipa", "modules\tmain sdk", `build\tv0\t1.0.0\tmain=${"11".repeat(16)}\tsdk=${"22".repeat(16)}`,
    "app_pool\t0xCD500000", "mem_reserve\t0x100000000", "mem_alias\t0x10000000", "mem_stack\t0x10000000", ...more].join("\n") + "\n";
  const fp = "ab".repeat(32);
  const tree: Files = {
    "dm/tools/nso_asm.py": "def B(frm, to): return 0x14000000 | (((to - frm) >> 2) & 0x3FFFFFF)\nNOP = 0xD503201F\n",
    "dm/tools/sdk_patches.py": `CUTS = {'${"33".repeat(16)}': [(0x10, '1f2003d5', 'c0035fd6', 'an sdk cut')]}\nMATCH_CUTS = {'sdk': [{'name': 'wide', 'size': 16, 'fingerprints': ['${fp}'], 'cuts': [(4, '1f2003d5', 'c0035fd6', 'a wide cut')]}]}\n`,
    "dm/tools/engine_patches.py": "import engine_tables\nMATCH_CUTS = {}\n",
    // needs a module the sandbox does not have (what a newer nxnative patch file does)
    "dm/games/0100000000001000/game.tsv": tsv("0100000000001000", "Needs A Module", ["fps_target\t60"]),
    "dm/games/0100000000001000/patches.py": `from nso_match import Image\nCUTS = {'${"11".repeat(16)}': [(0, '1f2003d5', 'c0035fd6', 'never converted')]}\n`,
    // a good one: every kind
    "dm/games/0100000000002000/game.tsv": tsv("0100000000002000", "Good Patches", ["mem_reserve\t0x400000000", "mem_alias\t0x200000000"]),
    "dm/games/0100000000002000/patches.py": [
      "import struct", "from nso_asm import B, NOP",
      `CUTS = {'${"11".repeat(16)}': [(0x40, '1f2003d5', struct.pack('<I', NOP).hex(), 'a cut')]}`,
      `MATCH_CUTS = {'main': [{'name': 'one', 'size': 32, 'fingerprints': ['${fp}'], 'cuts': [(8, '1f2003d5', struct.pack('<I', B(8, 16)).hex(), 'a branch inside the function')]},`,
      `                       {'name': 'two', 'functions': [{'size': 8, 'fingerprints': ['${fp}'], 'cuts': [(0, '1f2003d5', 'c0035fd6', 'first')]}, {'size': 12, 'fingerprints': ['${fp}', '${"cd".repeat(32)}'], 'cuts': [(4, '1f2003d5', 'c0035fd6', 'second')]}]}]}`,
      "def step(ctx):", "    ctx.site(0x100, '1f2003d5'); ctx.emit(NOP); ctx.emit(B(ctx.here(), ctx.here() + 8)); ctx.put(0x100, [NOP], 'a stub')",
      `FRAME_STEP = {'${"11".repeat(16)}': step}`, ""].join("\n"),
    // no patch file
    "dm/games/0100000000003000/game.tsv": tsv("0100000000003000", "No Patches", ["mem_reserve\t0x60000000"]),
    // a builtin outside the whitelist
    "dm/games/0100000000004000/game.tsv": tsv("0100000000004000", "Opens A File"),
    "dm/games/0100000000004000/patches.py": "CUTS = {}\ndata = open('/etc/hostname').read()\n",
    // fails while it is evaluated
    "dm/games/0100000000005000/game.tsv": tsv("0100000000005000", "Raises"),
    "dm/games/0100000000005000/patches.py": "CUTS = {}\nassert 1 == 2, 'a table that does not hold'\n",
  };
  writeTree(nx, tree);
  const tool = join(ROOT, "tools", "prepare", "convert_profiles.py");
  const conv = (args: string[]) => { try { return { code: 0, out: execFileSync("python3", [tool, "--nxnative", nx, "--out", out, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e: any) { return { code: e.status as number, out: String(e.stdout) + String(e.stderr) }; } };
  const r = conv([]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /patch files not evaluated: 4 \(their profiles are converted from game\.tsv, without patches; --strict fails here\)/);
  assert.match(r.out, /  0100000000001000\/patches\.py: imports nso_match, which the sandbox does not provide \(it has nso_asm, struct\)/);
  assert.match(r.out, /  0100000000004000\/patches\.py: uses a name the sandbox does not provide \(name 'open' is not defined\)/);
  assert.match(r.out, /  0100000000005000\/patches\.py: fails while it is evaluated \(AssertionError: a table that does not hold\)/);
  assert.match(r.out, /  engine_patches\.py: imports engine_tables, which the sandbox does not provide/);
  assert.ok(!/\[RED\]/.test(r.out), r.out);
  const read = (n: string) => JSON.parse(readFileSync(join(out, n), "utf8"));
  const a = read("0100000000001000.json") as Profile, b = read("0100000000002000.json") as Profile, c = read("0100000000003000.json") as Profile, rep = read("report.json"), sdk = read("_sdk.json");
  // the skipped one: everything of game.tsv, nothing of the patch file, and the reason where the page and the report find it
  assert.deepEqual([a.name, a.apply.app_pool, a.builds[0].modules.main, a.needs.map(n => n.key), a.cuts, a.match_cuts], ["Needs A Module", "0xCD500000", "11".repeat(16), ["fps_target"], {}, {}]);
  assert.deepEqual([a.patches, a.unconverted], [{ converted: false, reason: "imports nso_match, which the sandbox does not provide (it has nso_asm, struct)" }, [{ kind: "PATCH_FILE", reason: "imports nso_match, which the sandbox does not provide (it has nso_asm, struct)" }]]);
  assert.deepEqual([a.address_space!.fit, c.address_space!.fit], ["pool", "profile"]);
  assert.deepEqual(rep.conversion.patch_files_skipped.map((e: { file: string }) => e.file), ["0100000000001000/patches.py", "0100000000004000/patches.py", "0100000000005000/patches.py", "engine_patches.py"]);
  assert.deepEqual(rep.conversion.unconverted.PATCH_FILE.profiles, ["0100000000001000", "0100000000004000", "0100000000005000", "engine_patches.py"]);
  assert.deepEqual(rep.problems, []);
  // the good one
  assert.deepEqual(b.cuts, { ["11".repeat(16)]: { module: "main", cuts: [{ off: 0x40, orig: "1f2003d5", new: "1f2003d5", why: "a cut" }] } });
  assert.deepEqual(b.match_cuts, { main: [
    { name: "one", functions: [{ size: 32, fingerprints: [fp], cuts: [{ off: 8, orig: "1f2003d5", new: "02000014", why: "a branch inside the function" }] }] },
    { name: "two", functions: [{ size: 8, fingerprints: [fp], cuts: [{ off: 0, orig: "1f2003d5", new: "c0035fd6", why: "first" }] }, { size: 12, fingerprints: [fp, "cd".repeat(32)], cuts: [{ off: 4, orig: "1f2003d5", new: "c0035fd6", why: "second" }] }] }] });
  assert.deepEqual(b.unconverted.map(u => [u.kind, u.sites, u.writes, u.stub_words]), [["FRAME_STEP", 1, 1, 2]]);
  assert.equal(b.patches, undefined);
  assert.deepEqual([b.address_space!.fit, b.needs.map(n => n.key), /does not fit a 32-bit memory: the profile reserves heap 7\.50 GB, alias 8\.00 GB/.test(b.needs[0].what)], ["short", ["address_space"], true]);
  assert.deepEqual([c.cuts, c.unconverted, c.patches], [{}, [], undefined]);
  assert.deepEqual([Object.keys(sdk.cuts), sdk.match_cuts.sdk.map((x: MatchRule & { file: string }) => [x.name, x.file]), sdk.unconverted], [["33".repeat(16)], [["wide", "sdk_patches.py"]], [{ kind: "PATCH_FILE", reason: "imports engine_tables, which the sandbox does not provide (it has nso_asm, struct)", file: "engine_patches.py" }]]);
  assert.deepEqual([rep.conversion.registered_cuts, rep.conversion.converted_cuts, rep.conversion.match_rules, rep.conversion.converted_match_rules, rep.conversion.wide_match_rules, rep.address_space.counts], [1, 1, 2, 2, 1, { profile: 1, pool: 3, short: 1, unknown: 0 }]);
  // the files are stable, --check agrees and also exits 0; --strict is the old behaviour
  const chk = conv(["--check"]); assert.equal(chk.code, 0, chk.out); assert.match(chk.out, /convert_profiles --check: 8 files are up to date/); assert.match(chk.out, /patch files not evaluated: 4/);
  const strict = conv(["--strict"]); assert.equal(strict.code, 1); assert.match(strict.out, /\[RED\] convert_profiles --strict: 0100000000001000\/patches\.py imports nso_match, which the sandbox does not provide/);
  // a rule that cannot be right is a problem (red, exit 1), not a silent skip: a PC-relative replacement that leaves its function
  writeFileSync(join(nx, "dm", "games", "0100000000003000", "patches.py"), `MATCH_CUTS = {'main': [{'name': 'bad', 'size': 16, 'fingerprints': ['${fp}'], 'cuts': [(8, '1f2003d5', '04000014', 'a branch out of the function')]}]}\n`);
  const bad = conv([]); assert.equal(bad.code, 1); assert.match(bad.out, /\[RED\] 0100000000003000 module main: a function-matched rule does not convert \(ValueError: replacement must not contain PC-relative instructions, except branches inside the matched function\)/);
  // the prepare step shows a skipped patch file for what it is
  return [`5 synthetic profiles, 4 patch files and 2 shared files: 4 not evaluated (a missing module twice, a missing builtin, an assertion), exit 0; --strict exits 1`, r.out.trim().split("\n").filter(l => /not evaluated|patches\.py:/.test(l)).join(" | ")];
});

// =================================================================================================== NUP containers, the verdict
nupTests({ test, newWasm, APP, APP_HEX, play, fsgFirst, imageOffsets, profileFor });

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
