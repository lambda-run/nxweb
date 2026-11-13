// The mirror of global memory's bookkeeping (src/glue/gfx_gmem.ts GmemMap; docs/gmem-mirror.md), without a GPU: where ranges are placed, what overlapping
// ranges become, what is given back, and the table: searched here the way the translator's helper searches it (nxnative GlobalToStorage.cs
// TryGenerateRawStorageOp: the hint of the address's 2 MiB chunk, else 13 steps of binary search, then the end test), every guest address must come out at
// its byte in the mirror and every address outside the ranges must miss.
import assert from "node:assert/strict";
import { test } from "./harness.mts";
import { GmemMap, GM_ENTRIES, GM_RESERVED } from "../../src/glue/gfx_gmem.ts";

// The helper's search on a table: the mirror byte of address a, or -1 for a miss. `how` counts hint and search hits
function lookup(t: Uint32Array, a: number, how = { hint: 0, search: 0 }): number {
  const lo = a >>> 0, hi = Math.floor(a / 4294967296) >>> 0, W = (e: number, w: number) => t[e * 8 + w];
  const atOrBelow = (h: number, l: number) => h < hi || (h === hi && l <= lo), below = (h: number, l: number) => hi < h || (hi === h && lo < l);
  const chunk = ((hi << 11) | (lo >>> 21)) >>> 0, hint = W(chunk & 8191, 6), hintIndex = hint & 8191;
  let sel: number;
  if (hintIndex !== 0 && (hint >>> 13) === chunk && hi < 256) { sel = hintIndex; how.hint++; }
  else { sel = 0; for (let step = 4096; step; step >>= 1) if (atOrBelow(W(sel + step, 1), W(sel + step, 0))) sel += step; how.search++; }
  if (!below(W(sel, 3), W(sel, 2))) return -1;
  return Number((BigInt(a) + (BigInt(W(sel, 5)) << 32n | BigInt(W(sel, 4)))) & 0xffffffffffffffffn);
}

test("gmem mirror: ranges are placed 4-byte aligned at their address modulo 256, found again, merged when they overlap, and the table sends every address to its mirror byte", () => {
  const g = new GmemMap(64 << 20);
  const a = g.place(0x1_0000_1003, 10)!;                      // above 4 GiB, unaligned
  assert.deepEqual([a.r.start, a.r.end, a.merged.length], [0x1_0000_1000, 0x1_0000_1010, 0]);
  assert.equal(a.r.off % 256, 0x1_0000_1000 % 256); assert.ok(a.r.off >= GM_RESERVED, "the first 256 bytes belong to no range");
  const b = g.place(0x2000_0040, 0x300)!;
  assert.equal(b.r.off % 256, 0x40, "the address modulo 256 is kept");
  assert.equal(g.place(0x2000_0100, 16)!.r, b.r, "a range inside one that is placed is that one"); assert.equal(g.find(0x2000_0100, 16), b.r);
  assert.equal(g.find(0x2000_0330, 32), null, "one that runs past its end is not in it");
  const gen = g.gen;
  const c = g.place(0x2000_0330, 0x100)!;                     // overlaps b's tail
  assert.deepEqual([c.r.start, c.r.end, c.merged], [0x2000_0040, 0x2000_0430, [b.r]], "overlap: one range over both, the old one handed back");
  assert.ok(g.gen > gen); assert.equal(g.ranges.length, 2);
  // a 5 MiB range: two whole 2 MiB chunks get hints
  const big = g.place(0x4010_0000, 5 << 20)!.r;
  const t = g.table(), how = { hint: 0, search: 0 };
  assert.equal(t.length, GM_ENTRIES * 8); assert.deepEqual(Array.from(t.subarray(0, 8)), [0, 0, 0, 0, 0, 0, t[6], 0], "entry 0 is empty");
  assert.deepEqual([t[(g.ranges.length + 1) * 8], t[(g.ranges.length + 1) * 8 + 1]], [0xffffffff, 0xffffffff], "unused entries start at ~0");
  for (const r of g.ranges) for (const p of [r.start, r.start + 1, r.start + ((r.end - r.start) >> 1), r.end - 1]) assert.equal(lookup(t, p, how), r.off + p - r.start, `0x${p.toString(16)}`);
  for (const p of [0, 0xfff, 0x2000_003f, 0x2000_0430, 0x1_0000_0fff, 0x1_0000_1010, big.end, 2 ** 40]) assert.equal(lookup(t, p), -1, `0x${p.toString(16)} is in no range`);
  assert.equal(lookup(t, 0x4020_0000 + 12345, how), big.off + 0x4020_0000 + 12345 - big.start);
  assert.ok(how.hint >= 2 && how.search >= 6, `both the hint and the search were taken (${how.hint} / ${how.search})`);
});

test("gmem mirror: freed space returns after the submission, the limit and the table's 8191 ranges are refused, ranges sort by address", () => {
  const g = new GmemMap(GM_RESERVED + 2 * 4096);
  const a = g.place(0x10000, 4096)!.r, b = g.place(0x8000, 4096)!.r;
  assert.deepEqual(g.ranges, [b, a], "sorted by start");
  assert.equal(g.place(0x20000, 4096), null, "over the limit: not placed");
  g.drop(a);
  assert.equal(g.place(0x20000, 4096), null, "what was freed in this submission is not given out yet (encoded commands may read it)");
  g.settle();
  const c = g.place(0x20000, 4096)!.r;
  assert.equal(c.off, a.off, "after the submission the space is used again");
  g.drop(b); g.drop(c); g.settle();
  assert.equal(g.size, GM_RESERVED, "an empty mirror shrinks to its reserved bytes");
  const many = new GmemMap(1 << 30);
  for (let k = 0; k < GM_ENTRIES - 1; k++) assert.ok(many.place(0x100000 + k * 512, 16), `range ${k}`);
  assert.equal(many.place(0x100000 + GM_ENTRIES * 512, 16), null, "the table holds 8191 ranges");
  const t = many.table();
  assert.equal(lookup(t, 0x100000 + 8190 * 512 + 15), many.ranges[8190].off + 15, "the last entry is found");
});
