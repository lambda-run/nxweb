// The cost of "every guest thread instantiates every translated unit itself" at a larger scale than proof 2,
// measured in plain node (no Emscripten): a synthetic guest of thousands of functions (nxweb's
// test/a64/guests/big_gen.py) is translated once on the main thread; then worker A and, after it, worker B
// compile and instantiate the same unit bytes on the shared memory and run the guest twice each.
// What it answers: is the second thread's compile cheap (does V8 share compiled wasm between threads by bytes)?
// Usage: node test/scale_units.ts <big.bin> [stack top offset]      (run by build_scale.sh)
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { A64Host } from "/mnt/src/glue/a64_host.ts";
import { A64, HOST_END } from "/mnt/src/glue/rt_layout.ts";

const BASE = 0x0800_0000, EXIT = 0xFFFFFFF0n;
interface Job { memory: WebAssembly.Memory; core: WebAssembly.Module; helpers: WebAssembly.Module; units: { bytes: Uint8Array; tableBase: number }[]; tableLen: number; stackTop: number; image: Uint8Array; clearEnd: number; ctl: SharedArrayBuffer }

function makeSvc(core: any) {
  return (n: number) => { if (n === 0x07) core.pc.value = EXIT; else if (n === 0x1E) core.x0.value = 0n; else core.x0.value = 0n; };
}
function runGuest(core: any, memory: WebAssembly.Memory, image: Uint8Array, clearEnd: number, stackTop: number): number {
  const u8 = new Uint8Array(memory.buffer);
  u8.set(image, BASE); u8.fill(0, BASE + image.length, clearEnd);
  for (let i = 0; i <= 30; i++) core["x" + i].value = 0n;
  core.sp.value = BigInt(stackTop); core.x30.value = EXIT; core.pc.value = BigInt(BASE); core.excl_addr.value = -1n;
  const t0 = performance.now();
  while (core.pc.value !== EXIT) { core.budget.value = 1 << 30; core.run(); }
  return performance.now() - t0;
}

if (!isMainThread) {
  const j = workerData as Job, ctl = new Int32Array(j.ctl);
  const t0 = performance.now();
  const table = new WebAssembly.Table({ element: "anyfunc", initial: j.tableLen });
  const core = new WebAssembly.Instance(j.core, { env: { memory: j.memory, table, translate: () => { throw new Error("reached code that was not translated"); } } }).exports as any;
  const { staticBase: _b, staticEnd: _e, memory: _m, libcStat: _s, libcGuard: _g, ...hlp } = new WebAssembly.Instance(j.helpers, { env: { memory: j.memory, abort: () => { throw new Error("abort"); } } }).exports as any;
  const env = { memory: j.memory, table, svc: makeSvc(core), unimpl: () => { throw new Error("unimpl"); }, brk: () => { throw new Error("brk"); }, cntpct: () => 0n };
  let compileMs = 0, instMs = 0;
  for (const u of j.units) {
    const a = performance.now();
    const mod = new WebAssembly.Module(u.bytes as unknown as BufferSource);   // from bytes, as a pthread would have to
    const b = performance.now();
    new WebAssembly.Instance(mod, { cpu: core, hlp, env: { ...env, table_base: new WebAssembly.Global({ value: "i32", mutable: false }, u.tableBase) } });
    compileMs += b - a; instMs += performance.now() - b;
  }
  const setupMs = performance.now() - t0;
  const run1 = runGuest(core, j.memory, j.image, j.clearEnd, j.stackTop);
  const run2 = runGuest(core, j.memory, j.image, j.clearEnd, j.stackTop);
  const run3 = runGuest(core, j.memory, j.image, j.clearEnd, j.stackTop);
  parentPort!.postMessage({ setupMs, compileMs, instMs, run1, run2, run3, x0: Number(core.x0.value) });
  Atomics.wait(ctl, 0, 0);   // stay alive (its modules stay alive) until the main thread is done
} else {
  const image = readFileSync(process.argv[2]);
  const stackTop = BASE + Number(process.argv[3] ?? 0x4000000), clearEnd = stackTop;
  const mod = (f: string) => new WebAssembly.Module(readFileSync("/mnt/build/runtime/" + f));
  const helpers = mod("helpers.shared.wasm");
  const memory = new WebAssembly.Memory({ initial: Math.ceil((stackTop + 0x10000) / 65536), maximum: 65536, shared: true });
  const rss = () => (process.memoryUsage().rss / 1048576).toFixed(0) + " MB";
  const host = new A64Host(mod("translator.shared.wasm"), helpers, { memory, shared: true, layout: { ...A64, codeRegionLo: BASE }, imports: { svc: (n: number) => svc(n), unimpl: () => { throw new Error("unimpl"); }, brk: () => {}, cntpct: () => 0n } });
  const c = host.core as any; const svc = makeSvc(c);
  host.keepBytes = true;
  new Uint8Array(memory.buffer).set(image, BASE);
  host.addCode(BASE, image.length);
  const r0 = rss();
  const first = runGuest(c, memory, image, clearEnd, stackTop);
  const second = runGuest(c, memory, image, clearEnd, stackTop);
  const third = runGuest(c, memory, image, clearEnd, stackTop);
  const bytes = host.units.reduce((n, u) => n + u.bytes!.length, 0);
  console.log(`guest image ${(image.length / 1024).toFixed(0)} KB of ARM64; translated ${host.translatedInsns} instructions, ${host.translatedFuncs} functions into ${host.units.length} units, ${(bytes / 1048576).toFixed(2)} MB of wasm`);
  console.log(`main thread: first run ${first.toFixed(0)} ms (of it ${(host.translateNs / 1e6).toFixed(0)} ms translate + compile + instantiate), second ${second.toFixed(0)} ms, third ${third.toFixed(0)} ms; RSS ${r0} -> ${rss()}`);
  const units = host.units.map(u => ({ bytes: u.bytes!, tableBase: u.tableBase }));
  const ctl = new SharedArrayBuffer(4);
  const want = Number(c.x0.value);
  for (const name of ["A", "B", "C"]) {
    const before = rss();
    const job: Job = { memory, core: host.coreModule, helpers, units, tableLen: host.table.length, stackTop, image, clearEnd, ctl };
    const r: any = await new Promise((res, rej) => { const w = new Worker(new URL(import.meta.url), { workerData: job }); w.once("message", res); w.once("error", rej); });
    console.log(`worker ${name}: all units from bytes: compile ${r.compileMs.toFixed(0)} ms + instantiate ${r.instMs.toFixed(0)} ms (set-up in all ${r.setupMs.toFixed(0)} ms); guest run 1 ${r.run1.toFixed(0)} ms, run 2 ${r.run2.toFixed(0)} ms, run 3 ${r.run3.toFixed(0)} ms; ${r.x0 === want ? "same result" : "[RED] DIFFERENT result"}; RSS ${before} -> ${rss()}`);
  }
  process.exit(0);
}
