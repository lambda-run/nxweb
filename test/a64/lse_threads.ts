// LSE atomics under real concurrency: several host threads (Node worker_threads) run the same translated guest
// function on one shared memory (test/a64/guests/mt/lse_worker.c: LDADD, CAS, LDUMAX, LDSMIN, SWP, LDSET, LDCLR,
// LDEOR, CASP of 16 bytes). The totals checked at the end only come out when every one of them is atomic.
// Usage: node test/a64/lse_threads.ts [--mem64] [--threads N] [--rounds N] [--misaligned]
// --misaligned: the same with a hand-assembled function (MISALIGNED below) whose counters sit at addresses that are
// not multiples of their size: a wasm atomic instruction traps there, so the translated code runs them under its
// lock (src/a64/int.ts slowEnter). The totals only come out when that path is atomic between the threads too.
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

// x0 = block, x1 = rounds, x2 = thread; returns the number of retries (a failed CAS, STXR or CASP)
const MISALIGNED = [
  0xD2800009, 0x52800023,                                                               // 00 mov x9, #0; mov w3, #1
  0x91000404, 0xB8230085,                                                               // 08 loop: ldadd w3, w5, [x0, 1]
  0x91008404, 0x78230085,                                                               // 10 ldaddh w3, w5, [x0, 0x21]
  0x91003404, 0xF9400085, 0xAA0503E6, 0x91000CA7, 0xC8A67C87, 0xEB0500DF, 0x54000060, 0x91000529, 0x17FFFFF9,   // 18 x4 = x0 + 0xd; 1c: a 64-bit CAS loop adding 3 (over an 8-byte boundary)
  0x913FF804, 0x885F7C85, 0x110004A5, 0x88067C85, 0x34000066, 0x91000529, 0x17FFFFFB,   // 3c x4 = x0 + 0xffe; 40: a 32-bit LDXR / STXR loop adding 1 (over a page boundary)
  0x91040404, 0xB8230085,                                                               // 58 ldadd w3, w5, [x0, 0x101]
  0x91040004, 0x38230085, 0x91041404, 0x38230085, 0x91042004, 0xB8230085,               // 60 its neighbours with aligned atomics: ldaddb at 0x100 and 0x105, ldadd w at 0x108
  0x91080C04, 0xF8230085, 0xC85F7C85, 0x910004A5, 0xC8067C85, 0x34000066, 0x91000529, 0x17FFFFFB,   // 78 x4 = x0 + 0x203: ldadd x, then an LDXR / STXR loop on the same 64 bits
  0x910C0404, 0xA9402C8A, 0xAA0A03EC, 0xAA0B03ED, 0xB100054E, 0x9A1F016F, 0x482C7C8E, 0xEB0A019F, 0xFA4B01A0, 0x54000060, 0x91000529, 0x17FFFFF6,   // 98 x4 = x0 + 0x301; 9c: a 128-bit CASP loop adding 1
  0xF1000421, 0x54FFF9E1, 0xAA0903E0, 0xD65F03C0,                                       // c8 subs x1, x1, #1; b.ne loop; mov x0, x9; ret
];

if (!isMainThread) {
  try { parentPort!.postMessage({ spins: runThread(workerData as Job) }); } catch (e) { parentPort!.postMessage({ error: String(e) }); }
} else {
  const argv = process.argv.slice(2);
  const num = (n: string, d: number) => argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d;
  const mis = argv.includes("--misaligned");
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
  const image = mis ? new Uint8Array(new Uint32Array(MISALIGNED).buffer) : readFileSync(new URL("./guests/out/mt_lse_worker.bin", import.meta.url));
  new Uint8Array(memory.buffer).set(image, BASE);
  host.keepBytes = true;
  host.addCode(BASE, image.length);
  const c = host.core as any;
  const dv = new DataView(memory.buffer);
  const START_LO = 0xFFFF_FFFF_FFFF_FF00n;                        // the 128-bit counter starts 256 below a carry
  const init = (block: number) => {
    if (mis) { new Uint8Array(memory.buffer, block, 0x1100).fill(0); dv.setBigUint64(block + 0x301, START_LO, true); dv.setBigUint64(block + 0x309, 7n, true); return; }
    new Uint8Array(memory.buffer, block, 128).fill(0); dv.setBigUint64(block + 0x40, START_LO, true); dv.setBigUint64(block + 0x48, 7n, true);
  };
  // warm-up on a scratch block: translates everything the function reaches
  const SCRATCH = DATA + 0x4000;
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
  const spins = results.reduce((n, r) => n + (r.spins ?? 0n), 0n);
  if (mis) {
    eq("LDADD, 32 bits at +1", BigInt(dv.getUint32(DATA + 1, true)), total & 0xFFFFFFFFn);
    eq("LDADDH at +0x21", BigInt(dv.getUint16(DATA + 0x21, true)), total & 0xFFFFn);
    eq("CAS loop, 64 bits at +0xd", u64(0xD), 3n * total);
    eq("LDXR / STXR loop, 32 bits at +0xffe (over a page boundary)", BigInt(dv.getUint32(DATA + 0xFFE, true)), total & 0xFFFFFFFFn);
    eq("LDADD, 32 bits at +0x101", BigInt(dv.getUint32(DATA + 0x101, true)), total & 0xFFFFFFFFn);
    eq("its neighbour: LDADDB at +0x100", BigInt(dv.getUint8(DATA + 0x100)), total & 0xFFn);
    eq("its neighbour: LDADDB at +0x105", BigInt(dv.getUint8(DATA + 0x105)), total & 0xFFn);
    eq("its neighbour: LDADD, 32 bits at +0x108", BigInt(dv.getUint32(DATA + 0x108, true)), total & 0xFFFFFFFFn);
    eq("LDADD and LDXR / STXR on the same 64 bits at +0x203", u64(0x203), 2n * total);
    eq("CASP 128-bit counter at +0x301", (u64(0x309) << 64n) | u64(0x301), ((7n << 64n) | START_LO) + total);
    eq("the lock word afterwards", BigInt(dv.getUint32(A64.helpersEnd - 16, true)), 0n);
    const slow = host.misalignedAtomics, modeM = `${mem64 ? "memory64" : "memory32"}, shared memory, ${threads} threads x ${rounds} rounds`;
    if (!bad.length && slow < Number(total)) bad.push(`only ${slow} accesses took the lock path`);
    if (!bad.length && spins === 0n) bad.push("no compare-and-swap or store-exclusive was ever retried: the threads did not run at the same time, so nothing was shown (more --rounds)");
    if (bad.length) { console.log(`[RED] FAIL atomics at misaligned addresses under concurrency (${modeM})`); for (const b of bad) console.log("       " + b); process.exit(1); }
    console.log(`ok   atomics at misaligned addresses under concurrency (${modeM}): 10 totals exact, ${spins} retries, at least ${slow} accesses on the lock path (a 32-bit count), ${ms.toFixed(0)} ms`);
    process.exit(0);
  }
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
  const mode = `${mem64 ? "memory64" : "memory32"}, shared memory, ${threads} threads x ${rounds} rounds`;
  if (!bad.length && spins === 0n) bad.push("no compare-and-swap was ever retried: the threads did not run at the same time, so nothing was shown (more --rounds)");
  if (bad.length) { console.log(`[RED] FAIL LSE atomics under concurrency (${mode})`); for (const b of bad) console.log("       " + b); process.exit(1); }
  console.log(`ok   LSE atomics under concurrency (${mode}): 11 totals exact, ${spins} retries of a compare-and-swap or the lock, ${ms.toFixed(0)} ms`);
  process.exit(0);
}
