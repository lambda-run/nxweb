// The NUP container tests of `npm run prepare:test` (registered by run.mts): synthetic containers written here
// (nup_synth.mts), read by src/prepare/host/nup.ts, prepared by the same pipeline as a folder and run in the
// runtime's harness; damaged containers; the reader against nxnative's own (scripts/pack_nup.py); the verdict card's
// sentences and the explanations of files that are not games.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../src/prepare/host/build.mts";
import type { PrepWasm, Cut } from "../../src/prepare/host/wasm.ts";
import { Nup, NupTree, NupReader, scanNup, memBytes, blobBytes, nacpTitle, NO_BASE, SMALL_CACHE, SMALL_MAX, WHOLE_MAX, type NupBytes } from "../../src/prepare/host/nup.ts";
import { nodeBytes } from "../../src/prepare/host/nup_node.ts";
import { NodeStore } from "../../src/prepare/host/store_node.ts";
import { MemStore } from "../../src/prepare/host/store.ts";
import { memProfiles, type Profile, type ProfileSource } from "../../src/prepare/host/profiles.ts";
import { nodeProfiles } from "../../src/prepare/host/profiles_node.ts";
import { Prepare, STAGES, romFromMessage, graphicsOf, type DetectOut, type ProfileOut, type IndexOut, type CodeOut } from "../../src/prepare/host/prepare.ts";
import { verdictFor, failureSentence, explainFile } from "../../src/prepare/host/verdict.ts";
import { PrepError } from "../../src/prepare/host/detect.ts";
import type { DirRomDevice } from "../../src/prepare/host/romdev.ts";
import { MemStorage, DEV } from "../../src/glue/fs_host.ts";
import { SCRATCH, guest, npdm, blob, version, type Files } from "./synth.mts";
import { writeNup, retoc, tlv, nacp, localizedIcons, haveZstd, zstd, KIND, T, STANDALONE, type NupPackageIn, type NupOut } from "./nup_synth.mts";

export interface Ctx {
  test: (name: string, fn: () => Promise<string[] | void> | string[] | void) => void;
  newWasm: (lines?: string[]) => PrepWasm;
  APP: bigint; APP_HEX: string;
  // run a prepared game in the runtime: what the fs guest prints
  play: (r: { prep: Prepare }, saves?: MemStorage) => Promise<{ stdout: string; kind?: string; code?: number; red: string[]; reads: number }>;
  fsgFirst: (b: Uint8Array, mount?: string) => string;
  imageOffsets: (w: PrepWasm, nso: Uint8Array, pattern: Uint8Array) => number[];
  profileFor: (nso: Uint8Array, titleId: string, cuts: Cut[], more?: Partial<Profile>, rowMore?: Record<string, string>) => Profile;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ascii = (s: string) => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const split = (v: Files): { exefs: Files; romfs: Files } => ({ exefs: Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith("exefs/")).map(([k, x]) => [k.slice(6), x])), romfs: Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith("romfs/")).map(([k, x]) => [k.slice(6), x])) });

export function nupTests(c: Ctx): void {
  const { test, newWasm, APP, APP_HEX } = c;
  const noProfiles = memProfiles([]);
  const ICON = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]);
  const META = tlv([[T.NAME, "TG"], [T.NACP, nacp("Test Game", "テス", "1.2.3", "Test Publisher")], [T.ICON, ICON]]);
  const pkgOf = (kind: number, v: Files, more: Partial<NupPackageIn> = {}): NupPackageIn => ({ kind, titleId: APP, ...split(v), ...more });
  const dlcPkg = (n: bigint, romfs: Files): NupPackageIn => ({ kind: KIND.addon, titleId: APP + 0x1000n + n, romfs });
  const open = (bytes: NupBytes, name = "game.nup", lines?: string[]) => { const w = newWasm(); return NupTree.open(bytes, name, { sha256: b => w.sha256(b), log: l => lines?.push(l) }); };
  // one prepare over a container file on disk and a store that outlives it
  async function prepareNup(name: string, n: NupOut | Uint8Array, o: { profiles?: ProfileSource; version?: number; keepStore?: boolean; at?: (p: string) => void } = {}) {
    mkdirSync(SCRATCH, { recursive: true });
    const path = join(SCRATCH, name + ".nup"); writeFileSync(path, n instanceof Uint8Array ? n : n.bytes);
    if (!o.keepStore) rmSync(path + ".store", { recursive: true, force: true });
    const lines: string[] = [], src = nodeBytes(path), wasm = newWasm(lines);
    const tree = await NupTree.open(src, name + ".nup", { sha256: b => wasm.sha256(b), log: l => lines.push(l) });
    const prep = new Prepare({ wasm, tree, store: new NodeStore(path + ".store"), profiles: o.profiles ?? noProfiles, version: o.version, at: o.at });
    return { prep, lines, tree, src, path, close: () => src.close() };
  }
  const three = (b0: Uint8Array, b1: Uint8Array, more: Partial<{ compress: (p: string, d: Uint8Array) => boolean }> = {}) => writeNup([
    pkgOf(KIND.base, version({ programId: APP, blob: b0, rom: { "data/blob.bin": b0, "base-only.txt": "gone in the update", "hello.txt": "hello from a container\n", "empty.bin": "" } }), { meta: META }),
    pkgOf(KIND.update, version({ programId: APP, blob: b1, rom: { "data/blob.bin": b1, "hello.txt": "new", "deep/er/x.bin": blob(700, 9) }, extra: { "exefs/sdk": guest("two_lib"), "exefs/.listing": "not a module" } }), { version: 65536 }),
    dlcPkg(2n, { "pack/a.bin": blob(3000, 3), "pack/b.bin": blob(17, 4), "c.txt": "dlc" }),
  ], more);

  test("a NUP container is read as the folder it stands for: base/, updates/<version>/, dlc/<title ID>/0/romfs/ with every file's size, raw and zstd files give their bytes, a dump tool's .listing is left out; only the superblock, the table of contents and the extents asked for are read", async () => {
    assert.ok(haveZstd, "this Node has no zlib.zstdCompressSync (22.15 or newer is needed to write the test containers)");
    const b0 = blob(60_000, 7), b1 = blob(100_003, 8), pad = blob(WHOLE_MAX + (1 << 20), 5);
    const n = writeNup([pkgOf(KIND.base, { ...version({ programId: APP, blob: b0 }), "romfs/never-read.bin": pad }, { meta: META }), pkgOf(KIND.update, version({ programId: APP, blob: b1, extra: { "exefs/.listing": "x" } }), { version: 65536 }), dlcPkg(2n, { "c.txt": "dlc", "pack/a.bin": blob(3000, 3) })],
      { compress: (p, d) => d.length >= 200 && !p.includes("never-read") });
    const path = join(SCRATCH, "read.nup"); mkdirSync(SCRATCH, { recursive: true }); writeFileSync(path, n.bytes);
    const src = nodeBytes(path), t = await open(src, "read.nup"), l = await t.list();
    const afterOpen = src.bytesRead;
    assert.equal(afterOpen, 0x80 + n.tocSize, "open reads the superblock and the table of contents");
    const dlc = (APP + 0x1002n).toString(16).toUpperCase().padStart(16, "0");
    assert.deepEqual(l.files.map(f => f.path), ["base/exefs/main", "base/exefs/main.npdm", "base/romfs/data/blob.bin", "base/romfs/hello.txt", "base/romfs/never-read.bin",
      `dlc/${dlc}/0/romfs/c.txt`, `dlc/${dlc}/0/romfs/pack/a.bin`, "updates/65536/exefs/main", "updates/65536/exefs/main.npdm", "updates/65536/romfs/data/blob.bin", "updates/65536/romfs/hello.txt"].sort());
    assert.deepEqual(l.dirs, ["base", "base/exefs", "base/romfs", "base/romfs/data", "dlc", `dlc/${dlc}`, `dlc/${dlc}/0`, `dlc/${dlc}/0/romfs`, `dlc/${dlc}/0/romfs/pack`, "updates", "updates/65536", "updates/65536/exefs", "updates/65536/romfs", "updates/65536/romfs/data"].sort());
    assert.deepEqual([t.nup.packages.length, t.scan.noBase, [...t.scan.updates.keys()], [...t.scan.dlc.keys()]], [3, false, [65536], [dlc]]);
    const kinds = new Set([...n.extents.values()].map(e => e.codec));
    assert.deepEqual([...kinds].sort(), [0, 1], "the container holds raw and zstd files");
    // bytes: whole files (async and sync), ranges, an empty read
    assert.deepEqual(await t.read("updates/65536/romfs/data/blob.bin", 0, b1.length), b1);
    assert.deepEqual(await t.read("base/romfs/data/blob.bin", 1000, 5000), b0.subarray(1000, 6000));
    assert.deepEqual(new TextDecoder().decode(await t.read("base/romfs/hello.txt", 0, 20)), "hello from a folder\n");
    const part = new Uint8Array(4096); assert.equal(t.readSync!("base/romfs/never-read.bin", 1 << 20, part), 0); assert.deepEqual(part, pad.subarray(1 << 20, (1 << 20) + 4096));
    assert.equal(t.readSync!("base/romfs/nothing", 0, part), DEV.IO);
    assert.equal(t.readSync!("base/romfs/hello.txt", 10, part), DEV.IO, "a read past a file's end");
    await assert.rejects(t.read("base/exefs/.listing", 0, 1), /no file/);
    // identity for the stages' hashes: size and 48 bits of the content's SHA-256
    const f = l.files.find(x => x.path === "base/romfs/data/blob.bin")!;
    assert.deepEqual([f.size, f.mtime], [b0.length, parseInt(sha(b0).slice(0, 12), 16)]);
    // a raw file is a range of the user's file; a compressed one has no Blob
    assert.equal(t.blob("base/romfs/never-read.bin"), undefined, "no Blob behind a descriptor");
    const tb = await open(blobBytes(new Blob([n.bytes as BlobPart]), false), "read.nup");
    assert.deepEqual(new Uint8Array(await tb.blob("base/romfs/never-read.bin")!.arrayBuffer()), pad);
    assert.equal(tb.blob("base/romfs/data/blob.bin"), undefined);
    const read = src.bytesRead - afterOpen; src.close();
    assert.ok(read < 400_000 && n.bytes.length > WHOLE_MAX, `${read} bytes read of ${n.bytes.length}`);
    return [`${n.bytes.length} bytes, ${n.files} files in ${n.dirs} folders; open read ${afterOpen} bytes, the reads above ${read}: of the 9 MB raw file only the range asked for was read`,
      `reader: ${JSON.stringify(t.reader.stats)}`];
  });

  test("damaged and malformed containers are refused with pack_nup.py's reasons: bad magic, another format version, a truncated or grown file, a table of contents that does not match its SHA-256, records out of bounds, reserved fields, an unknown codec, a loop of folders; file data that does not match its SHA-256 is found when the file is read", async () => {
    const b0 = blob(60_000, 7), n = three(b0, blob(100_003, 8)), info: string[] = [];
    const refuse = async (what: string, bytes: Uint8Array, re: RegExp, reason: string) => {
      await assert.rejects(open(memBytes(bytes)), (e: unknown) => { assert.ok(e instanceof PrepError, what + ": " + e); assert.match(e.message, re, what); assert.equal(e.reason, reason, what); return true; }, what);
      info.push(what);
    };
    const edit = (f: (b: Uint8Array, dv: DataView) => void) => { const b = n.bytes.slice(); f(b, new DataView(b.buffer)); return b; };
    await refuse("an empty file", new Uint8Array(0), /empty file/, "layout");
    await refuse("too short", n.bytes.subarray(0, 0x40), /not a NUP \(too short\)/, "layout");
    await refuse("bad magic", edit(b => { b[0] = 0x50; }), /not a NUP$/, "layout");
    await refuse("format version 2", edit(b => { b[3] = 2; }), /NUP format version 2; this reads version 1/, "layout");
    await refuse("header flags", edit((_, dv) => dv.setUint32(76, 1, true)), /unsupported NUP header/, "layout");
    await refuse("a header size that is not the TOC offset", edit((_, dv) => dv.setUint16(4, 0x90, true)), /unsupported NUP header/, "layout");
    await refuse("truncated", n.bytes.subarray(0, n.bytes.length - 4096), /bytes, its header says [\d,]+ \(copied or downloaded partly\?\)/, "read");
    await refuse("grown", Uint8Array.from([...n.bytes, 0]), /its header says/, "read");
    await refuse("a data region inside the TOC", edit((_, dv) => dv.setBigUint64(56, 0x90n, true)), /TOC and data regions overlap/, "layout");
    await refuse("a TOC byte changed", edit(b => { b[n.tocOff + 0x40] ^= 1; }), /table of contents does not match its SHA-256 \(damaged file\)/, "read");
    const file = (k: string) => n.extents.get(k)!;
    const rec = file("0:romfs/data/blob.bin").record;
    await refuse("TOC magic", retoc(n, b => { b[n.tocOff] = 0x58; }), /malformed table of contents/, "layout");
    await refuse("package counts that differ", retoc(n, (_, dv) => dv.setUint32(n.tocOff + 4, 2, true)), /malformed table of contents/, "layout");
    await refuse("a name pool past the TOC", retoc(n, (_, dv) => dv.setBigUint64(n.tocOff + 32, 1n << 20n, true)), /malformed table of contents/, "layout");
    await refuse("a file extent past the end", retoc(n, (b, dv) => dv.setBigUint64(rec + 16, BigInt(b.length), true)), /file "blob\.bin" out of bounds/, "layout");
    await refuse("a file extent before the data region", retoc(n, (_, dv) => dv.setBigUint64(rec + 16, 0x80n, true)), /file "blob\.bin" out of bounds/, "layout");
    await refuse("an unaligned extent", retoc(n, (_, dv) => dv.setBigUint64(rec + 16, dv.getBigUint64(rec + 16, true) + 1n, true)), /out of bounds/, "layout");
    await refuse("a raw file whose stored size is not its size", retoc(n, (_, dv) => dv.setBigUint64(file("0:romfs/hello.txt").record + 24, 5n, true)), /file "hello\.txt" out of bounds/, "layout");
    await refuse("an empty file with data", retoc(n, (_, dv) => dv.setBigUint64(file("0:romfs/empty.bin").record + 24, 16n, true)), /empty file "empty\.bin" with data/, "layout");
    await refuse("codec 2", retoc(n, b => { b[rec + 64] = 2; }), /file "blob\.bin" uses codec 2; this reads raw and zstd/, "layout");
    await refuse("codec flags", retoc(n, b => { b[rec + 65] = 1; }), /uses codec/, "layout");
    await refuse("a name out of the pool", retoc(n, (_, dv) => dv.setUint32(rec, 1 << 24, true)), /name out of bounds/, "layout");
    await refuse("a package of kind 9", retoc(n, b => { b[n.packageRecord(1) + 24] = 9; }), /package 1 of unknown kind 9/, "layout");
    await refuse("package flags", retoc(n, b => { b[n.packageRecord(0) + 25] = 2; }), /package 0 has reserved fields or flags set/, "layout");
    await refuse("a reserved package field", retoc(n, (_, dv) => dv.setUint32(n.packageRecord(2) + 28, 7, true)), /package 2 has reserved fields or flags set/, "layout");
    await refuse("a package root out of bounds", retoc(n, (_, dv) => dv.setUint32(n.packageRecord(0) + 8, 9999, true)), /package 0 out of bounds/, "layout");
    await refuse("a package romfs out of bounds", retoc(n, (_, dv) => dv.setUint32(n.packageRecord(0) + 16, 9999, true)), /package 0 out of bounds/, "layout");
    await refuse("a meta block past the end", retoc(n, (_, dv) => dv.setUint32(n.packageRecord(0) + 40, 0x7FFFFFFF, true)), /package 0 out of bounds/, "layout");
    await refuse("a folder past the slots", retoc(n, (_, dv) => dv.setUint32(n.dirRecord(0) + 12, 9999, true)), /folder "" out of bounds/, "layout");
    await refuse("a child slot out of bounds", retoc(n, (_, dv) => dv.setUint32(n.slotsOff, n.dirs + n.files, true)), /child \d+ out of bounds/, "layout");
    // a folder that is its own child: no walk ends there
    const romfs0 = new DataView(n.bytes.buffer).getUint32(n.packageRecord(0) + 16, true), firstSlot = new DataView(n.bytes.buffer).getUint32(n.dirRecord(romfs0) + 8, true);
    await refuse("a folder that holds itself", retoc(n, (_, dv) => dv.setUint32(n.slotsOff + 4 * firstSlot, romfs0, true)), /is listed twice/, "layout");
    // what scan refuses
    const v = () => version({ programId: APP }), w = (p: NupPackageIn[], o = {}) => writeNup(p, o).bytes;
    await refuse("two base packages", w([pkgOf(KIND.base, v()), pkgOf(KIND.base, v())]), /2 base packages/, "layout");
    await refuse("an update alone that is not marked standalone", w([pkgOf(KIND.update, v(), { version: 65536 })]), /no base game: pack the base game and its update into one NUP/, "layout");
    await refuse("a DLC alone", w([dlcPkg(1n, { x: "x" })]), /no base game/, "layout");
    await refuse("two updates of one version", w([pkgOf(KIND.base, v()), pkgOf(KIND.update, v(), { version: 5 }), pkgOf(KIND.update, v(), { version: 5 })]), /two updates of version 5/, "version");
    await refuse("an update of version 0", w([pkgOf(KIND.base, v()), pkgOf(KIND.update, v(), { version: 0 })]), /an update of version 0/, "version");
    await refuse("a DLC without romfs/", w([pkgOf(KIND.base, v()), { kind: KIND.addon, titleId: APP + 0x1001n, exefs: { x: "x" } }]), /DLC [0-9A-F]{16} has no romfs\//, "dlc");
    await refuse("a DLC twice", w([pkgOf(KIND.base, v()), dlcPkg(1n, { x: "x" }), dlcPkg(1n, { y: "y" })]), /DLC [0-9A-F]{16} more than once/, "dlc");
    for (const name of ["../sentinel", "nested/file", "..", "bad\0name"]) await refuse(`the ExeFS name ${JSON.stringify(name)}`, w([{ kind: KIND.base, titleId: APP, exefs: { ...split(v()).exefs, [name]: "overwritten" }, romfs: { a: "a" } }]), /invalid (ExeFS )?name/, "layout");
    // file data: a byte of a raw file and of a zstd frame changed; a frame cut short
    const lines: string[] = [];
    const data = async (what: string, key: string, path: string, change: (b: Uint8Array, e: { off: number; stored: number }) => void, codec: number) => {
      const e = file(key); assert.equal(e.codec, codec, what);
      const b = n.bytes.slice(); change(b, e);
      const t = await open(memBytes(b), "game.nup", lines);
      await assert.rejects(t.read(path, 0, e.size), /(does not match its size or SHA-256|zstd: .*) \(damaged file\)/, what);
      const dst = new Uint8Array(Math.min(16, e.size)), before = lines.length;
      assert.equal(t.readSync!(path, 0, dst), DEV.IO, what + " (sync)"); assert.match(lines[before], /^\[RED\] prepare: game\.nup: .* \(damaged file\)/);
      assert.deepEqual(await t.read("base/exefs/main.npdm", 0, 0x40), npdm({ programId: APP }).subarray(0, 0x40), "the other files still read");
      info.push(what);
    };
    await data("a byte of a raw file changed", "0:romfs/base-only.txt", "base/romfs/base-only.txt", (b, e) => { b[e.off + 3] ^= 0x20; }, 0);
    await data("a byte in the middle of a zstd frame changed", "0:romfs/data/blob.bin", "base/romfs/data/blob.bin", (b, e) => { b[e.off + (e.stored >> 1)] ^= 0x55; }, 1);
    await data("a zstd frame's last bytes zeroed", "1:exefs/main", "updates/65536/exefs/main", (b, e) => { b.fill(0, e.off + e.stored - 24, e.off + e.stored); }, 1);
    // ... and in the pipeline: the stage that reads the file fails with reason read, the red line names the file
    const bad = n.bytes.slice(), em = file("1:exefs/main"); bad[em.off + (em.stored >> 1)] ^= 1;
    const r = await prepareNup("damaged", bad), res = await r.prep.run(); r.close();
    assert.deepEqual([res.state, res.reason], ["Failed", "read"], res.error); assert.match(res.error!, /updates\/65536\/exefs\/main could not be read: damaged\.nup: main .*\(damaged file\)/);
    assert.equal(failureSentence(res.reason, res.error), "The file is damaged or incomplete. Copy or download it again.");
    return [`${info.length} refused: ${info.join("; ")}`, `in the pipeline: ${res.error}`];
  });

  test("the whole pipeline on a NUP: Detect, Index, Profile (by title ID, with a registered cut), Code, Shaders, Ready; the newest update is prepared, the game reads its RomFS out of the container (zstd frames decompressed on demand, checked against their SHA-256) and runs with the cut; version 0 is the base; the DLC is an add-on content device; the NACP gives name and display version; a second run skips all five stages and a changed file runs what depends on it", async () => {
    const b0 = blob(60_000, 7), b1 = blob(100_003, 8), fsg = guest("fsg"), w0 = newWasm();
    const at = c.imageOffsets(w0, fsg, ascii("MountRom: ")); assert.equal(at.length, 1);
    const profiles = memProfiles([c.profileFor(fsg, APP_HEX, [{ off: at[0], orig: hexOf(ascii("MountRom")), new: hexOf(ascii("MountROM")), why: "test" }], { needs: [{ key: "fps_target", value: "60", what: "frame rate" }] }, { sdk: "00".repeat(16) })]);
    const n = three(b0, b1);
    const r = await prepareNup("pipeline", n, { profiles });
    const states: string[] = []; (r.prep.o as any).onChange = (s: any) => { if (states.at(-1) !== s.state) states.push(s.state); };
    const res = await r.prep.run();
    assert.deepEqual([res.state, res.ran, res.skipped], ["Ready", [...STAGES], []], res.error);
    assert.deepEqual(states, ["Detect", "Index", "Profile", "Code", "Shaders", "Ready"]);
    const det = r.prep.out<DetectOut>("detect"), prof = r.prep.out<ProfileOut>("profile"), code = r.prep.out<CodeOut>("code"), idx = r.prep.out<IndexOut>("index");
    assert.deepEqual([det.layout, det.titleId, det.version, det.versions, det.root, det.modules.map(m => m.name), det.other, det.dlc.map(d => d.index)], ["base", APP_HEX, 65536, [0, 65536], "updates/65536/", ["main", "sdk"], [], [2]]);
    assert.deepEqual([idx.rom.root, idx.rom.files, idx.rom.dirs, idx.aoc.map(a => [a.index_, a.files])], ["updates/65536/romfs/", 3, 4, [[2, 3]]]);
    assert.deepEqual([prof.found, prof.by, prof.cuts.length, prof.load, prof.graphics.api], [true, "title", 1, ["main", "sdk"], "unknown"]);
    assert.deepEqual(code.modules.map(m => [m.name, m.from, m.cuts]), [["main", "store", 1], ["sdk", "folder", 0]]);
    assert.equal(det.control, null, "the update package carries no control data and there is a base game: nothing is borrowed");
    const p = await c.play(r);
    assert.deepEqual([p.kind, p.code, p.red], ["exit", 0, []]);
    assert.equal(p.stdout, "lib: DT_INIT\nlib: init_array[0]\nlib: init_array[1]\n" + c.fsgFirst(b1, "MountROM: ") + "lib: fini_array[0]\nlib: DT_FINI\n");
    const st = { ...r.tree.reader.stats };
    assert.ok(st.inflated >= 3 && st.verified >= 4, JSON.stringify(st));
    // the DLC device: every file back through the device
    const h = await r.prep.handoff(), aoc = h.aoc.get(2) as DirRomDevice, img = new Uint8Array(aoc.size());
    assert.equal(aoc.readSync!(0, img), DEV.OK);
    const ai = aoc.index; let found = 0;
    for (const want of [blob(3000, 3), blob(17, 4), ascii("dlc")]) for (let i = 0; i < ai.sizes.length; i++) if (ai.sizes[i] === want.length && Buffer.compare(img.subarray(ai.starts[i], ai.starts[i] + want.length), want) === 0) found++;
    assert.equal(found, 3, "the three DLC files are in the device's image");
    // a second run on the unchanged container: everything is kept, and no file data is read to decide
    const r2 = await prepareNup("pipeline", n, { profiles, keepStore: true }), read0 = r2.src.bytesRead;
    const res2 = await r2.prep.run();
    assert.deepEqual([res2.state, res2.ran, res2.skipped], ["Ready", [], [...STAGES]]);
    const decided = r2.src.bytesRead - read0;
    assert.equal(decided, 0, "the stages' hashes are made from the table of contents");
    assert.equal((await c.play(r2)).stdout.includes("MountROM: 0x0"), true);
    // version 0: the base game, with the base package's NACP
    const rb = await prepareNup("pipeline-base", n, { profiles, version: 0 }); assert.equal((await rb.prep.run()).state, "Ready");
    const detb = rb.prep.out<DetectOut>("detect"), profb = rb.prep.out<ProfileOut>("profile");
    assert.deepEqual([detb.version, detb.root, detb.control, profb.display], [0, "base/", { name: "Test Game", publisher: "Test Publisher", displayVersion: "1.2.3", icon: true }, "1.0.0"]);
    assert.deepEqual((await rb.tree.control("base/"))!.icon, ICON);
    assert.equal((await c.play(rb)).stdout, c.fsgFirst(b0, "MountROM: "));
    // a container whose update RomFS differs in one file's content: Index runs (the file's identity in the listing is its hash); the tables are the same, so nothing after it does
    const n3 = three(b0, blob(100_003, 9));
    const r3 = await prepareNup("pipeline", n3, { profiles, keepStore: true }), res3 = await r3.prep.run();
    assert.deepEqual([res3.state, res3.ran, res3.skipped], ["Ready", ["index"], ["detect", "profile", "code", "shaders"]]);
    assert.equal((await c.play(r3)).stdout.includes(`rom:/data/blob.bin: 100003 bytes of 100003`), true);
    for (const x of [r, r2, rb, r3]) x.close();
    return [`states ${states.join(" > ")}; the guest printed ${JSON.stringify(p.stdout.split("\n")[3])} and read the update's ${b1.length}-byte blob out of a ${n.bytes.length}-byte container`,
      `reader: ${JSON.stringify(st)}`, `second run: 5 stages kept, ${decided} bytes of the container read to decide`];
  });

  test("a NUP whose main is ZBIC compressed (NSO flag bit 7, system 22.0.0 on): the container's file is unpacked for the build ID and the checks, handed to the loader as it is, and the game runs; with a registered cut the cut module is stored", async () => {
    const b = blob(50_000, 3), z = guest("fsg_zbic");
    assert.equal(new DataView(z.buffer, z.byteOffset).getUint32(0x0C, true) & 0x87, 0x87);
    const n = writeNup([pkgOf(KIND.base, version({ programId: APP, blob: b, main: "fsg_zbic" }), { meta: META })]);
    const r = await prepareNup("zbic", n);
    const res = await r.prep.run();
    assert.deepEqual([res.state, res.ran], ["Ready", [...STAGES]], res.error);
    const code = r.prep.out<CodeOut>("code");
    assert.deepEqual(code.modules.map(m => [m.name, m.from, m.cuts, m.size]), [["main", "folder", 0, z.length]]);
    const h = await r.prep.handoff();
    assert.equal(Buffer.compare(await h.modules[0].bytes(), z), 0, "the module handed over is the container's ZBIC file");
    const p = await c.play(r);
    assert.deepEqual([p.kind, p.code, p.red], ["exit", 0, []]);
    assert.equal(p.stdout, c.fsgFirst(b));
    r.close();
    const at = c.imageOffsets(newWasm(), z, ascii("MountRom: "));
    const profiles = memProfiles([c.profileFor(z, APP_HEX, [{ off: at[0], orig: hexOf(ascii("MountRom")), new: hexOf(ascii("MountROM")), why: "test" }])]);
    const r2 = await prepareNup("zbic", n, { profiles });
    assert.equal((await r2.prep.run()).state, "Ready");
    assert.deepEqual(r2.prep.out<CodeOut>("code").modules.map(m => [m.name, m.from, m.cuts]), [["main", "store", 1]]);
    const p2 = await c.play(r2);
    assert.deepEqual([p2.kind, p2.code, p2.red, p2.stdout], ["exit", 0, [], c.fsgFirst(b, "MountROM: ")]);
    r2.close();
    return [`main: ${z.length} bytes in the container, an image of ${code.modules[0].imageSize}`];
  });

  test("NUP variants: an update without romfs/ runs with the base game's; a standalone update without a base (no base record, or a base record with no files) is the whole game and says so, its name and icon come from the application record; an update that is not whole is refused; packages of other kinds are named and not used; no profile: provisional with the NACP's name", async () => {
    const b0 = blob(40_000, 1), info: string[] = [];
    // an update of code only
    const a = await prepareNup("noromfs", writeNup([pkgOf(KIND.base, version({ programId: APP, blob: b0 }), { meta: META }), { kind: KIND.update, titleId: APP, version: 131072, exefs: split(version({ programId: APP })).exefs }]));
    assert.equal((await a.prep.run()).state, "Ready");
    const da = a.prep.out<DetectOut>("detect");
    assert.deepEqual([da.version, da.root, a.prep.out<IndexOut>("index").rom.root], [131072, "updates/131072/", "updates/131072/romfs/"]);
    assert.match(da.notes.join("|"), /update 131072\) has no romfs\/: it runs with the base game's/);
    assert.equal((await c.play(a)).stdout, c.fsgFirst(b0)); a.close();
    info.push("an update without romfs/: the game read the base's blob");
    // standalone updates, the newest prepared; the first package's meta is the application's
    const b2 = blob(50_001, 2);
    const solo = [pkgOf(KIND.update, version({ programId: APP, blob: b0 }), { version: 65536, meta: tlv([[T.NAME, "TG"], [T.NACP, nacp("Test Game", "テス", "1.2.3", "Test Publisher")]]) }), pkgOf(KIND.update, version({ programId: APP, blob: b2 }), { version: 65537, meta: tlv([[T.LICONS, localizedIcons([["ja", Uint8Array.from([9, 9])], ["en-US", Uint8Array.from([0x89, 0x50, 1])]])]]) }), dlcPkg(1n, { "dlc.txt": "one" })];
    const s = await prepareNup("standalone", writeNup(solo, { updateFlags: STANDALONE }));
    assert.equal((await s.prep.run()).state, "Ready");
    const ds = s.prep.out<DetectOut>("detect"), ps = s.prep.out<ProfileOut>("profile");
    assert.deepEqual([ds.layout, ds.version, ds.versions, ds.dlc.map(d => d.index), ds.notes], ["update only", 65537, [65536, 65537], [1], [NO_BASE]]);
    assert.deepEqual([ds.control, ps.name, ps.display, ps.provisional], [{ name: "Test Game", publisher: "Test Publisher", displayVersion: "1.2.3", icon: true }, "Test Game", "1.2.3", true]);
    const ctl = (await s.tree.control("updates/65537/"))!;
    assert.deepEqual([[...ctl.icon!], ctl.iconType], [[0x89, 0x50, 1], "image/png"], "the update's own localized icon (en-US of two); the name is the application record's");
    assert.ok(ps.warnings.includes(NO_BASE));
    const h = await s.prep.handoff(); assert.deepEqual([h.name, h.displayVersion, h.version], ["Test Game", "1.2.3", 65537]);
    assert.equal((await c.play(s)).stdout, c.fsgFirst(b2)); s.close();
    info.push("standalone updates: the newest is the whole game; name, display version and icon from the control data");
    await assert.rejects(prepareNup("standalone-clear", writeNup(solo)), /no base game/);
    // a base record with no files (title ID 0), the update's flag clear, as an older packer left it
    const e = await prepareNup("emptybase", writeNup([{ kind: KIND.base, titleId: 0n, meta: META }, pkgOf(KIND.update, version({ programId: APP, blob: b0 }), { version: 655360 })]));
    assert.equal((await e.prep.run()).state, "Ready");
    const de = e.prep.out<DetectOut>("detect");
    assert.deepEqual([de.layout, de.version, de.versions, de.control?.name, de.notes], ["update only", 655360, [655360], "Test Game", [NO_BASE]]); e.close();
    info.push("a base record with no files is no base game");
    // an update that is not whole, with no base
    const part = await prepareNup("partial", writeNup([{ kind: KIND.update, titleId: APP, version: 7, exefs: split(version({ programId: APP })).exefs }], { updateFlags: STANDALONE })), rp = await part.prep.run(); part.close();
    assert.deepEqual([rp.state, rp.reason], ["Failed", "layout"]);
    // asked for a version that is not there; version 0 with no base
    const nv = await prepareNup("standalone", writeNup(solo, { updateFlags: STANDALONE }), { version: 0 }), rv = await nv.prep.run(); nv.close();
    assert.deepEqual([rv.state, rv.reason], ["Failed", "version"]); assert.match(rv.error!, /no base game \(base\/\), only updates 65536, 65537/);
    // other package kinds
    const o = await prepareNup("kinds", writeNup([pkgOf(KIND.base, version({ programId: APP, blob: b0 })), { kind: KIND.addon_update, titleId: APP + 0x1001n, version: 3, romfs: { x: "x" } }, { kind: KIND.system, titleId: 1n, romfs: { y: "y" } }]));
    assert.equal((await o.prep.run()).state, "Ready");
    assert.deepEqual(o.prep.out<DetectOut>("detect").notes, ["kinds.nup (addon_update): packages of this kind are not used", "kinds.nup (system): packages of this kind are not used"]);
    assert.deepEqual((await o.tree.list()).files.map(f => f.path), ["base/exefs/main", "base/exefs/main.npdm", "base/romfs/data/blob.bin", "base/romfs/hello.txt"]); o.close();
    // a DLC of another game is the pipeline's to refuse, as for a folder
    const od = await prepareNup("otherdlc", writeNup([pkgOf(KIND.base, version({ programId: APP })), { kind: KIND.addon, titleId: APP + 0x5000n, romfs: { x: "x" } }])), rod = await od.prep.run(); od.close();
    assert.deepEqual([rod.state, rod.reason], ["Failed", "dlc"]);
    // a 32-bit program
    const a32 = await prepareNup("arm32", writeNup([pkgOf(KIND.base, version({ programId: APP, is64: false }))])), r32 = await a32.prep.run(); a32.close();
    assert.deepEqual([r32.state, r32.reason, failureSentence(r32.reason, r32.error)], ["Failed", "arch", "This is a 32-bit game. nxweb only runs 64-bit games."]);
    // the NACP reader
    assert.deepEqual(await nacpTitle(nacp("Name", "名", "2.0.1", "Pub")), { name: "Name", publisher: "Pub", display: "2.0.1" });
    assert.deepEqual(await nacpTitle(nacp("", "名前", "x")), { name: "名前", publisher: "", display: null }, "the first non-empty language");
    assert.equal(await nacpTitle(new Uint8Array(0x4000)), null);
    return info;
  });

  test("a NUP's RomFS in a hand-off message (what the page posts to the Worker): the container's one File and the records of the files, read back through the device and checked; memory stays bounded: the small cache and one large file, whatever is read", async () => {
    const big = [blob(SMALL_MAX + 300_000, 21), blob(SMALL_MAX + 500_000, 22)], small = Array.from({ length: 24 }, (_, i) => blob(2_000_000 + i, 30 + i)), raw = blob(WHOLE_MAX + 4096, 60);
    const rom: Files = { "big/0.bin": big[0], "big/1.bin": big[1], "raw/large.bin": raw, "hello.txt": "hi" };
    small.forEach((b, i) => { rom[`small/${String(i).padStart(2, "0")}.bin`] = b; });
    const n = writeNup([{ kind: KIND.base, titleId: APP, exefs: split(version({ programId: APP })).exefs, romfs: rom }], { compress: (p, d) => d.length >= 200 && !p.startsWith("romfs/raw/") });
    const w = newWasm(), lines: string[] = [];
    const tree = await NupTree.open(blobBytes(new Blob([n.bytes as BlobPart]), false), "msg.nup", { sha256: b => w.sha256(b) });
    const prep = new Prepare({ wasm: newWasm(), tree, store: new MemStore(), profiles: noProfiles });
    assert.equal((await prep.run()).state, "Ready");
    const msg = await (await prep.handoff()).message();
    assert.deepEqual([msg.rom!.files.length, msg.rom!.nup!.name, msg.rom!.nup!.sha.length, msg.rom!.sizes.length, msg.modules.map(m => [m.name, m.file instanceof Blob])], [0, "msg.nup", 28, 28, [["main", true]]]);
    assert.deepEqual(new Uint8Array(await msg.modules[0].file.arrayBuffer()), guest("fsg"), "a compressed module travels as its bytes");
    // the receiving side: the device over the message, every file whole and in pieces
    const dev = romFromMessage(msg.rom!, { sha256: b => w.sha256(b), log: l => lines.push(l) }), ix = dev.index, src = (dev as any).src.reader as NupReader;
    const paths = (await tree.list()).files.filter(f => f.path.startsWith("base/romfs/")).map(f => f.path.slice(11));
    let peak = 0, total = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < paths.length; i++) {
      const want = typeof rom[paths[i]] === "string" ? ascii(rom[paths[i]] as string) : rom[paths[i]] as Uint8Array;
      const got = pass === 0 ? await dev.readAsync(ix.starts[i], ix.sizes[i]) : await dev.readAsync(ix.starts[i] + Math.min(100, want.length - 1), Math.min(5000, want.length - 1 - Math.min(100, want.length - 1)));
      assert.equal(Buffer.compare(got, pass === 0 ? want : want.subarray(Math.min(100, want.length - 1), Math.min(100, want.length - 1) + got.length)), 0, `${paths[i]} pass ${pass}`);
      peak = Math.max(peak, src.stats.peakCache); total += got.length;
    }
    assert.ok(peak <= SMALL_CACHE + big[1].length, `peak ${peak}`);
    assert.ok(small.reduce((a, b) => a + b.length, 0) > SMALL_CACHE, "the small files together are more than the small cache");
    assert.deepEqual(lines, []);
    assert.ok(src.stats.verified >= 27 && src.stats.rangeReads >= 2, JSON.stringify(src.stats));
    // without a hash function the files are read unchecked (and it says so nowhere: the caller chose)
    const plain = romFromMessage(msg.rom!); assert.equal((await plain.readAsync(ix.starts[0], 16)).length, 16);
    return [`28 files, ${(n.bytes.length / 2 ** 20).toFixed(1)} MB container, ${(total / 2 ** 20).toFixed(1)} MB read through the device in two passes; cache peak ${(peak / 2 ** 20).toFixed(1)} MB (the bound: ${(SMALL_CACHE / 2 ** 20)} MB of small files and one large one)`, `reader: ${JSON.stringify(src.stats)}`];
  });

  test("the NUP reader against nxnative's own (scripts/pack_nup.py, its Nup class): for the same containers, the packages, every file's path, size and bytes, the folders and the meta records are equal; the damaged ones are refused by both", async () => {
    const nx = process.env.NXNATIVE ?? "/home/user/nxnative";
    if (!existsSync(join(nx, "scripts", "pack_nup.py"))) return [`SKIPPED: no nxnative checkout at ${nx} (NXNATIVE names another)`];
    const b0 = blob(60_000, 7), n = three(b0, blob(100_003, 8));
    const solo = writeNup([pkgOf(KIND.update, version({ programId: APP, blob: b0 }), { version: 65536, meta: META }), dlcPkg(1n, { "dlc.txt": "one", "a/b/c/d.bin": blob(900, 3) })], { updateFlags: STANDALONE });
    const rawOnly = writeNup([pkgOf(KIND.base, version({ programId: APP, blob: b0 }))], { compress: () => false });
    const rec = n.extents.get("0:romfs/data/blob.bin")!.record;
    const cases: [string, Uint8Array, boolean][] = [["base + update + DLC", n.bytes, true], ["standalone update + DLC", solo.bytes, true], ["raw files only", rawOnly.bytes, true],
      ["bad magic", (() => { const b = n.bytes.slice(); b[1] = 0; return b; })(), false], ["truncated", n.bytes.subarray(0, n.bytes.length - 64), false], ["TOC hash", (() => { const b = n.bytes.slice(); b[n.tocOff + 50] ^= 4; return b; })(), false],
      ["record out of bounds", retoc(n, (b, dv) => dv.setBigUint64(rec + 16, BigInt(b.length), true)), false], ["reserved package field", retoc(n, (_, dv) => dv.setUint16(n.packageRecord(0) + 26, 1, true)), false],
      ["file data changed", (() => { const b = n.bytes.slice(), e = n.extents.get("0:romfs/data/blob.bin")!; b[e.off + 40] ^= 1; return b; })(), false]];
    const dir = join(SCRATCH, "nupref"); mkdirSync(dir, { recursive: true });
    const files = cases.map(([, b], i) => { const f = join(dir, `c${i}.nup`); writeFileSync(f, b); return f; });
    const out = execFileSync("python3", [join(ROOT, "tools", "prepare", "nup_reference.py"), nx, ...files], { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").map(l => JSON.parse(l));
    if (out[0].skip) return [`SKIPPED: ${out[0].skip}`];
    assert.equal(out.length, cases.length);
    const w = newWasm(), info: string[] = [];
    {
      let compared = 0;
      for (let i = 0; i < cases.length; i++) {
        const [what, bytes, good] = cases[i], ref = out[i];
        let mine: any = { error: null, packages: [] };
        try {
          const nup = await Nup.open(memBytes(bytes), "<file>", b => w.sha256(b)), reader = new NupReader(memBytes(bytes), nup.files, "<file>", { sha256: b => w.sha256(b) });
          scanNup(nup);
          for (const k of nup.packages) {
            const list = async (d: number) => { const x = nup.walk(d), fs: [string, number, string][] = []; for (const f of x.files) fs.push([f.path, nup.files[f.i].size, sha(await reader.read(f.i, 0, nup.files[f.i].size))]); return { fs: fs.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))), dirs: x.dirs.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) }; };
            const ex = k.exefs !== 0xFFFFFFFF ? await list(k.exefs) : null, rom = k.romfs !== 0xFFFFFFFF ? await list(k.romfs) : null;
            mine.packages.push({ kind: k.kind, title_id: k.titleId.toString(16).toUpperCase().padStart(16, "0"), version: k.version, flags: k.flags, exefs: ex?.fs ?? null, romfs: rom?.fs ?? null, dirs: rom?.dirs ?? null,
              meta: Object.fromEntries([...(await nup.meta(k))].sort((a, b) => a[0] - b[0]).map(([t, v]) => [String(t), sha(v)])) });
            compared += (ex?.fs.length ?? 0) + (rom?.fs.length ?? 0);
          }
        } catch (e) { mine = { error: (e as Error).message, packages: [] }; }
        if (good) { assert.equal(ref.error, null, what); for (const p of ref.packages) { p.exefs?.sort(); } assert.deepEqual(mine, ref, what); }
        else {
          assert.ok(ref.error && mine.error, `${what}: nxnative ${ref.error}, here ${mine.error}`);
          // the same sentence after the file's name (numbers are grouped the same way)
          if (what !== "file data changed") assert.equal(mine.error.replace(/^<file>: /, "").replace(/"([^"]*)"/g, "b'$1'"), ref.error.replace(/^<file>: /, ""), what);
        }
        info.push(`${what}: ${good ? `${mine.packages.length} packages equal` : "refused by both: " + mine.error.replace(/^<file>: /, "")}`);
      }
      return [`${compared} files compared byte for byte (by SHA-256 of what each reader gives)`, ...info];
    }
  });

  test("the verdict card's sentences: every converted profile gives 'should start' or 'can't run' with its reason (the 14 that do not fit a tab's memory say how much they need); no profile is 'might start'; a main that imports OpenGL or Vulkan and not NVN can't run; files that are not games are explained by their first bytes", async () => {
    const profiles = nodeProfiles(), index = await profiles.index(), counts = { ok: 0, maybe: 0, no: 0 }, short: string[] = [];
    const det = { titleId: APP_HEX, version: 0 } as DetectOut;
    const profOut = (p: Profile | null, more: Partial<ProfileOut> = {}): ProfileOut => ({ found: !!p, by: p ? "title" : null, id: p?.title_id ?? null, name: p?.name ?? "x", provisional: !p, registered: !!p, unregistered: [], display: null, apply: p?.apply ?? {}, needs: p?.needs ?? [], unconverted: p?.unconverted ?? [], load: ["main"], cuts: [], match: [],
      space: p?.address_space ? { heap_region: p.address_space.heap_region, alias_region: p.address_space.alias_region, stack_region: p.address_space.stack_region } : null, layout: p?.address_space?.fit ? { fit: p.address_space.fit, note: p.address_space.note ?? "" } : null,
      pool: Number(p?.apply.app_pool ?? 0xCD500000), graphics: { api: "nvn", names: ["nvnBootstrapLoader"] }, warnings: [], ...more });
    for (const id of Object.keys(index.games)) {
      const p = (await profiles.game(id))!, v = verdictFor(det, profOut(p));
      counts[v.level]++;
      assert.ok(v.reason.length > 10 && v.reason.length < 140 && !/0x|heap_region|undefined|NaN/.test(v.reason), `${id}: ${v.reason}`);
      if (p.address_space?.fit === "short") { assert.equal(v.level, "no", id); assert.match(v.reason, /^This game (needs about \d+(\.\d)? GB of memory|sets aside about \d+(\.\d)? GB of address space)\. A browser tab can give it 4 GB\.$/, id); short.push(v.reason); assert.ok(v.details.some(d => d.startsWith("memory: the profile reserves")), id); }
      for (const g of v.gaps) assert.ok(!/undefined/.test(g) && g.length > 10, g);
    }
    assert.equal(counts.no >= 14 && short.length === 14, true, JSON.stringify(counts));
    assert.equal(short.filter(s => s === "This game needs about 9 GB of memory. A browser tab can give it 4 GB.").length, 11, "the eleven with a 9 GB pool");
    const none = verdictFor(det, profOut(null));
    assert.deepEqual([none.level, none.headline, none.reason], ["maybe", "Might start", "There is no profile for this game, so it runs with default settings."]);
    const gl = verdictFor(det, profOut(null, { graphics: { api: "gl", names: ["eglInitialize"] } }));
    assert.deepEqual([gl.level, gl.headline, gl.reason], ["no", "Can't run in a browser yet", "This game uses OpenGL; nxweb only draws NVN, the graphics interface most games use."]);
    assert.equal(verdictFor(det, profOut(null, { graphics: { api: "vulkan", names: ["vkCreateInstance"] } })).reason, "This game uses Vulkan; nxweb only draws NVN, the graphics interface most games use.");
    // main's imports, from a module's bytes
    const names = (l: string[]) => ascii("\0" + l.join("\0") + "\0");
    assert.deepEqual([graphicsOf(names(["malloc", "nvnBootstrapLoader"])).api, graphicsOf(names(["eglInitialize", "eglGetDisplay"])).api, graphicsOf(names(["vkCreateInstance"])).api, graphicsOf(names(["eglInitialize", "nvnBootstrapLoader"])).api, graphicsOf(names(["xnvnBootstrapLoader", "vkCreateInstanceX"])).api],
      ["nvn", "gl", "vulkan", "nvn", "unknown"]);
    const far = new Uint8Array((8 << 20) + 40); far.set(names(["vkCreateDevice"]), (8 << 20) - 5); assert.equal(graphicsOf(far).api, "vulkan", "a name across the scan's window boundary");
    // files
    const head = (s: string, at = 0) => { const b = new Uint8Array(0x200); b.set(ascii(s), at); return b; };
    const kinds: [string, Uint8Array, string, RegExp][] = [
      ["game.nup", head("NUP\u0001"), "nup", /NUP/], ["Game.nsp", head("PFS0"), "package", /^This is an encrypted game package/], ["Game.xci", head("HEAD", 0x100), "package", /encrypted game package/], ["Game.nsz", head("PFS0"), "package", /encrypted/], ["Game.XCZ", head("xx"), "package", /encrypted/],
      ["x.nca", head("zz"), "nca", /encrypted piece/], ["main", head("NSO0"), "nso", /one code file of a game, not the whole game/], ["app.nro", head("NRO0", 0x10), "nro", /homebrew program/], ["Game.zip", head("PK\u0003\u0004"), "zip", /zip archive/], ["Game.7z", head("7z"), "archive", /compressed archive/],
      ["RomFS.img", head("DMROMFS1"), "nxnative-romfs", /made by nxnative/], ["game.romfs", head("P"), "romfs", /data image, without its code/], ["sdk", head("????"), "nso", /one file from a game's exefs folder/], ["notes.txt", head("hello"), "unknown", /doesn't know this kind of file/], ["broken.nup", head("NOPE"), "unknown", /not a \.nup file nxweb can read/]];
    for (const [name, h, kind, re] of kinds) { const x = explainFile(name, h, 5000); assert.equal(x.kind, kind, name); assert.match(x.title, re, name); if (kind !== "nup") assert.ok(x.text.length > 20, name); }
    assert.equal(explainFile("Game.nsp", head("PFS0"), 1).text, "nxweb can't open those yet. Convert it to a .nup or an extracted folder with the tool you dumped it with.");
    assert.equal(explainFile("a.bin", new Uint8Array(0), 0).kind, "empty");
    return [`${Object.keys(index.games).length} profiles: ${counts.ok} should start, ${counts.no} can't run in a browser yet (14 for memory); ${[...new Set(short)].join(" | ")}`];
  });
}
