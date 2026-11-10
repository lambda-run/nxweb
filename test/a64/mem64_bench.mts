// npm run a64:mem64: what 64-bit linear memory (the memory64 proposal) costs per guest load / store, estimated with
// the two addressing forms the translator would emit, in one loop each (hand-assembled modules; no translator change):
//   memory32, as today:   i64 guest address -> i32.wrap_i64 -> i64.load / i64.store        (bounds: the engine's guard pages)
//   memory64:             i64 guest address ->                 i64.load / i64.store on an i64 memory (bounds: an explicit check, or guard pages where the engine reserves enough)
// The loop walks a 64 MB window with a stride of 4160 bytes (so that the cache behaviour is the same in both), loads,
// adds and stores. Node 22.23 has memory64 on (older: --experimental-wasm-memory64). The translator's own memory64
// mode on the guest corpus: `npm run a64:mem64:speed`.
import { makeMemory64 } from "../../src/glue/a64_host.ts";
const leb = (v: number) => { const n: number[] = []; do { let b = v & 0x7F; v >>>= 7; if (v) b |= 0x80; n.push(b); } while (v); return n; };
const sleb = (v: number) => { const n: number[] = []; for (;;) { const b = v & 0x7F; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { n.push(b); break; } n.push(b | 0x80); } return n; };
const str = (t: string) => [t.length, ...Array.from(t, c => c.charCodeAt(0))];
const sec = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
function module(m64: boolean, stride: number, mask: number): Uint8Array {
  // (func (param $n i64) (result i64) (local $a i64) (local $s i64)
  //   loop: s += load(addr(a)); store(addr(a), s); a = (a + 4160) & 0x3FFFFF8; n -= 1; br_if n != 0;  return s)
  const addr = m64 ? [0x20, 1] : [0x20, 1, 0xA7];                       // local.get a  [i32.wrap_i64]
  const body = [1, 2, 0x7E,                                             // 2 locals i64
    0x03, 0x40,                                                         // loop
    ...addr, ...addr, 0x29, 3, 0, 0x20, 2, 0x7C, 0x22, 2, 0x37, 3, 0,   // addr; addr; i64.load; s; add; tee s; i64.store
    0x20, 1, 0x42, ...sleb(stride), 0x7C, 0x42, ...sleb(mask), 0x83, 0x21, 1,   // a = (a + 4160) & mask
    0x20, 0, 0x42, 1, 0x7D, 0x22, 0, 0x50, 0x45, 0x0D, 0,               // n -= 1; br_if n != 0
    0x0B, 0x20, 2, 0x0B];
  return new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0,
    ...sec(1, [1, 0x60, 1, 0x7E, 1, 0x7E]), ...sec(3, [1, 0]),
    ...sec(5, [1, m64 ? 0x05 : 0x01, ...leb(1024), ...leb(m64 ? 65536 * 4 : 65536)]),   // 64 MB now; max 4 GB (memory32) or 16 GB (memory64)
    ...sec(7, [1, ...str("run"), 0, 0]), ...sec(10, [1, ...leb(body.length), ...body])]);
}
const N = 40_000_000n, rounds = Number(process.argv[2] ?? 9);
const time = (x: any) => { const t = performance.now(); x.run(N); return performance.now() - t; };
const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1], min = (v: number[]) => Math.min(...v);
const per = (ms: number) => (ms * 1e6 / Number(N)).toFixed(2);
console.log(`a64:mem64 (node ${process.version}, V8 ${process.versions.v8}): ${N} iterations of load + add + store (two memory accesses in about eight instructions), ${rounds} interleaved rounds`);
for (const [what, stride, mask] of [["in the cache (a 32 KB window: the cost of the addressing form itself)", 8, 0x7FF8], ["out of the cache (a 64 MB window, stride 4160: memory-bound, as a game's data mostly is)", 4160, 0x3FFFFF8]] as [string, number, number][]) {
  let m32: any, m64: any;
  m32 = new WebAssembly.Instance(new WebAssembly.Module(module(false, stride, mask))).exports;
  try { m64 = new WebAssembly.Instance(new WebAssembly.Module(module(true, stride, mask))).exports; }
  catch (e) { console.log(`a64:mem64: this engine does not take a memory64 module (${(e as Error).message.split("\n")[0]}); run node with --experimental-wasm-memory64`); process.exit(2); }
  for (let i = 0; i < 3; i++) { time(m32); time(m64); }   // tier up
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < rounds; i++) { if (i & 1) { b.push(time(m64)); a.push(time(m32)); } else { a.push(time(m32)); b.push(time(m64)); } }
  if (m32.run(1000n) !== m64.run(1000n)) console.log("[RED] the two modules computed different sums");
  console.log(`  ${what}:`);
  console.log(`    memory32 (i32.wrap_i64, guard pages): median ${per(med(a))} ns an iteration (min ${per(min(a))})`);
  console.log(`    memory64 (i64 address):               median ${per(med(b))} ns an iteration (min ${per(min(b))}): ${((med(b) / med(a) - 1) * 100).toFixed(1)} % by the medians, ${((min(b) / min(a) - 1) * 100).toFixed(1)} % by the minima`);
}
// how large a memory64 may get here (made the way src/glue/a64_host.ts makes one: a module that defines it; Node 22's
// JavaScript API has no `address: "i64"`)
for (const gb of [8, 16, 32]) {
  try { const m = makeMemory64({ initial: 1, maximum: gb * 16384 }); const before = m.grow(gb * 16384 - 1); console.log(`  a memory64 with maximum ${gb} GB: made, ${before < 0 ? "but it does not grow to its maximum" : `grown to ${(m.memory.buffer.byteLength / 2 ** 30).toFixed(1)} GB of address space`}`); }
  catch (e) { console.log(`  a memory64 with maximum ${gb} GB: ${(e as Error).message.split("\n")[0].slice(0, 200)}`); }
}
