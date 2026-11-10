// Add-on content mounts and the mount-name table, as nxnative has them: a missing index, the cache size a game
// allocates for the mount, names released by Unmount and taken back, hundreds of add-ons in 512 entries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, both, Fs, R, KIND, SCRATCH, python } from "./harness.mts";
import { MemStorage, MemDevice } from "../../src/glue/fs_host.ts";

const images = new Map<number, { bytes: Uint8Array; rows: { path: string; type: string; size: number }[] }>();
function image(seed: number) {
  let im = images.get(seed);
  if (!im) {
    const f = join(SCRATCH, `aoc${seed}.img`);
    python(["synth", f, "--seed", String(1000 + seed), "--files", String(3 + seed * 5), "--dirs", String(seed), "--max-size", "200"]);
    images.set(seed, im = { bytes: new Uint8Array(readFileSync(f)), rows: python(["ls", f]).trim().split("\n").map(l => JSON.parse(l)) });
  }
  return im;
}
function storage(n: number): MemStorage {
  const st = new MemStorage();
  for (let i = 0; i < n; i++) st.setImage(KIND.AOC, i + 1, new MemDevice(image(i % 6).bytes));
  return st;
}
const names = async (fs: Fs, mount: string) => (await fs.list(`${mount}:/`))!.map(e => e.name.toString("latin1")).sort();
const top = (seed: number) => image(seed).rows.filter(r => !Buffer.from(r.path, "hex").includes(0x2F)).map(r => Buffer.from(r.path, "hex").toString("latin1")).sort();
// nxnative romfs_work_size, from the reader's listing
function workSize(seed: number): number {
  const buckets = (n: number) => { if (n < 3) return 3; if (n < 19) return n | 1; while ([2, 3, 5, 7, 11, 13, 17].some(p => n % p === 0)) n++; return n; };
  let nd = 1, db = 0x18, nf = 0, fb = 0;
  for (const r of image(seed).rows) {
    const p = Buffer.from(r.path, "hex"), name = (p.length - 1 - p.lastIndexOf(0x2F) + 3) & ~3;
    if (r.type === "d") { nd++; db += 0x18 + name; } else { nf++; fb += 0x20 + name; }
  }
  return 4 * buckets(nd) + db + 4 * buckets(nf) + fb;
}

both("add-on content: a missing index, the mount cache size (RomFS working memory), mount, read", async (async) => {
  const fs = new Fs(storage(3), { async });
  const out = fs.alloc(8);
  assert.equal(await fs.call("QueryAocCache", out, 9), R.OK); assert.equal(fs.dv.getBigUint64(out, true), 0x1000n, "an index that does not exist: the minimum");
  assert.equal(await fs.mount("MountAoc", "aoc9", 9, 0, 0), R.TARGET_NOT_FOUND);
  assert.equal(await fs.mount("IsMounted", "aoc9"), 0);
  assert.deepEqual(fs.red, [], "a missing add-on is no error of the host");
  for (const i of [1, 2, 3]) {
    assert.equal(await fs.call("QueryAocCache", out, i), R.OK);
    assert.equal(Number(fs.dv.getBigUint64(out, true)), workSize(i - 1), `the working memory of add-on ${i}`);
    assert.equal(await fs.mount("MountAoc", `aoc${i}`, i, 0, 0), R.OK);
    assert.deepEqual(await names(fs, `aoc${i}`), top(i - 1));
  }
  assert.equal(await fs.path("CreateFile", "aoc1:/x", 0), R.FAIL, "add-on content is read-only");
  assert.equal(await fs.path("Commit", "aoc1"), R.OK);
  const p = fs.alloc(8); fs.dv.setBigUint64(p, BigInt(fs.str("aoc1")), true);
  assert.equal(await fs.call("CommitList", p, 1), R.FAIL, "a read-only mount in a commit list");
  // a negative index is an index like any other (int in w1)
  assert.equal(await fs.mount("MountAoc", "neg", 0xFFFFFFFF, 0, 0), R.TARGET_NOT_FOUND);
});

both("add-on content: Unmount releases the name; the next mount under it gets the add-on it names; a released entry is taken back", async (async) => {
  const fs = new Fs(storage(3), { async });
  assert.equal(await fs.mount("MountAoc", "AVCtitle", 1, 0, 0), R.OK);
  assert.equal(await fs.mount("MountAoc", "AVCtitle", 2, 0, 0), R.OK, "a name in use keeps its target");
  assert.deepEqual(await names(fs, "AVCtitle"), top(0));
  const file = image(0).rows.find(r => r.type === "f" && r.size > 0 && !Buffer.from(r.path, "hex").includes(0x2F))!;
  const [, h] = await fs.open(`AVCtitle:/${Buffer.from(file.path, "hex").toString("latin1")}`);
  const [, dh] = await fs.openDir("AVCtitle:/");
  await fs.mount("Unmount", "AVCtitle");
  assert.equal(await fs.mount("IsMounted", "AVCtitle"), 0); assert.equal(await fs.mount("IsPathMounted", "AVCtitle:/x"), 0);
  assert.equal((await fs.entryType("AVCtitle:/"))[0], R.NOT_FOUND);
  assert.equal((await fs.read(h, 0, 4))[0], R.OK, "a handle left open still reads the image it opened");
  assert.equal((await fs.readDir(dh, 100))[1].length, top(0).length);
  await fs.mount("Unmount", "AVCtitle"); await fs.mount("Unmount", "never-mounted");
  assert.equal(await fs.mount("MountAoc", "AVCtitle", 2, 0, 0), R.OK);
  assert.deepEqual(await names(fs, "AVCtitle"), top(1), "the name now is add-on 2");
  assert.equal((await fs.size(h))[1], file.size);
  assert.equal(fs.x.fs_mount_count(), 2);
  // cycling through the add-ons does not grow the table
  for (let round = 0; round < 300; round++) {
    const i = 1 + (round % 3);
    await fs.mount("Unmount", "AVCtitle");
    assert.equal(await fs.mount("MountAoc", "AVCtitle", i, 0, 0), R.OK);
    if (round % 50 === 0) assert.deepEqual(await names(fs, "AVCtitle"), top(i - 1));
  }
  assert.equal(fs.x.fs_mount_count(), 3, "one entry per add-on, whatever the number of mounts");
  // Unmount of anything else changes nothing
  assert.equal(await fs.mount("MountSave", "save", 0), R.OK);
  await fs.mount("Unmount", "save");
  assert.equal(await fs.mount("IsMounted", "save"), 1);
  await fs.close(h); await fs.call("CloseDirectory", dh);
});

both("add-on content: 252 add-ons mounted beside the game files and the saves (the table has 512 names)", async (async) => {
  const st = storage(252);
  st.setImage(KIND.ROM, 0, new MemDevice(image(5).bytes));
  const fs = new Fs(st, { async });
  assert.equal(await fs.mount("MountRom", "rom", 0, 0), R.OK); assert.equal(await fs.mount("MountSave", "save", 0), R.OK);
  for (let i = 1; i <= 252; i++) assert.equal(await fs.mount("MountAoc", `aoc${i - 1}`, i, 0, 0), R.OK);
  assert.equal(fs.x.fs_mount_count(), 254);
  for (const i of [1, 17, 100, 252]) assert.deepEqual(await names(fs, `aoc${i - 1}`), top((i - 1) % 6));
  assert.deepEqual(fs.red, []);
});

test("add-on content: a damaged add-on fails red; concurrent mounts and reads of one image with asynchronous storage", async () => {
  const st = storage(2);
  st.setImage(KIND.AOC, 5, new MemDevice(image(1).bytes.slice(0, 300)));
  const fs = new Fs(st, { async: true });
  assert.equal(await fs.mount("MountAoc", "bad", 5, 0, 0), R.FAIL);
  assert.ok(fs.red.length >= 2);
  // four threads mount the same add-on at once, under two names
  assert.deepEqual(await Promise.all([fs.mount("MountAoc", "a", 1, 0, 0), fs.mount("MountAoc", "a", 1, 0, 0), fs.mount("MountAoc", "b", 1, 0, 0), fs.call("QueryAocCache", fs.alloc(8), 1)]), [R.OK, R.OK, R.OK, R.OK]);
  assert.ok(fs.retries > 0, "the image was loaded once; the other calls waited");
  assert.equal(fs.x.fs_mount_count(), 2);
  // many threads read at once: every read is its own pending call
  const files = image(0).rows.filter(r => r.type === "f" && r.size > 0 && !Buffer.from(r.path, "hex").includes(0x2F));
  const before = fs.pendings;
  const got = await Promise.all(files.flatMap(f => [0, 1, 2].map(async k => {
    const d = await fs.getFile(`${k % 2 ? "a" : "b"}:/${Buffer.from(f.path, "hex").toString("latin1")}`);
    return d!.length === f.size;
  })));
  assert.ok(got.length >= 3 && got.every(Boolean));
  assert.ok(fs.pendings - before >= got.length);
  assert.equal(fs.x.fs_pending(), 0); assert.equal(fs.x.fs_open_files(), 0);
});
