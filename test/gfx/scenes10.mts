// Scenes of `npm run gfx:test` (browser) for global memory through loaded addresses: the mirror (docs/gmem-mirror.md; src/shaders/spv.ts globalMemory,
// src/gfx/lower.ts emitGmem, GfxHost "the mirror of global memory"). The shaders are written here in the form the shader chain gives them: the bindings of a
// module that uses the mirror, the translator's own raw load and store helpers (gmem_helpers.mts: the chain's output, so the table the replayer builds is
// searched by the code that searches it in a game), and a few lines that call them as a translated body does. The memory they reach lies in real NVN buffers
// (the recorder finds the live buffer of each address). Checked on pixels and in guest memory.
import { Env } from "./env.mts";
import { type Scene } from "./scenes.mts";
import { SIZEOF, STAGE, POOL_FLAGS } from "./nvn.mts";
import { stageOf, naga, quad, register as registerMesh, words, begin } from "./scenes6.mts";
import { GM_LOAD, GM_STORE } from "./gmem_helpers.mts";
import type { ShaderInfo } from "../../src/glue/gfx_host.ts";

const BLACK = [0, 0, 0, 255], RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];
// What spv.ts globalMemory declares for stage st (0 vertex, 1 fragment, 2 compute): the mirror at 128 + st * 16 + 32, its table at + 1, the write log at + 2
// (a module that stores through an address), the bases of the stage's own storage slots at 224 + st; and the calls a translated body makes
const decl = (st: number, write: boolean) => `struct GmW { member: array<u32> }
struct GmL { member: array<atomic<u32>> }
struct GmB { member: array<vec4<u32>, 8> }
@group(0) @binding(${128 + st * 16 + 33}) var<storage> nx_gmem_table: GmW;
${write ? `@group(0) @binding(${128 + st * 16 + 34}) var<storage, read_write> nx_gmem_log: GmL;` : ""}
@group(0) @binding(${128 + st * 16 + 32}) var<storage${write ? ", read_write" : ""}> nx_gmem: GmW;
@group(0) @binding(${224 + st}) var<uniform> nx_gmem_base: GmB;
var<private> gm_last_r: u32 = u32();
var<private> gm_last_w: u32 = u32();
${GM_LOAD}
${write ? GM_STORE : ""}
fn base(s: u32) -> u32 { return nx_gmem_base.member[s >> 2u][s & 3u]; }
fn slot(s: u32, i: u32) -> u32 { return nx_gmem.member[base(s) + i]; }
fn ld(lo: u32, hi: u32) -> u32 { var a = bitcast<i32>(lo); var b = bitcast<i32>(hi); return bitcast<u32>(gm_load(&a, &b)); }
${write ? "fn sto(lo: u32, hi: u32, v: u32) { var a = bitcast<i32>(lo); var b = bitcast<i32>(hi); var c = bitcast<i32>(v); gm_store(&a, &b, &c); }" : ""}
`;
const gmExtra = (st: number) => ({ kind: "gmem", group: 0, binding: 224 + st, size: 128 });
const gmStorage = (write: boolean) => [{ slot: 32, write }, { slot: 33 }, ...(write ? [{ slot: 34, write: true }] : [])];
async function register(e: Env, name: string, info: Omit<ShaderInfo, "entry">) {
  const s = await e.blobs(name);
  if (e.host.registerShader(s.key, { entry: "main", ...info } as ShaderInfo) < 0) throw new Error(`registerShader ${name}`);
  return s;
}
// An NVN buffer over bytes of a pool (the data pool: new bytes): its GPU address, which is where the bytes are in guest memory
function buffer(e: Env, bytes: ArrayBufferView, pool?: { obj: number }, off = 0): number {
  const G = e.G, g = e.g, bb = g.alloc(SIZEOF.BUFFER_BUILDER), buf = g.alloc(SIZEOF.BUFFER);
  let addr: number;
  if (pool) { addr = G.c("MemoryPoolGetBufferAddress", [pool.obj]) + off; g.u8.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), addr); }
  else { addr = G.put(bytes); pool = G.data; off = addr - G.c("MemoryPoolGetBufferAddress", [G.data.obj]); }
  G.c("BufferBuilderSetDevice", [bb, G.dev]); G.c("BufferBuilderSetDefaults", [bb]); G.c("BufferBuilderSetStorage", [bb, pool.obj, off, bytes.byteLength]);
  if (G.c("BufferInitialize", [buf, bb]) !== 1) throw new Error("BufferInitialize");
  return addr;
}
const lo = (a: number) => a >>> 0, hi = (a: number) => Math.floor(a / 4294967296) >>> 0;
const u32s = (e: Env, addr: number, n: number) => Array.from(new Uint32Array(e.g.memory.buffer.slice(addr, addr + n * 4)));

// A culling shader: the address of an indirect draw record is word 0 (and 1) of its storage slot 0; it reads how many to draw from the record's third
// word and stores {count, first 1} at the address
const CS_CULL = `${decl(2, true)}
@compute @workgroup_size(1) fn main() {
  let a = slot(0u, 0u); let h = slot(0u, 1u);
  let n = ld(a + 8u, h);
  sto(a, h, n); sto(a + 4u, h, 1u);
}`;
// 12 addresses in slot 0 (words 0..23), each of a buffer of its own, read at word k & 3; word 24: where the sum is stored (the record does not say this
// address is stored through); word 26: where its complement is stored (it does); words 28, 30: an address in a large buffer and an offset into it.
// Slot 1 is the stage's own written storage, read and written in the mirror
const CS_SUM = `${decl(2, true)}
@compute @workgroup_size(1) fn main() {
  var sum = 0u;
  for (var k = 0u; k < 12u; k++) { sum += ld(slot(0u, 2u * k) + 4u * (k & 3u), slot(0u, 2u * k + 1u)); }
  sto(slot(0u, 24u), slot(0u, 25u), sum);
  sto(slot(0u, 26u) + 4u, slot(0u, 27u), ~sum);
  let o = base(1u);
  nx_gmem.member[o] = nx_gmem.member[o] + sum;
  nx_gmem.member[o + 1u] = ld(16u, 0u) + 5u;                                   // an address in no range reads 0
  nx_gmem.member[o + 2u] = ld(slot(0u, 28u) + slot(0u, 30u), slot(0u, 29u));   // in a whole 2 MiB chunk of a large range: the table's hint
  sto(48u, 0u, 7u);                                                            // a store to an address in no range is dropped
}`;
const FS_SUM = `${decl(1, false)}
@fragment fn main(@location(0) v: vec4f) -> @location(0) vec4f {
  var sum = 0u;
  for (var k = 0u; k < 12u; k++) { sum += ld(slot(0u, 2u * k) + 4u * (k & 3u), slot(0u, 2u * k + 1u)); }
  return vec4f(f32(sum) / 255.0, f32(ld(16u, 0u)), f32(slot(0u, 31u)) / 255.0, 1.0);
}`;

export const scenes10: Scene[] = [
  { name: "global memory mirror: a compute shader stores an indirect draw record through an address it loads, the indirect mesh draw after it draws from the mirror, the record lands in guest memory; the guest's next record is taken again", async run(e, t) {
    const G = e.G, cmd = G.cmd, fs = await e.shader("fs_color");
    const ms = stageOf(7), msq = await registerMesh(e, "ms_quad_gm", ms, naga(words(ms), `    let w = f32(global[0]);\n` + quad(ms, "-1.0 + w", "-1.0", ["1.0 - w", "w", "0.0", "1.0"], 2)));
    const prog = G.program([msq, fs]);
    const cull = G.program([await register(e, "cs_cull_gm", { stage: "compute", storage: gmStorage(true), extra: [gmExtra(2)], wgsl: CS_CULL,
      gmem: { pointers: [{ slot: 0, word: 0, write: true }], slots: [{ slot: 0, write: false }], write: true, log: true } })]);
    const rec = buffer(e, new Uint32Array([0, 0, 1, 0])), ptrs = buffer(e, new Uint32Array([lo(rec), hi(rec), 0, 0]));
    let i = begin(e, prog, 0x82);
    G.c("CommandBufferBindProgram", [cmd, cull, 0x20]); G.c("CommandBufferBindStorageBuffer", [cmd, STAGE.COMPUTE, 0, ptrs, 16]);
    G.c("CommandBufferDispatchCompute", [cmd, 1, 1, 1]);
    G.c("CommandBufferDrawMeshTasksIndirect", [cmd, rec]);
    e.finish(i);
    t.eq(u32s(e, rec, 3), [0, 0, 1], "guest memory has the record the CPU wrote right after the submit: count 0");
    let img = await e.read();
    t.rect(img, 32, 0, 64, 64, GREEN, "the record the compute shader stored, {count 1, first 1}: workgroup 1 draws the right half");
    t.rect(img, 0, 0, 32, 64, BLACK, "and workgroup 0 nothing");
    await e.settle(); await e.settle();
    t.eq(u32s(e, rec, 3), [1, 1, 1], "the stored record landed in guest memory");
    t.eq([e.host.stats.gmemReadbacks, e.host.stats.gmemRanges, e.host.stats.meshIndirect, e.host.stats.meshFailed], [1, 2, 1, 0], "one range read back from the mirror, which holds the pointer buffer and the record's");
    const logs = e.g.logs.join("\n");
    t.ok(/mesh draw 1: \{count 1, first 1\}, 1 output slots drawn/.test(logs), `the indirect draw's counts are the ones the GPU stored: ${logs}`);
    // the guest writes the record itself, no dispatch: the mirror takes the new bytes before the indirect copy
    new Uint32Array(e.g.memory.buffer, rec, 2).set([2, 0]);
    i = begin(e, prog, 0x82);
    G.c("CommandBufferDrawMeshTasksIndirect", [cmd, rec]);
    e.finish(i);
    img = await e.read();
    t.rect(img, 0, 0, 32, 64, RED, "the guest's record {count 2, first 0}: workgroup 0"); t.rect(img, 32, 0, 64, 64, GREEN, "and workgroup 1");
    t.ok(!/\[RED\]/.test(e.g.logs.filter(l => !/geometry stage/.test(l)).join("\n")), `no red line: ${e.g.logs.filter(l => /\[RED\]/.test(l)).join(" | ")}`);
  } },
  { name: "global memory mirror: a stage follows 14 addresses into 14 buffers with three storage bindings (more ranges than a device has storage buffers a stage); stores land in guest memory, one named only by the write log a submission later; a miss reads 0; the table's hint; the mirror grows; a fragment stage reads the same ranges", async run(e, t) {
    const G = e.G, cmd = G.cmd, vs = await e.shader("vs_quad");
    const bufs = Array.from({ length: 12 }, (_, k) => { const w = new Uint32Array(4); w[k & 3] = (k + 1) * 3; return buffer(e, w); });   // sum 234
    const t12 = buffer(e, new Uint32Array(4)), t13 = buffer(e, new Uint32Array(4)), out = buffer(e, new Uint32Array([1, 9, 9, 9]));
    // a 5 MiB buffer in a pool of its own: it holds at least one whole 2 MiB chunk of guest memory, which gets a hint in the table
    const pool = G.pool(6 << 20, POOL_FLAGS.CPU_CACHED | POOL_FLAGS.GPU_CACHED), big = buffer(e, new Uint8Array(5 << 20), pool);
    const chunk = Math.ceil(big / (2 << 20)) * (2 << 20), off = chunk + 0x1000 - big;
    new Uint32Array(e.g.memory.buffer, big + off, 1)[0] = 0xc0ffee;
    const pw = new Uint32Array(32);
    [...bufs, t12, t13, big].forEach((a, k) => { pw[2 * k] = lo(a); pw[2 * k + 1] = hi(a); });
    pw[30] = off; pw[31] = 128;
    const ptrs = buffer(e, pw);
    const pointers = Array.from({ length: 15 }, (_, k) => ({ slot: 0, word: 2 * k, ...(k === 13 ? { write: true } : {}) }));
    const sum = G.program([await register(e, "cs_sum_gm", { stage: "compute", storage: gmStorage(true), extra: [gmExtra(2)], wgsl: CS_SUM,
      gmem: { pointers, slots: [{ slot: 0, write: false }, { slot: 1, write: true }], write: true, log: true } })]);
    const fsum = G.program([vs, await register(e, "fs_sum_gm", { stage: "fragment", outputs: [0], storage: gmStorage(false), extra: [gmExtra(1)], wgsl: FS_SUM,
      gmem: { pointers: pointers.slice(0, 12).map(p => ({ slot: 0, word: p.word })), slots: [{ slot: 0, write: false }] } })]);
    let i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], fsum); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferBindProgram", [cmd, sum, 0x20]);
    G.c("CommandBufferBindStorageBuffer", [cmd, STAGE.COMPUTE, 0, ptrs, 128]); G.c("CommandBufferBindStorageBuffer", [cmd, STAGE.COMPUTE, 1, out, 16]);
    G.c("CommandBufferDispatchCompute", [cmd, 1, 1, 1]);
    e.finish(i);
    await e.settle(); await e.settle();
    t.eq(u32s(e, out, 4), [235, 5, 0xc0ffee, 9], "the stage's own written slot, in the mirror: 1 + the sum of the 12 buffers; a miss read 0; the word in the large buffer");
    t.eq(u32s(e, t13, 2), [0, ~234 >>> 0], "the store through the address the record marks as stored through landed");
    t.eq(u32s(e, t12, 1), [0], "the store through the other address is not in guest memory yet: only the write log knows of it");
    t.ok(e.host.stats.gmemRanges === 17 && e.host.stats.gmemGrows >= 1, `17 ranges in the mirror (2 slots, 12 + 2 + 1 buffers), which grew for the large one: ${e.host.stats.gmemRanges} ranges, ${e.host.stats.gmemGrows} grows`);
    // the next submission: the range the log named is read back; a fragment stage reads the 12 buffers in a render pass
    i = G.acquire(e.win);
    G.begin(); e.frame(cmd, e.wtex[i], fsum); G.clear(cmd, [0, 0, 0, 1]);
    G.c("CommandBufferBindStorageBuffer", [cmd, STAGE.FRAGMENT, 0, ptrs, 128]);
    e.drawQuad(cmd);
    e.finish(i);
    const img = await e.read();
    t.rect(img, 0, 0, 64, 64, [234, 0, 128, 255], "the fragment stage's sum over 12 ranges, a miss as 0, a word of its own slot");
    await e.settle(); await e.settle();
    t.eq([u32s(e, t12, 1), e.host.stats.gmemLogged], [[234], 1], "the write log's range landed with the next submission");
    t.ok(!/\[RED\]/.test(e.g.logs.join("\n")), `no red line: ${e.g.logs.filter(l => /\[RED\]/.test(l)).join(" | ")}`);
  } },
];
