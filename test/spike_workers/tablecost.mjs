// EXPERIMENTAL (spike, SPIKE.md). What instantiating a module that imports a function table costs, by table length.
//   node test/spike_workers/tablecost.mjs          (the browser runner prints the same for Chromium)
const m = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 9, 1, 1, 0x65, 1, 0x74, 1, 0x70, 0, 1, 3, 2, 1, 0, 9, 7, 1, 0, 0x41, 0, 0x0b, 1, 0, 10, 4, 1, 2, 0, 0x0b]));
const out = [];
for (const n of [1024, 65536, 524288]) {
  const t = new WebAssembly.Table({ element: "anyfunc", initial: n });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) new WebAssembly.Instance(m, { e: { t } });
  out.push(`${n}: ${((performance.now() - t0) / 20).toFixed(3)}`);
}
console.log(`Node ${process.version}: instantiating a 44-byte module that imports a function table, ms per instance by table length: ${out.join(", ")}`);
