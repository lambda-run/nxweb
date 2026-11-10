// EXPERIMENTAL (spike, SPIKE.md). Does V8 compile a module again when another Worker makes a WebAssembly.Module from
// bytes that were compiled before? Run with eager compilation so that the constructor's time is the compile time:
//   node --no-wasm-lazy-compilation test/spike_workers/modcache.mjs [file.wasm]
// Main thread: the bytes (variant A) for the first time. A Worker: variant A again, then variant B (one byte of a
// custom section differs: nothing compiled is reusable by content), then B again.
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
const time = x => { const t0 = performance.now(); const m = new WebAssembly.Module(x); return [performance.now() - t0, m]; };
const variant = (b, k) => { const v = new Uint8Array(b.length + 4); v.set(b); v.set([0, 2, 1, 65 + k], b.length); return v; };
if (isMainThread) {
  const file = process.argv[2] ?? "build/runtime/gfx.wasm";
  const b = new Uint8Array(readFileSync(file));
  const [first, keep] = time(variant(b, 0));
  globalThis.keep = keep;   // the cache holds a module only while one is alive
  const w = new Worker(new URL(import.meta.url), { workerData: b });
  w.on("message", m => { console.log(`${file} (${b.length} B), ${process.execArgv.includes("--no-wasm-lazy-compilation") ? "eager" : "lazy"} compilation: main thread first ${first.toFixed(1)} ms; in a Worker: the same bytes ${m.sameA.toFixed(1)} ms, other bytes ${m.firstB.toFixed(1)} ms, those again ${m.againB.toFixed(1)} ms`); process.exit(0); });
} else {
  const b = workerData;
  const [sameA] = time(variant(b, 0));
  const [firstB, keepB] = time(variant(b, 1));
  const [againB] = time(variant(b, 1));
  parentPort.postMessage({ sameA, firstB, againB, keepB: !!keepB });
}
