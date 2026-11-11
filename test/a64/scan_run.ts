// The static instruction scan (src/a64/scan.ts, src/glue/a64_scan.ts): synthetic text with known words, and the
// translator's own test guests, whose code must scan clean. Usage: node test/a64/scan_run.ts [--brief]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { A64Scanner, scanLines, scanHeadline, type ModuleScan } from "../../src/glue/a64_scan.ts";

const root = new URL("../../", import.meta.url).pathname;
const scanner = new A64Scanner(readFileSync(join(root, "build/a64/translator.wasm")));
const out: { name: string; ok: boolean; detail: string }[] = [];
const test = async (name: string, fn: () => Promise<string> | string) => {
  try { out.push({ name, ok: true, detail: await fn() }); } catch (e) { out.push({ name, ok: false, detail: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 900) }); }
};
const eq = (what: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`); };
const words = (w: number[]) => new Uint8Array(new Uint32Array(w).buffer);

const NOP = 0xD503201F, RET = 0xD65F03C0, ADD = 0x91000400;
const SVE1 = 0x04603000, SVE2 = 0x04A03020, ERETAA = 0xD69F0BFF, MRS_SCTLR = 0xD5381000, HVC = 0xD4000002, UDF = 0, JUNK = 0xFFFFFFFF;
const TEXT = [
  NOP, ADD, SVE1, SVE2, ERETAA, MRS_SCTLR, UDF, RET,       // 0x00 function A
  JUNK, SVE1, UDF, UDF,                                    // 0x20 between the functions
  HVC, RET, NOP, NOP,                                      // 0x30 function B
];
const kind = (s: ModuleScan, name: string) => s.kinds.find(k => k.name.startsWith(name));

await test("known words inside the functions of an unwind table: kinds, counts, first offsets; the text between functions apart", async () => {
  const s = await scanner.scan(words(TEXT), 0, [0x00, 0x20, 0x30, 0x40]);
  eq("functions", s.functions, 2); eq("text words", s.textWords, 16);
  eq("words in functions / translated", [s.words, s.implemented], [12, 6]);
  eq("words outside / translated", [s.wordsOutside, s.implementedOutside], [4, 0]);
  eq("SVE", [kind(s, "SVE (any)")?.count, kind(s, "SVE (any)")?.first, kind(s, "SVE (any)")?.outside, kind(s, "SVE (any)")?.firstOutside], [2, [8, 12], 1, [0x24]]);
  eq("ERET", [kind(s, "ERET")?.count, kind(s, "ERET")?.first], [1, [16]]);
  eq("MRS", [kind(s, "MRS")?.name, kind(s, "MRS")?.count, kind(s, "MRS")?.first], ["MRS S3_0_C1_C0_0 (SCTLR_EL1)", 1, [20]]);
  eq("HVC", [kind(s, "HVC")?.count, kind(s, "HVC")?.first], [1, [0x30]]);
  eq("UDF is not an instruction", [kind(s, "UDF")?.instruction, kind(s, "UDF")?.count, kind(s, "UDF")?.outside], [false, 1, 2]);
  eq("an unallocated word is not an instruction", [kind(s, "not an instruction")?.instruction, kind(s, "not an instruction")?.count, kind(s, "not an instruction")?.outside], [false, 0, 1]);
  eq("unsupported kinds / words (instructions in functions only)", [s.unsupported, s.unsupportedWords], [4, 5]);
  eq("headline", scanHeadline([{ scan: s }]), "4 kinds of instruction in this game are not supported yet");
  const lines = scanLines("main", s);
  if (!lines.some(l => /^\s+2  SVE \(any\)  \(first at 0x8, 0xc\)$/.test(l))) throw new Error("no table row for SVE:\n" + lines.join("\n"));
  if (!lines.some(l => /outside the function table/.test(l))) throw new Error("the text outside the functions is not reported:\n" + lines.join("\n"));
  return lines.join("\n       ");
});
await test("the same text without a table: one region, said to be the whole text; offsets are module offsets", async () => {
  const s = await scanner.scan(words(TEXT), 0x1000, null);
  eq("functions", s.functions, null); eq("words / translated", [s.words, s.implemented, s.wordsOutside], [16, 6, 0]);
  eq("SVE", [kind(s, "SVE (any)")?.count, kind(s, "SVE (any)")?.first], [3, [0x1008, 0x100C, 0x1024]]);
  eq("unsupported kinds", s.unsupported, 4);
  if (!/no unwind table/.test(scanLines("m", s)[0])) throw new Error(scanLines("m", s)[0]);
  return scanLines("m", s)[0];
});
await test("a module without unsupported instructions: no headline; one kind says `is`", async () => {
  const clean = await scanner.scan(words([NOP, ADD, RET, 0xD65F0FFF /* retab */, 0xD503237F /* pacibsp */]), 0, [0, 20]);
  eq("unsupported", [clean.unsupported, clean.implemented, clean.kinds.length], [0, 5, 0]);
  eq("headline", scanHeadline([{ scan: clean }]), "");
  const one = await scanner.scan(words([NOP, SVE1, RET]), 0, [0, 12]);
  eq("headline for one kind", scanHeadline([{ scan: one }, { scan: clean }]), "1 kind of instruction in this game is not supported yet");
  return scanLines("main", clean).join(" | ");
});
await test("piece boundaries inside functions and between them, a function list that goes on beyond the text", async () => {
  // 600,000 words: more than two pieces of the scanner's buffer; an unsupported word every 1000, functions of 3000 words with gaps of 1000
  const n = 600_000, w = new Uint32Array(n).fill(NOP), fns: number[] = [];
  for (let i = 0; i < n; i += 1000) w[i] = SVE1;
  for (let i = 0; i < n; i += 4000) fns.push(i * 4, (i + 3000) * 4);
  fns.push(n * 4 + 64, n * 4 + 128);
  const s = await scanner.scan(new Uint8Array(w.buffer), 0, fns);
  eq("words in / outside functions", [s.words, s.wordsOutside], [n * 3 / 4, n / 4]);
  eq("SVE in / outside", [kind(s, "SVE")?.count, kind(s, "SVE")?.outside], [n / 1000 * 3 / 4, n / 1000 / 4]);
  eq("first offsets", [kind(s, "SVE")?.first.slice(0, 4), kind(s, "SVE")?.firstOutside.slice(0, 2)], [[0, 4000, 8000, 16000], [12000, 28000]]);
  return `${s.textWords} words`;
});
await test("literal pools: with a function table, what the functions' PC-relative loads read is left out; without one it is scanned like the rest", async () => {
  // f: ldr x0, =value (8 bytes at +16); ldr w1, =w (at +24); ldr q2, =q (16 bytes at +32); ret; the pool; an SVE word after it
  const text = words([0x58000080, 0x180000A1, 0x9C0000C2, RET, 0x80000001, 0xC0000000, 0x80000000, NOP, 0x80000000, 0xE0000000, 0xA0000000, 0xC1000000, SVE1, RET]);
  const s = await scanner.scan(text, 0, [0, 56]);
  eq("literal words / words scanned / translated", [s.literals, s.words, s.implemented], [7, 7, 6]);
  eq("kinds", s.kinds.map(k => [k.name, k.count, k.first]), [["SVE (any)", 1, [48]]]);
  const all = await scanner.scan(text, 0, null);
  eq("without a table: no word left out", [all.literals, all.words], [0, 14]);
  if (all.unsupported < 2) throw new Error("the pool's words were not scanned: " + JSON.stringify(all.kinds.map(k => k.name)));
  return scanLines("f", s).join(" | ");
});
await test("the answer is the decoder's: words the translator translates and words it does not", () => {
  const yes = [NOP, RET, 0xD65F0FFF, 0xD73F0921, 0xF8E10002 /* ldaddal */, 0xC8E4FC05 /* casal */, 0x4868FC0A /* caspal */, 0x38BFC001 /* ldaprb */,
    0xCE608000 /* sha512h */, 0xCEC08000 /* sha512su0 */, 0xCE608C00 /* rax1 */, 0xCE000000 /* eor3 */, 0xCE200000 /* bcax */,
    0xCE800000 /* xar */, 0xCE400000 /* sm3ss1 */, 0xCE408000 /* sm3tt1a */, 0xCE60C000 /* sm3partw1 */, 0xCEC08400 /* sm4e */,
    0xCE60C800 /* sm4ekey */, 0x1E7E0000 /* fjcvtzs */,
    0x4E829420 /* sdot v0.4s, v1.16b, v2.16b */, 0x2E829484 /* udot v4.2s */, 0x6FB1E820 /* udot v0.4s, v1.16b, v17.4b[3] */, 0x0FA2E023 /* sdot v3.2s, .., v2.4b[1] */];
  const no = [SVE1, ERETAA, HVC, MRS_SCTLR, UDF, JUNK, 0xCE60CC00 /* unallocated (sha512 group, O=1 opcode=3) */,
    0xCE600000 /* unallocated (four-register Op0=3) */, 0x9E7E0000 /* fjcvtzs with sf=1 */,
    0x4E429420 /* dot with size 01 */, 0x0F62E023 /* dot by element, size 01 */];
  for (const w of yes) if (!scanner.implemented(w)) throw new Error(`0x${w.toString(16)} is said not to be implemented`);
  for (const w of no) if (scanner.implemented(w)) throw new Error(`0x${w.toString(16)} is said to be implemented`);
  return `${yes.length} + ${no.length} words`;
});

// ---- the translator's own guests: the .text of every ELF in test/a64/guests/out
function elfText(b: Buffer): { off: number; size: number } | null {
  if (b.readUInt32BE(0) !== 0x7F454C46) return null;
  const shoff = Number(b.readBigUInt64LE(0x28)), shentsize = b.readUInt16LE(0x3A), shnum = b.readUInt16LE(0x3C), shstrndx = b.readUInt16LE(0x3E);
  const sec = (i: number) => ({ name: b.readUInt32LE(shoff + i * shentsize), off: Number(b.readBigUInt64LE(shoff + i * shentsize + 0x18)), size: Number(b.readBigUInt64LE(shoff + i * shentsize + 0x20)) });
  const str = sec(shstrndx);
  for (let i = 0; i < shnum; i++) {
    const s = sec(i);
    let e = str.off + s.name; while (b[e]) e++;
    if (b.toString("latin1", str.off + s.name, e) === ".text") return { off: s.off, size: s.size };
  }
  return null;
}
await test("our own guests scan clean: the code of every image in test/a64/guests/out (first Switch and Switch 2 builds)", async () => {
  const dir = join(root, "test/a64/guests/out");
  if (!existsSync(dir)) throw new Error("test/a64/guests/out is not built (npm run a64:guests:build)");
  let n = 0, total = 0, v82 = 0;
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".elf")).sort()) {
    const b = readFileSync(join(dir, f)), t = elfText(b);
    if (!t) continue;
    const s = await scanner.scan(new Uint8Array(b.buffer, b.byteOffset + t.off, t.size & ~3).slice(), 0, null);
    n++; total += s.words; if (/a78c|^mt_/.test(f)) v82++;
    for (const k of s.kinds) if (k.instruction) bad.push(`${f}: ${k.count} x ${k.name} (first at ${k.first.map(o => "0x" + o.toString(16)).join(", ")})`);
  }
  if (n < 20) throw new Error(`only ${n} ELF images found`);
  if (bad.length) throw new Error(`${bad.length} kinds of unsupported instruction in our own guests:\n` + bad.slice(0, 20).join("\n"));
  return `${n} images (${v82} built for the Switch 2's core), ${total} words of code, none unsupported`;
});

const brief = process.argv.includes("--brief");
for (const r of out) console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}` + (brief && r.ok ? "" : `\n       ${r.detail}`));
const bad = out.filter(r => !r.ok).length;
console.log(`a64 scan: ${out.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
