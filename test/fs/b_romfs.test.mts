// RomFS images: mounting, paths, reads, listings, checked against tools/mkromfs.py's independent reader; images
// larger than 4 GB through a sparse file; damaged images.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, both, Fs, R, MODE, KIND, SCRATCH, python, rng, BEYOND, type Entry } from "./harness.mts";
import { MemStorage, MemDevice, DEV, type FsDevice } from "../../src/glue/fs_host.ts";
import { NodeStorage } from "../../src/glue/fs_dev_node.ts";

interface Row { path: string; type: "d" | "f"; size: number; sha256?: string; stamps?: [number, string][] }
const ls = (img: string): Row[] => python(["ls", img]).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
const lat = (hex: string) => Buffer.from(hex, "hex").toString("latin1");
const img = (name: string) => join(SCRATCH, name);
// Whether a row's directory can be listed: its path is under nxnative's 1024 bytes
const listable = (r: Row) => { const p = lat(r.path), cut = p.lastIndexOf("/"); return `rom:/${cut < 0 ? "" : p.slice(0, cut)}`.length < 1024; };
const node = (rom: string, async = false) => new Fs(new NodeStorage({ rom, saveDir: join(SCRATCH, "unused") }), { async });

// Everything under rom:/ by listing, as "path -> Entry" (paths as latin1); directories whose path is too long to
// name (nxnative: 1024 bytes) are counted, not entered
async function walk(fs: Fs, mount = "rom"): Promise<{ seen: Map<string, Entry>; tooLong: number }> {
  const seen = new Map<string, Entry>();
  let tooLong = 0;
  const go = async (dir: string): Promise<void> => {
    const full = `${mount}:/${dir}`;
    const es = await fs.list(full, 3, 9);
    if (!es) { assert.ok(full.length >= 1024, `cannot list ${full}`); tooLong++; return; }
    for (const e of es) {
      const p = dir ? `${dir}/${e.name.toString("latin1")}` : e.name.toString("latin1");
      assert.ok(!seen.has(p), `${p} listed twice`);
      seen.set(p, e);
      if (e.type === 0) await go(p);
    }
  };
  await go("");
  return { seen, tooLong };
}

both("romfs: a generated tree (deep, non-ASCII names, empty files) reads exactly as the Python reader reads it", async (async) => {
  const file = img(`gen${+async}.img`);
  const made = JSON.parse(python(["synth", file, "--seed", "11", "--files", "500", "--dirs", "80", "--depth", "14", "--max-size", "30000", "--nonascii"]));
  const rows = ls(file);
  assert.equal(rows.length, made.dirs - 1 + made.files);
  const fs = node(file, async);
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK);
  const { seen, tooLong } = await walk(fs);
  let reachable = 0, empty = 0, nonAscii = 0, deepest = 0;
  for (const r of rows) {
    const p = lat(r.path), full = `rom:/${p}`;
    deepest = Math.max(deepest, p.split("/").length);
    if (/[^\x20-\x7e]/.test(p)) nonAscii++;
    const [tr, type] = await fs.entryType(full);
    if (full.length >= 1024) { assert.equal(tr, R.FAIL, "a path of 1024 bytes or more is refused"); continue; }
    reachable++;
    assert.equal(tr, R.OK, full); assert.equal(type, r.type === "d" ? 0 : 1);
    const e = seen.get(p);
    assert.ok(e, `${full} is not listed`);
    assert.equal(e.type, r.type === "d" ? 0 : 1); assert.equal(e.size, r.size);
    const [or, h] = await fs.open(full);
    if (r.type === "d") { assert.equal(or, R.NOT_FOUND); assert.equal(h, 0n); continue; }
    assert.equal(or, R.OK);
    assert.deepEqual(await fs.size(h), [R.OK, r.size]);
    const [rr, data] = await fs.read(h, 0, r.size + 100);
    assert.equal(rr, R.OK); assert.equal(data.length, r.size);
    assert.equal(createHash("sha256").update(data).digest("hex"), r.sha256, full);
    if (!r.size) empty++;
    await fs.close(h);
    assert.equal((await fs.openDir(full))[0], R.NOT_FOUND, "a file is no directory");
  }
  assert.equal(seen.size, rows.filter(listable).length, "nothing listed that the reader does not have");
  assert.ok(empty > 10 && nonAscii > 50 && deepest >= 14, `empty ${empty}, non-ASCII ${nonAscii}, depth ${deepest}`);
  assert.equal(fs.x.fs_open_files(), 0); assert.equal(fs.x.fs_open_dirs(), 0);
  assert.deepEqual(fs.red, []);
  console.log(`     ${rows.length} entries (${reachable} with a path under 1024 bytes, ${tooLong} directories beyond it), ${empty} empty files, ${nonAscii} non-ASCII paths, depth ${deepest}`);

  // reads at offsets, across the end and past it, against the reader
  const files = rows.filter(r => r.type === "f" && `rom:/${lat(r.path)}`.length < 1024), rnd = rng(5);
  const reqs: [string, number, number][] = [];
  for (let i = 0; i < 400; i++) {
    const r = rnd.pick(files), k = rnd.int(5);
    const off = k === 0 ? 0 : k === 1 ? r.size : k === 2 ? r.size + rnd.int(50) : rnd.int(r.size + 1);
    reqs.push([r.path, off, k === 3 ? r.size : rnd.int(r.size + 300)]);
  }
  writeFileSync(img("reqs.json"), JSON.stringify(reqs));
  const want = python(["readat", file, img("reqs.json")]).trim().split("\n");
  for (let i = 0; i < reqs.length; i++) {
    const [p, off, len] = reqs[i];
    const [, h] = await fs.open(`rom:/${lat(p)}`);
    const [rr, data] = await fs.read(h, off, len);
    assert.equal(rr, R.OK);
    assert.equal(data.toString("hex"), want[i] === "-" ? "" : want[i], `${lat(p)} @${off}+${len}`);
    const [er] = await fs.readExact(h, off, len);
    assert.equal(er, data.length === len ? R.OK : R.FAIL, "ReadFile without the bytes-read output fails on a short read");
    await fs.close(h);
  }
});

both("romfs: thousands of files, one directory with thousands; listing modes and entry counts", async (async) => {
  const file = img(`many${+async}.img`);
  python(["synth", file, "--seed", "4", "--files", "7000", "--dirs", "0", "--max-size", "40"]);
  const rows = ls(file);
  assert.equal(rows.length, 7000);
  const fs = node(file, async);
  assert.equal(await fs.mount("MountRom1", "rom"), R.OK);
  const all = (await fs.list("rom:/", 3, 64))!;
  assert.equal(all.length, 7000);
  assert.deepEqual(all.map(e => e.name.toString("latin1")).sort(), rows.map(r => lat(r.path)).sort());
  assert.equal((await fs.list("rom:/", 1))!.length, 0, "mode 1: directories only");
  assert.equal((await fs.list("rom:/", 2, 1000))!.length, 7000, "mode 2: files only");
  const [, h] = await fs.openDir("rom:/", 2);
  assert.deepEqual(await fs.dirCount(h), [R.OK, 7000]);
  assert.equal((await fs.readDir(h, 10))[1].length, 10);
  assert.deepEqual(await fs.dirCount(h), [R.OK, 7000], "the count does not move the read position, nor depend on it");
  assert.equal((await fs.readDir(h, 0))[1].length, 0);
  assert.equal((await fs.readDir(h, -1))[1].length, 0);
  let rest = 0; for (;;) { const [, es] = await fs.readDir(h, 999); if (!es.length) break; rest += es.length; }
  assert.equal(rest, 6990);
  await fs.call("CloseDirectory", h);
  for (const r of [rows[0], rows[3500], rows[6999]]) {
    const d = await fs.getFile(`rom:/${lat(r.path)}`);
    assert.equal(createHash("sha256").update(d!).digest("hex"), r.sha256);
  }
  // a tree with many directories too
  const file2 = img(`many2${+async}.img`);
  const made = JSON.parse(python(["synth", file2, "--seed", "9", "--files", "3000", "--dirs", "700", "--depth", "6", "--max-size", "16"]));
  const fs2 = node(file2, async);
  await fs2.mount("MountRom", "rom", 0, 0);
  const { seen } = await walk(fs2);
  const rows2 = ls(file2);
  assert.equal(rows2.length, made.dirs - 1 + made.files);
  assert.equal(seen.size, rows2.filter(listable).length);
  for (const r of rows2.filter(listable)) assert.equal(seen.get(lat(r.path))?.size, r.size);
});

both("romfs: a file larger than 4 GB (sparse image, never in memory): size, reads beyond 2^32, across the end", async (async) => {
  const file = img(`big${+async}.img`), SIZE = 5368709123;
  python(["synth", file, "--seed", "2", "--files", "20", "--dirs", "3", "--virtual", `big.bin:${SIZE}`, "--virtual", `d/second.bin:${4294967296 + 77}`]);
  const rows = ls(file);
  const fs = node(file, async);
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK);
  for (const r of rows.filter(r => r.stamps)) {
    const p = `rom:/${lat(r.path)}`;
    const [or, h] = await fs.open(p);
    assert.equal(or, R.OK);
    assert.deepEqual(await fs.size(h), [R.OK, r.size]);
    assert.ok(r.size > 0xFFFFFFFF && r.stamps!.length >= 6);
    for (const [off, hex] of r.stamps!) {
      const [rr, d] = await fs.read(h, off, 8);
      assert.equal(rr, R.OK); assert.equal(d.toString("hex"), hex, `${p} @${off}`);
      const want = Buffer.alloc(8); want.writeBigUInt64LE(BigInt(off) ^ 0x5A5A5A5A5A5A5A5An);
      assert.deepEqual(d, want);
    }
    assert.deepEqual((await fs.read(h, r.size - 3, 100))[1], Buffer.from(r.stamps!.at(-1)![1], "hex").subarray(5), "across the end");
    assert.equal((await fs.read(h, r.size, 100))[1].length, 0);
    assert.equal((await fs.read(h, r.size + 2 ** 33, 100))[1].length, 0);
    assert.deepEqual((await fs.read(h, 2 ** 32 - 4, 8))[1], Buffer.from("000000005a5a5a5a", "hex"), "four bytes of the hole, then the stamp at 2^32");
    assert.deepEqual((await fs.read(h, 2 ** 32 + 8, 8))[1], Buffer.alloc(8), "the hole after 2^32");
    assert.equal((await fs.readExact(h, r.size - 3, 4))[0], R.FAIL);
    await fs.close(h);
    const dir = p.slice(0, p.lastIndexOf("/") + 1);
    const e = (await fs.list(dir))!.find(e => e.name.toString("latin1") === p.slice(dir.length))!;
    assert.equal(e.size, r.size, "the listing has the 64-bit size");
  }
  // the small files after the big ones in the data section (offsets beyond 4 GB in the image) read correctly too
  for (const r of rows.filter(r => r.type === "f" && r.sha256)) {
    const d = await fs.getFile(`rom:/${lat(r.path)}`);
    assert.equal(createHash("sha256").update(d!).digest("hex"), r.sha256, lat(r.path));
  }
  assert.ok(fs.x.fs_arena_used() < 1 << 20, "only the tables are in memory");
});

function smallTree(dir: string): void {
  mkdirSync(join(dir, "Data", "sub"), { recursive: true }); mkdirSync(join(dir, "data"), { recursive: true }); mkdirSync(join(dir, "emptydir"));
  writeFileSync(join(dir, "Data", "File.bin"), "UPPER"); writeFileSync(join(dir, "data", "file.bin"), "lower");
  writeFileSync(join(dir, "Data", "sub", "deep.txt"), "deep"); writeFileSync(join(dir, "top.txt"), "0123456789"); writeFileSync(join(dir, "empty"), "");
  writeFileSync(join(dir, "n".repeat(0xFF)), "long name"); writeFileSync(join(dir, "back\\slash"), "unreachable by path");
}

// Zelda's RomFS tables are 13 MB, the runtime's "fs arena" range 7 MB: the module asks the embedder for more
both("romfs: tables larger than the arena: refused without more memory, mounted with the embedder's (arenaMore)", async (async) => {
  const dir = join(SCRATCH, `wide${+async}`), file = img(`wide${+async}.img`);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3000; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}_${"x".repeat(120)}`), String(i));
  python(["build", dir, file]);
  const st = () => new NodeStorage({ rom: file, saveDir: join(SCRATCH, "unused") });
  const small = new Fs(st(), { async, arena: 256 << 10 });
  assert.notEqual(await small.mount("MountRom", "rom", 0, 0), R.OK, "256 KB of arena cannot hold the tables");
  assert.ok(small.red.some(l => l.includes("the arena has no room for its tables")), small.red.join("\n"));
  const fs = new Fs(st(), { async, arena: 256 << 10, more: 32 << 20 });
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK);
  assert.equal(fs.moreGiven, 16 << 20, "one grow of the 16 MB minimum");
  assert.equal(fs.x.fs_arena_size(), (256 << 10) + (16 << 20) - 0, "the arena's size counts what was added");
  for (const i of [0, 1234, 2999]) assert.equal((await fs.getFile(`rom:/f${String(i).padStart(4, "0")}_${"x".repeat(120)}`))?.toString(), String(i));
  assert.equal((await fs.list("rom:/", 3, 4000))!.length, 3000);
});

both("romfs: path rules (case, '.', '..', backslashes, slashes), open modes, error results, handles", async (async) => {
  const dir = join(SCRATCH, `tree${+async}`), file = img(`small${+async}.img`);
  smallTree(dir);
  python(["build", dir, file]);
  const fs = node(file, async);
  assert.equal((await fs.open("rom:/top.txt"))[0], R.NOT_FOUND, "nothing is mounted yet");
  assert.equal(await fs.mount("IsMounted", "rom"), 0);
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK);
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK, "a name in use keeps its target");
  assert.equal(await fs.mount("MountRomIdx", "rom2", 3, 0, 0), R.OK);
  assert.equal(fs.red.length, 1, "a program index other than 0 is red");
  assert.equal(fs.x.fs_mount_count(), 2);
  assert.equal(await fs.mount("IsMounted", "rom"), 1); assert.equal(await fs.mount("IsMounted", "ro"), 0); assert.equal(await fs.mount("IsMounted", "romx"), 0);
  assert.equal(await fs.mount("IsPathMounted", "rom:/whatever"), 1); assert.equal(await fs.mount("IsPathMounted", "rom"), 0); assert.equal(await fs.mount("IsPathMounted", "nope:/x"), 0);
  await fs.mount("Unmount", "rom");
  assert.equal(await fs.mount("IsMounted", "rom"), 1, "mounts are permanent");

  const text = async (p: string) => (await fs.getFile(p))?.toString() ?? null;
  assert.equal(await text("rom:/Data/File.bin"), "UPPER"); assert.equal(await text("rom:/data/file.bin"), "lower");
  for (const p of ["rom:/data/File.bin", "rom:/DATA/FILE.BIN", "rom:/Top.txt", "ROM:/top.txt"]) assert.equal((await fs.open(p))[0], R.NOT_FOUND, `${p}: names are case-sensitive`);
  for (const p of ["rom:/top.txt", "rom:top.txt", "rom://top.txt", "rom:/./top.txt", "rom:/Data/../top.txt", "rom:/Data/sub/../../top.txt", "rom:\\top.txt", "rom:/Data\\..\\top.txt",
    "rom:/nonexistent/../top.txt", "rom:/top.txt/", "rom:/emptydir/./../top.txt", "rom2:/top.txt"]) assert.equal(await text(p), "0123456789", p);
  assert.equal(await text("rom:\\Data\\sub\\deep.txt"), "deep");
  for (const p of ["rom:/..", "rom:/../top.txt", "rom:/Data/../../top.txt", "rom:..", "top.txt", "/top.txt", "", "nope:/top.txt", ":/top.txt", "rom:/top.txt/x", "rom:/Data/File.bin/..x"])
    assert.equal((await fs.entryType(p))[0], R.NOT_FOUND, JSON.stringify(p));
  assert.deepEqual(await fs.entryType("rom:/top.txt/.."), [R.OK, 0], "'..' is applied lexically (Horizon's PathNormalizer)");
  assert.deepEqual(await fs.entryType("rom:"), [R.OK, 0]); assert.deepEqual(await fs.entryType("rom:/"), [R.OK, 0]);
  assert.deepEqual(await fs.entryType("rom:/Data/"), [R.OK, 0]); assert.deepEqual(await fs.entryType("rom:/empty"), [R.OK, 1]);
  assert.equal(await text("rom:/" + "n".repeat(0xFF)), "long name");
  assert.equal((await fs.entryType("rom:/" + "n".repeat(0x300)))[0], R.NOT_FOUND);
  assert.equal((await fs.entryType("rom:/" + "n".repeat(0x301)))[0], R.FAIL, "a component longer than 0x300 bytes");
  assert.equal((await fs.entryType("rom:/" + "a/".repeat(510)))[0], R.FAIL, "a path of 1024 bytes or more");
  assert.equal((await fs.entryType("nope:/" + "a/".repeat(510)))[0], R.NOT_FOUND);
  // a name with a backslash is listed but no path reaches it (a backslash is a separator)
  assert.ok((await fs.list("rom:/"))!.some(e => e.name.toString() === "back\\slash"));
  assert.equal((await fs.open("rom:/back\\slash"))[0], R.NOT_FOUND);
  assert.deepEqual((await fs.list("rom:/"))!.map(e => `${e.name.toString().slice(0, 12)}:${e.type}:${e.size}`).sort(),
    ["Data:0:0", "back\\slash:1:19", "data:0:0", "empty:1:0", "emptydir:0:0", "nnnnnnnnnnnn:1:9", "top.txt:1:10"]);
  assert.deepEqual(await fs.list("rom:/emptydir"), []);
  assert.deepEqual((await fs.list("rom:/Data", 1))!.map(e => e.name.toString()), ["sub"]);
  assert.deepEqual((await fs.list("rom:/Data", 2))!.map(e => e.name.toString()), ["File.bin"]);
  assert.deepEqual(await fs.list("rom:/Data", 0), []);
  assert.equal(await fs.list("rom:/nope"), null);

  // game files are read-only: nxnative's answers
  for (const m of [MODE.W, MODE.R | MODE.W, MODE.A, MODE.R | MODE.W | MODE.A]) assert.equal((await fs.open("rom:/top.txt", m))[0], R.FAIL);
  assert.equal((await fs.open("rom:/nope", MODE.W))[0], R.NOT_FOUND);
  assert.equal(await fs.path("CreateFile", "rom:/top.txt", 0), R.EXISTS); assert.equal(await fs.path("CreateFile", "rom:/new.txt", 0), R.FAIL);
  assert.equal(await fs.path("CreateDirectory", "rom:/Data"), R.EXISTS); assert.equal(await fs.path("CreateDirectory", "rom:/newdir"), R.FAIL);
  for (const fn of ["DeleteFile", "DeleteDir", "DeleteDirRec", "CleanDirRec"]) {
    assert.equal(await fs.path(fn, "rom:/Data"), R.FAIL, fn); assert.equal(await fs.path(fn, "rom:/nope"), R.NOT_FOUND, fn);
  }
  assert.equal(await fs.rename("RenameFile", "rom:/top.txt", "rom:/t2"), R.FAIL); assert.equal(await fs.rename("RenameFile", "rom:/nope", "rom:/t2"), R.NOT_FOUND);
  assert.equal(await fs.path("Commit", "rom"), R.OK, "nothing to commit on game files");

  // handles
  const [, h] = await fs.open("rom:/top.txt", MODE.R);
  assert.ok(h !== 0n && (h & 15n) === 0n, "a handle is not 0 and has its low four bits clear");
  assert.equal(await fs.call("GetFileOpenMode", h), 1);
  assert.equal((await fs.read(h | 7n, 2, 3))[1].toString(), "234", "low bits a game sets are ignored");
  assert.deepEqual((await fs.read(h, -1, 3)), [R.OK, Buffer.alloc(0)], "a negative offset reads nothing");
  assert.equal(await fs.write(h, 0, Buffer.from("x")), R.FAIL); assert.equal(await fs.call("SetFileSize", h, 3), R.FAIL);
  assert.equal(await fs.call("FlushFile", h), R.OK);
  const [, h2] = await fs.open("rom:/top.txt");
  assert.notEqual(h2, h);
  await fs.close(h);
  const reds = fs.red.length;
  assert.equal((await fs.read(h, 0, 3))[0], R.FAIL, "a closed handle"); assert.equal((await fs.size(h))[0], R.FAIL); assert.equal(await fs.call("GetFileOpenMode", h), 0);
  await fs.close(h);
  assert.equal(fs.red.length, reds + 3, "each use of a handle that is not open is red");
  const [, h3] = await fs.open("rom:/empty");
  assert.notEqual(h3, h, "the slot answers to a new value after a close");
  assert.equal((await fs.read(h2, 5, 5))[1].toString(), "56789");
  // handle 0: what a game holds after a failed open
  const out = fs.alloc(8); fs.dv.setBigUint64(out, 99n, true);
  assert.equal(await fs.call("ReadFile", out, 0, 0, fs.alloc(8), 8), R.FAIL); assert.equal(fs.dv.getBigUint64(out, true), 0n);
  assert.equal(await fs.call("ReadFileExact", 0, 0, fs.alloc(8), 8), R.FAIL);
  assert.equal(await fs.call("GetFileSize", out, 0), R.FAIL); assert.equal(await fs.call("WriteFile", 0, 0, out, 8, 0), R.FAIL); assert.equal(await fs.call("SetFileSize", 0, 0), R.FAIL);
  await fs.call("CloseFile", 0); await fs.call("CloseDirectory", 0);
  assert.equal(await fs.call("ReadDirectory", out, fs.alloc(0x310), 0, 1), R.FAIL); assert.equal(fs.dv.getBigInt64(out, true), 0n);
  assert.equal(fs.red.length, reds + 3, "handle 0 is quiet");
  // a directory handle is no file handle, and the other way round
  const [, dh] = await fs.openDir("rom:/");
  assert.equal((await fs.read(dh, 0, 1))[0], R.FAIL); assert.equal((await fs.readDir(h2, 1))[0], R.FAIL);
  // a buffer outside linear memory is refused before anything is read
  assert.equal(await fs.call("ReadFile", out, h2, 0, BEYOND + 0xF0, 0x100), R.FAIL);
  assert.equal(await fs.call("ReadDirectory", out, BEYOND, dh, 4), R.FAIL);
  await fs.call("CloseDirectory", dh); await fs.close(h2); await fs.close(h3);
  assert.equal(fs.x.fs_open_files(), 0); assert.equal(fs.x.fs_open_dirs(), 0);
});

both("romfs: no image, then one: the mount fails red and works once the image is there", async (async) => {
  const st = new MemStorage();
  const fs = new Fs(st, { async });
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.FAIL);
  assert.match(fs.red[0], /game files are missing/);
  assert.equal(await fs.mount("IsMounted", "rom"), 0);
  const file = img(`late${+async}.img`);
  python(["synth", file, "--seed", "1", "--files", "5", "--dirs", "1"]);
  st.setImage(KIND.ROM, 0, new MemDevice(readFileSync(file)));
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK);
  assert.equal((await fs.list("rom:/", 2))!.length + (await fs.list("rom:/", 1))!.length, (await fs.list("rom:/"))!.length);
});

// A device that answers out-of-range reads with an error and counts them: the module must never make one
class Guarded implements FsDevice {
  oob = 0; reads = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  size(): number { return this.b.length; }
  readSync(off: number, dst: Uint8Array): number {
    this.reads++;
    if (off < 0 || off + dst.length > this.b.length) { this.oob++; return DEV.IO; }
    dst.set(this.b.subarray(off, off + dst.length));
    return DEV.OK;
  }
}
// Mount an image and, when it is accepted, visit everything in it; throws on a trap, a hang or an out-of-range read
async function probe(bytes: Uint8Array, async: boolean): Promise<"refused" | "accepted"> {
  const dev = new Guarded(bytes), st = new MemStorage();
  st.setImage(KIND.ROM, 0, dev);
  const fs = new Fs(st, { async, arena: 4 << 20, guest: 2 << 20, cover: false });
  const r = await fs.mount("MountRom", "rom", 0, 0);
  if (r !== R.OK) { assert.equal(r, R.FAIL); assert.equal(dev.oob, 0, "an out-of-range read while refusing"); assert.equal(fs.x.fs_arena_used(), 0, "a refused image leaves nothing in the arena"); return "refused"; }
  let steps = 0;
  const go = async (dir: string, depth: number): Promise<void> => {
    if (dir.length > 900) return;
    const es = await fs.list(`rom:/${dir}`, 3, 16);
    if (!es) return;
    for (const e of es) {
      if (++steps > 5000) throw new Error("the walk does not end");
      const p = dir ? `${dir}/${e.name.toString("latin1")}` : e.name.toString("latin1");
      if (e.type === 0) { await go(p, depth + 1); continue; }
      const [or, h] = await fs.open(`rom:/${p}`);
      if (or !== R.OK) continue;   // a name with a backslash, or a path too long
      const [, size] = await fs.size(h);
      assert.equal(size, e.size);
      const [rr, d] = await fs.read(h, 0, Math.min(e.size, 4096) + 8);
      assert.equal(rr, R.OK); assert.equal(d.length, Math.min(e.size, 4104));
      if (e.size > 16) assert.equal((await fs.read(h, e.size - 5, 64))[1].length, 5);
      await fs.close(h);
    }
  };
  await go("", 0);
  assert.equal(dev.oob, 0, "an out-of-range read of an accepted image");
  return "accepted";
}

test("romfs: damaged images are refused or stay in bounds: random mutation of header and tables, cuts, garbage", async () => {
  const file = img("mut.img");
  python(["synth", file, "--seed", "21", "--files", "40", "--dirs", "9", "--depth", "4", "--max-size", "300", "--nonascii"]);
  const good = new Uint8Array(readFileSync(file)), dvh = new DataView(good.buffer);
  assert.equal(await probe(good, false), "accepted");
  const tables = Number(dvh.getBigUint64(8, true)), rnd = rng(1234);
  const count = { refused: 0, accepted: 0 };
  const N = Number(process.env.FS_MUTATIONS ?? 6000);
  for (let i = 0; i < N; i++) {
    const b = good.slice();
    const flips = 1 + rnd.int(3);
    for (let k = 0; k < flips; k++) {
      // the header, or the tables after the data section
      const at = rnd.int(4) === 0 ? rnd.int(0x50) : tables + rnd.int(b.length - tables);
      const how = rnd.int(4);
      if (how === 0) b[at] ^= 1 << rnd.int(8);
      else if (how === 1) b[at] = rnd.int(256);
      else if (how === 2) b[at] = 0xFF;
      else { const v = rnd.int(b.length * 2); b[at & ~3] = v; b[(at & ~3) + 1] = v >> 8; b[(at & ~3) + 2] = v >> 16; b[(at & ~3) + 3] = v >> 24; }
    }
    try { count[await probe(b, i % 16 === 0)]++; }
    catch (e) { throw new Error(`mutation ${i} (seed 1234): ${e instanceof Error ? e.stack : e}`); }
  }
  for (let i = 0; i < 300; i++) {   // cut short
    const n = i < 0x60 ? i : rnd.int(good.length);
    try { count[await probe(good.slice(0, n), false)]++; } catch (e) { throw new Error(`cut at ${n}: ${e instanceof Error ? e.stack : e}`); }
  }
  for (let i = 0; i < 300; i++) {   // garbage with a plausible header
    const b = rnd.bytes(200 + rnd.int(3000));
    if (i % 2) { b.writeBigUInt64LE(0x50n, 0); for (let k = 1; k < 10; k++) b.writeBigUInt64LE(BigInt(rnd.int(b.length)), 8 * k); }
    try { count[await probe(b, false)]++; } catch (e) { throw new Error(`garbage ${i}: ${e instanceof Error ? e.stack : e}`); }
  }
  assert.ok(count.refused > N / 2, "most mutations are refused");
  console.log(`     ${N + 600} damaged images: ${count.refused} refused, ${count.accepted} accepted and walked in bounds (a changed size inside the image, a padding byte)`);
});

test("romfs: a refused image stays refused and is red; a read error of the device fails the read, not the module", async () => {
  const file = img("bad.img");
  python(["synth", file, "--seed", "8", "--files", "10", "--dirs", "2"]);
  const b = new Uint8Array(readFileSync(file));
  const st = new MemStorage();
  const cut = b.slice(0, b.length - 16);
  st.setImage(KIND.ROM, 0, new MemDevice(cut));
  const fs = new Fs(st);
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.FAIL);
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.FAIL);
  assert.ok(fs.red.some(l => /refused: a table lies outside the image/.test(l)), fs.red.join("\n"));
  assert.equal(await fs.mount("IsMounted", "rom"), 0);
  // a device that fails later
  let fail = false;
  const dev: FsDevice = { size: () => b.length, readSync: (off, dst) => { if (fail) return DEV.IO; dst.set(b.subarray(off, off + dst.length)); return DEV.OK; } };
  const st2 = new MemStorage(); st2.setImage(KIND.ROM, 0, dev);
  const fs2 = new Fs(st2);
  assert.equal(await fs2.mount("MountRom", "rom", 0, 0), R.OK);
  const f = (await fs2.list("rom:/", 2))!.find(e => e.size > 0)!;
  const [, h] = await fs2.open(`rom:/${f.name.toString("latin1")}`);
  fail = true;
  assert.equal((await fs2.read(h, 0, 4))[0], R.FAIL);
  fail = false;
  assert.equal((await fs2.read(h, 0, 4))[0], R.OK);
});

// src/glue/fs_romfs_one.ts: the image an embedder makes of one file the user picked
both("romfs: a one-file image made in memory (romfsOfFile) is what the Python reader and the module read; names of several lengths, an empty file", async (async) => {
  const { romfsOfFile, romfsImageOfFile } = await import("../../src/glue/fs_romfs_one.ts");
  const r = rng(77);
  for (const [name, size] of [["doom1.wad", 100_003], ["a", 0], ["abcd", 1], ["name with spaces.bin", 4096], ["x".repeat(61), 77]] as [string, number][]) {
    const bytes = new Uint8Array(r.bytes(size)), file = img(`one${+async}_${name.length}.img`);
    const parts = romfsOfFile(name, bytes);
    assert.equal(parts[1], bytes, "the file's bytes are a part of the image, not a copy");
    const image = romfsImageOfFile(name, bytes);
    assert.equal(image.length, parts.reduce((a: number, p: Uint8Array) => a + p.length, 0));
    writeFileSync(file, image);
    const rows = ls(file);
    assert.deepEqual(rows.map(x => [x.path, x.type, x.size, x.sha256]), [[Buffer.from(name).toString("hex"), "f", size, createHash("sha256").update(bytes).digest("hex")]], "the Python reader's listing");
    const fs = node(file, async);
    assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK);
    const es = await fs.list("rom:/");
    assert.deepEqual(es?.map(e => [e.name.toString(), e.type, e.size]), [[name, 1, size]]);
    const [or, h] = await fs.open(`rom:/${name}`);
    assert.equal(or, R.OK);
    assert.deepEqual(await fs.size(h), [R.OK, size]);
    const [rr, data] = await fs.read(h, 0, size + 10);
    assert.equal(rr, R.OK); assert.ok(data.equals(Buffer.from(bytes)), "the file's bytes through the module");
    assert.equal((await fs.open("rom:/other"))[0], R.NOT_FOUND);
  }
  assert.throws(() => romfsOfFile("a/b", new Uint8Array(1)), /plain file name/);
});
