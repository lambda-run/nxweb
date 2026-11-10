// EXPERIMENTAL (spike, SPIKE.md). Small facts the write-up quotes:  node test/spike_workers/evidence.mts
//   1. a shared memory grown by one thread, seen from another thread's JavaScript views
//   2. the mutable WebAssembly globals (state outside linear memory) of every AssemblyScript module of the runtime,
//      and whether mtify can move them
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import binaryen from "binaryen";

if (!isMainThread) {
  const { memory, sig } = workerData as { memory: WebAssembly.Memory; sig: Int32Array };
  const old = new Uint8Array(memory.buffer), oldBuf = memory.buffer;
  Atomics.store(sig, 0, 1); Atomics.notify(sig, 0);
  Atomics.wait(sig, 0, 1);   // the main thread grows the memory and writes 42 at 65546
  const before = { viewLength: old.length, viewRead: String(old[65546]), bufferObjectByteLength: oldBuf.byteLength };
  const fresh = memory.buffer;
  parentPort!.postMessage({ before, sameObject: fresh === oldBuf, freshByteLength: fresh.byteLength, freshRead: new Uint8Array(fresh)[65546] });
} else {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
  const sig = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(new URL(import.meta.url), { workerData: { memory, sig } });
  Atomics.wait(sig, 0, 0);
  memory.grow(1);
  new Uint8Array(memory.buffer)[65546] = 42;
  Atomics.store(sig, 0, 2); Atomics.notify(sig, 0);
  const m: any = await new Promise(r => w.once("message", r));
  console.log(`1. memory growth: another thread grew the shared memory from 1 to 2 pages and wrote 42 at 65546. In this thread a Uint8Array made before: length ${m.before.viewLength}, [65546] = ${m.before.viewRead}; the old buffer object: byteLength ${m.before.bufferObjectByteLength}; ` +
    `memory.buffer read again: ${m.sameObject ? "the same object" : "a new SharedArrayBuffer"}, byteLength ${m.freshByteLength}, [65546] = ${m.freshRead}`);
  await w.terminate();

  console.log("2. mutable wasm globals per module (state that every instance would have for itself), and mtify:");
  const { mtify } = await import("../../src/spike_workers/mtify.mts");
  const dir = join(import.meta.dirname, "..", "..", "build", "runtime");
  for (const name of ["kernel", "rt", "loader", "hle", "fs", "gfx", "translator", "helpers"]) {
    const bin = new Uint8Array(readFileSync(join(dir, name + ".wasm")));
    const mod = binaryen.readBinary(bin); mod.setFeatures(binaryen.Features.All);
    const text = mod.emitText(); mod.dispose();
    const mut = (text.match(/^ \(global \$\S+ \(mut /gm) ?? []).length;
    const data = (text.match(/^ \(data /gm) ?? []).length, start = /^ \(start /m.test(text);
    let res = "";
    try { const r = mtify(bin, 0x100000, 65536); new WebAssembly.Module(r.primary); new WebAssembly.Module(r.secondary); res = `mtify ok (${r.globals.length} moved; primary ${r.primary.length} B, secondary ${r.secondary.length} B)`; }
    catch (e) { res = "mtify FAILED: " + (e as Error).message; }
    console.log(`   ${(name + ".wasm").padEnd(16)} ${String(bin.length).padStart(7)} B  ${String(mut).padStart(3)} mutable globals, ${String(data).padStart(3)} data segments, start function: ${start ? "yes" : "no "}  ${res}`);
  }
}
