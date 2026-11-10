// npm run loader:zbic-bench: how fast the ZBIC decoder (src/loader/zbic.ts in build/loader/loader.wasm) is, in Node
// and in headless Chromium. Needs the reference codec to make the streams (python3 -m pip install zbic).
//
// Inputs, none of them from a game:
//   code      the AArch64 code this repository builds for its own tests (the ELF files under build/: the runtime's
//             and the loader's test guests, the a64 guests, the Doom guest when it was built), as it is
//   code100   100 MB made of copies of `code`, each copy with other low bits in a third of its words (other
//             immediates and registers), so that no copy is a plain repeat of the one before
//   text      generated text of a small vocabulary (literals in Huffman streams, short matches)
//   noise     random bytes (raw blocks: the floor of what a stream can cost)
// For each: the compressed size at levels 3 and 19 (code100: level 3 only), MB of output per second (best of 5), and
// for code100 the time of the whole segment, which is what the page waits for when it unpacks a main module.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build, ROOT, WASM } from "../../src/loader/host/build.mts";

process.chdir(ROOT);
const OUT = join(ROOT, "build", "loader", "zbic");
const REF = join(ROOT, "test", "loader", "zbic_ref.py");
mkdirSync(OUT, { recursive: true });
build();
try { execFileSync("python3", [REF, "check"]); } catch { console.error("[RED] loader:zbic-bench: the zbic package is not installed (python3 -m pip install zbic)"); process.exit(1); }

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0); };
}
// the executable segments of the ELF files this repository's tests build
function ownCode(): Uint8Array {
  const parts: Uint8Array[] = [];
  const dirs = ["build/runtime/guests", "build/loader/guests", "build/doom", "test/a64/guests/out", "test/a64/guests/out_big", "build/prepare/scratch"].map(d => join(ROOT, d));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!/\.(so|elf)$/.test(f) || !statSync(join(dir, f)).isFile()) continue;
      const d = new Uint8Array(readFileSync(join(dir, f))), dv = new DataView(d.buffer, d.byteOffset, d.length);
      if (d.length < 0x40 || dv.getUint32(0, true) !== 0x464C457F || dv.getUint16(0x12, true) !== 183) continue;
      const phoff = Number(dv.getBigUint64(0x20, true)), phentsize = dv.getUint16(0x36, true), phnum = dv.getUint16(0x38, true);
      for (let i = 0; i < phnum; i++) {
        const p = phoff + i * phentsize;
        if (dv.getUint32(p, true) === 1 && (dv.getUint32(p + 4, true) & 1)) parts.push(d.subarray(Number(dv.getBigUint64(p + 8, true)), Number(dv.getBigUint64(p + 8, true)) + Number(dv.getBigUint64(p + 0x20, true)) & ~3));
      }
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const code = ownCode();
if (code.length < 100000) { console.error(`[RED] loader:zbic-bench: only ${code.length} bytes of test code under build/ (run npm run rt:test first: it builds the guests)`); process.exit(1); }
function code100(): Uint8Array {
  const out = new Uint8Array(100 << 20), r = rng(100), w = new Uint32Array(out.buffer), src = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + (code.length & ~3)));
  for (let i = 0; i < w.length; i++) {
    const copy = Math.floor(i / src.length), v = src[i % src.length];
    w[i] = copy && r() % 3 === 0 ? v ^ (r() & (r() & 1 ? 0x1F : 0x3FFC00)) : v;
  }
  return out;
}
function text(n: number): Uint8Array {
  const r = rng(5), vocab = Array.from({ length: 2000 }, () => Array.from({ length: 2 + r() % 8 }, () => "etaoinshrdlucmfwypvbgkqjxz"[Math.min(25, Math.floor(-Math.log((r() + 1) / 2 ** 32) * 5))]).join(""));
  const out = new Uint8Array(n); let at = 0;
  while (at < n) { const s = vocab[Math.min(1999, Math.floor(-Math.log((r() + 1) / 2 ** 32) * 300))] + " "; for (let i = 0; i < s.length && at < n; i++) out[at++] = s.charCodeAt(i); }
  return out;
}
const noise = (n: number) => { const r = rng(9), o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = r(); return o; };

interface Row { name: string; level: number; raw: Uint8Array; comp: Uint8Array }
const rows: Row[] = [];
for (const [name, raw, levels] of [["code", code, [3, 19]], ["code100", code100(), [3]], ["text", text(20 << 20), [3, 19]], ["noise", noise(8 << 20), [3]]] as [string, Uint8Array, number[]][]) {
  const rawFile = join(OUT, `bench-${name}.bin`);
  writeFileSync(rawFile, raw);
  for (const level of levels) {
    const pack = join(OUT, `bench-${name}-${level}.pack`);
    execFileSync("python3", [REF, "pack", String(level), pack, rawFile], { stdio: ["ignore", "inherit", "inherit"] });
    const d = readFileSync(pack), dv = new DataView(d.buffer, d.byteOffset, d.length), nl = dv.getUint32(0, true) & 0x3FFFFFFF, cl = dv.getUint32(12, true);
    rows.push({ name, level, raw, comp: new Uint8Array(d.subarray(48 + nl, 48 + nl + cl)) });
  }
}

// ---- the measurement, the same function in Node and in the page ----
const measure = async (wasm: BufferSource, comp: Uint8Array, size: number, rounds: number): Promise<{ ms: number[]; ok: boolean; sum: string; stepMs: number; steps: number }> => {
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log() {}, abort() { throw new Error("abort"); } } });
  const x = instance.exports as any, SRC = 0x100000, DST = SRC + ((comp.length + 0xFFFF) & ~0xFFFF);
  x.memory.grow(Math.ceil((DST + size + 0x10000 - x.memory.buffer.byteLength) / 65536));
  new Uint8Array(x.memory.buffer).set(comp, SRC);
  const ms: number[] = [];
  let ok = true;
  for (let i = 0; i < rounds; i++) { const t = performance.now(); const n = x.ld_zbic(SRC, comp.length, DST, size); ms.push(performance.now() - t); ok &&= n === size; }
  // in steps of 4 MB, as the page does: the longest single step
  x.ld_zbic_begin(SRC, comp.length, DST, size);
  let stepMs = 0, steps = 0;
  for (let r = 1; r > 0; steps++) { const t = performance.now(); r = x.ld_zbic_step(4 << 20); stepMs = Math.max(stepMs, performance.now() - t); }
  return { ms, ok, sum: x.ld_xxh64(DST, size).toString(16), stepMs, steps };
};

const wasm = readFileSync(WASM);
const table: string[] = [];
const line = (where: string, r: Row, m: Awaited<ReturnType<typeof measure>>, want: string) => {
  const best = Math.min(...m.ms), mb = r.raw.length / (1 << 20);
  if (!m.ok || m.sum !== want) { console.error(`[RED] loader:zbic-bench: ${where}: ${r.name} level ${r.level} does not decode to its input`); process.exitCode = 1; }
  table.push(`${where.padEnd(9)} ${r.name.padEnd(8)} level ${String(r.level).padStart(2)}  ${mb.toFixed(1).padStart(6)} MB from ${(r.comp.length / (1 << 20)).toFixed(2).padStart(6)} MB (${(100 * r.comp.length / r.raw.length).toFixed(1).padStart(5)} %)  ${(mb / best * 1000).toFixed(0).padStart(5)} MB/s  whole: ${best.toFixed(0).padStart(5)} ms  longest 4 MB step: ${m.stepMs.toFixed(1)} ms (${m.steps} steps)`);
};
// what each must decode to: XXH64 of the input, by the module itself
const sums = new Map<Row, string>();
{
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log() {}, abort() {} } });
  const x = instance.exports as any;
  x.memory.grow(Math.ceil(((101 << 20) + 0x200000) / 65536));
  for (const r of rows) { new Uint8Array(x.memory.buffer).set(r.raw, 0x100000); sums.set(r, x.ld_xxh64(0x100000, r.raw.length).toString(16)); }
}
for (const r of rows) line(`node ${process.versions.node.split(".")[0]}`, r, await measure(wasm, r.comp, r.raw.length, 5), sums.get(r)!);

const { chromium } = createRequire(import.meta.url)("playwright");
const server = createServer((req, res) => {
  const m = /^\/row\/(\d+)$/.exec(req.url ?? "");
  if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>zbic bench</title>"); }
  else if (req.url === "/loader.wasm") { res.writeHead(200, { "Content-Type": "application/wasm" }); res.end(wasm); }
  else if (m) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(rows[+m[1]].comp); }
  else { res.writeHead(404); res.end(); }
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${(server.address() as any).port}/`);
  for (const [i, r] of rows.entries()) {
    const m = await page.evaluate(`(async () => { const measure = ${measure.toString()}; const [w, c] = await Promise.all([fetch("/loader.wasm"), fetch("/row/${i}")].map(p => p.then(r => r.arrayBuffer()))); return measure(w, new Uint8Array(c), ${r.raw.length}, 5); })()`);
    line(`chromium ${browser.version().split(".")[0]}`, r, m, sums.get(r)!);
  }
} finally { await browser.close(); server.close(); }
console.log(`loader:zbic-bench: ${code.length} bytes of this repository's own test code under build/\n` + table.join("\n"));
