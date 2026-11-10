// The loader's test harness: builds the test modules (clang, ld.lld, tools/elf2nso.py), reads their ELF files to
// compute what the loader must produce, and gives out fresh instances of build/loader/loader.wasm.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, WASM as WASM32 } from "../../src/loader/host/build.mts";
import { instantiate as instantiateAbi } from "../../src/glue/wasm_abi.ts";
import { makeMemory64, MEM64_MAX_PAGES } from "../../src/glue/a64_host.ts";
import { Loader, type LoaderExports, type FileInMemory } from "../../src/loader/host/loader.mts";
import { readMachines } from "../../src/kit/host/reader.mts";

// NX_MEM: "32" (default) the loader built for a 32-bit memory, with a memory of its own; "64" the wasm64 build on a
// 64-bit memory; "64hi" the same with the module files and the guest images above 4 GB (the arena and the stub
// region are host-area memory and stay low, as in the runtime).
export const MODE = process.env.NX_MEM ?? "32";
export const M64 = MODE !== "32";
export const HI = MODE === "64hi" ? 0x1_8000_0000 : 0;
export const WASM = M64 ? WASM32.replace(/\.wasm$/, "64.wasm") : WASM32;
export { ROOT };
export const OUT = join(ROOT, "build", "loader", "guests");
const SRC = join(ROOT, "test", "loader", "src");

// ---- building the modules ----
const CFLAGS = ["--target=aarch64-none-elf", "-fPIC", "-ffreestanding", "-nostdlib", "-O1", "-fno-asynchronous-unwind-tables", "-fno-unwind-tables"];
const LDFLAGS = ["-shared", "-z", "max-page-size=4096", "-z", "norelro", "--build-id=sha1", "-T", join(SRC, "module.ld")];
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });

// Whether the reference ZBIC codec (the `zbic` Python package) is installed: with it the *_zbic.nso files are really
// compressed by it and the differential tests run; without it they are written by elf2nso.py's own small compressor
// (--zbic-own: raw literals, sequences with the predefined tables) and the rest of the format is tested on the
// committed streams only (test/loader/zbic_fixtures.bin, test/loader/fixtures).
export const ZBIC_REF = join(ROOT, "test", "loader", "zbic_ref.py");
export const FIXTURES = join(ROOT, "test", "loader", "fixtures");
let zbicPackage: boolean | undefined;
export const haveZbic = (): boolean => zbicPackage ??= spawnSync("python3", [ZBIC_REF, "check"], { cwd: ROOT }).status === 0;

export function buildModules(): void {
  mkdirSync(OUT, { recursive: true });
  const o = (n: string) => join(OUT, n);
  run("clang", [...CFLAGS, "-c", join(SRC, "crt0.S"), "-o", o("crt0.o")]);
  for (const m of ["main", "sdk", "plugin"]) run("clang", [...CFLAGS, "-c", join(SRC, m + ".c"), "-o", o(m + ".o")]);
  // main: packed relative relocations (DT_RELR) and both hash tables; sdk: R_AARCH64_RELATIVE, DT_HASH only; plugin: DT_GNU_HASH only
  run("ld.lld", [...LDFLAGS, "--hash-style=both", "-z", "pack-relative-relocs", o("crt0.o"), o("main.o"), "-o", o("main.so")]);
  run("ld.lld", [...LDFLAGS, "--hash-style=sysv", o("crt0.o"), o("sdk.o"), "-o", o("sdk.so")]);
  run("ld.lld", [...LDFLAGS, "--hash-style=gnu", o("crt0.o"), o("plugin.o"), "-o", o("plugin.so")]);
  const nso = (elf: string, out: string, ...opts: string[]) => run("python3", [join(ROOT, "tools", "elf2nso.py"), o(elf), o(out), ...opts]);
  for (const m of ["main", "sdk", "plugin"]) {
    nso(m + ".so", m + ".nso", "--lz4");                    // compressed, hashes checked: what a retail module looks like
    nso(m + ".so", m + "_raw.nso", "--no-hash");            // stored, no hashes: every byte of the file is live
  }
  nso("main.so", "main_lit.nso", "--lz4", "--literal");
  nso("main.so", "main_part.nso", "--lz4=ro", "--no-hash");
  nso("main.so", "main_stored.nso");                        // stored, hashes checked
  nso("plugin.so", "plugin.nro", "--nro");
  // ZBIC (NSO flag bit 7, system 22.0.0 on)
  const how = haveZbic() ? [] : ["--zbic-own"];
  for (const m of ["main", "sdk", "plugin"]) nso(m + ".so", m + "_zbic.nso", "--zbic", ...how);
  nso("main.so", "main_zbicpart.nso", "--zbic=ro", "--no-hash", ...how);
  nso("main.so", "main_zbicown.nso", "--zbic", "--zbic-own");          // elf2nso.py's own compressor whether the package is there or not
}
export const file = (name: string): Uint8Array => new Uint8Array(readFileSync(join(OUT, name)));

// ---- reading an ELF ----
export interface Sym { name: string; info: number; other: number; shndx: number; value: number }
export interface Rela { offset: number; type: number; sym: number; addend: bigint }
export interface Elf {
  name: string;
  segs: { vaddr: number; bytes: Uint8Array; memsz: number }[];   // text, ro, data
  sections: Map<string, { addr: number; off: number; size: number }>;
  dynsym: Sym[]; relaDyn: Rela[]; relaPlt: Rela[]; relr: bigint[];
  buildId: Uint8Array; imageSize: number; bss: number;
}
export const R_ABS64 = 257, R_GLOB_DAT = 1025, R_JUMP_SLOT = 1026, R_RELATIVE = 1027;

export function readElf(name: string): Elf {
  const d = file(name), dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u64 = (o: number) => Number(dv.getBigUint64(o, true));
  const phoff = u64(0x20), phentsize = dv.getUint16(0x36, true), phnum = dv.getUint16(0x38, true);
  const segs: Elf["segs"] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (dv.getUint32(p, true) === 1) segs.push({ vaddr: u64(p + 0x10), bytes: d.slice(u64(p + 8), u64(p + 8) + u64(p + 0x20)), memsz: u64(p + 0x28) });
  }
  const shoff = u64(0x28), shentsize = dv.getUint16(0x3A, true), shnum = dv.getUint16(0x3C, true), shstrndx = dv.getUint16(0x3E, true);
  const sh = (i: number) => { const p = shoff + i * shentsize; return { nameOff: dv.getUint32(p, true), addr: u64(p + 0x10), off: u64(p + 0x18), size: u64(p + 0x20) }; };
  const cstr = (o: number) => { let e = o; while (d[e]) e++; return Buffer.from(d.subarray(o, e)).toString("latin1"); };
  const strs = sh(shstrndx), sections: Elf["sections"] = new Map();
  for (let i = 1; i < shnum; i++) { const s = sh(i); sections.set(cstr(strs.off + s.nameOff), { addr: s.addr, off: s.off, size: s.size }); }
  const sec = (n: string) => sections.get(n) ?? { addr: 0, off: 0, size: 0 };
  const dynstr = sec(".dynstr"), ds = sec(".dynsym");
  const dynsym: Sym[] = [];
  for (let p = ds.off; p < ds.off + ds.size; p += 24) {
    dynsym.push({ name: cstr(dynstr.off + dv.getUint32(p, true)), info: d[p + 4], other: d[p + 5], shndx: dv.getUint16(p + 6, true), value: u64(p + 8) });
  }
  const relas = (n: string): Rela[] => {
    const s = sec(n), out: Rela[] = [];
    for (let p = s.off; p < s.off + s.size; p += 24) out.push({ offset: u64(p), type: dv.getUint32(p + 8, true), sym: dv.getUint32(p + 12, true), addend: dv.getBigUint64(p + 16, true) });
    return out;
  };
  const rs = sec(".relr.dyn"), relr: bigint[] = [];
  for (let p = rs.off; p < rs.off + rs.size; p += 8) relr.push(dv.getBigUint64(p, true));
  const note = sec(".note.gnu.build-id");
  const end = segs[2].vaddr + segs[2].memsz;
  return { name, segs, sections, dynsym, relaDyn: relas(".rela.dyn"), relaPlt: relas(".rela.plt"), relr,
    buildId: d.slice(note.off + 16, note.off + note.size), imageSize: (end + 0xFFF) & ~0xFFF, bss: segs[2].memsz - segs[2].bytes.length };
}

// ---- the model: what the image of a module must be after relocation ----
export interface Placed { elf: Elf; base: number; pristine?: Uint8Array }   // pristine: the image before relocation when it is not the ELF's (an NRO)
export interface World { mods: Placed[]; force: Set<string>; hle: Set<string>; stub: (name: string) => number; unresolved: Map<string, Set<string>>; weakZero: number }

export function firstDef(w: World, name: string): number | undefined {
  for (const m of w.mods) {
    for (let i = 1; i < m.elf.dynsym.length; i++) {
      const s = m.elf.dynsym[i], bind = s.info >> 4, vis = s.other & 3;
      if (s.name === name && s.shndx && (bind === 1 || bind === 2) && (vis === 0 || vis === 3)) return s.shndx === 0xFFF1 ? s.value : m.base + s.value;
    }
  }
  return undefined;
}
// nxnative's bind_sym, written again from its description
export function resolve(w: World, m: Placed, si: number): number {
  if (!si) return 0;
  const s = m.elf.dynsym[si], bind = s.info >> 4;
  if (w.force.has(s.name)) return w.stub(s.name);
  if (s.shndx) {
    const self = m.base + s.value;
    if (bind === 0 || (s.other & 3) !== 0) return self;
    return firstDef(w, s.name) ?? self;
  }
  const d = firstDef(w, s.name);
  if (d !== undefined) return d;
  if (w.hle.has(s.name)) return w.stub(s.name);
  if (bind === 2) { w.weakZero++; return 0; }
  if (!w.unresolved.has(m.elf.name)) w.unresolved.set(m.elf.name, new Set());
  w.unresolved.get(m.elf.name)!.add(s.name);
  return w.stub(s.name);
}
export function pristineImage(m: Placed): Uint8Array {
  const img = new Uint8Array(m.elf.imageSize);
  if (m.pristine) img.set(m.pristine.subarray(0, Math.min(m.pristine.length, img.length)));
  else for (const s of m.elf.segs) img.set(s.bytes, s.vaddr);
  return img;
}
export function expectedImage(w: World, m: Placed): Uint8Array {
  const img = pristineImage(m), dv = new DataView(img.buffer), base = BigInt(m.base), M = (1n << 64n) - 1n;
  let where = 0;
  for (const e of m.elf.relr) {
    if (!(e & 1n)) { where = Number(e); dv.setBigUint64(where, (dv.getBigUint64(where, true) + base) & M, true); where += 8; continue; }
    for (let b = 0; b < 63; b++) if ((e >> BigInt(b + 1)) & 1n) { const o = where + 8 * b; dv.setBigUint64(o, (dv.getBigUint64(o, true) + base) & M, true); }
    where += 63 * 8;
  }
  for (const r of [...m.elf.relaDyn, ...m.elf.relaPlt]) {
    if (r.type === R_RELATIVE) dv.setBigUint64(r.offset, (base + r.addend) & M, true);
    else if (r.type === R_JUMP_SLOT) dv.setBigUint64(r.offset, BigInt(resolve(w, m, r.sym)), true);
    else if (r.type === R_ABS64 || r.type === R_GLOB_DAT) dv.setBigUint64(r.offset, (BigInt(resolve(w, m, r.sym)) + r.addend) & M, true);
    else throw new Error(`${m.elf.name}: relocation type ${r.type} is not in the model`);
  }
  return img;
}

// ---- instances ----
// Layout of the test instance's linear memory
export const ARENA = 0x0010_0000, ARENA_LEN = 0x0010_0000, STUBS = 0x0030_0000, STUB_CAP = 64, FILES = HI + 0x0040_0000, GUEST = HI + 0x0800_0000;
export const MEM_BYTES = HI + 0x0900_0000;

export interface Box {
  x: LoaderExports; ld: Loader; logs: string[];
  put(name: string, bytes: Uint8Array): FileInMemory;    // copy a file into memory (at the next free place after FILES)
  place(size: number): number;                            // the next free guest base (a free page between modules)
  mem(addr: number, len: number): Uint8Array;             // a copy
  u64(addr: number): number;
  red(): string[];
}

let module: WebAssembly.Module | undefined;
const live: LoaderExports[] = [];

export function instantiate(pages: number): { x: LoaderExports; logs: string[] } {
  module ??= new WebAssembly.Module(readFileSync(WASM));
  const logs: string[] = [];
  let x!: LoaderExports;
  // addresses are numbers on this side in every mode (src/glue/wasm_abi.ts)
  const mem = M64 ? makeMemory64({ initial: pages, maximum: MEM64_MAX_PAGES }) : null;
  x = instantiateAbi<LoaderExports>(module, { env: {
    ...(mem ? { memory: mem.memory, ...mem.imports() } : {}),
    log: (ptr: number, len: number) => { logs.push(Buffer.from(new Uint8Array(x.memory.buffer).slice(ptr, ptr + len)).toString("utf8")); },
    abort: () => { throw new Error("abort"); },
  } }, { mem64: M64, name: "loader.wasm" });
  const have = x.memory.buffer.byteLength / 65536;
  if (pages > have) { if (mem) mem.grow(pages - have); else x.memory.grow(pages - have); }
  (x as any).grow = (n: number) => mem ? mem.grow(n) : x.memory.grow(n);
  x.kit_cover_enable(1);
  live.push(x);
  return { x, logs };
}

export function fresh(o: { stubCap?: number } = {}): Box {
  const { x, logs } = instantiate(MEM_BYTES / 65536);
  if (x.ld_heap_base() > ARENA) throw new Error("the loader's static memory reaches the test arena");
  const ld = new Loader(x, { arena: ARENA, arenaLen: ARENA_LEN, stubBase: STUBS, stubCap: o.stubCap ?? STUB_CAP });
  let nextFile = FILES, nextBase = GUEST;
  return {
    x, ld, logs,
    put(name, bytes) { const ptr = nextFile; new Uint8Array(x.memory.buffer).set(bytes, ptr); nextFile = Math.ceil((ptr + bytes.length + 0x1000) / 0x1000) * 0x1000; return { name, ptr, len: bytes.length }; },
    place(size) { const b = nextBase; nextBase += size + 0x1000; return b; },
    mem: (addr, len) => new Uint8Array(x.memory.buffer).slice(addr, addr + len),
    u64: addr => Number(new DataView(x.memory.buffer).getBigUint64(addr, true)),
    red: () => logs.filter(l => l.startsWith("[RED] ")),
  };
}

// Hit bitmap of the `module` machine, OR-ed over every instance, with the machine as the wasm has it
export function moduleCoverage(): { machine: ReturnType<typeof readMachines>[number]; hits: Uint8Array } {
  let machine!: ReturnType<typeof readMachines>[number], hits!: Uint8Array;
  for (const x of live) {
    const m = readMachines(x).find(m => m.name === "module")!;
    machine = m; hits ??= new Uint8Array(m.hits.length);
    m.hits.forEach((h, i) => { if (h) hits[i] = 1; });
  }
  return { machine, hits };
}

// ---- tests ----
export const tests: { name: string; fn: () => void }[] = [];
export function test(name: string, fn: () => void): void { tests.push({ name, fn }); }
export function eq<T>(got: T, want: T, what: string): void {
  const g = typeof got === "object" ? JSON.stringify(got) : String(got), w = typeof want === "object" ? JSON.stringify(want) : String(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}
export function ok(cond: unknown, what: string): void { if (!cond) throw new Error(what); }
export function same(got: Uint8Array, want: Uint8Array, what: string): void {
  if (got.length !== want.length) throw new Error(`${what}: ${got.length} bytes, want ${want.length}`);
  for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) throw new Error(`${what}: differs at +0x${i.toString(16)} (got ${got[i]}, want ${want[i]})`);
}
export const hex = (n: number) => "0x" + n.toString(16);
// A small deterministic generator (mulberry32)
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0); };
}
