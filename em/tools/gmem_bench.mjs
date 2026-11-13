// node em/tools/gmem_bench.mjs <gfx64.wasm> [live buffers = 40000] [per frame = 2354]: the recorder alone (as
// tools/gfx_dynaudit.mjs sets it up) with that many live NVN buffers of 1 KiB in one pool; then, as the game does in
// its first 3D area every frame, `per frame` buffers are ended and made again (the oldest, the newest, random ones),
// and addresses are looked up in the live-buffer table (gfx_gmem_find, when the build exports it: what a draw of a
// shader that reads memory through loaded addresses does up to 16 times). Prints microseconds per call.
import { readFileSync } from "node:fs";
import { globalsToMemory, writeGlobalInits } from "./globals_to_memory.mjs";
const W = new URL("../../", import.meta.url).pathname;
const { sharedBuild } = await import(W + "src/glue/wasm_shared.ts"), { instantiate } = await import(W + "src/glue/wasm_abi.ts"), { range } = await import(W + "src/glue/rt_layout.ts");
const raw = new Uint8Array(readFileSync(process.argv[2])), LIVE = Number(process.argv[3] ?? 40000), PER = Number(process.argv[4] ?? 2354);
const PAGES = 8192, GLOBALS = 0x1FF10000;
const memory = new WebAssembly.Memory({ initial: BigInt(PAGES), maximum: BigInt(PAGES), shared: true, address: "i64" });
const first = globalsToMemory(sharedBuild(raw, PAGES), { base: GLOBALS }); writeGlobalInits(memory, first.globals);
let tables = 0x18000000;
const env = { memory, memory_size: () => PAGES, memory_grow: () => -1, abort: () => { throw new Error("abort"); }, log: (p, n) => console.log("[gfx] " + new TextDecoder().decode(new Uint8Array(memory.buffer).slice(Number(p), Number(p) + n))),
  gfx_exec: () => {}, gfx_proc_address: () => 0n, gfx_arena_more: (n) => { const at = tables; tables += ((n >>> 0) + 0xFFFF) & ~0xFFFF; return at; }, gfx_guest_call: () => 0n };
const x = instantiate(new WebAssembly.Module(first.wasm), { env }, { mem64: true, name: "gfx64.wasm" });
const arena = range("gfx arena"), u8 = new Uint8Array(memory.buffer), u64 = new BigUint64Array(memory.buffer);
if (!x.gfx_init(arena.lo, x.gfx_arena_bytes())) throw new Error("the recorder did not start");
const idOf = new Map(); for (let id = 0, n = x.nvn_count(); id < n; id++) { const p = Number(x.nvn_name(id)); let e = p; while (u8[e]) e++; idOf.set(String.fromCharCode(...u8.subarray(p, e)), id); }
let bump = 0x10000000; const alloc = (n) => { const a = bump; bump += (n + 63) & ~63; return a; };
const ARGS = alloc(4096), ids = {}, call = (name, ...a) => { for (let i = 0; i < a.length; i++) u64[ARGS / 8 + i] = BigInt(a[i]); return x.nvn_call(ids[name] ??= idOf.get(name), BigInt(ARGS)); };
const devb = alloc(64), dev = alloc(64); call("nvnDeviceBuilderSetDefaults", devb); call("nvnDeviceBuilderSetFlags", devb, 0); call("nvnDeviceInitialize", dev, devb);
const SZ = 1024, pb = alloc(64), pool = alloc(256), store = 0x12000000, bb = alloc(64);
call("nvnMemoryPoolBuilderSetDefaults", pb); call("nvnMemoryPoolBuilderSetDevice", pb, dev); call("nvnMemoryPoolBuilderSetStorage", pb, store, LIVE * SZ); call("nvnMemoryPoolBuilderSetFlags", pb, 0x22); call("nvnMemoryPoolInitialize", pool, pb);
call("nvnBufferBuilderSetDefaults", bb); call("nvnBufferBuilderSetDevice", bb, dev);
const objs = []; for (let i = 0; i < LIVE; i++) objs.push(alloc(64));
const us = (t0, n) => ((performance.now() - t0) * 1000 / n).toFixed(2);
const make = (i) => { call("nvnBufferBuilderSetStorage", bb, pool, i * SZ, SZ); if (!call("nvnBufferInitialize", objs[i], bb)) throw new Error("nvnBufferInitialize failed"); };
let t = performance.now(); for (let i = 0; i < LIVE; i++) make(i);
console.log(`${process.argv[2]}: ${LIVE} live buffers made, ${us(t, LIVE)} us each (builder call included)`);
const fin = idOf.get("nvnBufferFinalize"), round = (what, pick) => {
  let tf = 0, ti = 0;
  for (let r = 0; r < 5; r++) { const idx = []; for (let k = 0; k < PER; k++) idx.push(pick(k));
    let a = performance.now(); for (const i of idx) { u64[ARGS / 8] = BigInt(objs[i]); x.nvn_call(fin, BigInt(ARGS)); } tf += performance.now() - a;
    a = performance.now(); for (const i of idx) make(i); ti += performance.now() - a; }
  console.log(`  ${what}: nvnBufferFinalize ${(tf * 1000 / 5 / PER).toFixed(2)} us, nvnBufferInitialize (+ builder call) ${(ti * 1000 / 5 / PER).toFixed(2)} us; a frame of ${PER}: ${((tf + ti) / 5).toFixed(1)} ms`); };
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
round("the oldest", k => k); round("the newest", k => LIVE - 1 - k); { const seen = new Set(); round("random", () => { let i; do i = Math.floor(rnd() * LIVE); while (seen.has(i)); seen.add(i); if (seen.size > LIVE / 2) seen.clear(); return i; }); }
if (x.gfx_gmem_find) { const N = 20000; let bad = 0; t = performance.now();
  for (let k = 0; k < N; k++) { const i = Math.floor(rnd() * LIVE), p = store + i * SZ + 16 + (k & 255); if (Number(x.gfx_gmem_find(BigInt(p))) !== objs[i]) bad++; }
  console.log(`  address lookup (gfx_gmem_find, no hint): ${us(t, N)} us each, ${bad} wrong of ${N}; live ${x.gfx_gmem_live ? x.gfx_gmem_live() : "?"}, walked ${x.gfx_gmem_walked ? x.gfx_gmem_walked() : "?"}`);
  t = performance.now(); let none = 0; for (let k = 0; k < 2000; k++) if (Number(x.gfx_gmem_find(BigInt(store + LIVE * SZ + 4096 + k))) !== 0) none++;
  console.log(`  address in no buffer: ${us(t, 2000)} us each, ${none} wrong`);
} else console.log("  (this build has no gfx_gmem_find export: the lookup is not timed)");
