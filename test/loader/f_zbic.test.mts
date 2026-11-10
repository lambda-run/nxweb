// ZBIC (src/loader/zbic.ts): the decoder against streams the reference codec made, damaged streams, and NSO files
// with ZBIC segments.
//
// The reference is the `zbic` Python package (Atmosphere's zstd with its ZBIC changes). Streams it made are committed
// (zbic_fixtures.bin: generated data chosen to reach every part of the format and our own test modules' ELF files,
// each with the SHA-256 of what it must decode to; fixtures/*.nso: the test modules as ZBIC NSO files), so the decoder
// is tested where the package is not installed. Where it is, fresh streams are generated and compared as well, and
// damaged streams are checked to be accepted or refused as the reference does. Regenerating the committed files:
//   python3 test/loader/zbic_ref.py fixtures test/loader/zbic_fixtures.bin build/loader/guests/{main,sdk,plugin}.so
//   for m in main sdk plugin; do python3 tools/elf2nso.py build/loader/guests/$m.so test/loader/fixtures/${m}_zbic.nso --zbic; done
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { test, fresh, file, readElf, pristineImage, eq, ok, same, rng, haveZbic, ROOT, OUT, ZBIC_REF, FIXTURES, type Box } from "./harness.mts";
import { loadSet, checkImages } from "./c_load.test.mts";
import { LoaderError } from "../../src/loader/host/loader.mts";

const SRC = 0x0100_0000, DST = 0x0200_0000, CAP = 0x0100_0000;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ZE = ["", "truncated", "magic", "header", "dict", "block", "literals", "huf table", "huf stream", "seq header", "fse table", "seq stream", "offset", "output", "size", "checksum", "empty"];
const ZS = ["frames", "skippable frames", "checksums", "raw blocks", "RLE blocks", "compressed blocks", "raw literals", "RLE literals", "Huffman literals in 1 stream", "Huffman literals in 4 streams",
  "repeated tree, 1 stream", "repeated tree, 4 streams", "weights as 4-bit fields", "FSE-coded weights",
  "literal lengths predefined", "literal lengths RLE", "literal lengths FSE", "literal lengths repeated", "offsets predefined", "offsets RLE", "offsets FSE", "offsets repeated",
  "match lengths predefined", "match lengths RLE", "match lengths FSE", "match lengths repeated", "blocks without sequences",
  "first repeat offset", "second repeat offset", "third repeat offset", "first repeat offset less 1", "matches farther back than a block", "FSE tables with a less-than-one count"];
const stats = (b: Box) => ZS.map((_, i) => b.x.ld_zbic_stat(i));

interface Stream { name: string; level: number; size: number; sha: string; comp: Uint8Array; raw?: Uint8Array; refOk?: boolean }
function readPack(d: Uint8Array): Stream[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.length), out: Stream[] = [];
  for (let at = 0; at < d.length;) {
    const nl = dv.getUint32(at, true), level = dv.getInt32(at + 4, true), size = dv.getUint32(at + 8, true), cl = dv.getUint32(at + 12, true);
    const s: Stream = { name: "", level, size, sha: Buffer.from(d.subarray(at + 16, at + 48)).toString("hex"), comp: new Uint8Array(0) };
    at += 48;
    s.name = Buffer.from(d.subarray(at, at + (nl & 0x3FFFFFFF))).toString(); at += nl & 0x3FFFFFFF;
    s.comp = d.subarray(at, at + cl); at += cl;
    if (nl & 0x80000000) { s.raw = d.subarray(at, at + size); at += size; }
    if (nl & 0x40000000) s.refOk = level !== 0;     // a damaged stream: whether the reference decoded it (zbic_ref.py damage)
    out.push(s);
  }
  return out;
}
const fixtures = () => readPack(new Uint8Array(readFileSync(join(ROOT, "test", "loader", "zbic_fixtures.bin"))));

// Decode `comp` to at most `cap` bytes with bands of 0xEE around the output; `at`: where the input lies (default SRC)
function decode(b: Box, comp: Uint8Array, cap: number, o: { at?: number; dst?: number; steps?: number } = {}): { n: number; out: Uint8Array } {
  const mem = new Uint8Array(b.x.memory.buffer), at = o.at ?? SRC, dst = o.dst ?? DST;
  mem.set(comp, at);
  mem.fill(0xEE, dst - 64, dst); if (dst + cap + 64 <= mem.length) mem.fill(0xEE, dst + cap, dst + cap + 64);
  let n: number;
  if (o.steps) {
    b.x.ld_zbic_begin(at, comp.length, dst, cap);
    let r = 1, calls = 0;
    while (r > 0) { r = b.x.ld_zbic_step(o.steps); if (++calls > 1e6) throw new Error("the steps do not end"); }
    n = r < 0 ? r : b.x.ld_zbic_produced();
    eq(b.x.ld_zbic_step(o.steps), r, "a step after the end gives the end again");
  } else n = b.x.ld_zbic(at, comp.length, dst, cap);
  for (let i = 0; i < 64; i++) if (mem[dst - 64 + i] !== 0xEE || (dst + cap + 64 <= mem.length && mem[dst + cap + i] !== 0xEE)) throw new Error("wrote outside the output");
  if (Buffer.compare(Buffer.from(mem.buffer, at, comp.length), comp) !== 0) throw new Error("wrote to the input");
  return { n, out: n < 0 ? new Uint8Array(0) : mem.slice(dst, dst + n) };
}
const reason = (n: number) => n < 0 ? ZE[-n] ?? `error ${n}` : "ok";

// ---- XXH64, written again here (BigInt) ----
const M64 = (1n << 64n) - 1n, XP1 = 0x9E3779B185EBCA87n, XP2 = 0xC2B2AE3D27D4EB4Fn, XP3 = 0x165667B19E3779F9n, XP4 = 0x85EBCA77C2B2AE63n, XP5 = 0x27D4EB2F165667C5n;
const rotl = (v: bigint, n: bigint) => ((v << n) | (v >> (64n - n))) & M64;
function xxh64(d: Uint8Array): bigint {
  const dv = new DataView(d.buffer, d.byteOffset, d.length), round = (a: bigint, v: bigint) => (rotl((a + v * XP2) & M64, 31n) * XP1) & M64;
  let p = 0, h: bigint;
  if (d.length >= 32) {
    let v = [(XP1 + XP2) & M64, XP2, 0n, (0n - XP1) & M64];
    for (; p + 32 <= d.length; p += 32) v = v.map((a, i) => round(a, dv.getBigUint64(p + 8 * i, true)));
    h = (rotl(v[0], 1n) + rotl(v[1], 7n) + rotl(v[2], 12n) + rotl(v[3], 18n)) & M64;
    for (const a of v) h = ((h ^ round(0n, a)) * XP1 + XP4) & M64;
  } else h = XP5;
  h = (h + BigInt(d.length)) & M64;
  for (; p + 8 <= d.length; p += 8) h = (rotl(h ^ round(0n, dv.getBigUint64(p, true)), 27n) * XP1 + XP4) & M64;
  if (p + 4 <= d.length) { h = (rotl(h ^ ((BigInt(dv.getUint32(p, true)) * XP1) & M64), 23n) * XP2 + XP3) & M64; p += 4; }
  for (; p < d.length; p++) h = (rotl(h ^ ((BigInt(d[p]) * XP5) & M64), 11n) * XP1) & M64;
  h ^= h >> 33n; h = (h * XP2) & M64; h ^= h >> 29n; h = (h * XP3) & M64; h ^= h >> 32n;
  return h;
}

test("zbic: XXH64 (the frame checksum) gives the published values, agrees with a second implementation at every length 0..200, and is the checksum Zstandard itself writes (node:zlib)", () => {
  const b = fresh(), mem = new Uint8Array(b.x.memory.buffer), r = rng(7), enc = new TextEncoder();
  const of = (d: Uint8Array) => { mem.set(d, SRC); return BigInt.asUintN(64, b.x.ld_xxh64(SRC, d.length)); };
  eq(of(new Uint8Array(0)).toString(16), "ef46db3751d8e999", "XXH64 of nothing");
  eq(of(enc.encode("a")).toString(16), "d24ec4f1a98c6e5b", "XXH64 of 'a'");
  eq(of(enc.encode("abc")).toString(16), "44bc2cf5ad770999", "XXH64 of 'abc'");
  for (const n of [...Array(201).keys(), 1000, 4096, 65537]) {
    const d = Uint8Array.from({ length: n }, () => r());
    eq(of(d), xxh64(d), `XXH64 of ${n} bytes`);
    // a Zstandard frame with its checksum ends in the low 32 bits of XXH64 of the content
    const z = zlib as unknown as { zstdCompressSync?: (d: Uint8Array, o: object) => Uint8Array; constants: Record<string, number> };
    if (z.zstdCompressSync) {
      const f = z.zstdCompressSync(d, { params: { [z.constants.ZSTD_c_checksumFlag]: 1 } });
      eq(new DataView(f.buffer, f.byteOffset, f.length).getUint32(f.length - 4, true), Number(of(d) & 0xFFFFFFFFn), `the checksum zstd writes for ${n} bytes`);
    }
  }
});

test("zbic: the committed streams of the reference codec decode to their SHA-256, at once and in steps, and reach every block type, literal mode, table mode and repeat offset", () => {
  const b = fresh(), list = fixtures();
  b.x.ld_zbic_stats_clear();
  let bytes = 0;
  for (const s of list) {
    const got = decode(b, s.comp, s.size);
    eq(reason(got.n), "ok", `${s.name} (level ${s.level})`);
    eq([got.n, sha(got.out)], [s.size, s.sha], `${s.name} (level ${s.level})`);
    bytes += s.size;
  }
  const seen = stats(b);
  const missing = ZS.filter((n, i) => !seen[i] && n !== "skippable frames" && n !== "checksums");
  eq(missing, [], "parts of the format no committed stream reaches");
  for (const s of list) for (const steps of [1, 1000, 200000]) {
    const got = decode(b, s.comp, s.size + 100, { steps });
    eq([got.n, sha(got.out)], [s.size, s.sha], `${s.name} in steps of ${steps}`);
  }
  // an output of one byte less is refused; the input may end where memory ends
  const END = b.x.memory.buffer.byteLength;
  for (const s of list) {
    if (s.size) eq(reason(decode(b, s.comp, s.size - 1).n), "output", `${s.name} into one byte less`);
    const got = decode(b, s.comp, s.size, { at: END - s.comp.length });
    eq([got.n, sha(got.out)], [s.size, s.sha], `${s.name} read at the end of memory`);
  }
  console.log(`     ${list.length} streams, ${bytes} bytes decoded: ${ZS.map((n, i) => `${seen[i]} ${n}`).join(", ")}`);
});

// ---- frames made by hand: the container ----
const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v / 2 ** (8 * i)) & 0xFF);
const MAGIC = [0x5A, 0x42, 0x49, 0x43];
const blk = (type: number, last: boolean, size: number, body: number[]) => [...le(size << 3 | type << 1 | (last ? 1 : 0), 3), ...body];
const text = (s: string) => [...Buffer.from(s)];

test("zbic: frames made by hand: a window instead of a content size, a checksum, skippable frames, several frames, an empty frame", () => {
  const b = fresh();
  b.x.ld_zbic_stats_clear();
  const run = (bytes: number[], cap = 1000) => { const g = decode(b, Uint8Array.from(bytes), cap); return g.n < 0 ? reason(g.n) : Buffer.from(g.out).toString("latin1"); };
  // no content size, window 1 KB: a raw block, an RLE block, a raw block
  const plain = [...MAGIC, 0x00, 0x00, ...blk(0, false, 5, text("hello")), ...blk(1, false, 4, text("!")), ...blk(0, true, 3, text("end"))];
  eq(run(plain), "hello!!!!end", "raw + RLE + raw, no content size");
  // content size in 1, 2, 4 and 8 bytes
  const sized = (fhd: number, fcs: number[], n: number) => [...MAGIC, fhd, ...fcs, ...blk(1, true, n, text("z"))];
  eq(run(sized(0x20, [7], 7)), "zzzzzzz", "single segment, 1-byte size");
  eq(run(sized(0x40, [0x00, ...le(300 - 256, 2)], 300)).length, 300, "2-byte size (stored less 256)");
  eq(run(sized(0x80, [0x00, ...le(300, 4)], 300)).length, 300, "4-byte size");
  eq(run(sized(0xC0, [0x00, ...le(300, 8)], 300)).length, 300, "8-byte size");
  eq(run(sized(0x20, [7], 6)), "size", "the frame produces less than its header says");
  eq(run(sized(0x20, [7], 8)), "size", "the frame produces more than its header says");
  eq(run(sized(0x20, [7], 7), 6), "output", "the header's size does not fit the output");
  eq(run([...MAGIC, 0x20, 0, ...blk(0, true, 0, [])]), "", "an empty frame");
  eq(run([...MAGIC, 0x20, 3, ...blk(0, false, 3, text("abc")), ...blk(0, false, 0, []), ...blk(1, false, 0, text("x")), ...blk(0, true, 0, [])], 3), "abc", "empty blocks after the output is full");
  // checksum: the low 32 bits of XXH64 of the frame's output
  const sum = Number(xxh64(Uint8Array.from(text("hello!!!!end"))) & 0xFFFFFFFFn);
  const summed = [...MAGIC, 0x04, 0x00, ...plain.slice(6)];
  eq(run([...summed, ...le(sum, 4)]), "hello!!!!end", "a frame with its checksum");
  eq(run([...summed, ...le(sum ^ 0x100, 4)]), "checksum", "a wrong checksum");
  eq(run(summed), "truncated", "the checksum is missing");
  // skippable frames before, between and after; two frames one after the other
  const skip = [0x53, 0x2A, 0x4D, 0x18, ...le(3, 4), 1, 2, 3];
  eq(run([...skip, ...plain, ...skip, ...sized(0x20, [2], 2), ...skip]), "hello!!!!endzz", "skippable frames and two frames");
  eq(run([...plain, ...plain]), "hello!!!!endhello!!!!end", "two frames");
  eq(run([...plain, 0x53, 0x2A, 0x4D, 0x18, ...le(4, 4), 1, 2, 3]), "truncated", "a skippable frame cut short");
  eq(run(skip), "empty", "only a skippable frame");
  eq(run([]), "empty", "no bytes");
  // a compressed block with raw literals and no sequences; one with RLE literals
  eq(run([...MAGIC, 0x00, 0x00, ...blk(2, true, 5, [3 << 3, ...text("abc"), 0])]), "abc", "a compressed block of raw literals");
  eq(run([...MAGIC, 0x00, 0x00, ...blk(2, true, 3, [5 << 3 | 1, 0x71, 0])]), "qqqqq", "a compressed block of RLE literals");
  const s = stats(b);
  ok(s[1] >= 4 && s[2] === 1 && s[0] >= 12, `skippable frames ${s[1]}, checksums ${s[2]}, frames ${s[0]}`);
});

test("zbic: every header fault is refused for its reason", () => {
  const b = fresh();
  const why = (bytes: number[], cap = 1000) => reason(decode(b, Uint8Array.from(bytes), cap).n);
  const body = blk(0, true, 2, text("ok"));
  eq(why([...MAGIC, 0x00, 0x00, ...body]), "ok", "the frame these are made from");
  eq(why([0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x00, ...body]), "magic", "a Zstandard frame is not a ZBIC frame");
  eq(why([0x5A, 0x42, 0x49, 0x42, 0x00, 0x00, ...body]), "magic", "ZBIB");
  eq(why([...MAGIC, 0x00, 0x00, ...body, 0x00, 0x01, 0x02, 0x03]), "magic", "bytes that are no frame after the last frame");
  eq(why([...MAGIC, 0x00, 0x00, ...body, 0x00]), "truncated", "one byte after the last frame");
  eq(why([...MAGIC, 0x08, 0x00, ...body]), "header", "the reserved bit of the frame header");
  eq(why([...MAGIC, 0x00, 0xB0, ...body]), "header", "a window of 4 GB");
  eq(why([...MAGIC, 0x00, 0xA8, ...body]), "ok", "a window of 2 GB");
  for (const [fhd, id] of [[0x01, [9]], [0x02, [9, 0]], [0x03, [9, 0, 0, 0]]] as [number, number[]][]) eq(why([...MAGIC, fhd, 0x00, ...id, ...body]), "dict", `a dictionary ID of ${id.length} bytes`);
  eq(why([...MAGIC, 0x03, 0x00, 0, 0, 0, 0, ...body]), "ok", "a dictionary ID of 0");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(3, true, 2, text("ok"))]), "block", "the reserved block type");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 2000, Array(2000).fill(0))], 5000), "block", "a compressed block larger than the window");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(0, false, 2, text("ok"))]), "truncated", "no last block");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(0, true, 3, text("ok"))]), "truncated", "a raw block longer than the input");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(1, true, 3, [])]), "truncated", "an RLE block without its byte");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(1, true, 2000, text("x"))]), "output", "an RLE block larger than the output");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 1, [0])]), "literals", "a compressed block of one byte");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 4, [9 << 3, ...text("abc")])]), "literals", "raw literals longer than the block");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 4, [3 << 3, ...text("abc")])]), "seq header", "no sequences section");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 6, [3 << 3, ...text("abc"), 0, 0])]), "seq header", "bytes after a sequences section of no sequences");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 6, [3 << 3, ...text("abc"), 1, 0x01])]), "seq header", "the reserved bits of the modes byte");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 6, [3 << 3, ...text("abc"), 1, 0xC0])]), "seq header", "a repeated table in the frame's first block");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 7, [3 << 3, ...text("abc"), 1, 0x40, 36])]), "seq header", "an RLE literal-length symbol past the last one");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 6, [3 << 3, ...text("abc"), 1, 0x00])]), "seq stream", "sequences without a bitstream");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 7, [3 << 3, ...text("abc"), 1, 0x00, 0x00])]), "seq stream", "a bitstream that ends in a zero byte");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 7, [0x03 | 3 << 4, 0, 0, 0, 0, 0, 0])]), "literals", "a repeated Huffman tree in the frame's first block");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 7, [0x02 | 3 << 4, 1 << 6, 0, 0x80, 0, 0, 0])]), "huf table", "a Huffman tree description cut short");
  eq(why([...MAGIC, 0x00, 0x00, ...blk(2, true, 8, [3 << 3, ...text("abc"), 1, 0x80, 0x00, 0x01])]), "fse table", "an FSE table description of no bytes");
});

// The streams the damage tests work on: small, and between them every part of the format
const SMALL = ["guest:plugin.so", "skewed 16 x 200", "short text", "one byte", "skewed 130 x 900", "flat 2", "two symbols"];

test("zbic: every committed stream cut at every length up to 3000 bytes, and at 200 lengths beyond, is refused; the input ends where memory ends", () => {
  const b = fresh(), END = b.x.memory.buffer.byteLength, why = new Map<string, number>();
  let n = 0;
  for (const s of fixtures()) {
    const lens = new Set<number>([...Array(Math.min(3000, s.comp.length)).keys()]);
    const r = rng(s.comp.length);
    for (let i = 0; i < 200 && s.comp.length > 3000; i++) lens.add(r() % s.comp.length);
    for (const len of lens) {
      const got = decode(b, s.comp.subarray(0, len), s.size, { at: END - len });
      ok(got.n < 0, `${s.name} cut to ${len} of ${s.comp.length} bytes decodes (${got.n} bytes)`);
      why.set(reason(got.n), (why.get(reason(got.n)) ?? 0) + 1); n++;
    }
  }
  console.log(`     ${n} truncations: ${[...why].sort((a, c) => c[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ")}`);
});

test("zbic: every single bit of seven small streams flipped, and 30000 random mutations of all of them: refused or decoded, nothing read or written outside (input at the end of memory, bands around the output)", () => {
  const b = fresh(), END = b.x.memory.buffer.byteLength, list = fixtures(), why = new Map<string, number>();
  const note = (n: number) => { const k = n < 0 ? reason(n) : "decoded"; why.set(k, (why.get(k) ?? 0) + 1); };
  let flips = 0, same_ = 0;
  for (const name of SMALL) {
    const s = list.find(x => x.name === name)!;
    ok(s, `no committed stream ${name}`);
    for (let bit = 0; bit < s.comp.length * 8; bit++, flips++) {
      const m = s.comp.slice(); m[bit >> 3] ^= 1 << (bit & 7);
      const got = decode(b, m, s.size + 4096, { at: END - m.length });
      note(got.n);
      if (got.n === s.size && sha(got.out) === s.sha) same_++;
    }
  }
  const r = rng(0x2B1C);
  const edges = [0, 1, 0x7F, 0x80, 0xFF, 0xFE, 0x20, 0x40];
  for (let i = 0; i < 30000; i++) {
    const s = list[r() % list.length], m = s.comp.slice(0, Math.min(s.comp.length, 60000));
    if (!m.length) continue;
    const near = r() % 3 === 0 ? 40 : m.length;                      // a third aimed at the first block's headers and tables
    for (let k = 1 + r() % 3; k > 0; k--) {
      const at = r() % Math.min(near, m.length);
      switch (r() % 4) {
        case 0: m[at] ^= 1 << (r() % 8); break;
        case 1: m[at] = r(); break;
        case 2: m[at] = edges[r() % edges.length]; break;
        default: m.copyWithin(at, r() % m.length, m.length); break;
      }
    }
    note(decode(b, m, Math.min(s.size + 4096, CAP), { at: END - m.length }).n);
  }
  for (const k of ["magic", "header", "block", "literals", "huf table", "huf stream", "seq header", "fse table", "seq stream", "offset", "output", "size", "truncated"]) ok(why.get(k), `no damaged stream was refused for "${k}"`);
  console.log(`     ${flips} bit flips (${same_} still decode to the same bytes) and 30000 mutations: ${[...why].sort((a, c) => c[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ")}`);
});

// ---- with the reference codec ----
const SCRATCH = join(OUT, "zbic");
const ref = (args: string[]) => execFileSync("python3", [ZBIC_REF, ...args], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], maxBuffer: 1 << 20 });
const SKIP = "     SKIPPED: the zbic package is not installed (python3 -m pip install zbic); the committed streams above are what was tested";

test("zbic, differential: 600 inputs of varied statistics (12 kinds, 0 bytes to 1 MB, levels -7 to 22) compressed by the reference decode to the same bytes", () => {
  if (!haveZbic()) { console.log(SKIP); return; }
  mkdirSync(SCRATCH, { recursive: true });
  const b = fresh();
  b.x.ld_zbic_stats_clear();
  let n = 0, bytes = 0, comp = 0;
  for (const [seed, count, max] of [[101, 250, 300000], [102, 250, 40000], [103, 100, 1000000]]) {
    const pack = join(SCRATCH, `fuzz${seed}.pack`);
    ref(["fuzz", String(seed), String(count), String(max), pack]);
    for (const s of readPack(new Uint8Array(readFileSync(pack)))) {
      const got = decode(b, s.comp, s.size, n % 3 === 0 ? { steps: 50000 } : {});
      eq(reason(got.n), "ok", `${s.name} (level ${s.level}, ${s.size} bytes)`);
      same(got.out, s.raw!, `${s.name} (level ${s.level})`);
      n++; bytes += s.size; comp += s.comp.length;
    }
  }
  const seen = stats(b);
  eq(ZS.filter((nm, i) => !seen[i] && nm !== "skippable frames" && nm !== "checksums"), [], "parts of the format the generated streams did not reach");
  console.log(`     ${n} streams, ${comp} bytes compressed, ${bytes} decoded: ${ZS.map((nm, i) => `${seen[i]} ${nm}`).join(", ")}`);
});

test("zbic, differential: 6000 damaged streams are accepted or refused as the reference does, and what both accept decodes to the same bytes", () => {
  if (!haveZbic()) { console.log(SKIP); return; }
  mkdirSync(SCRATCH, { recursive: true });
  const b = fresh(), pack = join(SCRATCH, "damage.pack");
  ref(["damage", "201", "6000", pack]);
  // One known difference: zstd's fast path for literals in four Huffman streams checks that each stream gives its
  // count of symbols, not that it ends exactly at its end mark (a stream may stop early or run on into the bytes
  // before it), so it decodes some damaged streams to bytes. This decoder holds every stream to its exact end.
  let both = 0, neither = 0, lenient = 0;
  const differ: string[] = [];
  for (const s of readPack(new Uint8Array(readFileSync(pack)))) {
    const got = decode(b, s.comp, 0x400000);
    if (s.refOk && got.n >= 0) { both++; if (got.n !== s.size || sha(got.out) !== s.sha) differ.push(`${s.name}: other bytes (${got.n} for ${s.size})`); }
    else if (!s.refOk && got.n < 0) neither++;
    else if (s.refOk && reason(got.n) === "huf stream") lenient++;
    else differ.push(`${s.name}: the reference ${s.refOk ? "decodes" : "refuses"} it, this decoder ${got.n < 0 ? `refuses it (${reason(got.n)})` : "decodes it"}`);
  }
  eq(differ.slice(0, 10), [], `${differ.length} damaged streams treated differently`);
  ok(both > 100 && neither > 1000, `both sides: ${both} decoded, ${neither} refused`);
  ok(lenient < 0.03 * (both + neither), `${lenient} streams only the reference decodes`);
  console.log(`     ${both + neither + lenient} damaged streams: ${both} decoded by both to the same bytes, ${neither} refused by both, ${lenient} decoded by the reference only (Huffman streams that do not end at their end mark, which its fast path does not check)`);
});

// ---- NSO files with ZBIC segments ----
const flagsOf = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0x0C, true);

for (const names of [["main_zbic.nso", "sdk_zbic.nso"], ["sdk_zbic.nso", "main_zbic.nso"], ["main_zbicpart.nso", "sdk.nso"], ["main_zbicown.nso", "sdk_zbic.nso"]]) {
  test(`zbic nso: load ${names.join(" + ")}: every byte of both images is what the model computes from the ELF files, hashes checked`, () => {
    for (const n of names) if (n.includes("zbic")) ok(flagsOf(file(n)) & 0x80, `${n} has NSO flag bit 7`);
    const b = fresh(), { set, w } = loadSet(b, names);
    checkImages(b, w);
    eq(set.modules.map(m => m.state), ["Relocated", "Relocated"], "states");
    eq(b.x.ld_faults(), 0, "faults");
    if (!haveZbic()) console.log("     the zbic package is not installed: these files were compressed by elf2nso.py itself (--zbic-own)");
  });
}

test("zbic nso: the committed files (the test modules compressed by the reference codec) load with their hashes checked, and are the freshly built modules when the compiler gives the same code", () => {
  const b = fresh(), lines: string[] = [];
  for (const m of ["main", "sdk", "plugin"]) {
    const d = new Uint8Array(readFileSync(join(FIXTURES, m + "_zbic.nso"))), dv = new DataView(d.buffer);
    eq(dv.getUint32(0x0C, true), 0xBF, `${m}: three ZBIC segments, three hashes`);
    for (let i = 0; i < 3; i++) eq(Buffer.from(d.subarray(dv.getUint32(0x10 + 16 * i, true)).subarray(0, 4)).toString(), "ZBIC", `${m}: segment ${i} starts with a ZBIC frame`);
    const h = b.ld.parse(b.put(m, d)), base = b.place(b.ld.info(h).imageSize);
    b.ld.map(h, base);
    const i = b.ld.info(h), elf = readElf(m + ".so");
    eq(i.state, "Mapped", `${m}: state`);
    const fresh_ = Buffer.compare(Buffer.from(b.mem(base, i.imageSize)), Buffer.from(pristineImage({ elf, base }))) === 0;
    lines.push(`${m}: ${d.length} bytes for an image of ${i.imageSize}${fresh_ ? ", the same bytes as today's build" : ", not today's build (another compiler or source): checked by its hashes only"}`);
  }
  eq(b.red(), [], "red lines");
  console.log(lines.map(l => "     " + l).join("\n"));
});

test("zbic nso: refusals: LZ4 segments marked ZBIC, a damaged stream, a wrong size in the header, a flipped bit found by the hash", () => {
  const b = fresh();
  const refused = (name: string, d: Uint8Array, re: RegExp, verifyHash = true) => {
    b.logs.length = 0;
    let err = "";
    try { const h = b.ld.parse(b.put(name, d), { verifyHash }); b.ld.map(h, b.place(b.ld.info(h).imageSize)); } catch (e) { if (!(e instanceof LoaderError)) throw e; err = e.message; }
    ok(re.test(err), `${name}: ${err || "loaded"}`);
  };
  // nxnative's test: flag bit 7 on a module whose segments are LZ4 names ZBIC
  const lz = file("main.nso").slice(); lz[0x0C] |= 0x80;
  refused("lz4 marked zbic", lz, /text segment is marked ZBIC compressed \(NSO flag bit 7\) but does not start with a ZBIC frame/);
  const z = file("main_zbic.nso"), dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const seg = (i: number) => ({ off: dv.getUint32(0x10 + 16 * i, true), stored: dv.getUint32(0x60 + 4 * i, true), size: dv.getUint32(0x18 + 16 * i, true) });
  // the last bytes of the text stream cleared: the sequence bitstream has no end mark
  const cut = z.slice(); cut.fill(0, seg(0).off + seg(0).stored - 3, seg(0).off + seg(0).stored);
  refused("stream damaged", cut, /text segment does not decompress \(damaged ZBIC stream: damaged sequence stream\)/);
  // the frame header's content size and the NSO header disagree
  const small = z.slice(); new DataView(small.buffer).setUint32(0x18 + 16 * 2, seg(2).size - 1, true);
  refused("data size one less", small, /data segment does not decompress \(damaged ZBIC stream: more output than the header's size\)/);
  // elf2nso.py's own streams keep their literals as they are: a flipped bit in the first literal of each segment
  // (after the frame header of 6 or 9 bytes, the block header of 3 and the literals header of 1 to 3) changes one byte
  // of the output and nothing else, so only the hash can find it
  const own = file("main_zbicown.nso"), odv = new DataView(own.buffer, own.byteOffset, own.byteLength);
  const firstLiteral = (i: number) => {
    const at = odv.getUint32(0x10 + 16 * i, true), fh = own[at + 4] === 0x20 ? 6 : 9, lh = own[at + fh + 3];
    eq((own[at + fh] >> 1) & 3, 2, `segment ${i} of main_zbicown.nso starts with a compressed block`);
    eq(lh & 3, 0, `segment ${i}: raw literals`);
    return at + fh + 3 + (!(lh & 4) ? 1 : (lh & 8) ? 3 : 2);
  };
  for (let i = 0; i < 3; i++) {
    const m = own.slice(); m[firstLiteral(i)] ^= 0x10;
    refused(`bit flipped in segment ${i}`, m, /segment does not match its SHA-256 in the header: the file is damaged/);
  }
  // and with the hash checks off the same file loads (as Horizon would), with that one byte different
  const m = own.slice(); m[firstLiteral(0)] ^= 0x10;                // the first instruction of the text: nothing the loader reads
  const h = b.ld.parse(b.put("unchecked", m), { verifyHash: false }), base = b.place(b.ld.info(h).imageSize);
  b.ld.map(h, base);
  eq(b.ld.info(h).state, "Mapped", "the flipped file with hash checks off");
  const img = b.mem(base, b.ld.info(h).imageSize), want = pristineImage({ elf: readElf("main.so"), base });
  eq(img.reduce((n, v, k) => n + (v !== want[k] ? 1 : 0), 0), 1, "bytes of the image that differ");
});
