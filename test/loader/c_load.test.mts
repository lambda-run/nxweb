// Loading a set of modules: every relocation against a model computed from the ELF files, cross-module binding in
// load order, forced and weak take-overs, unresolved imports, init order.
import { test, fresh, file, readElf, expectedImage, firstDef, eq, ok, same, hex, STUBS, STUB_CAP,
  R_ABS64, R_GLOB_DAT, R_JUMP_SLOT, R_RELATIVE, type Box, type Elf, type World, type Placed } from "./harness.mts";
import { Info, HOST_FORCE, HOST_HLE, HOST_UNRESOLVED, type LoadedSet } from "../../src/loader/host/loader.mts";

export const FORCE = ["host_forced"], HLE = ["host_weak_only", "sdk_and_hle"];

export function newWorld(b: Box, force = FORCE, hle = HLE): World {
  return { mods: [], force: new Set(force), hle: new Set(hle), unresolved: new Map(), weakZero: 0,
    stub: name => { const id = b.ld.hostFind(name); if (id < 0) throw new Error(`no stub for ${name}`); return b.ld.stubAddr(id); } };
}
export function addHost(b: Box, force = FORCE, hle = HLE): void {
  for (const n of force) b.ld.hostAdd(n, true);
  for (const n of hle) b.ld.hostAdd(n, false);
}
// Load files (name.so gives the model of name*.nso / .nro) in this order, with the usual host table
export function loadSet(b: Box, names: string[], elfEdit?: (e: Elf) => void): { set: LoadedSet; w: World } {
  addHost(b);
  const w = newWorld(b);
  const set = b.ld.loadSet(names.map(n => b.put(n.split(/[_.]/)[0], file(n))), size => b.place(size));
  set.modules.forEach((m, i) => {
    const elf = readElf(names[i].split(/[_.]/)[0] + ".so");
    elfEdit?.(elf);
    w.mods.push({ elf, base: m.base, pristine: names[i].endsWith(".nro") ? file(names[i]) : undefined });
  });
  return { set, w };
}
export function checkImages(b: Box, w: World, what = ""): void {
  w.unresolved.clear(); w.weakZero = 0;
  for (const m of w.mods) same(b.mem(m.base, m.elf.imageSize), expectedImage(w, m), `${what}image of ${m.elf.name} at ${hex(m.base)}`);
}
const relrSlots = (e: Elf) => e.relr.reduce((n, v) => n + (v & 1n ? v.toString(2).split("1").length - 2 : 1), 0);
const count = (e: Elf, type: number) => [...e.relaDyn, ...e.relaPlt].filter(r => r.type === type).length;
export const symAddr = (m: Placed, name: string) => { const s = m.elf.dynsym.find(s => s.name === name && s.shndx); if (!s) throw new Error(`${m.elf.name} does not define ${name}`); return m.base + s.value; };
// The guest address of the slot of a relocation of `type` against `name`
export const slotOf = (m: Placed, name: string, type: number) => {
  const r = [...m.elf.relaDyn, ...m.elf.relaPlt].find(r => r.type === type && m.elf.dynsym[r.sym].name === name);
  if (!r) throw new Error(`${m.elf.name} has no relocation of type ${type} against ${name}`);
  return m.base + r.offset;
};

for (const names of [["main.nso", "sdk.nso"], ["main_raw.nso", "sdk_raw.nso"], ["sdk.nso", "main.nso"]]) {
  test(`load ${names.join(" + ")}: every byte of both images is what the model computes from the ELF files`, () => {
    const b = fresh(), { set, w } = loadSet(b, names);
    checkImages(b, w);
    eq(set.modules.map(m => m.state), ["Relocated", "Relocated"], "states");
    eq(set.entry, set.modules[0].base, "entry point");
    // the relocation counts by kind are the ELF's
    for (const [i, m] of set.modules.entries()) {
      const e = w.mods[i].elf;
      eq(m.relocs, { relative: count(e, R_RELATIVE), relr: relrSlots(e), abs64: count(e, R_ABS64), globDat: count(e, R_GLOB_DAT), jumpSlot: count(e, R_JUMP_SLOT), unsupported: 0,
        weakZero: m.name === "main" ? 3 : 0 }, `relocation counts of ${m.name}`);
      eq(m.symbolCount, e.dynsym.length, `symbol count of ${m.name}`);
    }
    eq(w.weakZero, 3, "the model also bound main's three references to maybe_fn to 0");
    eq(b.x.ld_faults(), 0, "faults");
  });
}

test("the test modules cover every relocation kind, DT_RELR bitmaps, both hash tables", () => {
  const main = readElf("main.so"), sdk = readElf("sdk.so"), plugin = readElf("plugin.so");
  for (const t of [R_ABS64, R_GLOB_DAT, R_JUMP_SLOT]) ok(count(main, t) > 0 && count(sdk, t) > 0, `type ${t} in main and sdk`);
  eq(count(main, R_RELATIVE), 0, "main has only packed relative relocations");
  ok(count(sdk, R_RELATIVE) > 0 && sdk.relr.length === 0, "sdk has R_AARCH64_RELATIVE and no DT_RELR");
  ok(main.relr.filter(v => v & 1n).length >= 2 && main.relr.filter(v => !(v & 1n)).length >= 1, "main's DT_RELR has an address entry and several bitmap entries");
  ok(relrSlots(main) > 100, "more than 100 packed slots");
  ok(main.relaDyn.some(r => r.type === R_ABS64 && r.addend !== 0n) && sdk.relaDyn.some(r => r.type === R_ABS64 && r.addend !== 0n), "ABS64 with an addend");
  ok(main.sections.has(".hash") && main.sections.has(".gnu.hash"), "main: both");
  ok(sdk.sections.has(".hash") && !sdk.sections.has(".gnu.hash"), "sdk: DT_HASH only");
  ok(!plugin.sections.has(".hash") && plugin.sections.has(".gnu.hash"), "plugin: DT_GNU_HASH only");
  const b = fresh(), { set } = loadSet(b, ["main.nso", "sdk.nso", "plugin.nso"]);
  eq(set.modules.map(m => [b.ld.get(m.handle, Info.HasHash), b.ld.get(m.handle, Info.HasGnuHash), b.ld.get(m.handle, Info.HasRelr)]), [[1, 1, 1], [1, 0, 0], [0, 1, 0]], "what the loader found");
  eq(set.modules.map(m => m.symbolCount), [main, sdk, plugin].map(e => e.dynsym.length), "symbol counts (from DT_HASH, DT_HASH, DT_GNU_HASH)");
});

test("cross-module binding, take-overs and the stub table (main, sdk)", () => {
  const b = fresh(), { set, w } = loadSet(b, ["main.nso", "sdk.nso"]);
  const [main, sdk] = w.mods, u = (a: number) => b.u64(a);
  checkImages(b, w);
  const fn = b.ld.hostFunctions(), byName = new Map(fn.map(f => [f.name, f]));
  // the table: the host's entries in the order given, then the loader's stubs for unresolved imports
  eq(fn.slice(0, 3).map(f => [f.name, f.kind, f.stub]), [["host_forced", HOST_FORCE, STUBS], ["host_weak_only", HOST_HLE, STUBS + 4], ["sdk_and_hle", HOST_HLE, STUBS + 8]], "host entries");
  eq(fn.slice(3).map(f => [f.name, f.kind]).sort(), [["missing_fn", HOST_UNRESOLVED], ["plugin_entry", HOST_UNRESOLVED]], "unresolved stubs");
  for (const f of fn) {
    eq(b.ld.stubId(f.stub), f.id, `stub address -> id of ${f.name}`);
    eq(b.ld.stubAddr(f.id), STUBS + 4 * f.id, `id -> stub address of ${f.name}`);
    eq(new DataView(b.x.memory.buffer).getUint32(f.stub, true), f.id, "the stub's word is UDF #id");
  }
  for (const a of [STUBS - 4, STUBS + 1, STUBS + 2, STUBS + 4 * fn.length, STUBS + 4 * STUB_CAP, 0, main.base]) eq(b.ld.stubId(a), -1, `${hex(a)} is no stub`);
  eq(b.ld.stubId(2n ** 32n + BigInt(STUBS)), -1, "nor is a stub address plus 4 GB");

  // sdk's functions and data, from main
  eq(u(slotOf(main, "sdk_add", R_JUMP_SLOT)), symAddr(sdk, "sdk_add"), "JUMP_SLOT main -> sdk_add");
  eq(u(slotOf(main, "sdk_var", R_GLOB_DAT)), symAddr(sdk, "sdk_var"), "GLOB_DAT main -> sdk_var");
  eq(u(slotOf(main, "sdk_var", R_ABS64)), symAddr(sdk, "sdk_var"), "ABS64 main -> sdk_var");
  eq(u(slotOf(main, "sdk_data", R_ABS64)), symAddr(sdk, "sdk_data") + 8, "ABS64 main -> sdk_data + 8");
  eq(u(slotOf(sdk, "main_counter", R_GLOB_DAT)), symAddr(main, "main_counter"), "GLOB_DAT sdk -> main_counter");
  // forced: wins over sdk's own definition, for main and for sdk itself
  const forced = byName.get("host_forced")!;
  eq(u(slotOf(main, "host_forced", R_JUMP_SLOT)), forced.stub, "forced: main's call");
  eq(u(slotOf(main, "host_forced", R_ABS64)), forced.stub, "forced: main's pointer");
  eq(u(slotOf(sdk, "host_forced", R_JUMP_SLOT)), forced.stub, "forced: the defining module's own call");
  ok(symAddr(sdk, "host_forced") !== forced.stub, "sdk does define it");
  eq([forced.refs, forced.firstModule], [3, set.modules[0].handle], "forced: references counted, first from main");
  // weak take-over: fills what nobody defines, loses to a module's definition
  eq(u(slotOf(main, "host_weak_only", R_JUMP_SLOT)), byName.get("host_weak_only")!.stub, "weak take-over fills main's import");
  eq(u(slotOf(sdk, "host_weak_only", R_JUMP_SLOT)), byName.get("host_weak_only")!.stub, "and sdk's");
  eq(u(slotOf(main, "sdk_and_hle", R_JUMP_SLOT)), symAddr(sdk, "sdk_and_hle"), "sdk's definition wins over the weak take-over");
  eq(byName.get("sdk_and_hle")!.refs, 0, "which was never used");
  // load order: main's shared_fn wins for sdk's references to its own shared_fn
  eq(u(slotOf(sdk, "shared_fn", R_JUMP_SLOT)), symAddr(main, "shared_fn"), "sdk's call of shared_fn goes to main's");
  eq(u(slotOf(sdk, "shared_fn", R_ABS64)), symAddr(main, "shared_fn"), "sdk's pointer to shared_fn too");
  eq(u(slotOf(main, "shared_fn", R_ABS64)), symAddr(main, "shared_fn"), "main's own");
  // undefined weak: 0; unresolved: a stub with the name
  eq(u(slotOf(main, "maybe_fn", R_JUMP_SLOT)), 0, "undefined weak (call)");
  eq(u(slotOf(main, "maybe_fn", R_GLOB_DAT)), 0, "undefined weak (address)");
  eq(u(slotOf(main, "missing_fn", R_JUMP_SLOT)), byName.get("missing_fn")!.stub, "unresolved call");
  eq(u(slotOf(main, "missing_fn", R_ABS64)), byName.get("missing_fn")!.stub, "unresolved pointer");
  eq(set.unresolved.map(x => `${x.module}:${x.name}`).sort(), ["main:missing_fn", "main:plugin_entry"], "reported unresolved imports");
  eq([...w.unresolved].map(([m, s]) => [m, [...s].sort()]), [["main.so", ["missing_fn", "plugin_entry"]]], "the model's");
  eq(b.red().filter(l => l.includes("unresolved import")).map(l => l.replace(/stub 0x[0-9a-f]+/, "stub")).sort(),
    ["[RED] loader: main: unresolved import missing_fn (no module defines it and the host does not implement it; stub)",
     "[RED] loader: main: unresolved import plugin_entry (no module defines it and the host does not implement it; stub)"], "one red line per name");
  eq(b.ld.unresolved(set.modules[1].handle), [], "sdk has none");
  eq(set.forcedUnused, 0, "every forced name was referenced");
  // the export lookup
  eq(b.ld.lookup("shared_fn"), symAddr(main, "shared_fn"), "lookup: the first in load order");
  eq(b.ld.lookupIn(set.modules[1].handle, "shared_fn"), symAddr(sdk, "shared_fn"), "lookupIn sdk");
  eq(b.ld.lookup("sdk_add"), symAddr(sdk, "sdk_add"), "lookup sdk_add");
  eq(b.ld.lookup("host_forced"), symAddr(sdk, "host_forced"), "lookup ignores the host table");
  eq(b.ld.lookup("missing_fn"), undefined, "lookup of an import");
  eq(b.ld.lookup(""), undefined, "lookup of the empty name");
  eq(b.ld.lookup("__nx_mod0"), undefined, "hidden symbols are not exported");
  for (const m of w.mods) for (const s of m.elf.dynsym) if (s.shndx) eq(b.ld.lookup(s.name), firstDef(w, s.name), `lookup ${s.name}`);
});

test("load order reversed: sdk's shared_fn wins everywhere", () => {
  const b = fresh(), { w } = loadSet(b, ["sdk.nso", "main.nso"]);
  const [sdk, main] = w.mods;
  eq(b.u64(slotOf(main, "shared_fn", R_JUMP_SLOT)), symAddr(sdk, "shared_fn"), "main's call of its own shared_fn goes to sdk's");
  eq(b.u64(slotOf(main, "shared_fn", R_ABS64)), symAddr(sdk, "shared_fn"), "main's pointer");
  eq(b.u64(slotOf(sdk, "shared_fn", R_ABS64)), symAddr(sdk, "shared_fn"), "sdk's");
  ok(b.logs.some(l => /^loader: main: reloc .* bound to an earlier module's definition/.test(l)), "logged");
});

test("a protected symbol binds to its own module's definition (dynsym patched in the NSO)", () => {
  const b = fresh(), sdkElf = readElf("sdk.so"), si = sdkElf.dynsym.findIndex(s => s.name === "shared_fn");
  const nso = file("sdk_raw.nso"), dv = new DataView(nso.buffer, nso.byteOffset, nso.byteLength);
  const at = dv.getUint32(0x20, true) + (sdkElf.sections.get(".dynsym")!.addr - dv.getUint32(0x24, true)) + si * 24 + 5;
  eq(nso[at], 0, "st_other was STV_DEFAULT");
  nso[at] = 3;
  addHost(b);
  const set = b.ld.loadSet([b.put("main", file("main_raw.nso")), b.put("sdk", nso)], size => b.place(size));
  const w = newWorld(b), patched = readElf("sdk.so");
  patched.dynsym[si].other = 3;
  w.mods.push({ elf: readElf("main.so"), base: set.modules[0].base }, { elf: patched, base: set.modules[1].base });
  const want = expectedImage(w, w.mods[1]);
  new DataView(want.buffer).setUint8(patched.sections.get(".dynsym")!.addr + si * 24 + 5, 3);
  same(b.mem(w.mods[1].base, patched.imageSize), want, "image of sdk");
  eq(b.u64(slotOf(w.mods[1], "shared_fn", R_JUMP_SLOT)), symAddr(w.mods[1], "shared_fn"), "sdk's call stays in sdk");
});

test("forced take-over that no module refers to is reported (nxnative force_check): one summary line, a red line a name when strict", () => {
  for (const strict of [false, true]) {
    const b = fresh();
    b.ld.forceStrict(strict);
    b.ld.hostAdd("nobody_calls_this", true);
    b.ld.hostAdd("nor_this_but_it_is_weak", false);
    const { set } = loadSet(b, ["main.nso", "sdk.nso"]);
    eq(set.forcedUnused, 1, "count");
    eq(b.red().includes("[RED] loader: forced take-over entry with no reference at all: nobody_calls_this"), strict, "the red line (strict only)");
    eq(b.logs.some(l => /force: 1 entries hit, 1 not referenced by this game$/.test(l)), !strict, "the summary line: " + b.logs.filter(l => l.includes("force")).join(" | "));
    ok(!b.logs.some(l => l.includes("nor_this")), "the weaker table may have unused entries");
  }
});

test("host table: duplicates and bad entries are refused, a full stub region is reported", () => {
  const b = fresh({ stubCap: 4 });
  eq(b.x.ld_stub_cap(), 4, "capacity");
  addHost(b);
  try { b.ld.hostAdd("host_forced", false); throw new Error("no exception"); } catch (e) { ok(String(e).includes("duplicate entry in the host function table: host_forced"), String(e)); }
  try { b.ld.hostAdd("", true); throw new Error("no exception"); } catch (e) { ok(String(e).includes("bad name or kind"), String(e)); }
  eq(b.x.ld_host_add(0x0500_0000, 4, 2), -1, "kind 2 cannot be added");
  eq(b.x.ld_host_count(), 3, "three entries");
  // main has two unresolved imports and one stub is left
  const set = b.ld.loadSet([b.put("main", file("main.nso")), b.put("sdk", file("sdk.nso"))], size => b.place(size));
  eq(b.x.ld_host_count(), 4, "the region is full");
  eq(b.x.ld_stub_overflow() > 0, true, "overflow counted");
  ok(b.red().some(l => l.includes("the host stub region (4 entries) or the arena is full")), "red line");
  eq(set.unresolved.length, 1, "the one that got a stub is listed");
  try { b.ld.hostAdd("one_more", true); throw new Error("no exception"); } catch (e) { ok(String(e).includes("is full at one_more"), String(e)); }
  eq(b.x.ld_faults(), 0, "faults");
});

test("init: DT_INIT, init_array and fini_array, in load order", () => {
  const b = fresh(), { set, w } = loadSet(b, ["main.nso", "sdk.nso", "plugin.nso"]);
  const want = (m: Placed, sec: string) => {
    const s = m.elf.sections.get(sec);
    if (!s) return [];
    // each entry is a relative relocation: its value is base + the function's offset, in the section's order
    const img = expectedImage(w, m), dv = new DataView(img.buffer);
    return Array.from({ length: s.size / 8 }, (_, i) => Number(dv.getBigUint64(s.addr + 8 * i, true)));
  };
  for (const [i, m] of set.modules.entries()) {
    eq(m.initArray, want(w.mods[i], ".init_array"), `init_array of ${m.name}`);
    eq(m.finiArray, want(w.mods[i], ".fini_array"), `fini_array of ${m.name}`);
    ok(m.initArray.every(a => a >= m.text.addr && a < m.text.addr + m.text.size), `init_array of ${m.name} points into its text`);
  }
  eq(set.modules.map(m => m.initArray.length), [2, 2, 1], "constructors per module");
  eq(set.modules.map(m => m.finiArray.length), [1, 0, 0], "destructors per module");
  // priorities: constructor(101) before (102) in main; (150) before (200) in sdk although written after it
  for (const m of set.modules) ok(m.initArray.every((a, i, l) => !i || a !== l[i - 1]), "distinct");
  const [main, sdk] = w.mods;
  eq(set.modules[0].init, symAddr(main, "_init"), "DT_INIT of main");
  eq(set.modules[0].fini, symAddr(main, "_fini"), "DT_FINI of main");
  eq(set.modules[1].init, symAddr(sdk, "_init"), "DT_INIT of sdk");
  eq([set.modules[2].init, set.modules[2].fini, set.modules[1].fini], [0, 0, 0], "no DT_INIT / DT_FINI where the module has none");
  eq(set.initCalls, [symAddr(main, "_init"), symAddr(sdk, "_init")], "init calls in load order");
});
