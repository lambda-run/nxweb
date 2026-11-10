// The fs module's embedder side: instantiates build/fs/fs.wasm, implements its storage imports over FsDevice
// objects and completes pending calls. No Node or browser APIs here; devices are in fs_dev_*.ts.
// See src/fs/README.md ("Storage interface").

export const FS_KIND = { ROM: 0, AOC: 1, SYSDATA: 2, SAVE: 3, DEVICE_SAVE: 4, CACHE: 5, TEMP: 6 } as const;
export const DEV = { OK: 0, PENDING: 1, NOT_FOUND: -1, IO: -2, NO_SPACE: -3 } as const;
export const FS_RES = { OK: 0, FAIL: 0x2A2, PATH_NOT_FOUND: 0x202, PATH_EXISTS: 0x402, TARGET_NOT_FOUND: 0x7D402 } as const;
export const FS_RETRY = -0x200000000n;          // 0xFFFFFFFE_00000000 as i64
export const fsIsPending = (r: bigint) => (r >> 32n) === -1n;
export const fsToken = (r: bigint) => Number(r & 0xFFFFFFFFn);

// One storage device: a RomFS image (read only) or a save container (read, write, flush).
// A save container must have readSync and write; its flush may be asynchronous. An image may have only readAsync.
export interface FsDevice {
  size(): number;
  // Fill dst from offset off. 0, or a negative DEV status (a read past the end is an error).
  readSync?(off: number, dst: Uint8Array): number;
  // The len bytes at off; rejects (or resolves to a shorter array) on error
  readAsync?(off: number, len: number): Promise<Uint8Array>;
  write?(off: number, src: Uint8Array): number;
  // Barrier: all writes so far are durable when it returns / resolves
  flush?(): number | Promise<number>;
  close?(): void;
}
export interface FsStorage {
  // The device of (kind, index): a save kind is created when it does not exist; an image that does not exist is
  // DEV.NOT_FOUND. May be asynchronous.
  open(kind: number, index: bigint): FsDevice | number | Promise<FsDevice | number>;
  // Delete a stored save container (DeleteCacheStorage)
  remove(kind: number, index: bigint): number | Promise<number>;
}

export interface FsExports {
  memory: WebAssembly.Memory;
  fs_init(arenaBase: number, arenaLen: number): void;
  fs_static_end(): number;
  fs_lookup(namePtr: number): number;
  fs_call(fnId: number, argsPtr: number): bigint;
  fs_complete(token: number, status: number): bigint;
  fs_set_program_id(id: bigint): void;
  fs_set_account_save(v: number): void;
  fs_fn_count(): number;
  fs_fn_name(id: number): number;
  fs_fn_name_len(id: number): number;
  fs_fn_is_stub(id: number): number;
  fs_save_state(kind: number, index: bigint): number;
  fs_save_generation(kind: number, index: bigint): bigint;
  fs_image_state(kind: number, index: bigint): number;
  fs_commit_count(): bigint;
  fs_mount_count(): number;
  fs_open_files(): number;
  fs_open_dirs(): number;
  fs_pending(): number;
  fs_arena_used(): number;
  fs_arena_size(): number;
  kit_cover_enable(on: number): void;
  [k: string]: unknown;
}

export interface FsHostOptions {
  // The shared linear memory, when the module was built with --importMemory
  memory?: WebAssembly.Memory;
  log?: (line: string) => void;
  // nxnative's front_save_failed: a save could not be written (errno)
  saveFailed?: (errno: number) => void;
  // A pending call finished: wake the guest thread parked under `token` with x0 = result. After every call of this,
  // make again the calls that returned FS_RETRY.
  completed?: (token: number, result: bigint) => void;
}

export class FsHost {
  readonly x: FsExports;
  readonly memory: WebAssembly.Memory;
  private devs = new Map<number, FsDevice>();
  private nextDev = 0x100;
  private storage: FsStorage;
  private opts: FsHostOptions;
  // Imports throw this to abandon a call (tests: the storage was killed)
  onImportError: ((e: unknown) => void) | undefined;

  constructor(module: WebAssembly.Module, storage: FsStorage, opts: FsHostOptions = {}) {
    this.storage = storage; this.opts = opts;
    const dec = new TextDecoder();
    const env: Record<string, unknown> = {
      log: (p: number, n: number) => { opts.log?.(dec.decode(new Uint8Array(this.memory.buffer, p >>> 0, n).slice())); },
      abort: () => { throw new Error("fs: abort"); },
    };
    if (opts.memory) env.memory = opts.memory;
    const fs = {
      dev_open: (kind: number, index: bigint, token: number): number => {
        const r = storage.open(kind, index);
        if (r instanceof Promise) {
          if (!token) return DEV.IO;
          this.park(token, r.then(d => this.adopt(d)));
          return DEV.PENDING;
        }
        return this.adopt(r);
      },
      dev_size: (dev: number): bigint => { const d = this.devs.get(dev); return d ? BigInt(d.size()) : BigInt(DEV.IO); },
      dev_read: (dev: number, off: bigint, ptr: number, len: number, token: number): number => {
        const d = this.devs.get(dev);
        if (!d) return DEV.IO;
        len >>>= 0; ptr >>>= 0;
        if (d.readSync) return d.readSync(Number(off), new Uint8Array(this.memory.buffer, ptr, len));
        if (!d.readAsync || !token) return DEV.IO;
        // the bytes are copied when they arrive: the memory may have grown (a new buffer) in between
        this.park(token, d.readAsync(Number(off), len).then(b => {
          if (b.length !== len) return DEV.IO;
          new Uint8Array(this.memory.buffer, ptr, len).set(b);
          return DEV.OK;
        }));
        return DEV.PENDING;
      },
      dev_write: (dev: number, off: bigint, ptr: number, len: number): number => {
        const d = this.devs.get(dev);
        if (!d || !d.write) return DEV.IO;
        return d.write(Number(off), new Uint8Array(this.memory.buffer, ptr >>> 0, len >>> 0));
      },
      dev_flush: (dev: number, token: number): number => {
        const d = this.devs.get(dev);
        if (!d) return DEV.IO;
        const r = d.flush ? d.flush() : DEV.OK;
        if (!(r instanceof Promise)) return r;
        if (!token) return DEV.IO;
        this.park(token, r);
        return DEV.PENDING;
      },
      dev_remove: (kind: number, index: bigint, token: number): number => {
        const r = storage.remove(kind, index);
        if (!(r instanceof Promise)) return r;
        if (!token) return DEV.IO;
        this.park(token, r);
        return DEV.PENDING;
      },
      save_failed: (err: number) => { opts.saveFailed?.(err); },
    };
    const inst = new WebAssembly.Instance(module, { env, fs } as WebAssembly.Imports);
    this.x = inst.exports as unknown as FsExports;
    this.memory = opts.memory ?? this.x.memory;
  }

  private adopt(d: FsDevice | number): number {
    if (typeof d === "number") return d < 0 ? d : DEV.IO;
    const id = this.nextDev++;
    this.devs.set(id, d);
    return id;
  }
  // The storage call under `token` is in flight: when it settles, resume the fs call that waits for it
  private park(token: number, p: Promise<number>): void {
    const done = (st: number) => {
      let r: bigint;
      try { r = this.x.fs_complete(token, st); }
      catch (e) { if (this.onImportError) { this.onImportError(e); return; } throw e; }
      if (fsIsPending(r)) return;   // it waits for its next storage call
      this.opts.completed?.(token, r);
    };
    p.then(done, () => done(DEV.IO));
  }

  // The names the module takes over, with whether each is answered by a stub
  names(): { id: number; name: string; stub: boolean }[] {
    const out = [];
    for (let id = 1; id <= this.x.fs_fn_count(); id++) {
      const p = this.x.fs_fn_name(id), n = this.x.fs_fn_name_len(id);
      out.push({ id, name: String.fromCharCode(...new Uint16Array(this.memory.buffer.slice(p, p + 2 * n))), stub: this.x.fs_fn_is_stub(id) !== 0 });
    }
    return out;
  }
  closeDevices(): void { for (const d of this.devs.values()) d.close?.(); this.devs.clear(); }
}

// ---- devices that need no platform API ----
// A growable in-memory device: temporary storage, and tests
export class MemDevice implements FsDevice {
  bytes: Uint8Array;
  length: number;
  constructor(init?: Uint8Array) { this.bytes = init ? init.slice() : new Uint8Array(0); this.length = this.bytes.length; }
  size(): number { return this.length; }
  readSync(off: number, dst: Uint8Array): number {
    if (off < 0 || off + dst.length > this.length) return DEV.IO;
    dst.set(this.bytes.subarray(off, off + dst.length));
    return DEV.OK;
  }
  write(off: number, src: Uint8Array): number {
    const end = off + src.length;
    if (end > this.bytes.length) { const b = new Uint8Array(Math.max(end, this.bytes.length * 2, 4096)); b.set(this.bytes.subarray(0, this.length)); this.bytes = b; }
    this.bytes.set(src, off);
    if (end > this.length) this.length = end;
    return DEV.OK;
  }
  flush(): number { return DEV.OK; }
  snapshot(): Uint8Array { return this.bytes.slice(0, this.length); }
}
// A RomFS image in a Blob or File: nothing is copied but the bytes a read asks for.
// In a Worker FileReaderSync reads synchronously; elsewhere reads are asynchronous (the fs call pends).
export class BlobDevice implements FsDevice {
  private blob: Blob;
  readSync?: (off: number, dst: Uint8Array) => number;
  constructor(blob: Blob, sync = typeof (globalThis as any).FileReaderSync === "function") {
    this.blob = blob;
    if (sync) {
      const reader = new (globalThis as any).FileReaderSync();
      this.readSync = (off, dst) => {
        if (off < 0 || off + dst.length > blob.size) return DEV.IO;
        try { dst.set(new Uint8Array(reader.readAsArrayBuffer(blob.slice(off, off + dst.length)))); return DEV.OK; }
        catch { return DEV.IO; }
      };
    }
  }
  size(): number { return this.blob.size; }
  async readAsync(off: number, len: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(off, off + len).arrayBuffer());
  }
}
// Storage with images from a table and every save in memory (nothing persists): tests, and a start without OPFS
export class MemStorage implements FsStorage {
  images = new Map<string, FsDevice>();
  saves = new Map<string, MemDevice>();
  static key(kind: number, index: bigint): string { return `${kind}:${index}`; }
  setImage(kind: number, index: bigint | number, dev: FsDevice): void { this.images.set(MemStorage.key(kind, BigInt(index)), dev); }
  open(kind: number, index: bigint): FsDevice | number {
    const k = MemStorage.key(kind, index);
    if (kind < FS_KIND.SAVE) return this.images.get(k) ?? DEV.NOT_FOUND;
    let d = this.saves.get(k);
    if (!d) this.saves.set(k, d = new MemDevice());
    return d;
  }
  remove(kind: number, index: bigint): number { this.saves.delete(MemStorage.key(kind, index)); return DEV.OK; }
}
