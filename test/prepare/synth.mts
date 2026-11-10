// Synthetic game folders for the prepare tests. Nothing here comes from a game: code modules are the runtime's test
// guests (test/runtime/src, built by its harness), main.npdm is made here from the fields the prepare step reads,
// RomFS trees are written here or unpacked from an image tools/mkromfs.py synthesizes.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
