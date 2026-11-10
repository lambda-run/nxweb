// Synthetic game folders for the prepare tests. Nothing here comes from a game: code modules are the runtime's test
// guests (test/runtime/src, built by its harness), main.npdm is made here from the fields the prepare step reads,
// RomFS trees are written here or unpacked from an image tools/mkromfs.py synthesizes.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, OUT } from "../../src/prepare/host/build.mts";

export const SCRATCH = join(OUT, "scratch");
export const GUESTS = join(ROOT, "build", "runtime", "guests");
export const guest = (name: string): Uint8Array => new Uint8Array(readFileSync(join(GUESTS, name + ".nso")));
export const python = (args: string[]): string => execFileSync("python3", [join(ROOT, "tools", "mkromfs.py"), ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

// main.npdm: META with the fields at the offsets Horizon has them, and an ACI0 section with the program ID
export function npdm(o: { programId: bigint; sysResource?: number; is64?: boolean; stackSize?: number; name?: string; magic?: string; aciMagic?: string; aciOffset?: number }): Uint8Array {
  const b = new Uint8Array(0x80 + 0x40), dv = new DataView(b.buffer), put = (at: number, s: string) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };
  put(0, o.magic ?? "META");
  b[0x0C] = (o.is64 ?? true) ? 1 : 0; b[0x0E] = 44; b[0x0F] = 0;
  dv.setUint32(0x14, o.sysResource ?? 0, true);
  dv.setUint32(0x1C, o.stackSize ?? 0x100000, true);
  put(0x20, (o.name ?? "Application").slice(0, 15));
  dv.setUint32(0x70, o.aciOffset ?? 0x80, true); dv.setUint32(0x74, 0x40, true);
  put(0x80, o.aciMagic ?? "ACI0");
  dv.setBigUint64(0x90, o.programId, true);
  return b;
}
// The blob the runtime's fs guest (fsg) reads and checksums, and what it prints for it
export function blob(n = 100_003, seed = 12345): Uint8Array {
  const b = new Uint8Array(n);
  let v = seed; for (let i = 0; i < n; i++) { v = (Math.imul(v, 1103515245) + 12345) >>> 0; b[i] = v >>> 16; }
  return b;
}
export const fnv64 = (b: Uint8Array): string => { let h = 0xcbf29ce484222325n; for (const x of b) h = BigInt.asUintN(64, (h ^ BigInt(x)) * 0x100000001b3n); return "0x" + h.toString(16); };

export type Files = Record<string, Uint8Array | string>;
export function writeTree(dir: string, files: Files, dirs: string[] = []): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  return dir;
}
export const prefixed = (prefix: string, f: Files): Files => Object.fromEntries(Object.entries(f).map(([k, v]) => [prefix + k, v]));
// One version of a game: the fs guest as main (with a library module beside it when asked), a RomFS it can read
export function version(o: { programId: bigint; rom?: Files; blob?: Uint8Array; main?: string; extra?: Files; sysResource?: number; is64?: boolean }): Files {
  const rom: Files = o.rom ?? { "hello.txt": "hello from a folder\n", "data/blob.bin": o.blob ?? blob() };
  return { "exefs/main": guest(o.main ?? "fsg"), "exefs/main.npdm": npdm({ programId: o.programId, sysResource: o.sysResource, is64: o.is64 }), ...(o.extra ?? {}), ...prefixed("romfs/", rom) };
}

// A tree unpacked from an image `mkromfs.py synth` wrote: the image, its independent listing, and the tree's files
export function synthTree(name: string, args: string[]): { image: string; ls: string; dir: string; files: number } {
  mkdirSync(SCRATCH, { recursive: true });
  const image = join(SCRATCH, name + ".img"), dir = join(SCRATCH, name + ".tree");
  python(["synth", image, ...args]);
  const ls = python(["ls", image]);
  const rows = ls.trim().split("\n").map(l => JSON.parse(l) as { path: string; type: string; size: number });
  const fileRows = rows.filter(r => r.type === "f");
  const req = join(SCRATCH, name + ".req.json");
  writeFileSync(req, JSON.stringify(fileRows.map(r => [r.path, 0, r.size])));
  const data = python(["readat", image, req]).split("\n");
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const p = (hex: string) => Buffer.from(hex, "hex").toString("utf8").replace(/^\//, "");
  for (const r of rows) if (r.type === "d" && p(r.path)) mkdirSync(join(dir, p(r.path)), { recursive: true });
  fileRows.forEach((r, i) => { const f = join(dir, p(r.path)); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.from(data[i], "hex")); });
  return { image, ls, dir, files: fileRows.length };
}
// `mkromfs.py ls` rows as a sorted, comparable list
export const lsRows = (ls: string): string[] => ls.trim().split("\n").filter(l => l).map(l => { const r = JSON.parse(l); return `${r.type} ${r.path} ${r.size} ${r.sha256 ?? ""}`; }).sort();

// A BNSH container as shader_split.py reads one (bnsh_shaders): header, a grsc block at +0x60 with the variation
// count at +0x7C and the variation table pointer at +0x80, 0x40-byte variations with the program pointer at +0x10,
// programs with six stage pointers from +0x08, stage descriptors with control pointer +0x08, code pointer +0x10,
// code length +0x18, control length +0x1C. Pointers are relative to the container's start.
export function bnsh(variations: ({ stage: number; control: Uint8Array; code: Uint8Array }[])[]): Uint8Array {
  const parts: { at: number; bytes: Uint8Array }[] = [];
  let top = 0x100 + 0x40 * variations.length;
  const place = (b: Uint8Array) => { const at = (top + 0xFF) & ~0xFF; parts.push({ at, bytes: b }); top = at + b.length; return at; };
  const head = new Uint8Array(0x100 + 0x40 * variations.length), dv = new DataView(head.buffer);
  head.set([0x42, 0x4E, 0x53, 0x48, 0, 0, 0, 0], 0);                 // 'BNSH\0\0\0\0'
  head.set([0x67, 0x72, 0x73, 0x63], 0x60);                          // 'grsc'
  dv.setUint32(0x7C, variations.length, true); dv.setBigUint64(0x80, 0x100n, true);
  variations.forEach((stages, v) => {
    if (!stages.length) return;                                       // a variation without a program
    const prog = new Uint8Array(0x40), pdv = new DataView(prog.buffer);
    for (const s of stages) {
      const desc = new Uint8Array(0x20), ddv = new DataView(desc.buffer);
      ddv.setBigUint64(0x08, BigInt(place(s.control)), true); ddv.setBigUint64(0x10, BigInt(place(s.code)), true);
      ddv.setUint32(0x18, s.code.length, true); ddv.setUint32(0x1C, s.control.length, true);
      pdv.setBigUint64(0x08 + 8 * s.stage, BigInt(place(desc)), true);
    }
    dv.setBigUint64(0x100 + 0x40 * v + 0x10, BigInt(place(prog)), true);
  });
  const out = new Uint8Array(top);
  out.set(head); for (const p of parts) out.set(p.bytes, p.at);
  return out;
}
export { existsSync };

// ---- function-matched cuts: modules with unwind tables, and hand-made images ----
// The runtime's and the translator's test sources compiled once more WITH unwind tables (the test guests have none),
// as modules of the loader's layout: real compiler output whose functions an .eh_frame_hdr names. `-shared` leaves
// undefined functions as imports through a PLT. Only what links is returned; nothing here needs to run except
// "hello", which is the runtime's guest of that name.
export interface UnwindModule { name: string; path: string }
export function unwindModules(levels = ["O2", "Os"]): UnwindModule[] {
  const dir = join(SCRATCH, "unwind");
  mkdirSync(dir, { recursive: true });
  const quiet = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; } };
  const nvn = join(process.env.NXNATIVE_NVN_INCLUDE ?? join(process.env.NXNATIVE ?? "/home/user/nxnative", "dm", "gfx", "nvn", "include"));
  const sources = [["rt", join(ROOT, "test", "runtime", "src")], ["a64", join(ROOT, "test", "guests", "src")]].flatMap(([tag, d]) =>
    existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".c") && f !== "large.c" && f !== "wide.c" /* 72 MB and 27 MB images: nothing more to fingerprint */).sort().map(f => ({ name: `${tag}_${f.slice(0, -2)}`, src: join(d, f) })) : []);
  const out: UnwindModule[] = [];
  for (const level of levels) for (const s of sources) {
    const base = join(dir, `${s.name}.${level}`), nso = base + ".nso";
    if (!existsSync(nso) || statSync(nso).mtimeMs < statSync(s.src).mtimeMs) {
      const ok = quiet("clang", ["--target=aarch64-none-elf", "-fPIC", "-ffreestanding", "-nostdlib", "-" + level, "-mcpu=cortex-a57", "-mno-outline-atomics", "-fsemantic-interposition", "-funwind-tables", "-w",
          "-I", join(ROOT, "test", "guests", "rt"), "-I", GUESTS, "-I", nvn, "-c", s.src, "-o", base + ".o"])
        && quiet("ld.lld", ["-shared", "-z", "max-page-size=4096", "-z", "norelro", "--build-id=sha1", "--hash-style=both", "--eh-frame-hdr", ...(s.name.startsWith("a64_") ? ["--defsym=rt_entry=0"] : []),
          "-T", join(ROOT, "test", "loader", "src", "module.ld"), join(GUESTS, "crt0.o"), base + ".o", join(GUESTS, "svc.o"), "-o", base + ".so"])
        && quiet("python3", [join(ROOT, "tools", "elf2nso.py"), base + ".so", nso, "--lz4"]);
      if (!ok) continue;
    }
    out.push({ name: `${s.name}.${level}`, path: nso });
  }
  return out;
}

// AArch64 words for the hand-made images
export const A64 = {
  RET: 0xD65F03C0, NOP: 0xD503201F,
  movX0X23: 0xAA1703E0,                    // mov x0, x23
  addX0X23: 0x914012E0,                    // add x0, x23, #0x4000
  movz: (rd: number, imm: number) => (0xD2800000 | (imm << 5) | rd) >>> 0,
  adrp: (rd: number, pc: number, target: number) => { const imm = ((target & ~0xFFF) - (pc & ~0xFFF)) >> 12; return (0x90000000 | ((imm & 3) << 29) | (((imm >> 2) & 0x7FFFF) << 5) | rd) >>> 0; },
  addi: (rd: number, rn: number, imm12: number) => (0x91000000 | (imm12 << 10) | (rn << 5) | rd) >>> 0,
  ldr: (rt: number, rn: number, imm12: number) => (0xF9400000 | (imm12 << 10) | (rn << 5) | rt) >>> 0,
  b: (from: number, to: number) => (0x14000000 | (((to - from) >> 2) & 0x3FFFFFF)) >>> 0,
  bl: (from: number, to: number) => (0x94000000 | (((to - from) >> 2) & 0x3FFFFFF)) >>> 0,
  beq: (delta: number) => (0x54000000 | (((delta >> 2) & 0x7FFFF) << 5)) >>> 0,
  svc: (n: number) => (0xD4000001 | (n << 5)) >>> 0,
};
// An unpacked module image of 0x4000 bytes whose unwind table names the given functions (start -> words): the word
// at +4 leads to MOD0 at 0x20, MOD0 to an .eh_frame_hdr at 0x3000 (version 1, a sorted table of start and FDE,
// relative to the header), one CIE ("zR", PC-relative 4-byte pointers) at 0x3200 and an FDE per function after it.
// Text ends at 0x2000. `raw` writes more words anywhere (code without an unwind entry, data).
export const MATCH_TEXT_END = 0x2000;
export function matchImage(functions: Record<number, number[]>, raw: Record<number, number[]> = {}): Uint8Array {
  const out = new Uint8Array(0x4000), dv = new DataView(out.buffer), fns = Object.entries(functions).map(([s, w]) => [Number(s), w] as const).sort((a, b) => a[0] - b[0]);
  dv.setUint32(4, 0x20, true);
  out.set([0x4D, 0x4F, 0x44, 0x30], 0x20);                                    // "MOD0"
  dv.setInt32(0x30, 0x3000 - 0x20, true); dv.setInt32(0x34, 0x300C + fns.length * 8 - 0x20, true);
  out.set([1, 0x1B, 0x03, 0x3B], 0x3000);
  dv.setInt32(0x3004, 0x3200 - 0x3004, true); dv.setUint32(0x3008, fns.length, true);
  dv.setUint32(0x3200, 16, true); dv.setUint32(0x3204, 0, true);
  out.set([1, 0x7A, 0x52, 0, 4, 0x78, 0x1E, 1, 0x1B], 0x3208);                // version 1, "zR", align 4 / -8, x30, 1 byte: the encoding
  fns.forEach(([start, words], i) => {
    words.forEach((w, k) => dv.setUint32(start + 4 * k, w, true));
    const fde = 0x3240 + i * 24;
    dv.setInt32(0x300C + i * 8, start - 0x3000, true); dv.setInt32(0x3010 + i * 8, fde - 0x3000, true);
    dv.setUint32(fde, 16, true); dv.setUint32(fde + 4, fde + 4 - 0x3200, true); dv.setInt32(fde + 8, start - (fde + 8), true); dv.setUint32(fde + 12, words.length * 4, true);
  });
  for (const [at, words] of Object.entries(raw)) words.forEach((w, k) => dv.setUint32(Number(at) + 4 * k, w, true));
  return out;
}
// The same image with one imported function: a PLT stub at `plt` that loads the GOT slot at `slot`, and the dynamic
// table (at 0x2100), DT_JMPREL (0x2200), symbol table (0x2300) and strings (0x2400) that name the slot
export function withImport(image: Uint8Array, name: string, plt = 0x1800, slot = 0x2500): Uint8Array {
  const out = image.slice(), dv = new DataView(out.buffer);
  dv.setInt32(0x24, 0x2100 - 0x20, true);
  ([[20, 7], [23, 0x2200], [2, 24], [6, 0x2300], [5, 0x2400], [0, 0]] as const).forEach(([tag, value], i) => { dv.setBigInt64(0x2100 + i * 16, BigInt(tag), true); dv.setBigUint64(0x2108 + i * 16, BigInt(value), true); });
  dv.setBigUint64(0x2200, BigInt(slot), true); dv.setBigUint64(0x2208, (1n << 32n) | 1026n, true);      // R_AARCH64_JUMP_SLOT of symbol 1
  dv.setUint32(0x2318, 1, true);                                                                        // symbol 1: its name at +1
  out.set(new TextEncoder().encode(name), 0x2401);
  const lo = slot & 0xFFF;
  [A64.adrp(16, plt, slot), (0xF9400211 | ((lo / 8) << 10)) >>> 0, A64.addi(16, 16, lo), 0xD61F0220].forEach((w, k) => dv.setUint32(plt + 4 * k, w, true));
  return out;
}
