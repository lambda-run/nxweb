// The table as a whole: the inventory against nxnative's sources, every in-scope name resolving, and every entry
// callable with all-zero arguments without a trap.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, Hle, inventory, status, NXNATIVE } from "./harness.mts";

test("inventory: one row per HLE / HLE_FORCE / HLE_FORCE_BIG use and per pass-through name of nxnative's dm/host", () => {
  const inv = inventory(), dir = join(NXNATIVE, "dm", "host");
  // an independent count: registrations as the linker sees them. Wrapper macros hide them from a plain search, so
  // the files without wrappers are compared exactly and the others must have at least their plain uses
  const wrappers = new Set(["hle_net.c", "hle_misc.c", "hle_swkbd.c", "hle_hid.c", "hle_fs.c", "hle_codec_video.c", "hle_table.c", "hle_offline.c"]);
  for (const f of readdirSync(dir).filter(f => /^hle.*\.c$/.test(f))) {
    const text = readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "");
    const plain = (text.match(/^\s*(?:HLE|HLE_FORCE|HLE_FORCE_BIG)\("/gm) ?? []).length;
    const rows = inv.filter(r => r.file === f).length;
    if (wrappers.has(f)) assert.ok(rows >= plain, `${f}: ${rows} rows, ${plain} plain uses`);
    else assert.equal(rows, plain, `${f}: rows against plain uses`);
  }
  assert.equal(inv.filter(r => r.file === "hle_table.c").length, 63, "the libc pass-through list");
  assert.equal(inv.filter(r => r.file === "hle_net.c").length, 101);
  assert.ok(inv.some(r => r.mangled === "_ZN2nn5prepo10PlayReport4SendERKNS_7account3UidE" && r.kind === "forced"), "the entry hle_offline.c writes out by hand");
  for (const r of inv) {
    assert.ok(r.kind === "forced" || r.kind === "weak");
    if (r.kind === "forced") assert.ok(r.reason.length > 0, `${r.mangled}: a forced entry states its reason`);
    if (r.mangled.startsWith("_Z")) assert.notEqual(r.demangled, r.mangled, `${r.mangled} demangles`);
  }
  assert.equal(inv.find(r => r.mangled === "_ZN2nn2oe25TryPopNotificationMessageEPj")!.demangled, "nn::oe::TryPopNotificationMessage(unsigned int*)");
});

test("table: every inventoried in-scope name resolves, with its kind; none is a stub", () => {
  const h = new Hle(), st = status().filter(r => !r.status.startsWith("out of scope")), entries = h.host.entries();
  assert.equal(entries.filter(e => !e.internal).length, st.length);
  assert.equal(h.x.hle_count(), st.length);
  const forcedNames = new Set(st.filter(r => r.kind === "forced").map(r => r.mangled));
  for (const r of st) {
    const id = h.host.lookup(r.mangled);
    assert.ok(id >= 0, `${r.mangled} resolves`);
    const e = entries[id];
    assert.equal(e.name, r.mangled);
    assert.equal(e.forced, forcedNames.has(r.mangled), `${r.mangled}: lookup gives the forced entry when the name has one`);
    assert.ok(e.implemented, `${r.mangled} is implemented`);
  }
  assert.equal(h.host.lookup("_ZN2nn2fs9MountRomEPKcPvm"), -1, "a file system name is not this table's");
  assert.equal(h.host.lookup(""), -1);
  assert.equal(h.host.lookup("zzzz"), -1);
  // the three names both tables have: the forced one wins, the weak one is marked
  for (const n of ["mktime", "localtime_r"]) {
    const both = entries.filter(e => e.name === n);
    assert.equal(both.length, 2, n);
    assert.ok(both.find(e => !e.forced)!.shadowed);
  }
  assert.equal(new Set(entries.filter(e => !e.shadowed && !e.duplicate).map(e => e.name)).size, entries.filter(e => !e.shadowed && !e.duplicate).length, "names to register are unique");
  assert.deepEqual(entries.filter(e => e.internal).map(e => e.name), ["hle.ngc_v_zero", "hle.ngc_v_none", "hle.ngc_v_check", "hle.ngc_v_mask"]);
});

test("table: every entry can be called with zero arguments without trapping (twice, and resumed when it waits)", () => {
  const h = new Hle();
  h.onText = () => { h.host.textAnswer(null); };
  let waits = 0, noReturn = 0;
  for (let round = 0; round < 2; round++) for (const e of h.host.entries()) {
    let r = h.callRegs(e.id, {});
    for (let i = 0; r.wait && i < 4; i++) { waits++; assert.ok(h.events.has(r.wait.handle), `${e.demangled}: waits on a real event`); r = h.resume(i < 2 ? "timeout" : "cancelled"); }
    if (r.noReturn) noReturn++;
    h.last = null;
  }
  assert.ok(waits > 0, "some calls wait (PopNotificationMessage, Poll with a timeout, WaitForExit)");
  assert.equal(noReturn, 2 * 4, "the three aborts and ExecuteProgram do not return");
  assert.equal(h.red.filter(l => l.endsWith(" unimplemented")).length, 0);
  assert.equal(h.x.hle_call_count(h.id("_ZN2nn2oe16GetOperationModeEv")), 2);
});

test("table: an id outside the table and a missing implementation are red lines, not traps", () => {
  const h = new Hle();
  assert.equal(h.host.call(100000).x0, 0n);
  assert.equal(h.host.call(-1).x0, 0n);
  assert.equal(h.red.length, 2);
});
