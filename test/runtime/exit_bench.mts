// node test/runtime/exit_bench.mts [exits] [rounds]   (NX_MEM=32|64, NX_SHARED=1 as the other runners)
// What one exit from translated code costs: a flat guest that makes N trivial SVCs (GetCurrentProcessorNumber, which
// the kernel answers at once) and another that makes N calls of a host function that does nothing, on each clock.
// The figure is the whole round trip (the translator's register write-back, the import, save_ctx, the kernel or the
// handler, load_ctx, back into the loop), the loop's own two instructions included. Needs the modules built
// (npm run rt:build); builds nothing itself.
import { loadEnv, MODE, SHARED } from "./harness.mts";
import { Runtime } from "../../src/glue/rt_runtime.ts";
import { asm, ldr, adr, bne, b, movz, svc, dec, BLR20, MOV_W0_W1, type Item } from "./a64_asm.ts";

const env = loadEnv(), N = Number(process.argv[2] ?? 1_000_000), rounds = Number(process.argv[3] ?? 5);
const BASE = 0x0800_0000;
type Kind = "svc" | "host" | "yield" | "yield90";
const EXIT = [movz(0, 0), svc(0x07)];
// x19 = n; do { <exit> } while (--x19); ExitProcess(0). yield90: beside 90 threads that sleep for ever (what the
// scheduler's scans cost when a process has that many thread records)
function image(n: number, kind: Kind, stub: number): Uint8Array {
  const lits = { n: BigInt(n), stub: BigInt(stub), threads: 90n, ever: 0x7FFF_FFFF_FFFF_FFFFn };
  if (kind === "svc") return asm([ldr(19, "n"), "loop", svc(0x10), dec(19), bne("loop"), ...EXIT], lits);
  if (kind === "host") return asm([ldr(19, "n"), ldr(20, "stub"), "loop", BLR20, dec(19), bne("loop"), ...EXIT], lits);
  const yields: Item[] = [ldr(19, "n"), "loop", movz(0, 0), svc(0x0B), dec(19), bne("loop"), ...EXIT];
  if (kind === "yield") return asm(yields, lits);
  return asm([ldr(21, "threads"), "make", adr(1, "entry"), movz(2, 0), adr(3, "n"), movz(4, 44), movz(5, 1), svc(0x08), MOV_W0_W1, svc(0x09), dec(21), bne("make"),
    ...yields, "entry", ldr(0, "ever"), svc(0x0B), b("entry")], lits);
}
function once(kind: Kind, clock: "deterministic" | "wall", n: number, pollBackoff?: boolean): { ns: number; rt: Runtime } {
  const rt = new Runtime(env.mods, { clock, pollBackoff });
  const stub = kind === "host" ? rt.lateStub("bench_nothing", () => 0) : 0;
  if (!rt.loadFlat(image(n, kind, stub), { base: BASE, entry: BASE, stack_top: BASE + 0x20000 })) throw new Error("load failed: " + rt.logs.slice(-3).join("; "));
  const t0 = performance.now(), r = rt.run(), ms = performance.now() - t0;
  if (r.stop?.kind !== "exit" || r.stop.code !== 0) throw new Error(`${kind}/${clock}: ${r.stop?.fault?.lines[0] ?? r.stop?.kind}`);
  const made = kind === "host" ? rt.stats.hostCalls : rt.stats.svcs - (kind === "yield90" ? 1 + 90 * 3 : 1);
  if (made !== n) throw new Error(`${kind}/${clock}: ${made} exits of ${n}`);
  if (process.env.EXIT_LINES) console.log(`${kind}/${clock}:\n  ` + (rt as any).exitLines?.(3).join("\n  "));
  rt.dispose();
  return { ns: (ms - rt.a64.translateNs / 1e6) * 1e6 / n, rt };
}
const out: string[] = [];
// (the wall-clock rows run without the poll back-off: with it the lone yielder sleeps, which is another measurement)
for (const kind of ["svc", "host", "yield", "yield90"] as const) for (const clock of ["deterministic", "wall"] as const) {
  once(kind, clock, 50_000, false);
  const v: number[] = [];
  for (let i = 0; i < rounds; i++) v.push(once(kind, clock, N, false).ns);
  v.sort((a, b) => a - b);
  out.push(`${kind}/${clock === "wall" ? "wall" : "det"} ${v[0].toFixed(0)} (median ${v[v.length >> 1].toFixed(0)})`);
}
console.log(`exit_bench [${MODE}${SHARED ? "s" : ""}] node ${process.version}, ${N} exits, best of ${rounds}, ns per exit: ${out.join("; ")}`);
