// nxem: the fs worker (?fsworker=1). The game's file, read off the owner thread.
//
// With the fs module called by the guest threads themselves (fsdirect: every thread has an instance, one lock, the
// module's state in the shared memory), the one thing left on the owner was the storage: a guest thread's dev_read
// asked the owner, the owner read the container asynchronously, copied the bytes into the memory and completed the
// call, all between its other work (the replayer, the decoder's pictures). Here a dedicated worker does that:
//   - it holds the File and builds the same RomFS device as the owner (rom.ts), with FileReaderSync;
//   - a guest thread's dev_read of a RomFS device leaves { dev, offset, address, length, token, context block } in the
//     slot at NXW and returns "pending" (kernel/nx_guest.js $nxFs): no owner involved;
//   - the worker reads straight into the shared memory (8 MB at a time), takes the fs module's lock, completes the
//     call in ITS instance of the module (fs_complete: the module's state is in the memory), writes the result into
//     the caller's context block and wakes it with Atomics.notify.
// What the module asks for while the worker completes a call (another storage call) is answered here when it is a
// RomFS read, and by the owner otherwise, through the lock holder's request words, as for a guest thread.
// NXW: i32 +0 the slot (0 free, 1 a request; the worker empties it into its own queue)  +4 1: the worker serves  +8 how many RomFS device ids follow  +12.. the ids (4)
//      i64 +32 dev, offset, address, length, token, context block   f64 +96 reads, bytes, ms reading, longest read ms
import { NupTree } from "../../src/prepare/host/nup.ts";
import { gameBytes } from "./game_file.ts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { romDevice } from "./rom.ts";

const NXF = 0x1FF1F100, NXW = 0x1FF1F200, FS_MOD = 0x1FFA0000, CELL = 0x3F0, ME = 0x7FFFFFF2, CH = 8 << 20;
const say = (line: string) => (self as any).postMessage({ line });

(self as any).onmessage = async (e: MessageEvent) => {
  const d = e.data; if (!d || !d.start) return;
  try {
    const memory: WebAssembly.Memory = d.memory, buf = memory.buffer, i32 = new Int32Array(buf), u8 = new Uint8Array(buf), i64 = new BigInt64Array(buf), u64 = new BigUint64Array(buf), f64 = new Float64Array(buf);
    const t0 = performance.now();
    const prep = new PrepWasm(d.prep, say), sha256 = (b: Uint8Array) => prep.sha256(b);
    const tree = await NupTree.open(gameBytes(d.file, true), d.file.name, { sha256, log: say });
    const rom = await romDevice(tree, prep, { skipMovie: d.skipMovie === true });
    if (!rom.dev.readSync) throw new Error("no synchronous reads here (FileReaderSync)");
    // this worker's instance of the fs module (the build for further instances, as a guest thread's)
    const f = NXF / 4, q = NXF / 8, w = NXW / 4, pages = buf.byteLength / 65536;
    let ctxNow = 0;
    // Requests wait in a queue of this worker's own: the slot is emptied whenever it is looked at, also while this
    // worker waits for the module's lock. (A thread that holds that lock and finds the slot full waits for the slot;
    // if the worker then waited for the lock without emptying the slot, neither went on: the first version hung so.)
    const queue: number[][] = [];
    const take = () => { if (Atomics.load(i32, w) !== 1) return; const a = NXW / 8 + 4; queue.push([Number(i64[a + 1]), Number(i64[a + 2]), Number(i64[a + 3]), Number(i64[a + 4]), Number(i64[a + 5])]); Atomics.store(i32, w, 0); Atomics.notify(i32, w); };
    const lock = () => { for (let spin = 0; ; spin++) { if (Atomics.compareExchange(i32, f, 0, ME) === 0) return; take(); if (spin < 4000) continue; Atomics.add(i32, f + 1, 1); const z = Atomics.load(i32, f); if (z) Atomics.wait(i32, f, z, 1); Atomics.sub(i32, f + 1, 1); } };
    const unlock = () => { Atomics.store(i32, f, 0); if (Atomics.load(i32, f + 1)) Atomics.notify(i32, f, 1); };
    const ask = (kind: number, a: (number | bigint)[]): bigint => {   // the owner, as kernel/nx_guest.js $nxFs asks it
      for (let i = 0; i < 6; i++) i64[q + 4 + i] = i < a.length ? BigInt(a[i]) : 0n;
      i64[q + 10] = BigInt(ctxNow); i32[f + 3] = kind;
      Atomics.store(i32, f + 2, 1); Atomics.notify(i32, f + 2);
      for (let spin = 0; Atomics.load(i32, f + 2) !== 2; spin++) if (spin > 4000) Atomics.wait(i32, f + 2, 1, 5);
      const r = i64[q + 2];
      Atomics.store(i32, f + 2, 0);
      return r;
    };
    const isRom = (dev: number) => { for (let i = 0, n = Atomics.load(i32, w + 2); i < n && i < 4; i++) if (i32[w + 3 + i] === dev) return true; return false; };
    const stats = { reads: 0, bytes: 0, ms: 0, max: 0 };
    const read = (off: number, ptr: number, len: number): number => {
      const r0 = performance.now(); let st = 0;
      for (let o = 0; o < len && !st; o += CH) st = rom.dev.readSync!(off + o, u8.subarray(ptr + o, ptr + Math.min(len, o + CH)));
      const ms = performance.now() - r0; stats.reads++; stats.bytes += len; stats.ms += ms; if (ms > stats.max) stats.max = ms;
      f64[NXW / 8 + 12] = stats.reads; f64[NXW / 8 + 13] = stats.bytes; f64[NXW / 8 + 14] = stats.ms; f64[NXW / 8 + 15] = stats.max;
      return st;
    };
    const env = { memory, memory_size: () => pages, memory_grow: (n: number) => n ? -1 : pages, abort: () => { throw new Error("fs: abort"); },
      log: (p: bigint, n: number) => say("[fs] " + new TextDecoder().decode(u8.slice(Number(p), Number(p) + n))) };
    const fs = {
      dev_open: (kind: number, index: bigint, token: number) => Number(ask(0, [kind, index, token])),
      dev_size: (dev: number) => ask(1, [dev]),
      dev_read: (dev: number, off: bigint, ptr: bigint, len: number, token: number) => isRom(dev) ? read(Number(off), Number(ptr), len >>> 0) : Number(ask(2, [dev, off, ptr, len >>> 0, token])),
      dev_write: (dev: number, off: bigint, ptr: bigint, len: number) => Number(ask(3, [dev, off, ptr, len >>> 0])),
      dev_flush: (dev: number, token: number) => Number(ask(4, [dev, token])),
      dev_remove: (kind: number, index: bigint, token: number) => Number(ask(5, [kind, index, token])),
      save_failed: (err: number) => { ask(6, [err]); },
      arena_more: (n: bigint | number) => ask(7, [n]),
    };
    const x: any = new WebAssembly.Instance(new WebAssembly.Module(u8.slice(FS_MOD, FS_MOD + i32[f + 6])), { env, fs }).exports;
    say(`fs worker: up in ${(performance.now() - t0).toFixed(0)} ms (RomFS ${rom.root}: ${rom.files} files, tables in ${rom.ms.toFixed(0)} ms): a guest thread's RomFS read is read here, straight into the memory, and completed here; the owner is not asked`);
    Atomics.store(i32, w + 1, 1);
    let last = performance.now(), seen = 0;
    for (;;) {
      take();
      if (!queue.length) { Atomics.wait(i32, w, 0, 1000); take(); }
      if (queue.length) {
        const [off, ptr, len, token, ctx] = queue.shift()!;
        let st = -2; try { st = read(off, ptr, len); } catch (err) { say(`[RED] fs worker: a read of ${len} bytes at ${off} failed: ${(err as Error).message}`); }
        lock(); ctxNow = ctx;
        let r = 0x2A2n, ok = true;
        try { r = x.fs_complete(token, st); } catch (err) { ok = false; say(`[RED] fs worker: fs_complete failed: ${(err as Error).stack ?? err}`); }
        unlock();
        if (ok && (r >> 32n) === -1n) continue;   // it waits for a storage call the owner completes
        u64[ctx / 8] = BigInt.asUintN(64, r);
        Atomics.store(i32, (ctx + CELL) / 4, 1); Atomics.notify(i32, (ctx + CELL) / 4);
      }
      const now = performance.now();
      if (now - last > 10000 && stats.reads !== seen) { say(`fs worker, so far: ${stats.reads} reads, ${(stats.bytes / 1048576).toFixed(1)} MB, ${stats.ms.toFixed(0)} ms reading, longest ${stats.max.toFixed(1)} ms`); last = now; seen = stats.reads; }
    }
  } catch (err) { say(`[RED] fs worker: not started (${(err as Error).stack ?? err}): RomFS reads stay with the owner`); }
};
