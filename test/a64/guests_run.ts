// Gate 2 runner: run every test guest (shared corpus + test/a64/guests/out) through the translator
// and compare stdout + exit code with the expected output.
// Usage: node guests_run.ts [--budget N] [--only REGEX] [--maxinsns N] [--nofma] [--speed] [--json]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { A64Host } from "../../src/glue/a64_host.ts";

const root = new URL("../../", import.meta.url).pathname;
const argv = process.argv.slice(2);
function opt(name: string, def: string | null = null): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const budget = Number(opt("--budget", String(1 << 30)));
const only = opt("--only") ? new RegExp(opt("--only")!) : null;
const maxInsns = Number(opt("--maxinsns", "1500"));
const maxFuncs = Number(opt("--maxfuncs", "48"));
const fma = !argv.includes("--nofma");
const speed = argv.includes("--speed");
const quiet = argv.includes("--quiet");
const translator = readFileSync(join(root, "build/a64/translator.wasm"));

interface Result { name: string; ok: boolean; why: string; insns: number; runMs: number; trMs: number; trInsns: number; funcs: number; bytes: number; slices: number }

function runGuest(dir: string, file: string): Result {
  const side = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const image = readFileSync(join(dir, side.image));
  const expected = readFileSync(join(dir, side.expected_stdout));
  const base: number = side.base, stackTop: number = side.stack_top;
  const top = Math.max(stackTop, side.bss_end ?? 0, base + image.length);
  const mapSize = (image.length + 0xFFF) & ~0xFFF;
  const pcmapBase = base - mapSize - 0x10000;
  const memory = new WebAssembly.Memory({ initial: Math.ceil((top + 0x10000) / 65536) });
  const out: number[] = [];
  let exitCode: number | null = null;
  let tick = 0n;
  let fault = "";
  const host: A64Host = new A64Host(translator, {
    memory, pcmapBase, codeLo: base, mapSize, maxInsns, maxFuncs, fma,
    imports: {
      svc: (n: number) => {
        const c = host.core as any;
        if (n === 0x27) {
          const p = Number(c.x0.value & 0xFFFFFFFFn), l = Number(c.x1.value & 0xFFFFFFFFn);
          const m = new Uint8Array(memory.buffer, p, l);
          for (let i = 0; i < l; i++) out.push(m[i]);
          c.x0.value = 0n;
        } else if (n === 0x07) {
          exitCode = Number(c.x0.value & 0xFFFFFFFFn);
          c.pc.value = 0xFFFFFFF0n;
        } else if (n === 0x1E) {
          c.x0.value = tick; tick += 1000n;
        } else { fault = "unknown svc 0x" + n.toString(16); c.pc.value = 0xFFFFFFF0n; }
      },
      unimpl: (pc: bigint, insn: number) => { fault = `unimplemented insn ${(insn >>> 0).toString(16).padStart(8, "0")} at 0x${pc.toString(16)}`; },
      brk: (pc: bigint, imm: number) => { fault = `brk #${imm} at 0x${pc.toString(16)}`; },
      cntpct: () => { tick += 1000n; return tick; },
    },
  });
  new Uint8Array(memory.buffer).set(image, base);
  host.setCode(BigInt(base), image);
  const c = host.core as any;
  c.sp.value = BigInt(stackTop);
  c.x30.value = 0xFFFFFFF0n;
  c.pc.value = BigInt(side.entry);
  let slices = 0;
  const t0 = performance.now();
  try {
    while (true) {
      c.budget.value = budget;
      c.run();
      slices++;
      if (fault) break;
      if (c.pc.value >= 0xFFFFFF00n) break;
    }
  } catch (e) {
    fault = "trap: " + String(e) + ` (pc=0x${c.pc.value.toString(16)})`;
  }
  const total = performance.now() - t0;
  if (exitCode === null) exitCode = Number(c.x0.value & 0xFFFFFFFFn);
  const got = Buffer.from(out);
  let why = "";
  if (fault) why = fault;
  else if (!got.equals(expected)) {
    let i = 0;
    while (i < got.length && i < expected.length && got[i] === expected[i]) i++;
    const ls = expected.lastIndexOf(10, i - 1) + 1;
    why = `stdout differs at byte ${i}: expected ${JSON.stringify(expected.subarray(ls, ls + 100).toString())} got ${JSON.stringify(got.subarray(ls, ls + 100).toString())}`;
  } else if (side.exit_code !== undefined && exitCode !== side.exit_code) why = `exit code ${exitCode}, expected ${side.exit_code}`;
  const trMs = host.translateNs / 1e6;
  return { name: file.replace(/\.json$/, ""), ok: why === "", why, insns: side.insn_count ?? 0, runMs: total - trMs, trMs, trInsns: host.translatedInsns, funcs: host.translatedFuncs, bytes: host.moduleBytes, slices };
}

const dirs = [join(root, "test/guests/out"), join(root, "test/a64/guests/out")].filter(existsSync);
let pass = 0, failn = 0;
let totInsns = 0, totRun = 0, totTr = 0, totTrInsns = 0;
if (!quiet) console.log(`budget=${budget} maxInsns=${maxInsns} fma=${fma}`);
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "manifest.json").sort()) {
    if (only && !only.test(f)) continue;
    let r: Result;
    try { r = runGuest(dir, f); } catch (e) { r = { name: f, ok: false, why: "runner: " + String(e), insns: 0, runMs: 0, trMs: 0, trInsns: 0, funcs: 0, bytes: 0, slices: 0 }; }
    if (r.ok) pass++; else failn++;
    totInsns += r.insns; totRun += r.runMs; totTr += r.trMs; totTrInsns += r.trInsns;
    if (speed) {
      console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(24)} insns=${String(r.insns).padStart(10)} run=${r.runMs.toFixed(1).padStart(8)}ms ${(r.insns / r.runMs / 1000).toFixed(1).padStart(8)} Minsn/s  translate=${r.trMs.toFixed(1).padStart(7)}ms for ${String(r.trInsns).padStart(6)} insns (${(r.trMs * 1000 / Math.max(1, r.trInsns)).toFixed(2)} us/insn, ${r.funcs} funcs, ${r.bytes} B) slices=${r.slices}`);
    } else if (!quiet || !r.ok) {
      console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}${r.ok ? "" : "  " + r.why}`);
    }
  }
}
console.log(`guests: ${pass} passed, ${failn} failed`);
if (speed) console.log(`total: ${totInsns} guest insns in ${totRun.toFixed(0)} ms run = ${(totInsns / totRun / 1000).toFixed(1)} Minsn/s; translated ${totTrInsns} insns in ${totTr.toFixed(0)} ms = ${(totTr * 1000 / totTrInsns).toFixed(2)} us/insn (includes wasm compile+instantiate)`);
process.exit(failn ? 1 : 0);
