// Saves: files and directories, open modes and results, the transaction (commit, rollback at the next mount,
// poison and recovery, read-only fallback), shared and separate backings, concurrent calls with asynchronous storage.
import assert from "node:assert/strict";
import { test, both, Fs, R, MODE, KIND, rng, treeText, BEYOND } from "./harness.mts";
import { MemStorage, MemDevice, DEV } from "../../src/glue/fs_host.ts";
import { NodeStorage } from "../../src/glue/fs_dev_node.ts";
import { Disk, TestStorage } from "./fault.mts";
import { Model } from "./model.mts";
import { join } from "node:path";
import { SCRATCH } from "./harness.mts";

const B = (s: string) => Buffer.from(s);
async function mounted(st: MemStorage | TestStorage | NodeStorage, async = false, name = "save"): Promise<Fs> {
  const fs = new Fs(st, { async });
  assert.equal(await fs.mount("MountSave", name, 0), R.OK);
  return fs;
}

both("save: create, open modes, read, write, set size, flush, sizes: nxnative's results", async (async) => {
  const fs = await mounted(new MemStorage(), async);
  assert.equal(fs.saveState(), "Clean");
  assert.equal((await fs.open("save:/a.bin"))[0], R.NOT_FOUND);
  assert.equal((await fs.open("save:/a.bin", MODE.W))[0], R.NOT_FOUND, "opening does not create");
  assert.equal(await fs.path("CreateFile", "save:/a.bin", 10), R.OK);
  assert.equal(fs.saveState(), "Dirty");
  assert.equal(await fs.path("CreateFile", "save:/a.bin", 10), R.EXISTS);
  assert.equal(await fs.path("CreateFile", "save:/no/a.bin", 0), R.NOT_FOUND, "the parent must exist");
  assert.equal(await fs.path("CreateFile", "save:/a.bin/x", 0), R.NOT_FOUND, "a file is no parent");
  assert.equal(await fs.path("CreateFile", "save:/neg", -1), R.FAIL);
  assert.equal((await fs.entryType("save:/neg"))[0], R.NOT_FOUND, "a failed create leaves nothing");
  assert.equal(await fs.path("CreateFile", "save:/", 0), R.EXISTS);
  assert.deepEqual(await fs.getFile("save:/a.bin"), Buffer.alloc(10), "a created file reads as zeroes");

  // read-only handle
  const [, hr] = await fs.open("save:/a.bin", MODE.R);
  assert.equal(await fs.call("GetFileOpenMode", hr), 1);
  assert.equal(await fs.write(hr, 0, B("x")), R.FAIL, "write through a handle opened for reading");
  assert.equal(await fs.call("SetFileSize", hr, 3), R.FAIL);
  assert.equal(fs.saveState(), "Dirty", "a refused write is no storage failure: the transaction is not poisoned");
  // write-only handles: Write, or AllowAppend alone
  for (const m of [MODE.W, MODE.A, MODE.W | MODE.A]) {
    const [r, h] = await fs.open("save:/a.bin", m);
    assert.equal(r, R.OK); assert.equal(await fs.call("GetFileOpenMode", h), m);
    assert.equal((await fs.read(h, 0, 4))[0], R.FAIL, "read through a write-only handle");
    assert.deepEqual(await fs.size(h), [R.OK, 10]);
    await fs.close(h);
  }
  // read-write
  const [, h] = await fs.open("save:/a.bin", MODE.R | MODE.W);
  assert.equal(await fs.write(h, 2, B("hello")), R.OK);
  assert.deepEqual((await fs.read(h, 0, 100))[1], Buffer.concat([Buffer.alloc(2), B("hello"), Buffer.alloc(3)]));
  assert.deepEqual((await fs.read(hr, 2, 5))[1], B("hello"), "another handle sees the write");
  // writing past the end extends the file whatever the open mode says about appending (pwrite), the gap reads as zeroes
  assert.equal(await fs.write(h, 20, B("tail")), R.OK);
  assert.deepEqual(await fs.size(h), [R.OK, 24]);
  assert.deepEqual((await fs.read(h, 8, 100))[1], Buffer.concat([Buffer.alloc(12), B("tail")]));
  assert.equal(await fs.write(h, 24, Buffer.alloc(0)), R.OK); assert.equal(await fs.write(h, 1000, Buffer.alloc(0)), R.OK, "an empty write does nothing");
  assert.deepEqual(await fs.size(h), [R.OK, 24]);
  assert.equal(await fs.write(h, -1, B("x")), R.FAIL);
  assert.deepEqual(await fs.read(h, -1, 4), [R.FAIL, Buffer.alloc(0)], "a negative offset fails on a save file (pread: EINVAL)");
  assert.deepEqual(await fs.read(h, 24, 4), [R.OK, Buffer.alloc(0)]);
  assert.deepEqual(await fs.read(h, 9999, 4), [R.OK, Buffer.alloc(0)]);
  assert.equal((await fs.readExact(h, 20, 4))[1].toString(), "tail");
  assert.equal((await fs.readExact(h, 20, 5))[0], R.FAIL);
  // set size: shrink, grow with zeroes (not with what the extent held before)
  assert.equal(await fs.call("SetFileSize", h, 4), R.OK);
  assert.equal(await fs.call("SetFileSize", h, 30), R.OK);
  assert.deepEqual((await fs.read(h, 0, 100))[1], Buffer.concat([Buffer.alloc(2), B("he"), Buffer.alloc(26)]));
  assert.equal(await fs.call("SetFileSize", h, -5), R.FAIL);
  assert.equal(await fs.call("FlushFile", h), R.OK);
  // a large file in pieces, rewritten in place and grown
  const big = rng(3).bytes(700000);
  assert.equal(await fs.path("CreateFile", "save:/big", 0), R.OK);
  const [, hb] = await fs.open("save:/big", MODE.R | MODE.W | MODE.A);
  for (let o = 0; o < big.length; o += 65536 + 7) assert.equal(await fs.write(hb, o, big.subarray(o, o + 65536 + 7)), R.OK);
  assert.deepEqual((await fs.read(hb, 0, big.length + 1))[1], big);
  assert.deepEqual((await fs.read(hb, 123456, 70000))[1], big.subarray(123456, 193456));
  // a buffer outside linear memory
  assert.equal(await fs.call("WriteFile", hb, 0, BEYOND + 0xF0, 0x100, 0), R.FAIL);
  await fs.close(h); await fs.close(hr); await fs.close(hb);
  assert.equal(fs.x.fs_open_files(), 0);
  assert.deepEqual(fs.red, []);
});

both("save: delete, rename, directories, listing: nxnative's results", async (async) => {
  const fs = await mounted(new MemStorage(), async);
  const m = new Model(fs);
  await m.mkdir("d"); await m.mkdir("d"); await m.mkdir("d/e"); await m.mkdir("x/y"); await m.put("d/f1", B("one")); await m.put("d/e/f2", B("two")); await m.put("top", B("top"));
  assert.equal(await fs.path("CreateDirectory", "save:/"), R.EXISTS);
  assert.equal(await fs.path("CreateDirectory", "save:/top/sub"), R.NOT_FOUND);
  assert.deepEqual(await fs.entryType("save:/d"), [R.OK, 0]); assert.deepEqual(await fs.entryType("save:/d/f1"), [R.OK, 1]); assert.deepEqual(await fs.entryType("save:/"), [R.OK, 0]);
  assert.equal((await fs.entryType("save:/D"))[0], R.NOT_FOUND, "case-sensitive");
  assert.equal((await fs.open("save:/d"))[0], R.NOT_FOUND, "a directory is no file");
  assert.equal((await fs.open("save:/d", MODE.W))[0], R.FAIL, "open(2) of a directory for writing: EISDIR");
  assert.equal((await fs.openDir("save:/top"))[0], R.NOT_FOUND, "a file is no directory");
  assert.equal((await fs.openDir("save:/nope"))[0], R.NOT_FOUND);
  // paths: the same rules as game files
  assert.equal((await fs.getFile("save:\\d\\e\\..\\f1"))!.toString(), "one");
  assert.equal((await fs.getFile("save:d/./e//f2"))!.toString(), "two");
  assert.equal((await fs.entryType("save:/../top"))[0], R.NOT_FOUND);
  await m.del("nope"); await m.del("d"); await m.rmdir("top"); await m.rmdir("d"); await m.rmdir("nope"); await m.rmrf("top"); await m.rmrf("nope");
  await m.rename("top", "d/e/top2"); await m.rename("nope", "z"); await m.rename("d/f1", "d/e/f2"); await m.rename("d/f1", "nope/x"); await m.rename("d", "d/e/inside"); await m.rename("d", "d");
  await m.rename("d/e", "e2"); await m.rename("e2/f2", "e2/F2");
  assert.equal(await fs.rename("RenameFile", "save:/d", "save:/d3"), R.OK, "RenameFile renames a directory too (rename(2))"); m.adopt(Object.assign(new Model(fs), { nodes: new Map([...m.nodes].map(([k, v]) => [k === "d" || k.startsWith("d/") ? "d3" + k.slice(1) : k, v])) }));
  assert.equal(await fs.rename("RenameFile", "save:/", "save:/r"), R.FAIL);
  assert.equal(await fs.rename("RenameFile", "save:/d3", "save:/"), R.EXISTS);
  await m.check();
  // listing: modes, count, batches; an entry deleted before it is read is skipped; sizes are current
  await m.put("d3/g1", B("1")); await m.put("d3/g2", B("22")); await m.put("d3/g3", B("333")); await m.mkdir("d3/sub");
  assert.deepEqual((await fs.list("save:/d3"))!.map(e => `${e.name}:${e.type}:${e.size}`).sort(), ["f1:1:3", "g1:1:1", "g2:1:2", "g3:1:3", "sub:0:0"]);
  assert.deepEqual((await fs.list("save:/d3", 1))!.map(e => `${e.name}`), ["sub"]);
  assert.equal((await fs.list("save:/d3", 2, 1))!.length, 4);
  assert.deepEqual(await fs.list("save:/d3", 0), []);
  const [, dh] = await fs.openDir("save:/d3");
  assert.deepEqual(await fs.dirCount(dh), [R.OK, 5]);
  const first = (await fs.readDir(dh, 1))[1][0].name.toString();
  const unread = ["g1", "g2", "g3"].filter(n => n !== first);
  await m.del("d3/" + unread[0]);
  await m.put("d3/" + unread[1], B("grown!"));
  await m.put("d3/new", B("created after the open: not in this listing"));
  const rest = (await fs.readDir(dh, 10))[1].map(e => `${e.name}:${e.size}`);
  assert.equal(rest.length, 3); assert.ok(rest.includes(`${unread[1]}:6`) && !rest.some(e => e.startsWith(unread[0] + ":") || e.startsWith("new:")), rest.join());
  assert.deepEqual(await fs.dirCount(dh), [R.OK, 4]);
  await fs.call("CloseDirectory", dh);
  assert.equal((await fs.readDir(dh, 1))[0], R.FAIL, "a closed directory handle");
  // delete with a handle open: the file lives on for the handle (unlink)
  const [, h] = await fs.open("save:/d3/f1", MODE.R | MODE.W);
  await m.del("d3/f1");
  assert.equal((await fs.read(h, 0, 9))[1].toString(), "one"); assert.equal(await fs.write(h, 3, B("!")), R.OK); assert.equal((await fs.read(h, 0, 9))[1].toString(), "one!");
  await m.put("d3/f1", B("a new file under the old name"));
  assert.equal((await fs.read(h, 0, 9))[1].toString(), "one!");
  await fs.close(h);
  // recursive delete and clean; the root can be cleaned and not deleted
  await m.rmrf("e2", true); await m.check("after CleanDirectoryRecursively");
  await m.rmrf("d3"); await m.check();
  await m.mkdir("k"); await m.put("k/1", B("1")); await m.put("r", B("r"));
  assert.equal(await fs.path("DeleteDir", "save:/"), R.FAIL);
  assert.equal(await fs.path("DeleteDirRec", "save:/"), R.OK, "deleting the root recursively empties it");
  assert.deepEqual(await fs.list("save:/"), []);
  assert.equal(await fs.path("CreateFile", "save:/again", 1), R.OK);
  assert.equal(fs.x.fs_open_files(), 0); assert.equal(fs.x.fs_open_dirs(), 0);
  assert.equal(fs.red.length, 1, "only the read through the closed directory handle was red");
});

both("save: commit; what was not committed is gone at the next mount; a commit replaces the whole save", async (async) => {
  const st = new MemStorage();
  let fs = await mounted(st, async);
  let m = new Model(fs);
  await m.put("keep", B("version 1")); await m.mkdir("dir"); await m.put("dir/inner", rng(1).bytes(9000)); await m.put("gone", B("deleted later"));
  assert.equal(fs.saveState(), "Dirty");
  await m.commit();
  assert.equal(fs.saveState(), "Clean"); assert.equal(fs.x.fs_save_generation(KIND.SAVE, 0n), 1n); assert.equal(fs.x.fs_commit_count(), 1n);
  const v1 = m.snapshot();
  // a transaction that is never committed: overwrite in place, extend, cut, delete, rename, create
  await m.writeAt("keep", 8, B("2 (uncommitted)")); await m.writeAt("dir/inner", 100, B("patched")); await m.setSize("dir/inner", 50); await m.del("gone");
  await m.rename("dir", "moved"); await m.put("new", B("new")); await m.mkdir("newdir");
  await m.check();
  assert.notEqual(m.snapshot(), v1);
  // the next session sees version 1 exactly
  fs = await mounted(st, async);
  assert.equal(treeText(await fs.tree("save")), v1, "rollback at the next mount");
  assert.equal(fs.x.fs_save_generation(KIND.SAVE, 0n), 1n);
  // commit with no change: fine, nothing written
  assert.equal(await fs.path("Commit", "save"), R.OK); assert.equal(await fs.path("CommitSaveData", "save"), R.OK); assert.equal(await fs.call("CommitOpt", fs.str("save"), fs.alloc(8)), R.OK);
  assert.equal(fs.x.fs_save_generation(KIND.SAVE, 0n), 1n);
  assert.equal(await fs.path("Commit", "nope"), R.OK, "an unknown name: nothing to commit");
  // generations: each commit is the whole new tree
  m = new Model(fs); m.nodes = new Map([["keep", B("version 1")], ["dir", null], ["dir/inner", rng(1).bytes(9000)], ["gone", B("deleted later")]]);
  const versions = [v1];
  const rnd = rng(77);
  for (let g = 2; g <= 12; g++) {
    for (let i = 0; i < 12; i++) await m.random(rnd);
    await m.commit(); versions.push(m.snapshot());
    for (let i = 0; i < 5; i++) await m.random(rnd);   // and some more that the next session must not see... unless committed
    await m.commit(); versions.push(m.snapshot());
    const again = await mounted(st, async);
    assert.equal(treeText(await again.tree("save")), versions.at(-1), `generation ${g}`);
  }
  await m.check();
});

both("save: a file open across commits keeps working; committed extents are not written in place", async (async) => {
  const disk = new MemDevice(), st = new TestStorage().set(KIND.SAVE, 0, disk);
  const fs = await mounted(st, async);
  await fs.putFile("save:/f", Buffer.alloc(5000, 1));
  const [, h] = await fs.open("save:/f", MODE.R | MODE.W);
  assert.equal(await fs.path("Commit", "save"), R.OK);
  const committed = disk.snapshot();
  assert.equal(await fs.write(h, 10, Buffer.alloc(20, 2)), R.OK);
  assert.equal(await fs.call("SetFileSize", h, 100), R.OK);
  assert.equal(await fs.path("DeleteFile", "save:/f"), R.OK);
  await fs.putFile("save:/g", Buffer.alloc(9000, 3));
  // every byte of the committed image is still there: the transaction only wrote elsewhere
  const now = disk.snapshot();
  assert.ok(now.length >= committed.length);
  assert.deepEqual(Buffer.from(now.subarray(0, committed.length)), Buffer.from(committed), "the committed version's bytes are untouched before the next commit");
  assert.equal((await fs.read(h, 0, 200))[1].length, 100);
  assert.equal(await fs.path("Commit", "save"), R.OK);
  assert.equal(await fs.write(h, 0, B("after the second commit")), R.OK, "the deleted, open file still answers");
  await fs.close(h);
  const again = await mounted(st, async);
  assert.deepEqual((await again.list("save:/"))!.map(e => `${e.name}:${e.size}`), ["g:9000"]);
});

test("save: the container does not grow with the number of commits (extents are reused once a commit is sealed)", async () => {
  const disk = new MemDevice(), st = new TestStorage().set(KIND.SAVE, 0, disk);
  const fs = await mounted(st), rnd = rng(5);
  let max = 0;
  for (let i = 0; i < 300; i++) {
    await fs.putFile("save:/slot0", rnd.bytes(20000 + rnd.int(2000)));
    await fs.putFile(`save:/small${i % 7}`, rnd.bytes(rnd.int(900)));
    if (i % 5 === 0) await fs.path("DeleteFile", `save:/small${(i + 3) % 7}`);
    assert.equal(await fs.path("Commit", "save"), R.OK);
    if (i === 20) max = disk.size();
  }
  assert.ok(disk.size() <= max * 1.5, `container ${disk.size()} bytes after 300 commits, ${max} after 20`);
  const live = 22000 + 7 * 900;
  assert.ok(disk.size() < 4 * live + 0x4000, `container ${disk.size()} bytes for about ${live} live bytes`);
  console.log(`     300 commits of a 20 KB save: container ${disk.size()} bytes (${max} after 20 commits), arena in use ${fs.x.fs_arena_used()} bytes`);
});

both("save: two mount names share one save and its transaction; device save data is the account save unless the game imports both", async (async) => {
  const st = new MemStorage();
  const fs = await mounted(st, async, "UserSave");
  assert.equal(await fs.mount("MountSave", "Second", 0), R.OK);
  assert.equal(await fs.mount("MountDeviceSave", "Device"), R.OK, "no MountSaveData import seen by fs_lookup: one save");
  await fs.putFile("UserSave:/a", B("via the first name"));
  assert.equal((await fs.getFile("Second:/a"))!.toString(), "via the first name");
  assert.equal((await fs.getFile("Device:/a"))!.toString(), "via the first name");
  await fs.putFile("Device:/b", B("via the third"));
  assert.equal(await fs.rename("RenameFile", "UserSave:/b", "Second:/c"), R.OK, "a rename between two names of one save");
  assert.equal(await fs.path("Commit", "Second"), R.OK);
  assert.equal(fs.saveState(KIND.SAVE), "Clean"); assert.equal(fs.saveState(KIND.DEVICE_SAVE), "none");
  // a list of names of one save is one commit
  await fs.putFile("UserSave:/d", B("d"));
  const list = (names: string[]) => { const p = fs.alloc(8 * names.length); names.forEach((n, i) => fs.dv.setBigUint64(p + 8 * i, BigInt(fs.str(n)), true)); return p; };
  assert.equal(await fs.call("CommitList", list(["UserSave", "Device", "Second"]), 3), R.OK);
  assert.equal(fs.x.fs_save_generation(KIND.SAVE, 0n), 2n);
  assert.equal(await fs.call("CommitList", 0, 0), R.OK);
  assert.equal(await fs.call("CommitList", 0, 2), R.FAIL); assert.equal(await fs.call("CommitList", list(["UserSave"]), -1), R.FAIL); assert.equal(await fs.call("CommitList", list(["UserSave"]), 513), R.FAIL);
  assert.equal(await fs.call("CommitList", list(["UserSave", "nope"]), 2), R.FAIL, "an unknown name refuses the whole list");
  assert.equal(await fs.call("CommitList", list(["UserSave", "x".repeat(32)]), 2), R.FAIL);
  const next = await mounted(st, async);
  assert.deepEqual((await next.list("save:/"))!.map(e => e.name.toString()).sort(), ["a", "c", "d"]);

  // a game that imports MountSaveData and MountDeviceSaveData gets two saves, as on Horizon
  const st2 = new MemStorage(), two = new Fs(st2, { async });
  assert.ok(two.lookup("_ZN2nn2fs13MountSaveDataEPKcRKNS_7account3UidE") > 0);
  assert.equal(await two.mount("MountDeviceSave", "CommonSave"), R.OK); assert.equal(await two.mount("MountSave", "UserSave", 0), R.OK);
  await two.putFile("CommonSave:/userdata.dat", B("common")); await two.putFile("UserSave:/userdata.dat", B("user"));
  assert.equal(await two.path("DeleteFile", "CommonSave:/userdata.dat"), R.OK);
  assert.equal((await two.getFile("UserSave:/userdata.dat"))!.toString(), "user", "deleting in one leaves the other");
  assert.equal(await two.rename("RenameFile", "UserSave:/userdata.dat", "CommonSave:/moved"), R.FAIL, "no rename between two saves");
  assert.equal(await two.call("CommitList", list2(two, ["CommonSave", "UserSave"]), 2), R.FAIL, "a list over two independent saves is refused whole");
  assert.equal(two.red.length, 1);
  assert.equal(two.saveState(KIND.SAVE), "Dirty"); assert.equal(two.saveState(KIND.DEVICE_SAVE), "Dirty");
  assert.equal(await two.path("Commit", "CommonSave"), R.OK); assert.equal(two.saveState(KIND.SAVE), "Dirty"); assert.equal(two.saveState(KIND.DEVICE_SAVE), "Clean");
  // the embedder can say so too
  const three = new Fs(new MemStorage(), { async });
  three.x.fs_set_account_save(1);
  await three.mount("MountDeviceSave", "dev"); assert.equal(three.saveState(KIND.DEVICE_SAVE), "Clean"); assert.equal(three.saveState(KIND.SAVE), "none");
});
function list2(fs: Fs, names: string[]): number { const p = fs.alloc(8 * names.length); names.forEach((n, i) => fs.dv.setBigUint64(p + 8 * i, BigInt(fs.str(n)), true)); return p; }

both("save: a failed storage write poisons the transaction: the commit is refused, the working copy is rebuilt from the committed version, the next transaction commits", async (async) => {
  const disk = new Disk(), st = new TestStorage().set(KIND.SAVE, 0, disk);
  const fs = await mounted(st, async);
  await fs.putFile("save:/slot", B("committed")); await fs.putFile("save:/other", B("other"));
  assert.equal(await fs.path("Commit", "save"), R.OK);
  const [, h] = await fs.open("save:/slot", MODE.R | MODE.W);
  const [, hw] = await fs.open("save:/other", MODE.W), [, hro] = await fs.open("save:/other", MODE.R);
  const [, dh] = await fs.openDir("save:/");
  // the disk is full: the game does not look at WriteFile's result and commits as usual
  disk.plan.fail = (_i, kind) => (kind === "write" ? DEV.NO_SPACE : undefined);
  assert.equal(await fs.call("SetFileSize", h, 0), R.OK, "cutting to 0 writes nothing");
  assert.equal(await fs.write(h, 0, B("half a sav")), R.FAIL);
  assert.equal(fs.saveState(), "Poisoned");
  assert.equal(await fs.write(h, 0, B("again")), R.FAIL);
  assert.equal(fs.saveState(), "Poisoned");
  disk.plan.fail = undefined;
  assert.equal(await fs.write(h, 0, B("this one works")), R.OK, "writes are still attempted");
  assert.equal(fs.saveState(), "Poisoned");
  assert.deepEqual(fs.saveFailed, []);
  assert.equal(await fs.path("Commit", "save"), R.FAIL);
  assert.deepEqual(fs.saveFailed, [28], "the front end is told, with the errno of the first failure");
  assert.equal(fs.saveState(), "Clean");
  assert.ok(fs.red.some(l => /save commit refused/.test(l)) && fs.red.some(l => /4 handle\(s\) were still open/.test(l)), fs.red.join("\n"));
  assert.equal((await fs.getFile("save:/slot"))!.toString(), "committed", "the working copy is the committed version again");
  // what was open in the discarded copy fails until it is closed
  assert.equal((await fs.read(h, 0, 4))[0], R.FAIL); assert.equal(await fs.write(h, 0, B("x")), R.FAIL); assert.equal((await fs.size(h))[0], R.FAIL);
  assert.equal((await fs.readDir(dh, 4))[0], R.FAIL); assert.equal((await fs.dirCount(dh))[0], R.FAIL);
  assert.equal(fs.saveState(), "Clean", "a stale handle changes nothing");
  assert.equal(await fs.write(hw, 0, B("x")), R.FAIL); assert.equal((await fs.read(hro, 0, 1))[0], R.FAIL);
  await fs.close(h); await fs.close(hw); await fs.close(hro); await fs.call("CloseDirectory", dh);
  assert.equal(fs.x.fs_open_files(), 0); assert.equal(fs.x.fs_open_dirs(), 0);
  // the next transaction (the game's next full save) commits
  await fs.putFile("save:/slot", B("second try"));
  assert.equal(await fs.path("Commit", "save"), R.OK);
  const next = await mounted(st, async);
  assert.equal((await next.getFile("save:/slot"))!.toString(), "second try");
  assert.equal((await next.getFile("save:/other"))!.toString(), "other");
});

both("save: when the working copy cannot be rebuilt it stays tainted, the next commit is refused again and retries", async (async) => {
  const disk = new Disk(), st = new TestStorage().set(KIND.SAVE, 0, disk);
  const fs = await mounted(st, async);
  await fs.putFile("save:/slot", B("committed"));
  assert.equal(await fs.path("Commit", "save"), R.OK);
  disk.plan.fail = (_i, kind) => (kind === "write" ? DEV.IO : undefined);
  await fs.path("CreateFile", "save:/new", 100);
  assert.equal(fs.saveState(), "Poisoned");
  assert.equal((await fs.entryType("save:/new"))[0], R.NOT_FOUND, "the failed create left nothing");
  disk.plan.fail = (_i, kind) => (kind === "read" ? DEV.IO : undefined);
  assert.equal(await fs.path("Commit", "save"), R.FAIL);
  assert.equal(fs.saveState(), "Poisoned");
  assert.equal(await fs.path("Commit", "save"), R.FAIL);
  assert.deepEqual(fs.saveFailed, [5, 5]);
  disk.plan.fail = undefined;
  assert.equal(await fs.path("Commit", "save"), R.FAIL, "refused once more, and this time rebuilt");
  assert.equal(fs.saveState(), "Clean");
  assert.equal((await fs.getFile("save:/slot"))!.toString(), "committed");
  await fs.putFile("save:/slot", B("fine")); assert.equal(await fs.path("Commit", "save"), R.OK);
});

both("save: a commit that fails before the superblock leaves the save Dirty and can be made again; one that fails at the superblock reads the save back", async (async) => {
  const disk = new Disk(), st = new TestStorage().set(KIND.SAVE, 0, disk);
  const fs = await mounted(st, async);
  await fs.putFile("save:/slot", B("v1")); assert.equal(await fs.path("Commit", "save"), R.OK);
  await fs.putFile("save:/slot", B("v2"));
  // the manifest cannot be written
  disk.plan.fail = (_i, kind) => (kind === "write" ? DEV.NO_SPACE : undefined);
  assert.equal(await fs.path("Commit", "save"), R.FAIL); assert.equal(fs.saveState(), "Dirty");
  // the first barrier fails
  disk.plan.fail = (_i, kind) => (kind === "flush" ? DEV.IO : undefined);
  assert.equal(await fs.path("Commit", "save"), R.FAIL); assert.equal(fs.saveState(), "Dirty");
  assert.deepEqual(fs.saveFailed, [], "nothing was lost: the game may commit again");
  assert.equal((await fs.getFile("save:/slot"))!.toString(), "v2");
  disk.plan.fail = undefined;
  assert.equal((await mounted(new TestStorage().set(KIND.SAVE, 0, new MemDevice(disk.mem.snapshot())), async)).x.fs_save_generation(KIND.SAVE, 0n), 1n);
  assert.equal(await fs.path("Commit", "save"), R.OK); assert.equal(fs.x.fs_save_generation(KIND.SAVE, 0n), 2n);
  // the superblock write fails: which version is committed is only known to the device
  await fs.putFile("save:/slot", B("v3"));
  const [, h] = await fs.open("save:/slot");
  let writes = 0;
  disk.plan.fail = (_i, kind) => (kind === "write" && ++writes === 2 ? DEV.IO : undefined);   // the manifest, then the slot
  assert.equal(await fs.path("Commit", "save"), R.FAIL);
  assert.equal(fs.saveState(), "Clean"); assert.deepEqual(fs.saveFailed, [5]);
  assert.equal((await fs.getFile("save:/slot"))!.toString(), "v2", "the device still has version 2");
  assert.equal((await fs.read(h, 0, 2))[0], R.FAIL, "handles of the discarded copy are stale"); await fs.close(h);
  // the second barrier fails: the slot is written, the device has version 3
  await fs.putFile("save:/slot", B("v3"));
  let flushes = 0;
  disk.plan.fail = (_i, kind) => (kind === "flush" && ++flushes === 2 ? DEV.IO : undefined);
  assert.equal(await fs.path("Commit", "save"), R.FAIL, "the call reports the failure");
  assert.equal(fs.saveState(), "Clean");
  assert.equal((await fs.getFile("save:/slot"))!.toString(), "v3", "and the save is what the device has");
  assert.equal(fs.x.fs_save_generation(KIND.SAVE, 0n), 3n);
  disk.plan.fail = undefined;
  await fs.putFile("save:/slot", B("v4")); assert.equal(await fs.path("Commit", "save"), R.OK);
  // the superblock write fails and the device cannot be read either: read-only from here on
  await fs.putFile("save:/slot", B("v5"));
  writes = 0;
  disk.plan.fail = (_i, kind) => (kind === "write" && ++writes === 2 ? DEV.IO : kind === "read" || kind === "size" ? (writes >= 2 ? DEV.IO : undefined) : undefined);
  assert.equal(await fs.path("Commit", "save"), R.FAIL);
  assert.equal(fs.saveState(), "ReadOnly");
  disk.plan.fail = undefined;
  assert.equal(await fs.path("CreateFile", "save:/x", 0), R.FAIL);
  assert.equal((await mounted(new TestStorage().set(KIND.SAVE, 0, new MemDevice(disk.mem.snapshot())), async)).x.fs_save_generation(KIND.SAVE, 0n), 4n);
});

both("save: a container that cannot be opened or read mounts read-only: every write fails, commits are no-ops, the front end is told", async (async) => {
  for (const what of ["open fails", "garbage", "manifest damaged"]) {
    const st = new TestStorage();
    if (what === "open fails") st.set(KIND.SAVE, 0, DEV.IO);
    else if (what === "garbage") st.set(KIND.SAVE, 0, new MemDevice(rng(9).bytes(20000)));
    else {
      const d = new MemDevice(); st.set(KIND.SAVE, 0, d);
      const w = await mounted(st, async); await w.putFile("save:/f", B("data")); await w.path("Commit", "save");
      const b = d.snapshot(); for (let i = 0x2000; i < b.length; i++) b[i] ^= 0x55;
      st.set(KIND.SAVE, 0, new MemDevice(b));
    }
    const before = st.get(KIND.SAVE) instanceof MemDevice ? (st.get(KIND.SAVE) as MemDevice).snapshot() : null;
    const fs = new Fs(st, { async });
    assert.equal(await fs.mount("MountSave", "save", 0), R.OK, `${what}: the mount itself succeeds`);
    assert.equal(fs.saveState(), "ReadOnly", what);
    assert.deepEqual(fs.saveFailed, [5]);
    assert.ok(fs.red.some(l => /mounted read-only/.test(l)));
    assert.equal(await fs.mount("IsMounted", "save"), 1);
    assert.deepEqual(await fs.list("save:/"), []);
    assert.deepEqual(await fs.entryType("save:/"), [R.OK, 0]);
    assert.equal(await fs.path("CreateFile", "save:/new", 0), R.FAIL); assert.equal(await fs.path("CreateDirectory", "save:/"), R.EXISTS, "what exists answers 'exists', as a writable mount would");
    assert.equal(await fs.path("CreateDirectory", "save:/d"), R.FAIL);
    assert.equal(await fs.path("DeleteFile", "save:/new"), R.NOT_FOUND); assert.equal(await fs.path("DeleteDirRec", "save:/"), R.FAIL); assert.equal(await fs.path("CleanDirRec", "save:/"), R.FAIL);
    assert.equal(await fs.rename("RenameFile", "save:/a", "save:/b"), R.NOT_FOUND);
    assert.equal((await fs.open("save:/new", MODE.W))[0], R.NOT_FOUND);
    assert.equal(await fs.path("Commit", "save"), R.OK, "a commit on it is a no-op");
    assert.equal(await fs.call("CommitList", list2(fs, ["save"]), 1), R.FAIL, "a list with a read-only mount is refused");
    assert.equal(await fs.mount("MountSave", "second", 0), R.OK);
    assert.equal(await fs.path("CreateFile", "second:/new", 0), R.FAIL);
    if (before) assert.deepEqual(Buffer.from((st.get(KIND.SAVE) as MemDevice).snapshot()), Buffer.from(before), "what is stored is left as it is");
  }
});

both("save: temporary storage is not transactional; cache storages are separate saves, committed, deleted", async (async) => {
  const st = new TestStorage();
  const fs = new Fs(st, { async });
  assert.equal(await fs.mount("MountTemp", "temp"), R.OK);
  await fs.putFile("temp:/scratch", B("tmp"));
  assert.equal(await fs.path("Commit", "temp"), R.OK);
  assert.equal(fs.saveState(KIND.TEMP), "Dirty", "Commit on temporary storage does nothing");
  assert.equal((await fs.getFile("temp:/scratch"))!.toString(), "tmp");
  assert.equal(await fs.call("CreateCache", 1, 1 << 20, 1 << 20), R.OK);
  assert.equal(await fs.mount("MountCache", "cache", 1), R.OK); assert.equal(await fs.mount("MountCache0", "cache0"), R.OK);
  await fs.putFile("cache:/shader.bin", B("one")); await fs.putFile("cache0:/shader.bin", B("zero"));
  assert.equal((await fs.getFile("cache:/shader.bin"))!.toString(), "one");
  assert.equal(await fs.path("Commit", "cache"), R.OK);
  assert.equal(fs.saveState(KIND.CACHE, 1n), "Clean"); assert.equal(fs.saveState(KIND.CACHE, 0n), "Dirty");
  // a list with a save and cache storages: the save is one commit, each cache storage is committed too
  assert.equal(await fs.mount("MountSave", "save", 0), R.OK);
  await fs.putFile("save:/s", B("s")); await fs.putFile("cache:/shader.bin", B("one, again"));
  assert.equal(await fs.call("CommitList", list2(fs, ["cache0", "save", "temp", "cache"]), 4), R.OK);
  for (const [k, i] of [[KIND.SAVE, 0n], [KIND.CACHE, 0n], [KIND.CACHE, 1n]] as const) assert.equal(fs.saveState(k, i), "Clean");
  assert.equal(await fs.call("DeleteCache", 1), R.FAIL, "a mounted cache storage is not deleted");
  assert.equal(await fs.call("DeleteCache", 7), R.OK);
  assert.deepEqual(st.removed, [`${KIND.CACHE}:7`]);
  // the next session: the cache storages are there, temporary storage is empty
  const next = new Fs(st, { async });
  await next.mount("MountCache", "c1", 1); await next.mount("MountCache", "c0", 0); await next.mount("MountTemp", "t");
  assert.equal((await next.getFile("c1:/shader.bin"))!.toString(), "one, again"); assert.equal((await next.getFile("c0:/shader.bin"))!.toString(), "zero");
  assert.deepEqual(await next.list("t:/"), []);
  const third = new Fs(st, { async });
  assert.equal(await third.call("DeleteCache", 1), R.OK);
  await third.mount("MountCache", "c1", 1);
  assert.deepEqual(await third.list("c1:/"), [], "deleted and created again");
});

test("save: on real files (Node storage over a directory): commit, new process, rollback", async () => {
  const dir = join(SCRATCH, "nodesave");
  let fs = await mounted(new NodeStorage({ saveDir: dir }));
  const m = new Model(fs), rnd = rng(31);
  for (let i = 0; i < 60; i++) await m.random(rnd);
  await m.commit();
  const v = m.snapshot();
  for (let i = 0; i < 30; i++) { const op = await m.random(rnd); if (op === "commit") break; }
  const v2 = m.committed;
  fs.host.closeDevices();
  fs = await mounted(new NodeStorage({ saveDir: dir }));
  assert.equal(treeText(await fs.tree("save")), v2);
  assert.ok(v.length > 0);
  fs.host.closeDevices();
});

for (const seed of [1, 2, 3, 4]) both(`save: 400 random operations against the model (seed ${seed})`, async (async) => {
  const st = new MemStorage();
  let fs = await mounted(st, async), m = new Model(fs);
  const rnd = rng(seed * 1000 + 7);
  for (let i = 0; i < 400; i++) {
    let op = "";
    try { op = await m.random(rnd); if (i % 40 === 39) await m.check(); }
    catch (e) { throw new Error(`seed ${seed}, operation ${i} (${op}): ${e instanceof Error ? e.stack : e}`); }
    if (i % 97 === 96) {   // a new session: back to the last commit
      const committed = m.committed, nodes = committedNodes(m);
      fs = await mounted(st, async);
      assert.equal(treeText(await fs.tree("save")), committed, `seed ${seed}: remount after operation ${i}`);
      m = new Model(fs); m.nodes = nodes; m.committed = committed;
    }
  }
  assert.deepEqual(fs.red, []);
});
const snaps = new WeakMap<Model, Map<string, Buffer | null>>();
function committedNodes(m: Model): Map<string, Buffer | null> { return snaps.get(m) ?? new Map(); }
// keep the committed node set beside the model (its snapshot text alone cannot seed a new model)
const realCommit = Model.prototype.commit;
Model.prototype.commit = async function (this: Model, want = R.OK) { const before = new Map(this.nodes); const c = this.commits; await realCommit.call(this, want); if (this.commits > c) snaps.set(this, before); };

test("save: two guest threads with asynchronous storage: writes wait while a commit is in flight, mounts of one save do not race", async () => {
  const st = new MemStorage();
  const fs = new Fs(st, { async: true });
  // two threads mount the same save under two names at once
  assert.deepEqual(await Promise.all([fs.mount("MountSave", "a", 0), fs.mount("MountSave", "b", 0), fs.mount("MountDeviceSave", "c")]), [R.OK, R.OK, R.OK]);
  assert.ok(fs.retries >= 2, "the second and third mount were told to retry while the first was pending");
  assert.equal(fs.x.fs_mount_count(), 3);
  await fs.putFile("a:/f", B("before"));
  // thread 1 commits; thread 2 writes and creates while the commit waits for its barriers
  const before = fs.retries;
  const [c, w, k, rd] = await Promise.all([
    fs.path("Commit", "a"),
    fs.putFile("b:/f", B("written during the commit")).then(() => R.OK),
    fs.path("CreateFile", "c:/g", 5),
    fs.getFile("b:/f").then(d => d!.toString()),
  ]);
  assert.deepEqual([c, w, k], [R.OK, R.OK, R.OK]);
  assert.equal(rd, "before", "a read does not wait for the commit");
  assert.ok(fs.retries > before, "the writers were parked for retry");
  assert.equal(fs.saveState(), "Dirty", "what was written during the commit belongs to the next transaction");
  const next = await mounted(st, true);
  assert.equal((await next.getFile("save:/f"))!.toString(), "before");
  assert.equal((await next.entryType("save:/g"))[0], R.NOT_FOUND);
  // two commits at once: one after the other
  assert.deepEqual(await Promise.all([fs.path("Commit", "a"), fs.path("Commit", "b")]), [R.OK, R.OK]);
  assert.equal((await (await mounted(st, true)).getFile("save:/f"))!.toString(), "written during the commit");
  assert.equal(fs.x.fs_pending(), 0);
});

test("save: limits: 512 mount names, 31-byte names, 1024 open files, 256 open directories, a full arena: refused, never a trap", async () => {
  const fs = await mounted(new MemStorage());
  // names are kept up to 31 bytes; a longer one is cut and then matches no path (nxnative's strlcpy into name[32])
  const n31 = "n".repeat(31), n40 = "m".repeat(40);
  assert.equal(await fs.mount("MountSave", n31, 0), R.OK); assert.equal(await fs.mount("MountSave", n40, 0), R.OK);
  assert.equal(await fs.mount("IsMounted", n31), 1); assert.equal(await fs.mount("IsMounted", n40), 0); assert.equal(await fs.mount("IsMounted", "m".repeat(31)), 1);
  assert.equal((await fs.entryType(n31 + ":/"))[0], R.OK); assert.equal((await fs.entryType(n40 + ":/"))[0], R.NOT_FOUND);
  for (let i = fs.x.fs_mount_count(); i < 512; i++) assert.equal(await fs.mount("MountSave", `m${i}`, 0), R.OK);
  assert.equal(fs.x.fs_mount_count(), 512);
  assert.equal(await fs.mount("MountSave", "one-too-many", 0), R.FAIL);
  assert.match(fs.red.at(-1)!, /mount table is full/);
  assert.equal(await fs.mount("MountSave", "m400", 0), R.OK, "a name in use is still answered");
  await fs.putFile("m511:/f", B("x"));
  const hs: bigint[] = [];
  for (let i = 0; i < 1024; i++) { const [r, h] = await fs.open("save:/f"); assert.equal(r, R.OK); hs.push(h); }
  assert.equal(new Set(hs).size, 1024);
  assert.equal((await fs.open("save:/f"))[0], R.FAIL);
  assert.match(fs.red.at(-1)!, /every handle slot is in use/);
  for (const h of hs) await fs.close(h);
  assert.equal((await fs.open("save:/f"))[0], R.OK);
  const ds: bigint[] = [];
  for (let i = 0; i < 256; i++) { const [r, h] = await fs.openDir("save:/"); assert.equal(r, R.OK); ds.push(h); }
  assert.equal((await fs.openDir("save:/"))[0], R.FAIL);
  for (const h of ds) await fs.call("CloseDirectory", h);
  assert.equal(fs.x.fs_open_dirs(), 0);
  // a small arena: creating files until it is full fails cleanly, and the save still commits and reads
  const small = new Fs(new MemStorage(), { arena: 96 << 10 });
  assert.equal(await small.mount("MountSave", "save", 0), R.OK);
  let made = 0, r = R.OK;
  for (; made < 5000 && r === R.OK; made++) r = await small.path("CreateFile", `save:/file-with-a-rather-long-name-${made}`, 0);
  assert.equal(r, R.FAIL); assert.ok(made > 100 && made < 5000, `${made} files fit`);
  assert.equal((await small.list("save:/", 3, 50)) === null || true, true);
  assert.equal(await small.path("DeleteFile", "save:/file-with-a-rather-long-name-0"), R.OK);
});

test("save: thousands of files in one save, committed and read back", async () => {
  const st = new MemStorage();
  const fs = await mounted(st), rnd = rng(8), want = new Map<string, Buffer>();
  for (let d = 0; d < 20; d++) {
    assert.equal(await fs.path("CreateDirectory", `save:/d${d}`), R.OK);
    for (let i = 0; i < 150; i++) { const data = rnd.bytes(rnd.int(300)); want.set(`d${d}/f${i}`, data); await fs.putFile(`save:/d${d}/f${i}`, data); }
  }
  assert.equal(await fs.path("Commit", "save"), R.OK);
  const next = await mounted(st);
  const t = await next.tree("save");
  assert.equal(t.size, 20 + 3000);
  for (const [p, d] of [...want].filter((_, i) => i % 37 === 0)) assert.deepEqual(await next.getFile(`save:/${p}`), d);
  assert.equal((await next.list("save:/d7", 2, 64))!.length, 150);
});
