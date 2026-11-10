// Crash safety: the storage is killed at every operation of a scenario (and at random ones of random scenarios),
// with a killed write reaching the device not at all, in part or whole, or with the power lost (anything not yet
// flushed may be lost or torn). The next session must find the last version whose Commit returned, or the one
// whose Commit was in flight: never a mix, never a container it cannot use.
import assert from "node:assert/strict";
import { test, Fs, R, MODE, KIND, rng, treeText } from "./harness.mts";
import { DEV } from "../../src/glue/fs_host.ts";
import { Disk, Killed, TestStorage, type Plan } from "./fault.mts";
import { Model } from "./model.mts";

const B = (s: string) => Buffer.from(s);
interface Ctx { fs: Fs; m: Model; disk: Disk }
type Body = (c: Ctx) => Promise<void>;
const SMALL = { arena: 2 << 20, guest: 2 << 20, cover: false };

async function session(bytes: Uint8Array | undefined, plan: Plan, from?: Model): Promise<Ctx> {
  const disk = new Disk(bytes, plan), fs = new Fs(new TestStorage().set(KIND.SAVE, 0, disk), SMALL);
  const m = new Model(fs);
  if (from) { m.adopt(from); m.committed = from.committed; }
  return { fs, m, disk };
}
// What a new session finds on `bytes`: the tree text. The container must mount clean and take a further commit.
async function recovered(bytes: Uint8Array, why: string): Promise<{ text: string; bytes: Uint8Array }> {
  const disk = new Disk(bytes), fs = new Fs(new TestStorage().set(KIND.SAVE, 0, disk), SMALL);
  assert.equal(await fs.mount("MountSave", "save", 0), R.OK, why);
  assert.equal(fs.saveState(), "Clean", `${why}: the save mounts read-write (${fs.red.join(" | ")})`);
  const text = treeText(await fs.tree("save"));
  // and it is a working save: one more transaction on top of it
  await fs.putFile("save:/after-the-crash", B("still a save"));
  assert.equal(await fs.path("Commit", "save"), R.OK, why);
  const again = new Fs(new TestStorage().set(KIND.SAVE, 0, new Disk(disk.mem.snapshot())), SMALL);
  await again.mount("MountSave", "save", 0);
  assert.equal((await again.getFile("save:/after-the-crash"))?.toString(), "still a save", why);
  const t2 = await again.tree("save"); t2.delete("after-the-crash");
  assert.equal(treeText(t2), text.split("\n").filter(l => !l.startsWith("after-the-crash ")).join("\n"), `${why}: the transaction after the crash kept the tree`);
  return { text, bytes: disk.mem.snapshot() };
}

// Run `body` on a copy of the baseline with the storage killed at operation k. Returns what happened.
async function killAt(base: Uint8Array | undefined, baseModel: Model, body: Body, k: number, tear: number, power: boolean, seed: number): Promise<"old" | "new" | "ran to the end"> {
  const c = await session(base, { killAt: k, tear, power }, baseModel);
  let killed = false;
  try { assert.equal(await c.fs.mount("MountSave", "save", 0), R.OK); await body(c); }
  catch (e) { if (!(e instanceof Killed)) throw e; killed = true; }
  const allowed = [c.m.committed];
  if (killed && c.m.committing !== null) allowed.push(c.m.committing);
  const why = `killed at operation ${k} (${c.disk.kinds[k] ?? "past the end"}), ${power ? "power loss" : "process killed"}, tear ${tear}, seed ${seed}`;
  const { text } = await recovered(c.disk.survivor(rng(seed)), why);
  if (!allowed.includes(text)) {
    assert.fail(`${why}: the save is neither the old nor the new version\n--- found ---\n${text}\n--- last committed ---\n${allowed[0]}${allowed[1] !== undefined ? "\n--- being committed ---\n" + allowed[1] : ""}`);
  }
  return !killed ? "ran to the end" : text === allowed[0] ? "old" : "new";
}

// Kill at every operation index of body (after `setup` made the baseline), for every way a killed write can end
async function exhaustive(name: string, setup: Body | null, body: Body): Promise<void> {
  let base: Uint8Array | undefined, baseModel = new Model(null as unknown as Fs);
  if (setup) {
    const c = await session(undefined, {});
    assert.equal(await c.fs.mount("MountSave", "save", 0), R.OK);
    await setup(c);
    base = c.disk.mem.snapshot(); baseModel = c.m;
  }
  const dry = await session(base, {}, baseModel);
  await dry.fs.mount("MountSave", "save", 0); await body(dry);
  const total = dry.disk.ops, kinds = dry.disk.kinds.slice();
  const count: Record<string, number> = { old: 0, new: 0, "ran to the end": 0 };
  let runs = 0;
  for (let k = 0; k <= total; k++) {
    const tears = kinds[k] === "write" ? [0, 0.5, 1] : [0];
    for (const tear of tears) { count[await killAt(base, baseModel, body, k, tear, false, 1)]++; runs++; }
    for (let seed = 1; seed <= 3; seed++) { count[await killAt(base, baseModel, body, k, kinds[k] === "write" ? seed / 3 : 0, true, seed * 7919 + k)]++; runs++; }
  }
  assert.equal(count["ran to the end"], 4, "only the runs killed past the last operation complete");
  assert.ok(count.old > 0, "some kills leave the old version");
  console.log(`     ${name}: ${total} storage operations (${kinds.filter(k => k === "write").length} writes, ${kinds.filter(k => k === "flush").length} flushes), ${runs} kills: ${count.old} left the old version, ${count.new} the new one`);
}

test("crash: the first commit of a new save, killed at every storage operation (mount, format, writes, both barriers)", async () => {
  await exhaustive("first commit", null, async ({ m }) => {
    await m.mkdir("profile"); await m.put("profile/slot0.sav", rng(1).bytes(70000)); await m.put("profile/slot1.sav", B("small")); await m.put("system.dat", rng(2).bytes(3000)); await m.create("empty");
    await m.commit();
  });
});

const world: Body = async ({ m }) => {
  await m.mkdir("profile"); await m.mkdir("profile/old"); await m.put("profile/slot0.sav", rng(1).bytes(20000)); await m.put("profile/slot1.sav", rng(2).bytes(5000));
  await m.put("profile/old/a", B("aaaa")); await m.put("profile/old/b", B("bbbb")); await m.put("system.dat", rng(3).bytes(9000)); await m.put("delete-me", rng(4).bytes(1234));
  await m.commit();
  await m.put("system.dat", rng(5).bytes(8000)); await m.commit();   // a second generation, so both superblock slots are in use
};

test("crash: a full rewrite, a patch in place, delete, rename, new directory, then one commit: killed at every operation", async () => {
  await exhaustive("rewrite and commit", world, async ({ m }) => {
    await m.put("profile/slot0.sav", rng(10).bytes(26000));            // the game's usual save: cut and rewrite
    await m.writeAt("profile/slot1.sav", 1000, rng(11).bytes(300));    // a patch in the middle of a committed file
    await m.writeAt("system.dat", 12000, B("past the end"));           // extend with a gap
    await m.setSize("profile/old/a", 2);
    await m.del("delete-me"); await m.rename("profile/old", "archive"); await m.mkdir("profile/new"); await m.put("profile/new/c", B("cccc"));
    await m.commit();
  });
});

test("crash: three commits in a row, killed at every operation: always the last commit that returned, or the one in flight", async () => {
  await exhaustive("three commits", world, async ({ m }) => {
    await m.put("profile/slot0.sav", rng(20).bytes(15000)); await m.commit();
    await m.del("profile/slot1.sav"); await m.put("profile/slot2.sav", rng(21).bytes(6000)); await m.commit();
    await m.rmrf("profile/old"); await m.put("system.dat", B("tiny")); await m.commit();
  });
});

test("crash: a burst of writes that is never committed, killed at every operation: always the committed version", async () => {
  let news = 0;
  const realLog = console.log;
  console.log = (l: string) => { news = Number(/(\d+) the new one/.exec(l)?.[1] ?? 0); realLog(l); };
  try {
    await exhaustive("write burst", world, async ({ m }) => {
      const rnd = rng(30);
      for (let i = 0; i < 12; i++) await m.writeAt(rnd.pick(["profile/slot0.sav", "profile/slot1.sav", "system.dat"]), rnd.int(20000), rnd.bytes(1 + rnd.int(5000)));
      await m.del("delete-me"); await m.put("fresh", rng(31).bytes(40000)); await m.setSize("system.dat", 100); await m.rmrf("profile");
    });
  } finally { console.log = realLog; }
  assert.equal(news, 0, "nothing uncommitted is ever found");
});

test("crash: a refused commit (a write failed) and the rebuild of the working copy, killed at every operation", async () => {
  await exhaustive("refused commit, rebuild, next commit", world, async ({ fs, m, disk }) => {
    const before = disk.plan.fail;
    let writes = 0;
    disk.plan.fail = (_i, kind) => (kind === "write" && ++writes === 2 ? DEV.NO_SPACE : undefined);
    const [, h] = await fs.open("save:/profile/slot0.sav", MODE.W);
    assert.equal(await fs.call("SetFileSize", h, 0), R.OK);
    assert.equal(await fs.write(h, 0, rng(40).bytes(3000)), R.OK);
    assert.equal(await fs.write(h, 3000, rng(41).bytes(3000)), R.FAIL);      // the disk is full
    await fs.close(h);
    disk.plan.fail = before;
    m.committing = null;
    assert.equal(await fs.path("Commit", "save"), R.FAIL);                 // refused: the model's tree is still the committed one
    assert.equal(fs.saveState(), "Clean");
    await m.check("after the rebuild");
    await m.put("profile/slot0.sav", rng(42).bytes(7000)); await m.commit();
  });
});

test("crash: random scenarios, random kill points, process kills and power losses", async () => {
  const N = Number(process.env.FS_CRASH_SEEDS ?? 400);
  const count: Record<string, number> = { old: 0, new: 0, "ran to the end": 0 };
  let ops = 0;
  for (let seed = 1; seed <= N; seed++) {
    // a baseline with some history
    const c = await session(undefined, {});
    await c.fs.mount("MountSave", "save", 0);
    const r0 = rng(seed);
    for (let i = 0; i < 25; i++) await c.m.random(r0);
    await c.m.commit();
    const base = c.disk.mem.snapshot(), baseModel = c.m;
    const body: Body = async ({ m }) => {
      const r = rng(seed * 7 + 1);
      for (let i = 0; i < 40; i++) { await m.random(r); if (r.int(9) === 0) await m.commit(); }
    };
    const dry = await session(base, {}, baseModel);
    await dry.fs.mount("MountSave", "save", 0);
    try { await body(dry); } catch (e) { throw new Error(`seed ${seed}, without a kill: ${e instanceof Error ? e.stack : e}`); }
    ops += dry.disk.ops;
    const pick = rng(seed * 31 + 5);
    for (let j = 0; j < 4; j++) {
      const k = pick.int(dry.disk.ops + 1);
      try { count[await killAt(base, baseModel, body, k, pick.int(5) / 4, pick.int(2) === 1, seed * 100 + j)]++; }
      catch (e) { throw new Error(`seed ${seed}, kill ${j}: ${e instanceof Error ? e.stack : e}`); }
    }
  }
  assert.ok(count.old > N / 2 && count.new > N / 20, JSON.stringify(count));
  console.log(`     ${N} random scenarios (${ops} storage operations in all), ${4 * N} kills: ${count.old} left the last committed version, ${count.new} the one being committed, ${count["ran to the end"]} past the end`);
});

test("crash: both superblock slots damaged, or the manifest of the newest generation damaged: read-only, nothing written, nothing guessed", async () => {
  const c = await session(undefined, {});
  await c.fs.mount("MountSave", "save", 0);
  await world(c);
  const good = c.disk.mem.snapshot();
  const gen = c.fs.x.fs_save_generation(KIND.SAVE, 0n);
  const open = async (b: Uint8Array) => { const d = new Disk(b); const fs = new Fs(new TestStorage().set(KIND.SAVE, 0, d), SMALL); await fs.mount("MountSave", "save", 0); return { fs, d }; };
  // one slot damaged: the other one (the older generation's, if it is the newer that broke) is NOT taken when the
  // newer slot is merely torn mid-write... it is: a torn newer slot means that commit never happened
  const newer = Number(gen & 1n) * 0x1000, older = 0x1000 - newer;
  const b1 = good.slice(); b1[newer + 20] ^= 0xFF;
  const s1 = await open(b1);
  assert.equal(s1.fs.saveState(), "Clean"); assert.equal(s1.fs.x.fs_save_generation(KIND.SAVE, 0n), gen - 1n, "a torn newer slot: the commit before it is the committed one");
  const b2 = good.slice(); b2[older + 20] ^= 0xFF;
  const s2 = await open(b2);
  assert.equal(s2.fs.saveState(), "Clean"); assert.equal(s2.fs.x.fs_save_generation(KIND.SAVE, 0n), gen);
  const b3 = good.slice(); b3[20] ^= 0xFF; b3[0x1000 + 20] ^= 0xFF;
  const s3 = await open(b3);
  assert.equal(s3.fs.saveState(), "ReadOnly"); assert.equal(s3.d.kinds.filter(k => k === "write").length, 0);
  // random damage anywhere: mounts clean with some committed tree, or read-only; never a trap, never a write to a damaged container at mount
  const rnd = rng(99);
  let ro = 0, clean = 0;
  for (let i = 0; i < 1500; i++) {
    const b = good.slice();
    for (let n = 1 + rnd.int(4); n > 0; n--) { const at = rnd.int(3) === 0 ? rnd.int(2) * 0x1000 + rnd.int(64) : rnd.int(b.length); b[at] = rnd.int(2) ? rnd.int(256) : b[at] ^ (1 << rnd.int(8)); }
    const cut = rnd.int(10) === 0 ? b.slice(0, rnd.int(b.length)) : b;
    let s;
    try { s = await open(cut); if (s.fs.saveState() === "Clean") { await s.fs.tree("save"); clean++; } else { assert.equal(s.fs.saveState(), "ReadOnly"); ro++; } }
    catch (e) { throw new Error(`damage ${i} (seed 99): ${e instanceof Error ? e.stack : e}`); }
    if (s.fs.saveState() === "ReadOnly") assert.equal(s.d.kinds.filter(k => k === "write").length, 0);
  }
  console.log(`     1500 damaged containers: ${clean} mounted (the damage missed the committed metadata, or hit one slot), ${ro} read-only`);
});
