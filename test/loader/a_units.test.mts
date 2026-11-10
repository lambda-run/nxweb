// The pieces on their own: SHA-256 against node:crypto, the LZ4 block decompressor on hand-made blocks.
import { createHash } from "node:crypto";
import { test, fresh, eq, same, rng } from "./harness.mts";

const AT = 0x0500_0000;

test("sha256: every length 0..300 and some large ones match node:crypto", () => {
  const b = fresh(), mem = new Uint8Array(b.x.memory.buffer), r = rng(1);
  const lens = [...Array(301).keys(), 1000, 4095, 4096, 4097, 65536, 1_000_003];
  for (const n of lens) {
    for (let i = 0; i < n; i++) mem[AT + i] = r();
    b.x.ld_sha256(AT, n, AT + 0x200000);
    same(b.mem(AT + 0x200000, 32), new Uint8Array(createHash("sha256").update(mem.subarray(AT, AT + n)).digest()), `sha256 of ${n} bytes`);
  }
});

test("lz4: literals, matches, overlapping matches, long lengths", () => {
  const b = fresh(), mem = new Uint8Array(b.x.memory.buffer);
  const dec = (block: number[], cap: number): Uint8Array | number => {
    mem.set(block, AT); mem.fill(0xEE, AT + 0x10000, AT + 0x10000 + cap + 16);
    const n = b.x.ld_lz4(AT, block.length, AT + 0x10000, cap);
    for (let i = 0; i < 16; i++) if (mem[AT + 0x10000 + cap + i] !== 0xEE) throw new Error("wrote past the output's end");
    return n < 0 ? n : b.mem(AT + 0x10000, n);
  };
  const A = 0x41;
  eq(dec([], 10), new Uint8Array(0), "empty block");
  same(dec([0x30, 1, 2, 3], 3) as Uint8Array, Uint8Array.of(1, 2, 3), "literals only");
  // "A", then a match of 4 + 6 at distance 1 (the byte repeats itself), then 5 literals
  same(dec([0x16, A, 1, 0, 0x50, 1, 2, 3, 4, 5], 16) as Uint8Array, Uint8Array.of(...Array(11).fill(A), 1, 2, 3, 4, 5), "run by an overlapping match");
  // 4 literals, a match of 4 + 15 + 255 + 3 = 277 at distance 4, then one literal
  const long = dec([0x4F, 1, 2, 3, 4, 4, 0, 255, 3, 0x10, 9], 400) as Uint8Array;
  eq(long.length, 4 + 277 + 1, "long match length");
  for (let i = 0; i < 281; i++) if (long[i] !== 1 + (i & 3)) throw new Error(`long match: byte ${i}`);
  // 15 + 255 + 30 = 300 literals
  const lits = Array.from({ length: 300 }, (_, i) => i & 0xFF);
  same(dec([0xF0, 255, 30, ...lits], 300) as Uint8Array, Uint8Array.from(lits), "long literal length");
});

test("lz4: damaged blocks give -1 and write nothing outside the output", () => {
  const b = fresh(), mem = new Uint8Array(b.x.memory.buffer);
  const dec = (block: number[], cap: number): number => {
    mem.set(block, AT); mem.fill(0xEE, AT + 0x10000 - 16, AT + 0x10000 + cap + 16);
    const n = b.x.ld_lz4(AT, block.length, AT + 0x10000, cap);
    for (let i = 0; i < 16; i++) if (mem[AT + 0x10000 + cap + i] !== 0xEE || mem[AT + 0x10000 - 16 + i] !== 0xEE) throw new Error("wrote outside the output");
    return n;
  };
  eq(dec([0x30, 1, 2], 10), -1, "literals run past the input");
  eq(dec([0x30, 1, 2, 3], 2), -1, "literals run past the output");
  eq(dec([0x10, 1, 0, 0, 0x10, 2], 100), -1, "match at distance 0");
  eq(dec([0x10, 1, 2, 0, 0x10, 2], 100), -1, "match before the start of the output");
  eq(dec([0x10, 1, 1], 100), -1, "match offset cut short");
  eq(dec([0x1F, 1, 1, 0, 255, 255], 100000), -1, "match length cut short");
  eq(dec([0xF0, 255, 255], 100000), -1, "literal length cut short");
  eq(dec([0x1F, 1, 1, 0, 200, 0x10, 2], 100), -1, "match runs past the output");
  eq(dec([0xF0, ...Array(20).fill(255), 0], 100), -1, "literal length beyond the output, stopped while it is read");
  // a match that fills the output exactly, then the end: valid
  eq(dec([0x10, 7, 1, 0], 5), 5, "match ending the block exactly at the output's end");
});
