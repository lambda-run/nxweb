// Gate 2 core, shared by the Node runner (guests_run.ts) and the browser worker: run one test guest
// through the translator per the contract's test ABI and compare stdout + exit code.
import { A64Host } from "../../src/glue/a64_host.ts";

export interface GuestOpts { budget: number; maxInsns: number; maxFuncs: number; fma: boolean; nanFix: boolean; tailCalls: boolean; depthLimit: number }
export const defaultOpts: GuestOpts = { budget: 1 << 30, maxInsns: 1500, maxFuncs: 48, fma: true, nanFix: true, tailCalls: true, depthLimit: 160 };
export interface Result {
  name: string; ok: boolean; why: string; insns: number; runMs: number; trMs: number; trOnlyMs: number; trInsns: number;
  funcs: number; bytes: number; slices: number; tableLen: number;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const dec = new TextDecoder();

export function runGuest(translator: BufferSource | WebAssembly.Module, helpers: BufferSource | WebAssembly.Module, name: string,
                         side: any, image: Uint8Array, expected: Uint8Array, o: GuestOpts): Result {
  const base: number = side.base, stackTop: number = side.stack_top;
  const top = Math.max(stackTop, side.bss_end ?? 0, base + image.length);
  const mapSize = (image.length + 0xFFF) & ~0xFFF;
  const pcmapBase = base - mapSize - 0x10000;
  const memory = new WebAssembly.Memory({ initial: Math.ceil((top + 0x10000) / 65536) });
  const out: number[] = [];
  let exitCode: number | null = null;
  let tick = 0n;
  let fault = "";
  const host: A64Host = new A64Host(translator, helpers, {
    memory, pcmapBase, codeLo: base, mapSize, maxInsns: o.maxInsns, maxFuncs: o.maxFuncs, fma: o.fma, nanFix: o.nanFix,
    tailCalls: o.tailCalls, depthLimit: o.depthLimit,
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
      c.budget.value = o.budget;
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
  const got = Uint8Array.from(out);
  if ((globalThis as any).A64_DUMP) (globalThis as any).A64_DUMP(got);
  let why = "";
  if (fault) why = fault;
  else if (!eq(got, expected)) {
    let i = 0;
    while (i < got.length && i < expected.length && got[i] === expected[i]) i++;
    const ls = expected.lastIndexOf(10, i - 1) + 1;
    why = `stdout differs at byte ${i}: expected ${JSON.stringify(dec.decode(expected.subarray(ls, ls + 100)))} got ${JSON.stringify(dec.decode(got.subarray(ls, ls + 100)))}`;
  } else if (side.exit_code !== undefined && exitCode !== side.exit_code) why = `exit code ${exitCode}, expected ${side.exit_code}`;
  const trMs = host.translateNs / 1e6;
  return { name, ok: why === "", why, insns: side.insn_count ?? 0, runMs: total - trMs, trMs, trOnlyMs: host.translatorNs / 1e6,
           trInsns: host.translatedInsns, funcs: host.translatedFuncs, bytes: host.moduleBytes, slices, tableLen: host.table.length };
}

export function speedLine(r: Result): string {
  return `${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(24)} insns=${String(r.insns).padStart(10)} run=${r.runMs.toFixed(1).padStart(8)}ms ${(r.insns / r.runMs / 1000).toFixed(1).padStart(8)} Minsn/s  translate=${r.trMs.toFixed(1).padStart(7)}ms for ${String(r.trInsns).padStart(6)} insns (${(r.trMs * 1000 / Math.max(1, r.trInsns)).toFixed(2)} us/insn, translator alone ${(r.trOnlyMs * 1000 / Math.max(1, r.trInsns)).toFixed(3)}, ${r.funcs} funcs, ${r.bytes} B) slices=${r.slices}`;
}
export function totalLine(rs: Result[]): string {
  let insns = 0, run = 0, tr = 0, trI = 0, trO = 0;
  for (const r of rs) { insns += r.insns; run += r.runMs; tr += r.trMs; trI += r.trInsns; trO += r.trOnlyMs; }
  return `total: ${insns} guest insns in ${run.toFixed(0)} ms run = ${(insns / run / 1000).toFixed(1)} Minsn/s; translated ${trI} insns in ${tr.toFixed(0)} ms = ${(tr * 1000 / trI).toFixed(2)} us/insn including wasm compile+instantiate, translator alone ${trO.toFixed(0)} ms = ${(trO * 1000 / trI).toFixed(3)} us/insn`;
}
