// The proof of the lock-free recording path (kernel/nx_gfx.c, tools/gfx_audit.mjs): nxweb's recorder on its own, no game.
// T command buffers, each with its own command memory. The same sequence of recording commands is written
//   A. into each of them by one thread, one after the other (the first instance of the recorder), and
//   B. into T further ones by T workers at the same time, each through its own instance of the recorder, with no lock;
// the command memory of every buffer of B must be byte for byte that of A. Every command used must be one the audit
// lets through without the lock. node em/test/gfx_lockfree_test.mts [dir with gfx64.wasm]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { globalsToMemory, writeGlobalInits } from "../tools/globals_to_memory.mjs";
import { lockFreeTable } from "../tools/gfx_audit.mjs";

const PAGES = 8192, GLOBALS = 0x1FF10000, T = 6, N = 1200, MEM = 256 * 1024;   // (N = 1500 runs the buffers out of room: the allocator's slow path then runs, which is exactly what must stay under the lock; 4 of 6 buffers came out different)
const SEQ = ["nvnCommandBufferSetScissor", "nvnCommandBufferSetStencilRef", "nvnCommandBufferSetStencilMask", "nvnCommandBufferSetStencilValueMask", "nvnCommandBufferBindVertexBuffer", "nvnCommandBufferBindProgram"];
// the arguments of step k of the sequence for command j (x1..x4; x0 is the command buffer)
const argsOf = (j: number, k: number): bigint[] => [[k, k + 1, 100 + (k & 63), 200], [1, k & 255], [3, k & 255], [2, (k * 7) & 255], [k & 3, 0x40000000 + 64 * k, 4096], [0x50000000 + 256 * (k & 15), 3]][j].map(BigInt);
function record(call: (id: number, args: number) => unknown, u64: BigUint64Array, args: number, ids: number[], c: number): void {
  for (let k = 0; k < N; k++) for (let j = 0; j < ids.length; j++) { const a = argsOf(ids.length === 1 ? Number(process.env.NX_ONLY) : j, k); u64[args / 8] = BigInt(c); for (let i = 0; i < a.length; i++) u64[args / 8 + 1 + i] = a[i]; call(ids[j], args); }
}
if (!isMainThread) {
  const { memory, wasm, ids, c, args } = workerData, pages = PAGES;
  const env = { memory, memory_size: () => pages, memory_grow: () => -1, log: () => {}, abort: () => { throw new Error("abort"); }, gfx_exec: () => {}, gfx_proc_address: () => 0n, gfx_arena_more: () => 0,
    gfx_guest_call: () => { throw new Error("the recorder called back into the guest: the slow path ran without the lock"); } };
  const x: any = new WebAssembly.Instance(new WebAssembly.Module(wasm), { env }).exports;
  const gate = new Int32Array(memory.buffer, 0x1F000000, 2);
  Atomics.add(gate, 0, 1); Atomics.wait(gate, 1, 0);   // every worker starts its recording at the same moment
  record((id, a) => x.nvn_call(id, BigInt(a)), new BigUint64Array(memory.buffer), args, ids, c);
  parentPort!.postMessage(0);
} else {
  const { sharedBuild } = await import("../../src/glue/wasm_shared.ts"), { instantiate } = await import("../../src/glue/wasm_abi.ts"), { range } = await import("../../src/glue/rt_layout.ts");
  const dir = process.argv[2] ?? "/mnt/build/web/wasm", plain = sharedBuild(readFileSync(`${dir}/gfx64.wasm`), PAGES);
  const memory = new WebAssembly.Memory({ initial: BigInt(PAGES), maximum: BigInt(PAGES), shared: true, address: "i64" } as any);
  const first = globalsToMemory(plain, { base: GLOBALS }), second = globalsToMemory(plain, { base: GLOBALS, secondary: true });
  writeGlobalInits(memory, first.globals);
  const lines: string[] = [], dec = new TextDecoder();
  const env = { memory, memory_size: () => PAGES, memory_grow: () => -1, abort: () => { throw new Error("abort"); }, log: (p: number, n: number) => lines.push(dec.decode(new Uint8Array(memory.buffer).slice(p, p + n))),
    gfx_exec: () => {}, gfx_proc_address: () => 0n, gfx_arena_more: (n: number) => { const at = tables; tables += ((n >>> 0) + 0xFFFF) & ~0xFFFF; return at; }, gfx_guest_call: () => 0n };
  let tables = 0x18000000;   // the recorder's tables beyond its arena (fresh memory: zero)
  const x: any = instantiate(new WebAssembly.Module(first.wasm as any), { env }, { mem64: true, name: "gfx64.wasm" });
  const arena = range("gfx arena"), u8 = new Uint8Array(memory.buffer), u64 = new BigUint64Array(memory.buffer);
  let bad = 0; const check = (ok: boolean, what: string) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) bad++; };
  check(!!x.gfx_init(arena.lo, x.gfx_arena_bytes()), "the recorder starts on a shared 64-bit memory with its globals in the memory");
  x.kit_trace_enable(0);
  const nameOf = (id: number) => { const p = x.nvn_name(id); let e = p; while (u8[e]) e++; return String.fromCharCode(...u8.slice(p, e)); };
  const tab = lockFreeTable(plain, nameOf, x.nvn_count()), idOf = new Map<string, number>(); for (let id = 0; id < x.nvn_count(); id++) idOf.set(nameOf(id), id);
  const only = process.env.NX_ONLY;   // one command of the sequence alone (to find which one differs)
  const ids = SEQ.map(n => idOf.get(n)!).filter((_, j) => only === undefined || j === Number(only));
  check(ids.every(id => tab.table[id] === 3), `the audit lets every command of the sequence through without the lock while there is room (${tab.free} free, ${tab.room} with room, of ${tab.cases} cases)`);
  // objects, by the game's calls (under "the lock": this thread alone)
  let bump = 0x10000000; const alloc = (n: number) => { const a = bump; bump += (n + 4095) & ~4095; u8.fill(0, a, a + n); return a; };
  const ARGS = alloc(4096), call = (name: string, ...a: (number | bigint)[]) => { a.forEach((v, i) => u64[ARGS / 8 + i] = BigInt(v)); return x.nvn_call(idOf.get(name)!, ARGS); };
  const devb = alloc(64), dev = alloc(64); call("nvnDeviceBuilderSetDefaults", devb); call("nvnDeviceBuilderSetFlags", devb, 0); call("nvnDeviceInitialize", dev, devb);
  const bufs: { c: number; mem: number }[] = [];
  for (let i = 0; i < 2 * T; i++) {
    const pb = alloc(64), pool = alloc(64), mem = alloc(MEM), c = alloc(256), ctl = alloc(4096);
    call("nvnMemoryPoolBuilderSetDefaults", pb); call("nvnMemoryPoolBuilderSetDevice", pb, dev); call("nvnMemoryPoolBuilderSetStorage", pb, mem, MEM); call("nvnMemoryPoolBuilderSetFlags", pb, 0x22); call("nvnMemoryPoolInitialize", pool, pb);
    call("nvnCommandBufferInitialize", c, dev); call("nvnCommandBufferAddCommandMemory", c, pool, 0, MEM); call("nvnCommandBufferAddControlMemory", c, ctl, 4096); call("nvnCommandBufferBeginRecording", c);
    bufs.push({ c, mem });
  }
  // A: one thread
  for (let i = 0; i < T; i++) record((id, a) => x.nvn_call(id, a), u64, ARGS, ids, bufs[i].c);
  const used = Number(u64[(bufs[0].c + 64) / 8]);
  check(used > 10000 && used + 32768 < MEM, `one thread recorded ${N * SEQ.length} commands into each of ${T} command buffers: ${used} bytes each, room left`);
  // B: T threads at once, each its own instance, no lock
  const gate = new Int32Array(memory.buffer, 0x1F000000, 2); gate[0] = 0; gate[1] = 0;
  const done = Array.from({ length: T }, (_, i) => new Promise((ok, no) => { const w = new Worker(new URL(import.meta.url), { workerData: { memory, wasm: second.wasm, ids, c: bufs[T + i].c, args: alloc(4096) } }); w.once("message", ok); w.once("error", no); }));
  while (Atomics.load(gate, 0) < T) await new Promise(r => setTimeout(r, 5));
  Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
  await Promise.all(done);
  let diff = 0;
  for (let i = 0; i < T; i++) { const a = u8.subarray(bufs[i].mem, bufs[i].mem + MEM), b = u8.subarray(bufs[T + i].mem, bufs[T + i].mem + MEM); for (let k = 0; k < MEM; k++) if (a[k] !== b[k]) { diff++; break; } if (u64[(bufs[i].c + 64) / 8] !== u64[(bufs[T + i].c + 64) / 8]) diff++; }
  check(diff === 0, `${T} threads recorded the same commands at the same time without the lock: ${diff} command buffers differ from the single thread's (bytes of the command memory, bytes used)`);
  check(lines.filter(l => /RED/.test(l)).length === 0, `no red line from the recorder${lines.length ? " (" + lines.slice(0, 2).join(" | ") + ")" : ""}`);
  console.log(bad ? `gfx_lockfree_test: ${bad} FAILED` : "gfx_lockfree_test: all passed");
  process.exit(bad ? 1 : 0);
}
