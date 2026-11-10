// The module lifecycle: an NRO loaded at run time, unloaded and loaded again; what each state allows; where a module may be mapped.
import { test, fresh, file, readElf, expectedImage, pristineImage, eq, ok, same, hex, ARENA, STUBS, GUEST, MEM_BYTES, R_ABS64, R_JUMP_SLOT, type Box, type World } from "./harness.mts";
import { loadSet, checkImages, addHost, newWorld, symAddr, slotOf } from "./c_load.test.mts";
import { Info, LoaderError, ERR_ARG, ERR_STATE, ERR_REFUSED, HOST_UNRESOLVED } from "../../src/loader/host/loader.mts";
import { readTrace, formatRecord, readMachines } from "../../src/kit/host/reader.mts";

for (const pluginFile of ["plugin.nro", "plugin.nso"]) {
  test(`run-time load, unload and reload of ${pluginFile}: imports bound and unbound, data restored, bss zeroed`, () => {
    const b = fresh(), { set, w } = loadSet(b, ["main.nso", "sdk.nso"]);
    const [mainH, sdkH] = set.modules.map(m => m.handle), main = w.mods[0];
    for (const h of [mainH, sdkH]) { b.ld.activate(h); eq(b.ld.state(h), "Active", "state"); }
    const stub = b.ld.hostFunction(b.ld.hostFind("plugin_entry")).stub;
    eq(b.u64(slotOf(main, "plugin_entry", R_JUMP_SLOT)), stub, "before the load, main's import is the unresolved stub");

    // first load
    const f = b.put("plugin", file(pluginFile)), h = b.ld.parse(f);
    const elf = readElf("plugin.so"), pristine = pluginFile.endsWith(".nro") ? file(pluginFile) : undefined;
    const base1 = b.place(elf.imageSize);
    b.ld.map(h, base1);
    eq(b.u64(slotOf(main, "plugin_entry", R_JUMP_SLOT)), stub, "mapped but not relocated: main is not bound to it yet");
    b.ld.relocate(h);
    w.mods.push({ elf, base: base1, pristine });
    checkImages(b, w, "first load: ");
    eq(b.u64(slotOf(main, "plugin_entry", R_JUMP_SLOT)), symAddr(w.mods[2], "plugin_entry"), "main's import is bound to the plugin");
    eq(b.ld.unresolved(mainH).map(u => u.name), ["missing_fn"], "main's unresolved imports now");
    ok(b.logs.includes("loader: plugin: load 1: 1 imports of the modules loaded before bound to it"), "logged");
    eq(b.u64(slotOf(w.mods[2], "shared_fn", R_ABS64)), symAddr(main, "shared_fn"), "the plugin's imports follow the load order");
    eq(b.u64(slotOf(w.mods[2], "host_forced", R_JUMP_SLOT)), b.ld.stubAddr(b.ld.hostFind("host_forced")), "and the forced take-over");
    b.ld.activate(h);
    eq(b.ld.lookup("plugin_entry"), symAddr(w.mods[2], "plugin_entry"), "lookup finds it");
    eq([b.x.ld_loaded_count(), b.x.ld_loaded_at(2)], [3, h], "third in the lookup order");

    // the guest runs: data, bss and a GOT slot change
    const mem = new Uint8Array(b.x.memory.buffer), i1 = b.ld.info(h);
    mem.fill(0x5A, i1.data.addr, i1.base + i1.imageSize);
    mem[i1.text.addr + 0x90] ^= 0xFF;

    // unload
    b.ld.unload(h);
    eq(b.ld.state(h), "Unloaded", "state");
    eq(b.u64(slotOf(main, "plugin_entry", R_JUMP_SLOT)), stub, "main's import is the same unresolved stub again");
    eq(b.ld.unresolved(mainH).map(u => u.name).sort(), ["missing_fn", "plugin_entry"], "and reported again");
    eq(b.ld.lookup("plugin_entry"), undefined, "lookup no longer finds it");
    eq(b.x.ld_loaded_count(), 2, "out of the lookup order");
    ok(b.logs.includes("loader: plugin: unloaded: 1 imports that pointed into it bound again"), "logged");
    w.mods.pop();
    checkImages(b, w, "after the unload: ");
    ok(b.ld.get(h, Info.FilePtr) === f.ptr, "an unloaded module still has its file: the pristine copy cannot be missing");

    // reload, at another address
    const base2 = b.place(elf.imageSize);
    mem.fill(0x77, base2, base2 + elf.imageSize);
    b.ld.map(h, base2);
    same(b.mem(base2, elf.imageSize), pristineImage({ elf, base: base2, pristine }), "mapped again: text and data as in the file, bss zero");
    b.ld.relocate(h);
    w.mods.push({ elf, base: base2, pristine });
    checkImages(b, w, "reload: ");
    eq(b.u64(slotOf(main, "plugin_entry", R_JUMP_SLOT)), symAddr(w.mods[2], "plugin_entry"), "main's import is bound to the new address");
    eq(b.ld.info(h).loads, 2, "loads");
    b.ld.activate(h);

    // and once more at the first address
    b.ld.unload(h); w.mods.pop();
    b.ld.map(h, base1); b.ld.relocate(h);
    w.mods.push({ elf, base: base1, pristine });
    checkImages(b, w, "third load: ");
    eq(b.x.ld_host_count(), 5, "no stub was made twice (3 host entries, missing_fn, plugin_entry)");
    eq(b.x.ld_faults(), 0, "faults");
    eq(b.red().filter(l => !l.includes("unresolved import")), [], "no red lines but the two unresolved imports");
  });
}

test("a module relocated before its provider is mapped is bound when the provider is relocated", () => {
  const b = fresh();
  addHost(b);
  const mainH = b.ld.parse(b.put("main", file("main.nso"))), sdkH = b.ld.parse(b.put("sdk", file("sdk.nso")));
  const mainElf = readElf("main.so"), sdkElf = readElf("sdk.so");
  const mb = b.place(mainElf.imageSize), sb = b.place(sdkElf.imageSize);
  b.ld.map(mainH, mb); b.ld.relocate(mainH);
  ok(b.ld.unresolved(mainH).map(u => u.name).includes("sdk_add"), "sdk_add is unresolved while sdk is not there");
  b.ld.map(sdkH, sb); b.ld.relocate(sdkH);
  const w = newWorld(b);
  w.mods.push({ elf: mainElf, base: mb }, { elf: sdkElf, base: sb });
  checkImages(b, w);
  eq(b.ld.unresolved(mainH).map(u => u.name).sort(), ["missing_fn", "plugin_entry"], "what is left");
});

test("reload when the file was damaged in between: refused, never a half-restored module", () => {
  const b = fresh(), { set, w } = loadSet(b, ["main.nso", "sdk.nso"]);
  const f = b.put("plugin", file("plugin.nso")), h = b.ld.parse(f), elf = readElf("plugin.so"), base = b.place(elf.imageSize);
  b.ld.map(h, base); b.ld.relocate(h); b.ld.activate(h); b.ld.unload(h);
  new Uint8Array(b.x.memory.buffer)[f.ptr + f.len - 3] ^= 4;
  try { b.ld.map(h, base); throw new Error("no exception"); }
  catch (e) { ok(e instanceof LoaderError && e.code === ERR_REFUSED && /plugin: data segment (does not|decompresses)/.test(e.message), String(e)); }
  eq([b.ld.state(h), b.ld.info(h).refuseReason === "hash" || b.ld.info(h).refuseReason === "decompress"], ["Refused", true], "state");
  eq(b.x.ld_loaded_count(), 2, "not in the lookup order");
  checkImages(b, w, "the others: ");
  void set;
});

test("lifecycle: what each state allows, and the trace", () => {
  const b = fresh();
  addHost(b);
  const elf = readElf("sdk.so"), h = b.ld.parse(b.put("sdk", file("sdk.nso"))), base = b.place(elf.imageSize);
  const refused = (what: string, call: () => number, state: string) => {
    const before = b.x.kit_refused_total();
    eq(call(), ERR_STATE, what);
    eq(b.x.kit_refused_total(), before + 1, `${what}: counted by the kit`);
    eq(b.ld.state(h), state, `${what}: the state stays`);
  };
  eq(b.ld.state(h), "Parsed", "after parse");
  eq([b.ld.get(h, Info.Base), b.ld.get(h, Info.Entry), b.ld.get(h, Info.Init)], [0, 0, 0], "no addresses before the map");
  refused("relocate in Parsed", () => b.x.ld_relocate(h), "Parsed");
  refused("activate in Parsed", () => b.x.ld_activate(h), "Parsed");
  refused("unload in Parsed", () => b.x.ld_unload(h), "Parsed");
  refused("pin in Parsed", () => b.x.ld_pin(h), "Parsed");
  b.ld.map(h, base);
  refused("map in Mapped", () => b.x.ld_map(h, base), "Mapped");
  refused("activate in Mapped", () => b.x.ld_activate(h), "Mapped");
  b.ld.unload(h);                                     // Mapped -> Unloaded
  refused("relocate in Unloaded", () => b.x.ld_relocate(h), "Unloaded");
  refused("unload in Unloaded", () => b.x.ld_unload(h), "Unloaded");
  b.ld.map(h, base); b.ld.relocate(h);
  refused("relocate in Relocated", () => b.x.ld_relocate(h), "Relocated");
  b.ld.unload(h);                                     // Relocated -> Unloaded
  b.ld.map(h, base); b.ld.relocate(h); b.ld.activate(h);
  refused("activate in Active", () => b.x.ld_activate(h), "Active");
  refused("map in Active", () => b.x.ld_map(h, base), "Active");
  b.ld.unload(h);                                     // Active -> Unloaded
  b.ld.map(h, base); b.ld.relocate(h); b.ld.activate(h);
  ok(b.ld.get(h, Info.FilePtr) !== 0, "the file is referred to until the pin");
  b.ld.pin(h);
  eq(b.ld.get(h, Info.FilePtr), 0, "a pinned module has let go of its file");
  refused("unload in Pinned", () => b.x.ld_unload(h), "Pinned");
  refused("map in Pinned", () => b.x.ld_map(h, base), "Pinned");
  eq(b.ld.lookup("sdk_add"), base + elf.dynsym.find(s => s.name === "sdk_add")!.value, "a pinned module is still looked up");
  const w: World = newWorld(b); w.mods.push({ elf, base });
  checkImages(b, w, "after four loads: ");
  ok(b.red().includes("[RED] kit: module#0 refused Unload in Pinned (no transition)"), "the kit's red line");
  const machines = readMachines(b.x);
  eq(readTrace(b.x).filter(r => !r.refused).map(r => formatRecord(r, machines)), [
    "module#0 New -ParseOk-> Parsed", "module#0 Parsed -Map-> Mapped", "module#0 Mapped -Unload-> Unloaded",
    "module#0 Unloaded -Map-> Mapped", "module#0 Mapped -Relocate-> Relocated", "module#0 Relocated -Unload-> Unloaded",
    "module#0 Unloaded -Map-> Mapped", "module#0 Mapped -Relocate-> Relocated", "module#0 Relocated -Activate-> Active", "module#0 Active -Unload-> Unloaded",
    "module#0 Unloaded -Map-> Mapped", "module#0 Mapped -Relocate-> Relocated", "module#0 Relocated -Activate-> Active", "module#0 Active -Pin-> Pinned"], "trace");
  // a module of the start set: pinned as soon as it is relocated (its file is let go of before its init functions
  // run); Mapped is too early
  const h2 = b.ld.parse(b.put("main", file("main.nso")));
  b.ld.map(h2, b.place(b.ld.get(h2, Info.ImageSize)));
  eq(b.x.ld_pin(h2), ERR_STATE, "pin in Mapped");
  b.ld.relocate(h2);
  ok(b.ld.get(h2, Info.FilePtr) !== 0, "a relocated module refers to its file");
  b.ld.pin(h2);
  eq([b.ld.state(h2), b.ld.get(h2, Info.FilePtr)], ["Pinned", 0], "pinned from Relocated: the file is let go of");
  eq([b.x.ld_activate(h2), b.x.ld_unload(h2)], [ERR_STATE, ERR_STATE], "a pinned module is neither activated nor unloaded");
  ok(b.ld.lookup("sdk_add") !== undefined && readTrace(b.x).some(r => formatRecord(r, machines) === "module#1 Relocated -Pin-> Pinned"), "the trace has Relocated -Pin-> Pinned");
  // handles that do not exist
  for (const bad of [-1, 2, 4096, 0x7FFFFFFF]) {
    eq([b.x.ld_map(bad, base), b.x.ld_relocate(bad), b.x.ld_activate(bad), b.x.ld_pin(bad), b.x.ld_unload(bad), b.x.ld_state(bad), b.x.ld_get(bad, Info.Base)],
      [ERR_ARG, ERR_ARG, ERR_ARG, ERR_ARG, ERR_ARG, -1, 0], `handle ${bad}`);
  }
});

test("map: the base must be a free, page-aligned range of linear memory", () => {
  const b = fresh();
  const fm = b.put("main", file("main.nso")), fs = b.put("sdk", file("sdk.nso"));
  const main = b.ld.parse(fm), sdk = b.ld.parse(fs), size = b.ld.get(main, Info.ImageSize);
  b.ld.map(sdk, GUEST);
  const sdkSize = b.ld.get(sdk, Info.ImageSize);
  const cases: [string, number, string][] = [
    ["not on a page", GUEST + 0x100800, "not a page-aligned range"],
    ["address 0", 0, "not a page-aligned range"],
    ["inside the loader's static memory", 0x1000, "not a page-aligned range"],
    ["runs past the end of memory", MEM_BYTES - size + 0x1000, "not a page-aligned range"],
    ["beyond memory", 0xFFFF_0000, "not a page-aligned range"],
    ["over the arena", ARENA + 0x8000, "overlaps"],
    ["ending in the arena", ARENA, "overlaps"],
    ["over the stub region", STUBS, "overlaps"],
    ["over its own file", fm.ptr & ~0xFFF, "overlaps"],
    ["over another module's file", fs.ptr & ~0xFFF, "overlaps"],
    ["over a mapped module", GUEST, "overlaps"],
    ["over the end of a mapped module", GUEST + sdkSize - 0x1000, "overlaps"],
    ["ending inside a mapped module", GUEST - size + 0x1000, "overlaps"],
  ];
  const before = b.mem(ARENA, 0x0040_0000);   // the arena, the stubs, the files
  for (const [what, base, text] of cases) {
    eq(b.x.ld_map(main, base), ERR_ARG, what);
    ok(b.ld.error().includes(text), `${what}: ${b.ld.error()}`);
    eq(b.ld.state(main), "Parsed", `${what}: the state stays`);
  }
  same(b.mem(ARENA, 0x0040_0000), before, "nothing was written");
  same(b.mem(GUEST, sdkSize), pristineImage({ elf: readElf("sdk.so"), base: GUEST }), "the mapped module is as it was");
  b.ld.map(main, GUEST + sdkSize);                      // right after sdk, and right before:
  b.ld.unload(main);
  b.ld.map(main, GUEST - size);
  b.ld.unload(main);
  b.ld.map(main, MEM_BYTES - size);                     // the last pages of memory
  eq(b.ld.state(main), "Mapped", "mapped at the end of memory");
  eq(hex(b.ld.info(main).base + size), hex(MEM_BYTES), "ends where memory ends");
});

test("the arena: when it is full, parse makes no record and a map is refused", () => {
  const b = fresh();
  // a loader with a tiny arena of its own, in the same memory
  const tiny = (len: number) => b.x.ld_init(0x0600_0000, len, STUBS, 4);
  eq(tiny(64), -4, "too small for the host table");
  eq(tiny(200), 0, "enough for the table");
  const f = b.put("main", file("main.nso"));
  eq(b.x.ld_parse(f.ptr, f.len, 1), -4, "no room for a record");
  ok(b.ld.error().includes("the arena is full"), b.ld.error());
  eq(tiny(600), 0, "room for a record");
  const h = b.x.ld_parse(f.ptr, f.len, 1);
  eq(h, 0, "parsed");
  eq(b.x.ld_map(h, GUEST), ERR_REFUSED, "no room for the export table");
  eq([b.ld.state(h), b.ld.info(h).refuseReason], ["Refused", "arena"], "refused");
  eq(b.x.ld_init(0x10, 0x1000, STUBS, 4), ERR_ARG, "an arena in the loader's static memory");
  eq(b.x.ld_init(0x0600_0000, 0x1000, 0x0600_0800, 4), ERR_ARG, "stubs inside the arena");
  eq(b.x.ld_init(0x0600_0000, 0x1000, STUBS + 2, 4), ERR_ARG, "stubs off a 4-byte boundary");
  eq(b.x.ld_parse(f.ptr, f.len, 1), ERR_ARG, "after a failed init nothing works");
});
