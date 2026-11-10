// SHA-256 (FIPS 180-4), for the segment hashes of an NSO. One call over a byte range; static memory only.

const K: usize = memory.data<u32>([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const W: usize = memory.data(256);      // the message schedule, 64 words
const TAIL: usize = memory.data(128);   // the last one or two blocks, with the padding
const H: usize = memory.data(32);       // the state, 8 words

function block(p: usize): void {
  for (let i: usize = 0; i < 16; i++) store<u32>(W + (i << 2), bswap<u32>(load<u32>(p + (i << 2))));
  for (let i: usize = 16; i < 64; i++) {
    const w15 = load<u32>(W + ((i - 15) << 2)), w2 = load<u32>(W + ((i - 2) << 2));
    const s0 = rotr<u32>(w15, 7) ^ rotr<u32>(w15, 18) ^ (w15 >> 3);
    const s1 = rotr<u32>(w2, 17) ^ rotr<u32>(w2, 19) ^ (w2 >> 10);
    store<u32>(W + (i << 2), load<u32>(W + ((i - 16) << 2)) + s0 + load<u32>(W + ((i - 7) << 2)) + s1);
  }
  let a = load<u32>(H), b = load<u32>(H, 4), c = load<u32>(H, 8), d = load<u32>(H, 12);
  let e = load<u32>(H, 16), f = load<u32>(H, 20), g = load<u32>(H, 24), h = load<u32>(H, 28);
  for (let i: usize = 0; i < 64; i++) {
    const t1 = h + (rotr<u32>(e, 6) ^ rotr<u32>(e, 11) ^ rotr<u32>(e, 25)) + ((e & f) ^ (~e & g)) + load<u32>(K + (i << 2)) + load<u32>(W + (i << 2));
    const t2 = (rotr<u32>(a, 2) ^ rotr<u32>(a, 13) ^ rotr<u32>(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  store<u32>(H, load<u32>(H) + a); store<u32>(H, load<u32>(H, 4) + b, 4);
  store<u32>(H, load<u32>(H, 8) + c, 8); store<u32>(H, load<u32>(H, 12) + d, 12);
  store<u32>(H, load<u32>(H, 16) + e, 16); store<u32>(H, load<u32>(H, 20) + f, 20);
  store<u32>(H, load<u32>(H, 24) + g, 24); store<u32>(H, load<u32>(H, 28) + h, 28);
}

// The SHA-256 of [ptr, ptr + len), 32 bytes written at out
export function sha256(ptr: usize, len: u32, out: usize): void {
  store<u32>(H, 0x6a09e667); store<u32>(H, 0xbb67ae85, 4); store<u32>(H, 0x3c6ef372, 8); store<u32>(H, 0xa54ff53a, 12);
  store<u32>(H, 0x510e527f, 16); store<u32>(H, 0x9b05688c, 20); store<u32>(H, 0x1f83d9ab, 24); store<u32>(H, 0x5be0cd19, 28);
  const full = len & ~63;
  for (let i: u32 = 0; i < full; i += 64) block(ptr + <usize>i);
  const rest = len - full;
  memory.fill(TAIL, 0, 128);
  memory.copy(TAIL, ptr + <usize>full, rest);
  store<u8>(TAIL + <usize>rest, 0x80);
  const blocks: usize = rest < 56 ? 1 : 2;
  store<u64>(TAIL + blocks * 64 - 8, bswap<u64>(<u64>len << 3));
  block(TAIL);
  if (blocks == 2) block(TAIL + 64);
  for (let i: usize = 0; i < 8; i++) store<u32>(out + (i << 2), bswap<u32>(load<u32>(H + (i << 2))));
}
