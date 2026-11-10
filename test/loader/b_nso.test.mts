// NSO and NRO files: the segments as mapped, and the refusal of every header fault nso.ts checks for.
import { test, fresh, file, readElf, pristineImage, eq, ok, same, type Box } from "./harness.mts";
import { LoaderError, Info, KIND_NSO, KIND_NRO } from "../../src/loader/host/loader.mts";

// Parse and map one file; the outcome is the state, and the reason and red line when it was refused
function tryLoad(b: Box, bytes: Uint8Array, verifyHash = true): { state: string; reason: string; error: string; handle: number; base: number } {
  const f = b.put("m", bytes);
  const h = b.x.ld_parse(f.ptr, f.len, verifyHash ? 1 : 0);
  ok(h >= 0, `parse made no record: ${b.ld.error()}`);
  let base = 0;
  if (b.ld.state(h) === "Parsed") { base = b.place(b.ld.get(h, Info.ImageSize)); b.x.ld_map(h, base); }
  const i = b.ld.info(h);
  return { state: i.state, reason: i.refuseReason, error: i.state === "Refused" ? b.ld.error() : "", handle: h, base };
}

for (const [variant, what] of [["main.nso", "LZ4 with a matcher, hashes checked"], ["main_lit.nso", "LZ4 literal-only blocks"], ["main_part.nso", "only ro compressed, no hashes"],
  ["main_stored.nso", "stored, hashes checked"], ["main_raw.nso", "stored, no hashes"], ["sdk.nso", "sdk, LZ4"], ["plugin.nso", "plugin, LZ4"]] as const) {
  test(`nso: ${variant} (${what}) maps to the ELF's segments, bss zero`, () => {
    const b = fresh(), elf = readElf(variant.split(/[_.]/)[0] + ".so");
    // dirty the place first: gaps and bss must be written, not assumed
    new Uint8Array(b.x.memory.buffer).fill(0xCC, 0x0800_0000, 0x0800_0000 + elf.imageSize + 0x2000);
    const r = tryLoad(b, file(variant));
    eq(r.state, "Mapped", `state (${r.error})`);
    const i = b.ld.info(r.handle);
    eq(i.kind, KIND_NSO, "kind");
    eq(i.imageSize, elf.imageSize, "image size");
    eq(i.bssSize, elf.bss, "bss size");
    eq([i.text.addr - i.base, i.ro.addr - i.base, i.data.addr - i.base], elf.segs.map(s => s.vaddr), "segment offsets");
    eq([i.text.size, i.ro.size, i.data.size], elf.segs.map(s => s.bytes.length), "segment sizes");
    same(i.buildId.subarray(0, elf.buildId.length), elf.buildId, "build id");
    ok(i.buildId.subarray(elf.buildId.length).every(v => v === 0), "build id padding");
    same(b.mem(i.base, i.imageSize), pristineImage({ elf, base: i.base }), "image");
    eq(new Uint8Array(b.x.memory.buffer)[i.base + i.imageSize], 0xCC, "the byte after the image is untouched");
    eq(b.x.ld_faults(), 0, "faults");
  });
}

test("nso: the compressed files are really compressed, with matches", () => {
  const dv = (n: string) => { const d = file(n); return new DataView(d.buffer, d.byteOffset, d.byteLength); };
  const m = dv("main.nso"), lit = dv("main_lit.nso");
  eq(m.getUint32(0x0C, true), 0x3F, "flags of main.nso: three compressed, three hashed");
  for (let i = 0; i < 3; i++) {
    const size = m.getUint32(0x18 + 0x10 * i, true);
    ok(m.getUint32(0x60 + 4 * i, true) < size, `segment ${i} of main.nso is stored smaller than it is`);
    ok(m.getUint32(0x60 + 4 * i, true) < lit.getUint32(0x60 + 4 * i, true), `segment ${i}: the matcher beats literal-only`);
  }
});

test("nro: plugin.nro maps to its own bytes, bss zero", () => {
  const b = fresh(), elf = readElf("plugin.so"), bytes = file("plugin.nro");
  const r = tryLoad(b, bytes);
  eq(r.state, "Mapped", `state (${r.error})`);
  const i = b.ld.info(r.handle);
  eq(i.kind, KIND_NRO, "kind");
  eq(i.imageSize, elf.imageSize, "image size");
  ok(i.bssSize > 0, "the NRO has bss left");
  eq((bytes.length + i.bssSize + 0xFFF) & ~0xFFF, elf.imageSize, "file + bss, in whole pages = image");
  same(b.mem(i.base, i.imageSize), pristineImage({ elf, base: i.base, pristine: bytes }), "image");
  same(b.mem(i.text.addr + 0x80, elf.segs[0].bytes.length - 0x80), elf.segs[0].bytes.subarray(0x80), "text after the header is the ELF's");
  same(i.buildId.subarray(0, elf.buildId.length), elf.buildId, "build id");
});

// One fault per case: [name, the file to start from, the edit, the reason, a piece of the red line, verify hashes]
type Edit = (d: Uint8Array, dv: DataView) => Uint8Array | void;
const faults: [string, string, Edit, string, string][] = [
  ["empty file", "main.nso", d => d.subarray(0, 0), "header", "not an NSO or NRO"],
  ["header cut short", "main.nso", d => d.subarray(0, 0xFF), "header", "not an NSO or NRO"],
  ["wrong magic", "main.nso", d => { d[0] = 0x4D; }, "header", "not an NSO or NRO"],
  ["ro not on a page", "main.nso", (_, v) => v.setUint32(0x24, v.getUint32(0x24, true) + 8, true), "layout", "not on a page"],
  ["text not at 0", "main_raw.nso", (_, v) => { v.setUint32(0x14, 0x1000, true); v.setUint32(0x24, 0x2000, true); v.setUint32(0x34, 0x3000, true); }, "layout", "not at 0"],
  ["ro overlaps text", "main_raw.nso", (_, v) => v.setUint32(0x24, 0, true), "layout", "overlaps the text segment"],
  ["data overlaps ro", "main_raw.nso", (_, v) => v.setUint32(0x34, 0x1000, true), "layout", "overlaps the ro segment"],
  ["size above 2 GiB", "main_raw.nso", (_, v) => v.setUint32(0x38, 0x80000000, true), "layout", "more than Horizon loads"],
  ["text stored past the end", "main_raw.nso", (_, v) => v.setUint32(0x10, 0xFFFFFFF0, true), "layout", "past the end of the file"],
  ["data one byte past the end", "main_raw.nso", d => d.subarray(0, d.length - 1), "layout", "past the end of the file"],
  ["data size one more than stored", "main_raw.nso", (_, v) => v.setUint32(0x38, v.getUint32(0x38, true) + 1, true), "layout", "past the end of the file"],
  ["compressed larger than its size", "main.nso", (_, v) => v.setUint32(0x18, v.getUint32(0x60, true) - 1, true), "layout", "more than its"],
  ["size beyond what LZ4 can produce", "main.nso", (_, v) => v.setUint32(0x28, v.getUint32(0x64, true) * 255 + 1, true), "layout", "more than LZ4 can produce"],
  ["ZBIC flag", "main.nso", (_, v) => v.setUint32(0x0C, v.getUint32(0x0C, true) | 0x80, true), "header", "ZBIC"],
  ["bss past 4 GB", "main_raw.nso", (_, v) => v.setUint32(0x3C, 0xFFFFF000, true), "layout", "does not fit below 4 GB"],
  ["segments span more than the file can fill", "main_raw.nso", (_, v) => v.setUint32(0x34, 0x7000_0000, true), "layout", "more than a file of"],
  ["text size smaller than the block gives", "main.nso", (_, v) => v.setUint32(0x18, v.getUint32(0x18, true) - 4, true), "decompress", "does not decompress"],
  ["text size larger than the block gives", "main.nso", (_, v) => v.setUint32(0x18, v.getUint32(0x18, true) + 4, true), "decompress", "decompresses to"],
  ["compressed size one short", "main.nso", (_, v) => v.setUint32(0x60, v.getUint32(0x60, true) - 1, true), "decompress", "text segment"],
  ["a flipped bit in a hashed stored segment", "main_stored.nso", (d, v) => { d[v.getUint32(0x30, true) + 0x40] ^= 1; }, "hash", "data segment does not match its SHA-256"],
  ["a flipped bit in a header hash", "main.nso", d => { d[0xC5] ^= 0x10; }, "hash", "ro segment does not match its SHA-256"],
  ["MOD0 offset outside", "main_raw.nso", (d, v) => v.setUint32(v.getUint32(0x10, true) + 4, 0x7FFFFFF0, true), "mod0", "no MOD0 header"],
  ["MOD0 magic", "main_raw.nso", (d, v) => { d[v.getUint32(0x20, true)] = 0x4E; }, "mod0", "no MOD0 header"],
  ["dynamic offset outside", "main_raw.nso", (d, v) => v.setInt32(v.getUint32(0x20, true) + 4, -0x100000, true), "mod0", "dynamic section outside the image"],
  ["NRO: header cut short", "plugin.nro", d => d.subarray(0, 0x7F), "header", "not an NSO or NRO"],
  ["NRO: compressed", "plugin.nro", (_, v) => v.setUint32(0x1C, 2, true), "header", "compressed NRO"],
  ["NRO: segment not whole pages", "plugin.nro", (_, v) => v.setUint32(0x24, 0xFFF, true), "layout", "not whole pages"],
  ["NRO: ro not after text", "plugin.nro", (_, v) => v.setUint32(0x28, 0x2000, true), "layout", "not whole pages right after"],
  ["NRO: size is not the segments' end", "plugin.nro", (_, v) => v.setUint32(0x18, 0x4000, true), "layout", "not at the module's size"],
  ["NRO: file cut short", "plugin.nro", d => d.subarray(0, d.length - 1), "layout", "cut short or damaged"],
  ["NRO: bss past 4 GB", "plugin.nro", (_, v) => v.setUint32(0x38, 0xFFFFE000, true), "layout", "does not fit below 4 GB"],
];
for (const [name, from, edit, reason, text] of faults) {
  test(`refused: ${name} (${reason})`, () => {
    const b = fresh();
    let d = file(from);
    d = (edit(d, new DataView(d.buffer, d.byteOffset, d.byteLength)) as Uint8Array | undefined) ?? d;
    const r = tryLoad(b, d);
    eq(r.state, "Refused", "state");
    eq(r.reason, reason, `reason (${r.error})`);
    ok(r.error.startsWith("[RED] loader: ") && r.error.includes(text), `red line: ${r.error}`);
    ok(b.logs.includes(r.error), "the red line was logged");
    eq(b.ld.get(r.handle, Info.FilePtr), 0, "a refused module lets go of its file");
    eq(b.x.ld_faults(), 0, "faults");
    // refused is final: the kit refuses everything after
    const before = b.x.kit_refused_total();
    eq(b.x.ld_map(r.handle, 0x0800_0000), -2, "map of a refused module");
    eq(b.x.ld_relocate(r.handle), -2, "relocate of a refused module");
    eq(b.x.kit_refused_total(), before + 2, "the kit counted both");
    ok(b.red().some(l => /kit: module#\d+ refused Map in Refused/.test(l)), "the kit's red line");
  });
}

test("hashes: a module with a wrong hash loads when checking is off or its check-hash flag is clear (as Horizon)", () => {
  const damaged = () => { const d = file("main_stored.nso"); d[0xA0] ^= 1; return d; };
  let b = fresh();
  eq(tryLoad(b, damaged(), true).reason, "hash", "checked");
  b = fresh();
  eq(tryLoad(b, damaged(), false).state, "Mapped", "verification off");
  b = fresh();
  const d = damaged(); d[0x0C] &= ~0x08;   // text's check-hash flag
  eq(tryLoad(b, d, true).state, "Mapped", "flag clear");
});

test("parse: a file that is not in linear memory makes no record", () => {
  const b = fresh();
  eq(b.x.ld_parse(0x08FF_FF00, 0x200, 1), -1, "runs past the end of memory");
  eq(b.x.ld_parse(0, 0x200, 1), -1, "null");
  eq(b.x.ld_module_count(), 0, "no record");
  ok(b.ld.error().includes("not in linear memory"), b.ld.error());
  try { b.ld.parse({ name: "x", ptr: 0xFFFF_FF00, len: 0x1000 }); throw new Error("no exception"); }
  catch (e) { ok(e instanceof LoaderError && e.code === -1, String(e)); }
});
