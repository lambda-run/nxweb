// What does a wasm module cost per thread? N workers each hold the same module, either compiled by each from the
// bytes (as an Emscripten pthread that cannot be sent messages has to) or received compiled over postMessage.
// node test/module_share.mjs <file.wasm> [workers]   -> resident memory per worker for both ways
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
if (!isMainThread) {
  let m = workerData.module ?? new WebAssembly.Module(workerData.bytes);
  parentPort.postMessage(WebAssembly.Module.exports(m).length);
  setInterval(() => m, 1 << 30);
} else {
  const bytes = readFileSync(process.argv[2]), n = Number(process.argv[3] ?? 8), rss = () => process.memoryUsage().rss / 1048576;
  const run = async (mk) => { const r0 = rss(), ws = [];
    for (let i = 0; i < n; i++) { const w = new Worker(new URL(import.meta.url), { workerData: mk() }); await new Promise(r => w.once("message", r)); ws.push(w); }
    const d = (rss() - r0) / n; for (const w of ws) await w.terminate(); return d; };
  const empty = await run(() => ({ module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) }));
  const own = await run(() => ({ bytes }));
  const mod = new WebAssembly.Module(bytes);
  const shared = await run(() => ({ module: mod }));
  console.log(`${(bytes.length / 1048576).toFixed(1)} MB of wasm, ${n} workers: an empty worker ${empty.toFixed(1)} MB; compiled from bytes in each ${own.toFixed(1)} MB per worker; received compiled ${shared.toFixed(1)} MB per worker`);
  process.exit(0);
}
