// LZ4 block decompression (the format of a compressed NSO segment). Every read is checked against the end of the
// input and every write against the end of the output: a damaged block gives -1, never a read or write outside.

// Decompress the block [src, src + srcLen) to [dst, dst + dstCap). Returns the number of bytes produced, or -1 when the
// block is damaged or would produce more than dstCap. The caller compares the result with the size it expects.
export function lz4Decompress(src: usize, srcLen: u32, dst: usize, dstCap: u32): i32 {
  let s = src, d = dst;
  const sEnd = src + <usize>srcLen, dEnd = dst + <usize>dstCap;
  while (s < sEnd) {
    const tok = <u32>load<u8>(s++);
    // literals
    let ll: u64 = tok >> 4;
    if (ll == 15) {
      let b: u32;
      do {
        if (s >= sEnd) return -1;
        b = load<u8>(s++);
        ll += b;
        if (ll > <u64>dstCap) return -1;
      } while (b == 255);
    }
    if (ll > <u64>(sEnd - s) || ll > <u64>(dEnd - d)) return -1;
    memory.copy(d, s, <usize>ll);
    s += <usize>ll; d += <usize>ll;
    if (s == sEnd) break;   // the last sequence is literals only
    // match
    if (sEnd - s < 2) return -1;
    const off = <usize>load<u16>(s);
    s += 2;
    if (off == 0 || off > d - dst) return -1;
    let ml: u64 = tok & 15;
    if (ml == 15) {
      let b: u32;
      do {
        if (s >= sEnd) return -1;
        b = load<u8>(s++);
        ml += b;
        if (ml > <u64>dstCap) return -1;
      } while (b == 255);
    }
    ml += 4;
    if (ml > <u64>(dEnd - d)) return -1;
    const n = <usize>ml;
    if (off >= n) memory.copy(d, d - off, n);
    else for (let i: usize = 0; i < n; i++) store<u8>(d + i, load<u8>(d + i - off));   // overlapping: the match repeats itself
    d += n;
  }
  return <i32>(d - dst);
}
