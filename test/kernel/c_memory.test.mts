// Memory SVCs: SetHeapSize, QueryMemory, MapMemory / UnmapMemory, MapPhysicalMemory / UnmapPhysicalMemory, the
// permission stubs, GetInfo's memory values and the address-space layout.
// Ported from nxnative dm/host/tests: t_svc_memory.c (alias_lifecycle, device_shared_refused, ownership,
// module_sources, fragmented_queries, metadata_limit, heap_regrow) and t_heap_size.c (resize, used memory, the heap
// region and pool limits). Not ported, because they test the Apple host's page protection and files: concurrency,
// lazy_commit, dirty_integration, failures, release_fallback, file_rule, file_sweep, guest_helper, module_back_patch.
import assert from "node:assert/strict";
import { test, Kernel, R, L, END, P, def } from "./harness.mts";

const BAD = R.BAD_MEMORY;
const PS = Object.fromEntries(def("alias_page").states.map((s, i) => [s, i])) as Record<string, number>;
const pages = (k: Kernel, map: boolean, a: number | bigint, n: number | bigint) => k.call(k.main, map ? 0x2C : 0x2D, a, n);
const resize = (k: Kernel, n: number) => k.call(k.main, 0x01, 0, n);
const map = (k: Kernel, d: number | bigint, s: number | bigint, n: number) => k.call(k.main, 0x04, d, s, n);
const unmap = (k: Kernel, d: number, s: number, n: number) => k.call(k.main, 0x05, d, s, n);
const info = (k: Kernel, id: number) => { assert.equal(k.call(k.main, 0x29, 0, id, 0, 0), 0); return k.main.x(1); };
function query(k: Kernel, a: number | bigint) {
  const out = k.alloc(64);
  k.u8.fill(0xA7, out, out + 64);
  assert.equal(k.call(k.main, 0x06, out + 8, 0x55, a), 0);
  assert.equal(k.main.x(1), 0n, "PageInfo");
  assert.equal(k.u8[out + 7], 0xA7); for (let i = 48; i < 64; i++) assert.equal(k.u8[out + i], 0xA7, "MemoryInfo is 40 bytes");
  const o = out + 8, m = { base: Number(k.r64(o)), size: Number(k.r64(o + 8)), state: k.r32(o + 16), attr: k.r32(o + 20), perm: k.r32(o + 24) };
  assert.deepEqual([k.r32(o + 28), k.r32(o + 32), k.r32(o + 36)], [0, 0, 0], "IPC count, device count, padding");
  const addr = Number(BigInt(a));
  assert.ok(m.size > 0 && addr >= m.base && addr - m.base < m.size, "the segment holds the address");
  return m;
}
const expect = (k: Kernel, a: number | bigint, base: number, size: number, state: number, attr: number, perm: number) =>
  assert.deepEqual(query(k, a), { base, size, state, attr, perm }, `QueryMemory(0x${a.toString(16)})`);
const fill = (k: Kernel, a: number, n: number, v: number) => k.u8.fill(v, a, a + n);
const all = (k: Kernel, a: number, n: number, v: number) => k.u8.subarray(a, a + n).every(b => b === v);
const A = L.alias, S = L.stack, H = L.heap;

test("t_svc_memory alias_lifecycle: map, query, unmap, map again reads zero, argument checks", () => {
  const k = new Kernel();
  assert.equal(pages(k, true, A + 4 * P, 4 * P), 0);
  fill(k, A + 4 * P, 4 * P, 0x53);
  assert.equal(pages(k, true, A + 6 * P, 4 * P), 0);
  assert.equal(k.count("aliasMapped"), 6 * P, "only pages whose state changed count");
  expect(k, A + 7 * P, A + 4 * P, 6 * P, 5, 0, 3);
  expect(k, L.code, L.code, L.tls - L.code, 0, 0, 0);
  expect(k, L.tls + 5, L.tls, L.tlsSize, 0xC, 0, 3);
  expect(k, S, L.tls + L.tlsSize, A + 4 * P - L.tls - L.tlsSize, 0, 0, 0);     // no heap yet: free up to the first mapped alias page
  expect(k, A + 10 * P, A + 10 * P, END - A - 10 * P, 0, 0, 0);
  assert.ok(all(k, A + 4 * P, 4 * P, 0x53) && all(k, A + 8 * P, 2 * P, 0));
  assert.equal(pages(k, true, A + 4 * P, 6 * P), 0, "mapping mapped pages changes nothing");
  assert.ok(all(k, A + 4 * P, 4 * P, 0x53));
  assert.equal(pages(k, false, A + 5 * P, P), 0);
  expect(k, A + 5 * P, A + 5 * P, P, 0, 0, 0);
  expect(k, A + 6 * P, A + 6 * P, 4 * P, 5, 0, 3);
  expect(k, A + 4 * P, A + 4 * P, P, 5, 0, 3);
  assert.equal(k.x.kernel_alias_page_state(BigInt(A + 5 * P)), PS.Stale);
  assert.equal(pages(k, true, A + 5 * P, P), 0);
  assert.ok(all(k, A + 5 * P, P, 0), "a page mapped again reads zero");
  assert.ok(all(k, A + 4 * P, P, 0x53) && all(k, A + 6 * P, 2 * P, 0x53));
  assert.equal(pages(k, false, A, 16 * P), 0);
  assert.equal(pages(k, false, A, 16 * P), 0, "unmapping unmapped pages changes nothing");
  assert.equal(k.count("aliasMapped"), 0);
  assert.deepEqual([0, 4, 12].map(i => k.x.kernel_alias_page_state(BigInt(A + i * P))), [PS.Fresh, PS.Stale, PS.Fresh]);
  for (const [a, n] of [[A, 0], [A + 1, P], [A, P + 1], [A - P, P], [0xFFFFFFFFFFFFF000n, 2 * P], [A + L.aliasSize - P, 2 * P], [H, P]] as [number | bigint, number][]) {
    assert.equal(pages(k, true, a, n), BAD); assert.equal(pages(k, false, a, n), BAD);
  }
  assert.deepEqual(k.red, []);
  k.check();
});

test("t_svc_memory device_shared_refused: device-shared memory is not unmapped and not shrunk away", () => {
  const k = new Kernel(), share = (a: number, n: number, on: number) => k.x.kernel_device_share(BigInt(a), BigInt(n), on);
  assert.equal(pages(k, true, A, 16 * P), 0);
  fill(k, A, 16 * P, 0x6D);
  share(A + 4 * P, 4 * P, 1); share(A + 4 * P, 4 * P, 1);   // two pools over the same storage
  for (const [a, n] of [[A + 7 * P, 2 * P], [A, 16 * P], [A + 4 * P, 4 * P]]) assert.equal(pages(k, false, a, n), BAD);
  assert.equal(k.count("aliasMapped"), 16 * P);
  assert.ok(all(k, A, 16 * P, 0x6D));
  assert.equal(pages(k, false, A + 12 * P, 4 * P), 0); assert.equal(pages(k, false, A, 2 * P), 0);   // beside it: given back
  assert.equal(pages(k, true, A + 2 * P, 2 * P), 0); assert.equal(pages(k, true, A + 8 * P, 2 * P), 0);   // mapping over or next to it is allowed
  share(A + 4 * P, 4 * P, 0);
  assert.equal(pages(k, false, A + 4 * P, P), BAD, "the other pool still holds it");
  share(A + 4 * P, 4 * P, 0);
  assert.equal(pages(k, false, A, 16 * P), 0); assert.equal(k.count("aliasMapped"), 0);
  const MB = 1 << 20;
  assert.equal(resize(k, 4 * MB), 0);
  share(H + 3 * MB, P, 1);
  assert.equal(resize(k, 2 * MB), BAD); assert.equal(k.count("heap"), 4 * MB);
  share(H + 3 * MB, P, 0);
  share(H + MB, P, 1);
  assert.equal(resize(k, 2 * MB), 0, "below the new end: left alone");
  assert.equal(resize(k, 0), BAD);
  share(H + MB, P, 0);
  assert.equal(resize(k, 0), 0);
  share(H, P, 0);
  assert.deepEqual(k.red, [`[RED] kernel: device-shared memory 0x${H.toString(16)}+0x1000 removed but never registered`]);
});

test("t_svc_memory ownership: MapMemory borrows its source, UnmapMemory moves the bytes back, every refusal", () => {
  const k = new Kernel();
  assert.equal(pages(k, true, A, 16 * P), 0);
  fill(k, A, 16 * P, 0x34);
  assert.equal(map(k, S + P, A + P, 2 * P), 0);
  assert.ok(all(k, S + P, 2 * P, 0x34), "the stack holds the source's bytes");
  expect(k, A + P, A + P, 2 * P, 5, 1, 0);          // the borrowed source: Locked, no permissions
  expect(k, A, A, P, 5, 0, 3);
  expect(k, A + 3 * P, A + 3 * P, 13 * P, 5, 0, 3);
  expect(k, S + P, S + P, 2 * P, 0xB, 0, 3);        // the mapped stack
  assert.equal(map(k, S + 8 * P, A + 2 * P, P), BAD, "a source that is borrowed already");
  assert.equal(map(k, S + 2 * P, A + 8 * P, P), BAD, "a destination that is mapped already");
  assert.equal(pages(k, false, A, 4 * P), BAD, "unmapping under a borrowed source");
  // the SDK's StandardAllocator extends committed windows across existing stacks: mapping again keeps every byte
  assert.equal(pages(k, true, A, 4 * P), 0);
  assert.equal(pages(k, false, A, P), 0);
  assert.equal(pages(k, true, A, 4 * P), 0);
  assert.equal(pages(k, true, A + 15 * P, 2 * P), 0);
  expect(k, A + P, A + P, 2 * P, 5, 1, 0);
  assert.equal(k.u8[A + P], 0x34);
  { // the last page of the 64-bit address space: free, the page around it
    const out = k.alloc(40);
    assert.equal(k.call(k.main, 0x06, out, 0, 0xFFFFFFFFFFFFFFFFn), 0);
    assert.deepEqual([k.r64(out), k.r64(out + 8), k.r32(out + 16), k.r32(out + 24)], [0xFFFFFFFFFFFFF000n, 0x1000n, 0, 0]);
  }
  assert.equal(k.call(k.main, 0x02, A + P, P, 3), BAD, "SetMemoryPermission on a borrowed source");
  assert.equal(k.call(k.main, 0x03, A + P, P, 0, 0), BAD, "SetMemoryAttribute on a borrowed source");
  assert.equal(k.call(k.main, 0x02, A + 4 * P, P, 3), 0);
  assert.equal(k.call(k.main, 0x03, A + 4 * P, 0, 0, 0), 0);
  assert.equal(k.call(k.main, 0x02, 0xFFFFFFFFFFFFF000n, 2 * P, 3), BAD);
  assert.equal(unmap(k, S + P, A + P, P), BAD, "an unmap that is not the whole mapping");
  assert.equal(unmap(k, S + P, A + 4 * P, 2 * P), BAD, "or names another source");
  assert.equal(unmap(k, S + 4 * P, A + P, 2 * P), BAD, "or no mapping at all");
  fill(k, S + P, 2 * P, 0x76);
  assert.equal(unmap(k, S + P, A + P, 2 * P), 0);
  assert.ok(all(k, A + P, 2 * P, 0x76), "what the thread wrote on its stack is back in the source");
  expect(k, A + P, A, 17 * P, 5, 0, 3);
  assert.equal(pages(k, false, A, 17 * P), 0);
  assert.equal(map(k, S, A, P), BAD, "a source that is not mapped");
  assert.equal(map(k, S + 1, A, P), R.BAD_ADDR);
  assert.equal(map(k, S, A, 0), R.BAD_SIZE);
  assert.equal(map(k, S, A, P + 8), R.BAD_SIZE);
  assert.equal(map(k, A, A, P), R.BAD_REGION, "the destination must be in the stack region");
  assert.equal(map(k, S, 0xFFFFFFFFFFFFF000n, 2 * P), BAD);
  assert.equal(unmap(k, S + 1, A, P), R.BAD_ADDR);
  const MB = 1 << 20;
  assert.equal(resize(k, 4 * MB), 0);
  assert.equal(map(k, S, H + 3 * MB, P), 0);
  expect(k, H + 3 * MB, H + 3 * MB, P, 5, 1, 0);
  expect(k, H, H, 3 * MB, 5, 0, 3);
  assert.equal(resize(k, 2 * MB), BAD, "the heap does not shrink away under a mapped stack");
  assert.equal(k.count("heap"), 4 * MB);
  assert.equal(resize(k, 6 * MB), 0);
  k.u8[S] = 0x91;
  assert.equal(unmap(k, S, H + 3 * MB, P), 0);
  assert.equal(k.u8[H + 3 * MB], 0x91);
  assert.equal(resize(k, 0), 0);
  assert.equal(k.count("maps"), 0);
  assert.equal(k.red.length, 3, "the three refusals of well-formed requests are reported");
  assert.ok(k.red.every(l => l.startsWith("[RED] kernel: MapMemory refused (0x")));
  k.check();
});

test("QueryMemory on module images (t_svc_memory module_sources): code RX, read-only data R, data RW; data backs a stack", () => {
  const k = new Kernel(), base = L.code + 0x100000, add = (b: number, n: number, ro: number, da: number) => k.x.kernel_module_add(BigInt(b), BigInt(n), BigInt(ro), BigInt(da));
  assert.equal(add(base, 0x40000, 0x10000, 0x20000), 0);
  assert.equal(add(base + 0x40000, 0x20000, 0x8000, 0x8000), 1, "a second image right behind the first");
  expect(k, base + 0x123, base, 0x10000, 3, 0, 5);
  expect(k, base + 0x10000, base + 0x10000, 0x10000, 3, 0, 1);
  expect(k, base + 0x3FFFF, base + 0x20000, 0x20000, 4, 0, 3);
  expect(k, base + 0x40000, base + 0x40000, 0x8000, 3, 0, 5);
  expect(k, base + 0x48000, base + 0x48000, 0x18000, 4, 0, 3);
  // the SDK's exception unwinding walks back from the pc over Code+RX to find the module start: below it is free
  expect(k, base - 1, L.code, 0x100000, 0, 0, 0);
  expect(k, base + 0x60000, base + 0x60000, L.tls - base - 0x60000, 0, 0, 0);
  for (const bad of [[base, 0x1000, 0, 0], [base + 0x70001, 0x1000, 0, 0], [base + 0x70000, 0, 0, 0], [L.heap, 0x1000, 0, 0], [base + 0x70000, 0x2000, 0x2000, 0x1000], [base + 0x70000, 0x1000, 0, 0x2000]])
    assert.equal(add(bad[0], bad[1], bad[2], bad[3]), -1);
  // a thread stack carved out of a module's bss (FFX / X-2's launcher)
  assert.equal(map(k, S, base + 0x30000, P), 0);
  expect(k, base + 0x30000, base + 0x30000, P, 4, 1, 0);
  expect(k, base + 0x20000, base + 0x20000, 0x10000, 4, 0, 3);
  expect(k, base + 0x31000, base + 0x31000, 0xF000, 4, 0, 3);
  assert.equal(map(k, S + P, base, P), BAD, "code is no backing for a stack");
  assert.equal(map(k, S + P, base + 0x10000, P), BAD, "nor read-only data");
  assert.equal(k.x.kernel_module_remove(BigInt(base)), 0, "an image a stack borrows from stays");
  assert.equal(unmap(k, S, base + 0x30000, P), 0);
  assert.equal(k.x.kernel_module_remove(BigInt(base)), 1);
  assert.equal(k.x.kernel_module_remove(BigInt(base)), 0);
  expect(k, base, L.code, 0x140000, 0, 0, 0);
  expect(k, base + 0x40000, base + 0x40000, 0x8000, 3, 0, 5);
});

test("t_svc_memory fragmented_queries: every page of a randomly mapped range answers with its run", () => {
  const k = new Kernel(), N = 96, live = new Array<boolean>(N).fill(false);
  let seed = 12345;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  for (let round = 0; round < 60; round++) {
    const a = rnd(N), n = 1 + rnd(Math.min(8, N - a)), on = rnd(3) !== 0;
    assert.equal(pages(k, on, A + a * P, n * P), 0);
    for (let i = a; i < a + n; i++) live[i] = on;
    if (round % 6) continue;
    for (let i = 0; i < N; i++) {
      let b = i, e = i + 1;
      while (b > 0 && live[b - 1] === live[i]) b--;
      while (e < N && live[e] === live[i]) e++;
      const lo = !live[i] && b === 0 ? L.tls + L.tlsSize : A + b * P, hi = !live[i] && e === N ? END : A + e * P;
      expect(k, A + i * P, lo, hi - lo, live[i] ? 5 : 0, 0, live[i] ? 3 : 0);
    }
    assert.equal(k.count("aliasMapped"), live.filter(Boolean).length * P);
    k.check();
  }
});

test("t_svc_memory metadata_limit: the 4097th mapped stack is ResultOutOfResource, and a freed entry is usable", () => {
  const k = new Kernel(), MAX = 4096;
  assert.equal(pages(k, true, A, (MAX + 1) * P), 0);
  for (let i = 0; i < MAX; i++) assert.equal(map(k, S + i * P, A + i * P, P), 0);
  assert.equal(map(k, S + MAX * P, A + MAX * P, P), R.OUT_OF_RES);
  assert.equal(k.count("maps"), MAX);
  expect(k, A + MAX * P, A + MAX * P, P, 5, 0, 3);
  assert.equal(unmap(k, S + 123 * P, A + 123 * P, P), 0);
  assert.equal(map(k, S + 123 * P, A + MAX * P, P), 0);
  for (let i = 0; i < MAX; i++) assert.equal(unmap(k, S + i * P, A + (i === 123 ? MAX : i) * P, P), 0);
  assert.equal(pages(k, false, A, (MAX + 1) * P), 0);
  assert.equal(k.count("maps"), 0);
});

test("SetHeapSize (t_heap_size): the heap's base, used memory, the heap region and the pool, a heap that grows back reads zero", () => {
  const MB = 1 << 20;
  let k = new Kernel();
  assert.equal(resize(k, 2 * MB), 0);
  assert.equal(k.main.x(1), BigInt(H), "x1 = the heap's base");
  expect(k, H + MB, H, 2 * MB, 5, 0, 3);
  expect(k, H + 2 * MB, H + 2 * MB, END - H - 2 * MB, 0, 0, 0);
  assert.equal(info(k, 7), BigInt(2 * MB + L.used)); assert.equal(info(k, 22), BigInt(2 * MB + L.used));
  assert.equal(resize(k, 2 * MB), 0, "the same size again");
  fill(k, H + MB, MB, 0xEE);
  assert.equal(resize(k, MB), 0);
  assert.equal(resize(k, 0), 0);
  expect(k, H, L.tls + L.tlsSize, END - L.tls - L.tlsSize, 0, 0, 0);
  assert.equal(resize(k, 3 * MB), 0);
  assert.ok(all(k, H, 3 * MB, 0), "t_svc_memory heap_regrow: what an earlier heap held is gone");
  k.main.setX(1, 0x77);
  assert.equal(resize(k, L.heapSize + P), R.OOM, "larger than the heap region: ResultOutOfMemory (Tropical Freeze's binary search needs it)");
  assert.equal(k.count("heap"), 3 * MB);
  assert.equal(resize(k, L.heapSize), 0);
  assert.equal(info(k, 7), BigInt(L.heapSize + L.used));
  k.check();
  // the pool: heap + images (in 2 MB units) may not exceed it: ResultLimitReached, and games retry 2 MB lower
  k = new Kernel({ pool: 10 * MB });
  assert.equal(resize(k, 12 * MB), R.LIMIT);
  assert.equal(resize(k, 10 * MB), 0);
  assert.equal(k.x.kernel_module_add(BigInt(L.code), 0x3000n, 0x1000n, 0x2000n), 0);
  assert.equal(resize(k, 10 * MB), R.LIMIT);
  assert.equal(resize(k, 8 * MB), 0);
  assert.equal(info(k, 6), BigInt(10 * MB)); assert.equal(info(k, 21), BigInt(10 * MB));
});

test("mem_map_limit: maps past the application pool fail with ResultLimitReached and count as used memory", () => {
  const MB = 1 << 20, k = new Kernel({ pool: 10 * MB, flags: 1 });     // used memory reported: 4 MB
  assert.equal(resize(k, 2 * MB), 0);
  assert.equal(pages(k, true, A, 4 * MB), 0);
  assert.equal(info(k, 7), BigInt(10 * MB));
  assert.equal(pages(k, true, A + 4 * MB, P), R.LIMIT, "the pool is full: the SDK frees cached pages and retries");
  assert.equal(pages(k, true, A, 4 * MB), 0, "mapping what is mapped needs nothing");
  assert.equal(resize(k, 2 * MB + P), R.LIMIT);
  assert.equal(pages(k, false, A, MB), 0);
  assert.equal(pages(k, true, A + 4 * MB, P), 0);
  assert.equal(resize(k, 2 * MB + 0xFF000), 0);
  // without the key nothing limits the alias region but its size
  const free = new Kernel({ pool: 10 * MB });
  assert.equal(pages(free, true, A, 16 * MB), 0);
  assert.equal(info(free, 7), BigInt(L.used));
});

test("layout: GetInfo reports the regions; the default layout below 4 GB; invalid layouts are refused", () => {
  const k = new Kernel();
  assert.deepEqual([2, 3, 4, 5, 12, 13, 14, 15].map(i => Number(info(k, i))), [A, L.aliasSize, H, L.heapSize, L.code, END - L.code, S, L.stackSize]);
  const d = new Kernel({ defaults: true });
  const h = d.x.kernel_create_main_thread(0x08000000n, 0x78010000n);
  d.main = d.byIndex(d.x.kernel_thread_index(h));
  assert.deepEqual([2, 3, 4, 5, 12, 13, 14, 15, 6].map(i => Number(info(d, i))),
    [0x88000000, 0x77FF0000, 0x18000000, 0x60000000, 0x08000000, 0xF7FF0000, 0x78000000, 0x10000000, 0xCD500000]);
  assert.equal(Number(info(d, 20)), 0x17C00000);
  assert.equal(Number(d.dv.getBigUint64(d.main.ctx + 0x120, true)), 0x17C01000, "the main thread's ThreadLocalRegion");
  expect(d, 0x100, 0, P, 0, 0, 0);                       // below the guest address space: the page around it
  expect(d, 0x08000000, 0x08000000, 0x0FC00000, 0, 0, 0);
  expect(d, 0x90000000, 0x17C00000 + 0x400000, 0xFFFF0000 - 0x18000000, 0, 0, 0);
  // refused layouts
  const bad = (change: (v: bigint[]) => void, code: number) => {
    const x = new Kernel({ main: false });
    const v = [L.code, L.codeSize, L.tls, L.tlsSize, L.heap, L.heapSize, L.stack, L.stackSize, L.alias, L.aliasSize, L.pool, L.used, 0, 0, 0, 0].map(BigInt);
    change(v);
    const cfg = 0x017FE000; v.forEach((n, i) => x.dv.setBigUint64(cfg + 8 * i, n, true));
    assert.equal(x.x.kernel_init(cfg), code);
    assert.equal(x.red.length, 1); assert.ok(x.red[0].startsWith("[RED] kernel: invalid address-space layout"));
  };
  bad(v => { v[4] += 0x800n; }, 1);                      // not page-aligned
  bad(v => { v[5] = 0n; }, 2);                           // empty
  bad(v => { v[9] = 0x100000000n; }, 2);                 // past 0xFFFF0000
  bad(v => { v[6] = v[4] + 0x1000n; }, 3);               // the stack region inside the heap region
  bad(v => { v[8] = 0x10000000n; v[9] = 0xE0001000n; }, 4);   // an alias region over 3.5 GB
});
