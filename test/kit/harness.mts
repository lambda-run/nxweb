// The kit's test harness: a test list, fresh wasm instances whose red lines are captured, and the hit bitmaps of
// every instance for the coverage rule (run.mts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDefs, KIT_DIR, type MachineDef } from "../../src/kit/host/defs.mts";
import { readMachines, type KitExports, type WasmMachine } from "../../src/kit/host/reader.mts";

export const ROOT = join(KIT_DIR, "..", "..");
export const WASM = join(ROOT, "build", "kit", "kit_test.wasm");

export interface TestExports extends KitExports {
  m_init(slot: number, machine: number, id: number): void;
  m_step(slot: number, ev: number, arg: number): number;
  m_can(slot: number, ev: number): number;
  m_state(slot: number): number;
  m_data(slot: number): number;
  m_bench(n: number, rounds: number): number;
  hq_init(i: number): void;
  hq_step(i: number, now: number, home: number, a: number, b: number): number;
  hq_cancel(i: number): void;
  hq_phase(i: number): number;
  hq_ring(i: number, now: number): number;
  hq_blocks_input(phase: number): number;
  hq_latch(i: number, which: number): number;
}

export interface Kit { x: TestExports; logs: string[]; machines: WasmMachine[] }

export const defs: MachineDef[] = loadDefs();
export const def = (name: string): MachineDef => {
  const d = defs.find(d => d.name === name);
  if (!d) throw new Error(`no machine ${name}`);
  return d;
};
export const S = (d: MachineDef, s: string) => { const i = d.states.indexOf(s); if (i < 0) throw new Error(`${d.name}: no state ${s}`); return i; };
export const E = (d: MachineDef, e: string) => { const i = d.events.indexOf(e); if (i < 0) throw new Error(`${d.name}: no event ${e}`); return i; };

let module: WebAssembly.Module | undefined;
const live: Kit[] = [];

// A new instance of the test module with coverage on (cover = false: off, and its hits do not count)
export function fresh(cover = true): Kit {
  module ??= new WebAssembly.Module(readFileSync(WASM));
  const logs: string[] = [];
  let x!: TestExports;
  const inst = new WebAssembly.Instance(module, { env: {
    log: (ptr: number, len: number) => { logs.push(Buffer.from(x.memory.buffer, ptr >>> 0, len).toString("utf8")); },
    abort: () => { throw new Error("abort"); },
  } });
  x = inst.exports as unknown as TestExports;
  x.kit_cover_enable(cover ? 1 : 0);
  const kit: Kit = { x, logs, get machines() { return readMachines(x); } };
  if (cover) live.push(kit);
  return kit;
}

// Hit bitmaps, one per machine, OR-ed over every instance fresh() gave out
export function allHits(): Uint8Array[] {
  const sum = defs.map(d => new Uint8Array(d.states.length * d.events.length));
  for (const k of live) k.machines.forEach((m, i) => m.hits.forEach((h, c) => { if (h) sum[i][c] = 1; }));
  return sum;
}

export const tests: { name: string; fn: () => void }[] = [];
export function test(name: string, fn: () => void): void { tests.push({ name, fn }); }
