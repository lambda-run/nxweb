// A fake guest for the graphics tests and the demo: linear memory with the recorder instantiated in it, a bump
// allocator for the "game's" objects and data, and `call(name, ints, floats)`, which makes one NVN call exactly as a
// game does: the name is resolved with nvn_lookup (as nvnBootstrapLoader would) and the arguments go into a block of
// x0..x7 and d0..d7. Nothing here reaches into the recorder. Works in Node and in the browser.
export interface GuestImports { gfx_exec(ptr: number, len: number): void }
export const GUEST_BASE = 0x0200_0000;      // the "game" lives from 32 MB up
export const ARENA_BASE = 0x0010_0000;      // the recorder's tables: 16 MB from 1 MB (its static data is at 64 KB)

export class Guest {
  memory: WebAssembly.Memory;
  x: any;
  logs: string[] = [];
  top = GUEST_BASE;
  private ids = new Map<string, number>();
  private args = 0;
  private nameBuf = 0;
  private callbacks: ((...a: bigint[]) => bigint | number | void)[] = [];
  calls = 0;

  static async create(wasm: BufferSource | WebAssembly.Module, imports: GuestImports, pages = 2048): Promise<Guest> {
    const g = new Guest();
    g.memory = new WebAssembly.Memory({ initial: pages });
    const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
    const dec = new TextDecoder();
    const inst = await WebAssembly.instantiate(module, { env: {
      memory: g.memory,
      log: (p: number, n: number) => g.logs.push(dec.decode(new Uint8Array(g.memory.buffer, p >>> 0, n))),
      abort: () => { throw new Error("abort"); },
      gfx_exec: (p: number, n: number) => imports.gfx_exec(p, n),
      // The recorder calls the game back (the command memory callback): fn is a fake code address
      gfx_guest_call: (fn: bigint, a0: bigint, a1: bigint, a2: bigint, a3: bigint) => BigInt(g.callbacks[Number(fn - 0xF000_0000n) >> 2](a0, a1, a2, a3) ?? 0),
      // nvnDeviceGetProcAddress: the "address" of an entry point is 0xE0000000 + id * 16 in this fake guest
      gfx_proc_address: (id: number) => 0xE000_0000 + id * 16,
    } });
    g.x = inst.exports;
    if (!g.x.gfx_init(ARENA_BASE, g.x.gfx_arena_bytes())) throw new Error("gfx_init failed");
    g.args = g.alloc(128); g.nameBuf = g.alloc(128);
    return g;
  }
  get dv() { return new DataView(this.memory.buffer); }
  get u8() { return new Uint8Array(this.memory.buffer); }
  alloc(n: number, align = 16): number { const p = (this.top + align - 1) & ~(align - 1); this.top = p + n; if (this.top > this.memory.buffer.byteLength) throw new Error("fake guest out of memory"); return p; }
  // A game function the recorder can call: the fake address to pass as the callback
  fn(f: (...a: bigint[]) => bigint | number | void): number { this.callbacks.push(f); return 0xF000_0000 + (this.callbacks.length - 1) * 4; }
  id(name: string): number {
    let id = this.ids.get(name);
    if (id === undefined) {
      const b = new TextEncoder().encode(name + "\0");
      this.u8.set(b, this.nameBuf);
      id = this.x.nvn_lookup(this.nameBuf) as number;
      this.ids.set(name, id);
    }
    return id;
  }
  call(name: string, ints: (number | bigint)[] = [], floats: number[] = []): number {
    const id = this.id(name);
    if (id < 0) throw new Error(`NVN has no ${name}`);
    const dv = this.dv;
    for (let i = 0; i < 8; i++) dv.setBigUint64(this.args + i * 8, i < ints.length ? BigInt.asUintN(64, BigInt(ints[i])) : 0xDEAD_0000_0000_0000n + BigInt(i), true);   // unused registers hold junk, as in a real call
    for (let i = 0; i < 8; i++) { dv.setBigUint64(this.args + 64 + i * 8, 0x7FF8_DEAD_0000_0000n, true); if (i < floats.length) dv.setFloat32(this.args + 64 + i * 8, floats[i], true); }
    this.calls++;
    return Number(BigInt.asUintN(64, this.x.nvn_call(id, this.args)));
  }
  // Data the game has in memory
  f32(v: number[]): number { const p = this.alloc(v.length * 4); new Float32Array(this.memory.buffer, p, v.length).set(v); return p; }
  u32(v: number[]): number { const p = this.alloc(v.length * 4); new Uint32Array(this.memory.buffer, p, v.length).set(v); return p; }
  u64(v: (number | bigint)[]): number { const p = this.alloc(v.length * 8, 8); v.forEach((x, i) => this.dv.setBigUint64(p + i * 8, BigInt(x), true)); return p; }
  bytes(v: ArrayLike<number>): number { const p = this.alloc(v.length); this.u8.set(v as any, p); return p; }
  red(): string[] { return this.logs.filter(l => l.startsWith("[RED] ")); }
}
