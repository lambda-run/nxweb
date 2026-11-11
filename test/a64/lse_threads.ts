// LSE atomics under real concurrency: several host threads (Node worker_threads) run the same translated guest
// function on one shared memory (test/a64/guests/mt/lse_worker.c: LDADD, CAS, LDUMAX, LDSMIN, SWP, LDSET, LDCLR,
// LDEOR, CASP of 16 bytes). The totals checked at the end only come out when every one of them is atomic.
// Usage: node test/a64/lse_threads.ts [--mem64] [--threads N] [--rounds N]
// The main thread translates (a warm-up call on a scratch block), then hands each thread the compiled core module,
// the helpers and the units' bytes; a thread instantiates them on the shared memory with a table of its own (the
// same indices, so the pc map in the memory serves all of them) and its own CPU state.
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { A64Host, makeMemory64, MEM64_MAX_PAGES } from "../../src/glue/a64_host.ts";
import { A64, HOST_END } from "../../src/glue/rt_layout.ts";

const BASE = 0x0800_0000, DATA = 0x0900_0000, STACKS = 0x0910_0000, STACK = 0x10000;

interface Job { memory: WebAssembly.Memory; mem64: boolean; core: WebAssembly.Module; helpers: WebAssembly.Module; units: { bytes: Uint8Array; tableBase: number }[]; tableLen: number; tid: number; rounds: number; block: number; gate: SharedArrayBuffer; threads: number }

function runThread(j: Job): bigint {
  const table = new WebAssembly.Table({ element: "anyfunc", initial: j.tableLen });
  const env = { memory: j.memory, abort: () => { throw new Error("abort"); } };
  const core = new WebAssembly.Instance(j.core, { env: { memory: j.memory, table, translate: () => { throw new Error("a thread reached code that was not translated"); } } }).exports as any;
  const { staticBase: _b, staticEnd: _e, memory: _m, ...hlp } = new WebAssembly.Instance(j.helpers, { env }).exports as any;
  const stop = (what: string) => () => { throw new Error(what); };
  for (const u of j.units) {
    new WebAssembly.Instance(new WebAssembly.Module(u.bytes as unknown as BufferSource), {
      cpu: core, hlp,
      env: { memory: j.memory, table, svc: stop("svc"), unimpl: (pc: bigint, w: number) => { throw new Error(`unimplemented ${(w >>> 0).toString(16)} at ${pc.toString(16)}`); }, brk: stop("brk"), cntpct: () => 0n,
             table_base: new WebAssembly.Global({ value: "i32", mutable: false }, u.tableBase) },
    });
  }
  core.x0.value = BigInt(j.block); core.x1.value = BigInt(j.rounds); core.x2.value = BigInt(j.tid);
  core.sp.value = BigInt(STACKS + (j.tid + 1) * STACK); core.x30.value = 0xFFFFFFF0n; core.pc.value = BigInt(BASE);
  core.excl_addr.value = -1n;
  // instantiating takes longer than the rounds on a small machine: every thread waits here until all are ready, so they run together
  const gate = new Int32Array(j.gate);
  if (Atomics.add(gate, 0, 1) + 1 === j.threads) { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); }
  else Atomics.wait(gate, 1, 0, 30000);
  while (core.pc.value !== 0xFFFFFFF0n) { core.budget.value = 1 << 30; core.run(); }
  return core.x0.value;
}

if (!isMainThread) {
  try { parentPort!.postMessage({ spins: runThread(workerData as Job) }); } catch (e) { parentPort!.postMessage({ error: String(e) }); }
} else {
  const argv = process.argv.slice(2);
  const num = (n: string, d: number) => argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d;
  const mem64 = argv.includes("--mem64"), threads = num("--threads", 4), rounds = num("--rounds", 200000);
  const x = mem64 ? "64" : "";
  const mod = (f: string) => new WebAssembly.Module(readFileSync(new URL("../../build/a64/" + f, import.meta.url)));
  const helpers = mod(`helpers${x}.shared.wasm`);
  const pages = Math.ceil(Math.max(STACKS + (threads + 2) * STACK, HOST_END) / 65536);
  const memory = mem64 ? makeMemory64({ initial: pages, maximum: MEM64_MAX_PAGES, shared: true }).memory : new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
  const host = new A64Host(mod(`translator${x}.shared.wasm`), helpers, {
    memory, mem64, shared: true, layout: { ...A64, codeRegionLo: BASE },
    imports: { svc: () => {}, unimpl: (pc, w) => { throw new Error(`unimplemented ${(w >>> 0).toString(16)} at ${pc.toString(16)}`); }, brk: () => {}, cntpct: () => 0n },
  });
  const image = readFileSync(new URL("./guests/out/mt_lse_worker.bin", import.meta.url));
  new Uint8Array(memory.buffer).set(image, BASE);
  host.keepBytes = true;
  host.addCode(BASE, image.length);
  const c = host.core as any;
  const dv = new DataView(memory.buffer);
  const START_LO = 0xFFFF_FFFF_FFFF_FF00n;                        // the 128-bit counter starts 256 below a carry
  const init = (block: number) => { new Uint8Array(memory.buffer, block, 128).fill(0); dv.setBigUint64(block + 0x40, START_LO, true); dv.setBigUint64(block + 0x48, 7n, true); };
  // warm-up on a scratch block: translates everything the function reaches
  const SCRATCH = DATA + 0x1000;
  init(SCRATCH);
  c.x0.value = BigInt(SCRATCH); c.x1.value = 50n; c.x2.value = 0n; c.sp.value = BigInt(STACKS + STACK); c.x30.value = 0xFFFFFFF0n; c.pc.value = BigInt(BASE);
  while (c.pc.value !== 0xFFFFFFF0n) { c.budget.value = 1 << 30; c.run(); }
  const units = host.units.map(u => ({ bytes: u.bytes!, tableBase: u.tableBase }));
  init(DATA);
  const gate = new SharedArrayBuffer(8);
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: threads }, (_, tid) => new Promise<{ spins?: bigint; error?: string }>((res) => {
    const job: Job = { memory, mem64, core: host.coreModule, helpers, units, tableLen: host.table.length, tid, rounds, block: DATA, gate, threads };
    const w = new Worker(new URL(import.meta.url), { workerData: job });
    w.once("message", res); w.once("error", e => res({ error: String(e) }));
  })));
  const ms = performance.now() - t0;
  const bad: string[] = [];
  for (const [i, r] of results.entries()) if (r.error) bad.push(`thread ${i}: ${r.error}`);
  const total = BigInt(threads) * BigInt(rounds);
  const eq = (what: string, got: bigint, want: bigint) => { if (got !== want) bad.push(`${what}: got 0x${got.toString(16)}, want 0x${want.toString(16)}`); };
  const u64 = (o: number) => dv.getBigUint64(DATA + o, true);
  // struct shared: add 0, cas 8, umax 0x10, smin 0x18, lock 0x20, add16 0x22, clr32 0x24, plain 0x28, bits 0x30, x 0x38, wide 0x40 (low word first)
  eq("LDADD counter", u64(0), total);
  eq("CAS counter", u64(8), 3n * total);
  eq("LDUMAX", u64(0x10) >> 8n, BigInt(rounds - 1));
  eq("LDSMIN", BigInt.asIntN(64, u64(0x18)), -BigInt(rounds - 1));
  eq("SWP lock released", BigInt(dv.getUint8(DATA + 0x20)), 0n);
  eq("LDADDH counter", BigInt(dv.getUint16(DATA + 0x22, true)), total & 0xFFFFn);
  eq("LDSET / LDCLR (32 bits)", BigInt(dv.getUint32(DATA + 0x24, true)), 0n);
  eq("counter under the SWP lock", u64(0x28), total);
  eq("LDSET / LDCLR (64 bits)", u64(0x30), 0n);
  eq("LDEOR twice", u64(0x38), 0n);
  const wide = (u64(0x48) << 64n) | u64(0x40);
  eq("CASP 128-bit counter", wide, ((7n << 64n) | START_LO) + total);
  const spins = results.reduce((n, r) => n + (r.spins ?? 0n), 0n);
  const mode = `${mem64 ? "memory64" : "memory32"}, shared memory, ${threads} threads x ${rounds} rounds`;
  if (!bad.length && spins === 0n) bad.push("no compare-and-swap was ever retried: the threads did not run at the same time, so nothing was shown (more --rounds)");
  if (bad.length) { console.log(`[RED] FAIL LSE atomics under concurrency (${mode})`); for (const b of bad) console.log("       " + b); process.exit(1); }
  console.log(`ok   LSE atomics under concurrency (${mode}): 11 totals exact, ${spins} retries of a compare-and-swap or the lock, ${ms.toFixed(0)} ms`);
  process.exit(0);
}
