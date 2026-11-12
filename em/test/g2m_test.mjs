// The test of tools/globals_to_memory.mjs: a module's state is shared between instances in different threads.
//   1. a small module (32- and 64-bit memory) with mutable globals, a start function and a data segment: the first
//      instance runs in this thread, two workers instantiate the secondary build over the same memory and each add
//      to a counter global under a lock; every instance then reads the same values;
//   2. nxweb's gfx64.wasm and fs64.wasm (when built): both builds of each validate.
// node em/test/g2m_test.mjs [dir with gfx64.wasm / fs64.wasm]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { globalsToMemory, writeGlobalInits } from "../tools/globals_to_memory.mjs";

const N = 200000, LOCK = 1024, BASE = 4096;
if (!isMainThread) {
  const { memory, wasm } = workerData, x = new WebAssembly.Instance(new WebAssembly.Module(wasm), { env: { memory } }).exports, l = new Int32Array(memory.buffer, LOCK, 1);
  for (let i = 0; i < N; i++) { while (Atomics.compareExchange(l, 0, 0, 1) !== 0) Atomics.wait(l, 0, 1, 1); x.inc(); Atomics.store(l, 0, 0); Atomics.notify(l, 0, 1); }
  parentPort.postMessage({ get: x.get(), get64: String(x.get64()) });
} else {
  const uleb = n => { const o = []; do { let b = n & 0x7F; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const str = s => [s.length, ...Buffer.from(s)], sec = (id, b) => [id, ...uleb(b.length), ...b], fn = b => [...uleb(b.length + 1), 0, ...b];
  const module = m64 => Uint8Array.from([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0,
    ...sec(1, [4, 0x60, 0, 0, 0x60, 0, 1, 0x7F, 0x60, 1, 0x7E, 0, 0x60, 0, 1, 0x7E]),
    ...sec(2, [1, ...str("env"), ...str("memory"), 2, m64 ? 7 : 3, 1, 16]),
    ...sec(3, [5, 0, 0, 1, 2, 3]),
    ...sec(6, [4, 0x7F, 1, 0x41, 5, 0x0B, 0x7E, 1, 0x42, 0x79, 0x0B, 0x7F, 0, 0x41, 3, 0x0B, 0x7F, 1, 0x41, 9, 0x0B]),   // counter = 5, wide = -7, a constant, an exported mutable one
    ...sec(7, [5, ...str("inc"), 0, 1, ...str("get"), 0, 2, ...str("set64"), 0, 3, ...str("get64"), 0, 4, ...str("keep"), 3, 3]),
    ...sec(8, [0]),
    ...sec(12, [1]),
    ...sec(10, [5,
      ...fn([0x41, 0xE4, 0x00, 0x24, 0, 0x0B]),                                  // start: counter = 100
      ...fn([0x23, 0, 0x41, 1, 0x6A, 0x24, 0, 0x23, 3, 0x1A, 0x23, 2, 0x1A, 0x0B]),   // inc
      ...fn([0x23, 0, 0x0B]), ...fn([0x20, 0, 0x24, 1, 0x0B]), ...fn([0x23, 1, 0x0B])]),
    ...sec(11, [1, 0, m64 ? 0x42 : 0x41, 0xC0, 0x00, 0x0B, 4, 1, 2, 3, 4])]);   // 4 bytes at 64
  let bad = 0; const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) bad++; };
  for (const m64 of [false, true]) {
    const src = module(m64), name = m64 ? "memory64" : "memory32";
    const memory = new WebAssembly.Memory(m64 ? { initial: 1n, maximum: 16n, shared: true, address: "i64" } : { initial: 1, maximum: 16, shared: true });
    const first = globalsToMemory(src, { base: BASE }), second = globalsToMemory(src, { base: BASE, secondary: true });
    check(first.globals.length === 2 && first.gets === 3 && first.sets === 3, `${name}: 2 of 4 globals moved (the constant and the exported one stay), 3 gets and 3 sets rewritten`);
    writeGlobalInits(memory, first.globals);
    const dv = new DataView(memory.buffer), u8 = new Uint8Array(memory.buffer);
    check(dv.getInt32(BASE, true) === 5 && dv.getBigInt64(BASE + 16, true) === -7n, `${name}: the initial values are in the block (5, -7)`);
    const a = new WebAssembly.Instance(new WebAssembly.Module(first.wasm), { env: { memory } }).exports;
    check(a.get() === 100 && u8[64] === 1 && u8[67] === 4, `${name}: the first instance ran its start function and wrote its data`);
    u8[64] = 77; a.set64(-(2n ** 40n));
    const res = await Promise.all([0, 1].map(() => new Promise((ok, no) => { const w = new Worker(new URL(import.meta.url), { workerData: { memory, wasm: second.wasm } }); w.once("message", ok); w.once("error", no); })));
    check(a.get() === 100 + 2 * N, `${name}: two workers added ${N} each through their own instances: the first instance reads ${a.get()}`);
    check(res.some(r => r.get === 100 + 2 * N) && res.every(r => r.get64 === String(-(2n ** 40n))), `${name}: the workers read the same counter and the i64 the first instance set`);
    check(u8[64] === 77, `${name}: a secondary instance does not write the data again`);
    check(a.keep.value === 9, `${name}: the exported global is still a global`);
  }
  const dir = process.argv[2] ?? "/mnt/build/web/wasm";
  for (const n of ["gfx64", "fs64"]) {
    if (!existsSync(`${dir}/${n}.wasm`)) { console.log(`skip ${n}.wasm (not in ${dir})`); continue; }
    const b = readFileSync(`${dir}/${n}.wasm`), r1 = globalsToMemory(b, { base: 0x1FE00000 }), r2 = globalsToMemory(b, { base: 0x1FE00000, secondary: true });
    check(WebAssembly.validate(r1.wasm) && WebAssembly.validate(r2.wasm), `${n}.wasm: ${r1.globals.length} globals moved (${r1.gets} gets, ${r1.sets} sets); the first and the secondary build validate`);
    check(WebAssembly.Module.customSections(new WebAssembly.Module(r2.wasm), "nx.abi").length === 1, `${n}.wasm: the address table (nx.abi) is kept`);
  }
  console.log(bad ? `g2m_test: ${bad} FAILED` : "g2m_test: all passed");
  process.exit(bad ? 1 : 0);
}
