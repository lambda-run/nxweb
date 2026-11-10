// The API toward the runtime: fs_lookup over nxnative's names, stubs, and the calls that only answer constants.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, both, Fs, FN, MANGLED, R, NXNATIVE, KIND } from "./harness.mts";
import { MemStorage } from "../../src/glue/fs_host.ts";
import { namesOf } from "../../src/fs/host/gen_names.mts";

test("names: every HLE / HLE_FORCE name of nxnative's hle_fs.c resolves, in its order; other names do not", () => {
  const fs = new Fs(new MemStorage());
  assert.equal(MANGLED.length, 73);
  MANGLED.forEach((n, i) => assert.equal(fs.lookup(n), i + 1, n));
  assert.deepEqual(fs.host.names().map(n => n.name), MANGLED);
  for (const n of ["", "_ZN2nn2fs8OpenFile", "_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKciX", "_ZN2nn2os9WaitEventEPNS0_9EventTypeE", "x".repeat(600)]) assert.equal(fs.lookup(n), 0, n);
  const src = join(NXNATIVE, "dm", "host", "hle_fs.c");
  if (existsSync(src)) {
    const ref = namesOf(readFileSync(src, "utf8"));
    const all = [...readFileSync(src, "utf8").matchAll(/^HLE(?:_FORCE)?\("(_Z\w+)"/gm)].map(m => m[1]);
    assert.deepEqual(ref.map(r => r.mangled), all, "the generator sees every HLE line");
    assert.deepEqual(MANGLED, all, "src/fs/names.ts is hle_fs.c's list");
    assert.deepEqual(Object.keys(FN).filter(k => k !== "None"), ref.map(r => r.ident));
  } else console.log("     (no nxnative clone at " + NXNATIVE + ": names.ts checked against itself only)");
});

test("names: a stub logs '[RED] <name> unimplemented' once and returns nxnative's failure result", () => {
  const fs = new Fs(new MemStorage());
  const stubs = fs.host.names().filter(n => n.stub);
  assert.deepEqual(stubs.map(s => s.name), ["_ZN2nn2fs15MountSystemDataEPKcNS_3ncm12SystemDataIdEPvm"]);
  for (let i = 0; i < 3; i++) assert.equal(fs.callSync("MountSysData", fs.str("MiiResource"), 0x0100000000000802n, 0, 0), R.TARGET_NOT_FOUND);
  assert.deepEqual(fs.red, ["[RED] _ZN2nn2fs15MountSystemDataEPKcNS_3ncm12SystemDataIdEPvm unimplemented"]);
  assert.equal(fs.callSync("IsMounted", fs.str("MiiResource")), 0);
  console.log(`     ${fs.host.names().length} names: ${fs.host.names().length - stubs.length} implemented, ${stubs.length} stubbed`);
});

test("names: an unknown function id fails with a red line", () => {
  const fs = new Fs(new MemStorage());
  const p = fs.alloc(64);
  assert.equal(fs.x.fs_call(0, p), BigInt(R.FAIL));
  assert.equal(fs.x.fs_call(74, p), BigInt(R.FAIL));
  assert.equal(fs.red.length, 2);
  assert.equal(fs.x.fs_complete(1, 0), BigInt(R.FAIL));
  assert.match(fs.red[2], /no call waits under token 1/);
});

test("constants: cache sizes, length limits, save sizes, free space, flags (nxnative's answers)", () => {
  const fs = new Fs(new MemStorage());
  const a = fs.alloc(8), b = fs.alloc(8), dv = () => fs.dv;
  const u64 = (p: number) => dv().getBigUint64(p, true);
  const clear = () => { dv().setBigUint64(a, 0xAAn, true); dv().setBigUint64(b, 0xBBn, true); };
  for (const [fn, args] of [["QueryRomCache", [a]], ["QueryRomCacheIdx", [a, 1]], ["QuerySysDataCache", [a, 0x0100000000000802n]], ["QueryAocCache", [a, 5]]] as const) {
    clear(); assert.equal(fs.callSync(fn, ...args), R.OK, fn); assert.equal(u64(a), 0x1000n, fn);
  }
  for (const fn of ["GetPathLengthMax", "GetEntryNameLengthMax"]) { clear(); assert.equal(fs.callSync(fn, a, fs.str("rom:/x")), R.OK); assert.equal(u64(a), 0x300n); }
  for (const fn of ["GetUtf16PathLengthMax", "GetUtf16EntryNameLengthMax"]) {
    clear(); assert.equal(fs.callSync(fn, a, b, fs.str("rom:/x")), R.OK);
    assert.equal(dv().getUint8(a), 0); assert.equal(u64(a), 0xAAn & ~0xFFn); assert.equal(u64(b), 0x300n);
  }
  for (const [fn, args] of [["SaveSize", [a, b, 0]], ["SaveSizeMax", [a, b]], ["CacheSize", [a, b, 3]], ["DeviceSaveSize", [a, b]]] as const) {
    clear(); assert.equal(fs.callSync(fn, ...args), R.OK, fn); assert.equal(u64(a), 256n << 20n); assert.equal(u64(b), 256n << 20n);
  }
  clear(); assert.equal(fs.callSync("SaveSize", 0, b, 0), R.OK); assert.equal(u64(a), 0xAAn); assert.equal(u64(b), 256n << 20n);
  clear(); assert.equal(fs.callSync("FreeSpace", a, fs.str("save:/")), R.OK); assert.equal(u64(a), 256n << 20n);
  assert.equal(fs.callSync("FreeSpace", 0, fs.str("save:/")), R.OK);
  for (const [fn, args] of [["ExtendSave", [0, 1 << 20, 1 << 20]], ["ExtendDeviceSave", [1 << 20, 1 << 20]], ["EnsureSave", [0]], ["OpenCacheList", [a]], ["CreateCache", [0, 1 << 20, 1 << 20]],
    ["EnableFileCache", [0, 0, 0]], ["FlushFile", [0]]] as const) assert.equal(fs.callSync(fn, ...args), R.OK, fn);
  for (const [fn, args] of [["CloseCacheList", [0]], ["EnableGlobalCache", [0, 0]], ["DisableFileCache", [0]], ["DisableGlobalCache", []], ["SetPrio", [1]], ["AccessLogMask", [1]], ["AccessLog", []]] as const)
    assert.equal(fs.callSync(fn, ...args), 0, fn);
  dv().setInt32(a, 7, true); assert.equal(fs.callSync("ReadCacheList", a, 0, 0, 8), R.OK); assert.equal(dv().getInt32(a, true), 0);
  dv().setUint8(a, 9); assert.equal(fs.callSync("RestoreFlag", a, fs.str("save")), R.OK); assert.equal(dv().getUint8(a), 0);
  assert.equal(fs.callSync("SaveExists", 0), 1);
  fs.x.fs_set_program_id(0x0100000000001234n);
  assert.equal(fs.callSync("SaveExisting", 0x0100000000001234n, 0), 1);
  assert.equal(fs.callSync("SaveExisting", 0x0100000000009999n, 0), 0);
  assert.equal(fs.callSync("MountSaveRO", fs.str("other"), 0x0100000000009999n, 0), R.TARGET_NOT_FOUND);
  assert.equal(fs.red.length, 1);
  // a pointer outside linear memory is refused, not written through
  assert.equal(fs.callSync("QueryRomCache", 0xFFFFFFF8), R.FAIL);
  assert.equal(fs.callSync("QueryRomCache", 0), R.FAIL);
});

both("pending: a call that waits for storage returns a token and is completed by the glue", async (async) => {
  const fs = new Fs(new MemStorage(), { async });
  assert.equal(await fs.mount("MountSave", "save", 0), R.OK);
  assert.equal(fs.pendings > 0, async);
  assert.equal(fs.x.fs_pending(), 0);
  assert.equal(fs.saveState(KIND.SAVE), "Clean");
});

test("shared memory: built with --importMemory --memoryBase, the module runs on the runtime's one linear memory", async () => {
  const { execFileSync } = await import("node:child_process");
  const { FsHost } = await import("../../src/glue/fs_host.ts");
  const { ROOT } = await import("./harness.mts");
  const BASE = 0x00300000, out = join(ROOT, "build", "fs", "fs_shared.wasm");
  execFileSync(process.execPath, [join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js"), "src/fs/index.ts", "-o", out, "--runtime", "stub", "-O2",
    "--importMemory", "--zeroFilledMemory", "--memoryBase", String(BASE)], { cwd: ROOT, stdio: "inherit" });
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536 });   // 64 MB, as a runtime would own it
  const logs: string[] = [];
  const host = new FsHost(new WebAssembly.Module(readFileSync(out)), new MemStorage(), { memory, log: l => logs.push(l) });
  const x = host.x, end = x.fs_static_end();
  assert.ok(end > BASE && end < BASE + (1 << 20), `static data ${BASE.toString(16)}..${end.toString(16)}`);
  x.fs_init(0x01000000, 16 << 20);                       // an arena range the embedder chose
  const G = 0x02800000, u8 = new Uint8Array(memory.buffer), dv = new DataView(memory.buffer);   // "guest" memory far from both
  const str = (at: number, s: string) => { u8.set(Buffer.from(s + "\0"), G + at); return G + at; };
  const call = (name: string, ...args: (number | bigint)[]) => { args.forEach((a, i) => dv.setBigUint64(G + 0x1000 + 8 * i, BigInt(a), true)); return Number(x.fs_call(FN[name], G + 0x1000)); };
  assert.equal(x.fs_lookup(str(0, MANGLED[1])), 2);
  assert.equal(call("MountSave", str(0, "save"), 0), R.OK);
  assert.equal(call("CreateFile", str(0, "save:/f"), 0), R.OK);
  assert.equal(call("OpenFile", G + 0x2000, str(0, "save:/f"), 3), R.OK);
  const h = dv.getBigUint64(G + 0x2000, true);
  u8.set(Buffer.from("shared"), G + 0x3000);
  assert.equal(call("WriteFile", h, 0, G + 0x3000, 6, 0), R.OK);
  assert.equal(call("Commit", str(0, "save")), R.OK);
  assert.equal(call("ReadFile", G + 0x2008, h, 0, G + 0x4000, 64), R.OK);
  assert.equal(Buffer.from(u8.slice(G + 0x4000, G + 0x4006)).toString(), "shared");
  assert.ok(u8.subarray(0, BASE).every(b => b === 0), "nothing below the module's base was written");
  assert.ok(u8.subarray(end + 16, 0x01000000).every(b => b === 0), "nothing between its static data and its arena");
  assert.deepEqual(logs.filter(l => l.startsWith("[RED]")), []);
  console.log(`     static data: ${end - BASE} bytes from the base; arena in use after a mount, a file and a commit: ${x.fs_arena_used()} bytes`);
});
