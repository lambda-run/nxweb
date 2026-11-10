// The alias region's two-level page table (src/kernel/mem.ts): leaves of 4096 pages made when a page is first
// stepped, scans that cross the parts without a leaf, the static pool's end and the embedder's arena; and, on a
// 64-bit memory, a layout far beyond 4 GB (heap 8 GB, alias region 6 GB).
import assert from "node:assert/strict";
import { test, Kernel, R, L, P, def, CFG, M64, HI } from "./harness.mts";

const PS = Object.fromEntries(def("alias_page").states.map((s, i) => [s, i])) as Record<string, number>;
const MB = 0x100000, GB = 1024 * MB, LEAF = 16 * MB;
const pages = (k: Kernel, map: boolean, a: number, n: number) => k.call(k.main, map ? 0x2C : 0x2D, a, n);
const info = (k: Kernel, id: number) => { assert.equal(k.call(k.main, 0x29, 0, id, 0, 0), 0); return Number(k.main.x(1)); };
function query(k: Kernel, a: number) {
  const out = k.alloc(64);
  assert.equal(k.call(k.main, 0x06, out, 0, a), 0);
  return { base: Number(k.r64(out)), size: Number(k.r64(out + 8)), state: k.r32(out + 16), perm: k.r32(out + 24) };
}
// A kernel with its own regions: the test layout's code and thread-local regions, then heap, stack and alias as given
function kernelWith(heap: number, heapSize: number, stack: number, stackSize: number, alias: number, aliasSize: number, pool: number): Kernel {
  const k = new Kernel({ main: false });
  const v = [L.code, L.codeSize, L.tls, L.tlsSize, heap, heapSize, stack, stackSize, alias, aliasSize, pool, L.used, 0, 0x0100000000001000n, 0, 0];
  const cfg = CFG - 0x1000;
  v.forEach((n, i) => k.dv.setBigUint64(cfg + 8 * i, BigInt(n), true));
  assert.equal(k.x.kernel_init(cfg), 0);
  const h = k.x.kernel_create_main_thread(BigInt(L.code), BigInt(L.code + 0x10000));
  k.main = k.byIndex(k.x.kernel_thread_index(h));
  return k;
}
const base = HI + 0x06000000;   // above the test layout

test("alias page table: leaves are made on demand, scans cross the parts without one", () => {
  const A = base + 0x02000000, size = 3 * GB, k = kernelWith(base, 16 * MB, base + 16 * MB, 16 * MB, A, size, 4 * GB - 1 - 0xFFF);
  assert.equal(k.x.kernel_alias_leaves(0), 0, "a new process has no leaf: every page is Fresh");
  assert.deepEqual(query(k, A + GB), { base: L.tls + L.tlsSize, size: A + size - L.tls - L.tlsSize, state: 0, perm: 0 }, "all free");
  // a page in the first leaf, three pages across the border of leaves 1 and 2, one page 2.5 GB up
  assert.equal(pages(k, true, A + 5 * P, P), 0);
  assert.equal(pages(k, true, A + 2 * LEAF - P, 3 * P), 0);
  const far = A + 2.5 * GB + 7 * P;
  assert.equal(pages(k, true, far, P), 0);
  assert.equal(k.x.kernel_alias_leaves(0), 4);
  assert.equal(k.count("aliasMapped"), 5 * P);
  k.check();
  k.u8.fill(0x6B, far, far + P);
  assert.deepEqual(query(k, A + 5 * P), { base: A + 5 * P, size: P, state: 5, perm: 3 });
  assert.deepEqual(query(k, A + 2 * LEAF), { base: A + 2 * LEAF - P, size: 3 * P, state: 5, perm: 3 }, "a mapped run over two leaves");
  // free runs between them: over pages of leaves that exist and over 2.4 GB that has none
  assert.deepEqual(query(k, A + LEAF), { base: A + 6 * P, size: 2 * LEAF - P - 6 * P, state: 0, perm: 0 });
  assert.deepEqual(query(k, A + GB), { base: A + 2 * LEAF + 2 * P, size: far - (A + 2 * LEAF + 2 * P), state: 0, perm: 0 });
  assert.deepEqual(query(k, far + P), { base: far + P, size: A + size - far - P, state: 0, perm: 0 }, "nothing was ever mapped above");
  assert.deepEqual(query(k, L.tls + L.tlsSize + P), { base: L.tls + L.tlsSize, size: A + 5 * P - L.tls - L.tlsSize, state: 0, perm: 0 }, "from outside the region: up to its first mapped page");
  assert.deepEqual([A, A + 5 * P, A + GB, far].map(a => k.x.kernel_alias_page_state(BigInt(a))), [PS.Fresh, PS.Mapped, PS.Fresh, PS.Mapped]);
  // unmap in the middle of nowhere makes a leaf (the page takes Fresh -Unmap-> Fresh) and changes nothing else
  assert.equal(pages(k, false, A + GB, 2 * P), 0);
  assert.equal(k.x.kernel_alias_leaves(0), 5);
  assert.equal(k.count("aliasMapped"), 5 * P);
  assert.equal(pages(k, false, far, P), 0);
  assert.equal(pages(k, true, far, P), 0);
  assert.ok(k.u8.subarray(far, far + P).every(b => b === 0), "a Stale page is zeroed when it is mapped again");
  assert.equal(pages(k, false, A, size), 0, "the whole region at once");
  assert.equal(k.count("aliasMapped"), 0);
  k.check();
  assert.deepEqual(k.red, []);
});

test("alias page table: beyond the static leaves a map needs the embedder's arena", () => {
  if (!M64) {
    // a 32-bit memory: the static leaves cover the largest alias region there is (3.5 GB), mapped whole
    const A = 0x10000000, size = 0xE0000000, k = kernelWith(base, 16 * MB, base + 16 * MB, 16 * MB, A, size, 4 * GB - 1 - 0xFFF);
    for (let a = A; a < A + size; a += LEAF) assert.equal(pages(k, true, a + 3 * P, P), 0);
    assert.equal(k.x.kernel_alias_leaves(0), 224); assert.equal(k.x.kernel_alias_leaves(1), 0);
    assert.equal(k.count("aliasMapped"), 224 * P);
    k.check(); assert.deepEqual(k.red, []);
    return;
  }
  const A = base + 0x02000000, size = 6 * GB, k = kernelWith(base, 16 * MB, base + 16 * MB, 16 * MB, A, size, 9 * GB);
  assert.equal(k.x.kernel_alias_leaves(1), 224);
  for (let i = 0; i < 224; i++) assert.equal(pages(k, true, A + i * LEAF + 9 * P, P), 0);
  assert.equal(k.x.kernel_alias_leaves(1), 0);
  assert.equal(pages(k, true, A + 224 * LEAF, P), R.OUT_OF_RES, "no leaf left");
  assert.equal(k.red.length, 1); assert.ok(k.red[0].startsWith("[RED] kernel: no memory for the alias region's page table"), k.red[0]);
  assert.equal(k.count("aliasMapped"), 224 * P);
  assert.equal(pages(k, true, A + 100 * LEAF, LEAF), 0, "pages of leaves that exist still map");
  // three leaves of host-side memory (here: in the test layout's code region)
  const arena = k.alloc(3 * 65536 + 16);
  assert.equal(k.x.kernel_alias_arena(arena, 3 * 65536 + 16), 3);
  assert.equal(pages(k, true, A + 224 * LEAF, P), 0);
  assert.equal(pages(k, true, A + size - 2 * LEAF + 5 * P, LEAF), 0, "two more leaves, at the top of the region");
  assert.equal(k.x.kernel_alias_leaves(0), 227); assert.equal(k.x.kernel_alias_leaves(1), 0);
  const top = A + size - 2 * LEAF + 5 * P;
  k.u8.fill(0x3C, top + LEAF - P, top + LEAF);
  assert.deepEqual(query(k, top + LEAF - 1), { base: top, size: LEAF, state: 5, perm: 3 });
  assert.equal(pages(k, true, A + 300 * LEAF, P), R.OUT_OF_RES);
  k.check();
});

test("layout beyond 4 GB (64-bit memory): heap 8 GB, alias 6 GB, a 9 GB pool; SetHeapSize 6.2 GB, MapMemory, QueryMemory", () => {
  if (!M64) return;
  // (placed high, the layout starts 6 GB up: a heap region of 6.5 GB and an alias region of 2.5 GB fit below 16 GB)
  const H = HI + 0x18000000, heapSize = HI ? 6.5 * GB : 8 * GB, S = H + heapSize, A = S + 256 * MB, aliasSize = HI ? 2.5 * GB : 6 * GB;
  const k = kernelWith(H, heapSize, S, 256 * MB, A, aliasSize, 9 * GB);
  assert.deepEqual([2, 3, 4, 5, 14, 15].map(i => info(k, i)), [A, aliasSize, H, heapSize, S, 256 * MB], "GetInfo: alias, heap and stack regions");
  assert.equal(info(k, 6), 9 * GB, "the pool");
  const want = 0x18ce00000;   // 6.2 GB in one call
  assert.equal(k.call(k.main, 0x01, 0, want), 0);
  assert.equal(Number(k.main.x(1)), H, "the heap's base");
  assert.equal(k.count("heap"), want);
  assert.equal(k.x.memory.buffer.byteLength >= H + want, true, "the memory reaches the heap's end");
  // a pattern at the bottom, in the middle and at the top (sparse: three pages touched)
  const at = [H, H + 0xC6700000, H + want - P];
  at.forEach((a, i) => { for (let j = 0; j < P; j += 8) k.w64(a + j, BigInt(a + j) * 0x9E3779B1n + BigInt(i)); });
  at.forEach((a, i) => { for (let j = 0; j < P; j += 8) assert.equal(k.r64(a + j), BigInt.asUintN(64, BigInt(a + j) * 0x9E3779B1n + BigInt(i))); });
  assert.deepEqual(query(k, H + want - 1), { base: H, size: want, state: 5, perm: 3 });
  assert.deepEqual(query(k, H + want), { base: H + want, size: A + aliasSize - H - want, state: 0, perm: 0 });
  assert.equal(k.call(k.main, 0x01, 0, heapSize + 2 * MB), R.OOM, "past the heap region");
  // an alias mapping above 8 GB of address space
  const m = A + aliasSize - 64 * MB;
  assert.ok(m > 8 * GB);
  assert.equal(pages(k, true, m, 4 * P), 0);
  for (let j = 0; j < 4 * P; j += 8) k.w64(m + j, BigInt(m + j) ^ 0x5555AAAA5555AAAAn);
  for (let j = 0; j < 4 * P; j += 8) assert.equal(k.r64(m + j), BigInt(m + j) ^ 0x5555AAAA5555AAAAn);
  assert.deepEqual(query(k, m + P), { base: m, size: 4 * P, state: 5, perm: 3 });
  assert.ok(k.u8.subarray(m - 0x1_0000_0000, m - 0x1_0000_0000 + 4 * P).every(b => b === 0), "nothing was written 4 GB lower");
  // a thread stack mapped from the top of the heap into the stack region
  const src = H + want - 16 * P;
  assert.equal(k.call(k.main, 0x04, S + 32 * P, src, 8 * P), 0);
  assert.deepEqual(query(k, S + 33 * P), { base: S + 32 * P, size: 8 * P, state: 0xB, perm: 3 });
  assert.equal(k.call(k.main, 0x05, S + 32 * P, src, 8 * P), 0);
  assert.equal(k.call(k.main, 0x01, 0, 2 * MB), 0, "the heap shrinks");
  assert.equal(k.call(k.main, 0x01, 0, want), 0);
  assert.equal(k.r64(at[2]), 0n, "and reads zero where it grows back");
  k.check();
  assert.deepEqual(k.red, []);
});
