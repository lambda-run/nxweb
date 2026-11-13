// The mirror of global memory: where each guest range a shader may reach through a loaded address lies in ONE storage buffer, and the table of those ranges the
// translator's helpers search (src/shaders/spv.ts globalMemory; docs/gmem-mirror.md). This file is the bookkeeping only, with no WebGPU in it (the tests run it
// in Node): GfxHost owns the buffers, uploads, copies and read-backs.
//   Table (nxnative dmsh_abi.h DMSH_GMEM_MAP_*, the format the translator's code reads): GM_ENTRIES entries of 8 words
//   { start lo, start hi, end lo, end hi, delta lo, delta hi, hint, 0 }, sorted by start, disjoint; entry 0 is empty (start 0, end 0) and unused entries start
//   at ~0. delta = the range's byte offset in the mirror - its guest address (64-bit, two's complement), so guest address + delta is a byte offset into the
//   mirror. Word 6 of entry (chunk & 8191) is a hint for the 2 MiB chunk `chunk` of guest memory: chunk << 13 | index of an entry holding the whole chunk.
//   Ranges start and end on 4 bytes (a word of the mirror is a word of guest memory) and keep their address modulo 256 in the mirror (a part of a range can
//   be bound as a uniform, storage, vertex or index buffer where the guest's own alignment allows it).
//   The first GM_RESERVED bytes of the mirror belong to no range and stay zero: the base of a storage slot with nothing bound points there.
export const GM_ENTRIES = 8192, GM_ENTRY_WORDS = 8, GM_RESERVED = 256, GM_ALIGN = 256, GM_HINT_SHIFT = 21, GM_LOG_BYTES = 1024 + 2048;
// the write log's buffer: 256 words of the translator's bitmap, then the miss log (src/shaders/spv.ts gmemMissLog): 256 slots of {address lo, hi}, the slot a hash of
// the address's 64 KiB window
export const GM_MISS_WORD = 256, GM_MISS_SLOTS = 256, GM_MISS_WINDOW = 0x10000;

export interface GmRange {
  start: number; end: number;      // guest bytes [start, end)
  off: number;                     // the mirror offset of `start`
  alloc: number; span: number;     // the mirror bytes it holds: [alloc, alloc + span)
  hash: number;                    // of the guest bytes when the mirror last took them, or when a read-back last landed (NaN: never)
  checked: number;                 // the epoch the hash was last compared in
  used: number;                    // the submission it was last named in
  gpu: boolean; pending: number;   // a shader may have written it since the guest last had it; read-backs of it under way
  index: number;                   // its entry in the table last built
}

export class GmemMap {
  ranges: GmRange[] = [];          // sorted by start, disjoint
  size = GM_RESERVED;              // the mirror bytes in use (its high-water mark): the buffer is at least this long
  gen = 1;                         // changes with the set of ranges
  private free: { off: number; size: number }[] = [];
  private limbo: { off: number; size: number }[] = [];    // freed in this submission: commands already encoded may still read them
  limit: number;                   // the most bytes the mirror may take
  constructor(limit: number) { this.limit = limit; }

  // The range holding [addr, addr + size), or null
  find(addr: number, size: number): GmRange | null {
    const r = this.ranges[this.at(addr)];
    return r && r.start <= addr && addr + size <= r.end ? r : null;
  }
  // The index of the first range that ends above addr
  private at(addr: number): number {
    let lo = 0, hi = this.ranges.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.ranges[m].end > addr) hi = m; else lo = m + 1; }
    return lo;
  }
  private take(n: number): number {
    for (let k = 0; k < this.free.length; k++) {
      const f = this.free[k];
      if (f.size < n) continue;
      const off = f.off;
      if (f.size === n) this.free.splice(k, 1); else { f.off += n; f.size -= n; }
      return off;
    }
    if (this.size + n > this.limit) return -1;
    const off = this.size; this.size += n;
    return off;
  }
  // A range holding [addr, addr + size): the one there is, or a new one. Ranges it overlaps without lying in one are replaced by one over them all (`merged`:
  // the caller moves what only the mirror held of them). null: the mirror or the table is full
  place(addr: number, size: number): { r: GmRange; merged: GmRange[] } | null {
    let s = addr - addr % 4, e = Math.ceil((addr + size) / 4) * 4;
    const i = this.at(s);
    let j = i;
    while (j < this.ranges.length && this.ranges[j].start < e) j++;
    if (j === i + 1 && this.ranges[i].start <= s && this.ranges[i].end >= e) return { r: this.ranges[i], merged: [] };
    const merged = this.ranges.slice(i, j);
    if (merged.length) { s = Math.min(s, merged[0].start); e = Math.max(e, merged[merged.length - 1].end); }
    if (this.ranges.length - merged.length + 1 >= GM_ENTRIES) return null;
    const span = Math.ceil((e - s + (s % GM_ALIGN)) / GM_ALIGN) * GM_ALIGN, alloc = this.take(span);
    if (alloc < 0) return null;
    const r: GmRange = { start: s, end: e, off: alloc + s % GM_ALIGN, alloc, span, hash: NaN, checked: 0, used: 0, gpu: false, pending: 0, index: 0 };
    for (const o of merged) this.limbo.push({ off: o.alloc, size: o.span });
    this.ranges.splice(i, j - i, r); this.gen++;
    return { r, merged };
  }
  drop(r: GmRange): void {
    const i = this.ranges.indexOf(r);
    if (i < 0) return;
    this.ranges.splice(i, 1); this.limbo.push({ off: r.alloc, size: r.span }); this.gen++;
  }
  // A submission is over: what was freed in it may be given out again
  settle(): void {
    if (!this.limbo.length) return;
    this.free.push(...this.limbo); this.limbo = [];
    this.free.sort((a, b) => a.off - b.off);
    for (let k = this.free.length - 2; k >= 0; k--) { const a = this.free[k], b = this.free[k + 1]; if (a.off + a.size === b.off) { a.size += b.size; this.free.splice(k + 1, 1); } }
    const last = this.free[this.free.length - 1];
    if (last && last.off + last.size === this.size) { this.size = last.off; this.free.pop(); }
  }
  // The table as the shaders read it
  // va: the address a shader holds for a byte the replayer keeps at `a` (a replay's layout; identity in the page)
  table(va: (a: number) => number = a => a): Uint32Array {
    const t = new Uint32Array(GM_ENTRIES * GM_ENTRY_WORDS), lo = (v: number) => v >>> 0, hi = (v: number) => Math.floor(v / 4294967296) >>> 0;
    for (let k = this.ranges.length + 1; k < GM_ENTRIES; k++) { t[k * 8] = 0xffffffff; t[k * 8 + 1] = 0xffffffff; }
    this.ranges.forEach((r, n) => {
      const k = n + 1, vs = va(r.start), ve = vs + r.end - r.start, d = BigInt.asUintN(64, BigInt(r.off) - BigInt(vs));
      r.index = k;
      t[k * 8] = lo(vs); t[k * 8 + 1] = hi(vs); t[k * 8 + 2] = lo(ve); t[k * 8 + 3] = hi(ve);
      t[k * 8 + 4] = Number(d & 0xffffffffn); t[k * 8 + 5] = Number(d >> 32n);
    });
    // hints, after the entries (word 6 of an entry belongs to the chunk whose low bits are the entry's number, not to the entry)
    const C = 2 ** GM_HINT_SHIFT;
    for (const r of this.ranges) for (let c = Math.ceil(va(r.start) / C); (c + 1) * C <= va(r.start) + r.end - r.start && c < 2 ** 19; c++) t[(c & (GM_ENTRIES - 1)) * 8 + 6] = ((c << 13) | r.index) >>> 0;
    return t;
  }
}
