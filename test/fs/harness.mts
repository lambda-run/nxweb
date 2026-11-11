// The fs tests' harness: fresh instances of build/fs/fs.wasm (its own memory is the guest memory), a scripted
// guest (each helper puts arguments in guest memory, makes the fs_call and reads the results back), storage that
// answers asynchronously on request, and storage that can be killed at any operation (fault.mts).
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { KIT_DIR } from "../../src/kit/host/defs.mts";
import { readMachines, type KitExports, type WasmMachine } from "../../src/kit/host/reader.mts";
import { FsHost, fsIsPending, fsToken, FS_RETRY, FS_KIND, DEV, type FsStorage, type FsDevice, type FsExports } from "../../src/glue/fs_host.ts";

import { writeStamp } from "../../src/kit/host/stamp.mts";
import { buildPair } from "../../tools/asc64/abi.mjs";
import { makeMemory64, MEM64_MAX_PAGES } from "../../src/glue/a64_host.ts";
export const ROOT = join(KIT_DIR, "..", "..");
// NX_MEM (tools/modes.mjs): "32" (default) fs.wasm, whose own memory is the guest memory; "64" fs64.wasm on a 64-bit
// memory made here; "64hi" the same with the scripted guest's memory (paths, read and write buffers, the structures
// the calls fill) above 4 GB. The arena is host-area memory in the runtime and stays low.
export const MEM_MODE = process.env.NX_MEM ?? "32";
export const M64 = MEM_MODE !== "32";
export const HI = MEM_MODE === "64hi" ? 0x1_8000_0000 : 0;
export const BEYOND = HI + 0xFFFF_FF00;   // an address outside the linear memory in every mode
export const WASM = join(ROOT, "build", "fs", M64 ? "fs64.wasm" : "fs.wasm");
export const SCRATCH = process.env.FS_TEST_TMP ?? join(ROOT, "build", "fs", "tmp");
export const NXNATIVE = process.env.NXNATIVE ?? "/home/user/nxnative";

export function build(): void {
  mkdirSync(dirname(WASM), { recursive: true });
  buildPair("src/fs/index.ts", join("build", "fs", "fs.wasm"), ["--runtime", "stub", "-O2"], { args64: ["--runtime", "stub", "-O2", "--importMemory"] });
  writeStamp(join(ROOT, "build", "fs", "fs.wasm")); writeStamp(join(ROOT, "build", "fs", "fs64.wasm"));
}

// Fn ids by nxnative's identifier (h_fs_<x>), from src/fs/names.ts
const namesSrc = readFileSync(join(ROOT, "src", "fs", "names.ts"), "utf8");
export const FN: Record<string, number> = Object.fromEntries([...namesSrc.matchAll(/^\s+(\w+) = (\d+),$/gm)].map(m => [m[1], Number(m[2])]));
export const MANGLED: string[] = [...namesSrc.matchAll(/^\s+"(_Z\w+)",$/gm)].map(m => m[1]);

export const R = { OK: 0, FAIL: 0x2A2, NOT_FOUND: 0x202, EXISTS: 0x402, TARGET_NOT_FOUND: 0x7D402 };
export const MODE = { R: 1, W: 2, A: 4 };
export const KIND = FS_KIND;
export const SAVE_S = ["Unmounted", "Recovering", "Clean", "Dirty", "Committing", "Sealing", "Poisoned", "ReadOnly"];

type Arg = number | bigint;
export interface Entry { name: Buffer; type: number; size: number }
export interface FsOptions { async?: boolean; arena?: number; guest?: number; cover?: boolean; more?: number }   // more: bytes the embedder can add to the arena (arenaMore)

let module: WebAssembly.Module | undefined;
const live: Fs[] = [];
let sum: Uint8Array[] | undefined;

export class Fs {
  host: FsHost;
  x: FsExports & KitExports;
  logs: string[] = [];
  saveFailed: number[] = [];
  private base: number; private top: number; private limit: number; private depth = 0;
  private waiters = new Map<number, (r: bigint) => void>();
  private retry: (() => void)[] = [];
  retries = 0; pendings = 0;
  moreGiven = 0; private moreAt = 0; private moreLeft = 0;

  constructor(storage: FsStorage, o: FsOptions = {}) {
    module ??= new WebAssembly.Module(readFileSync(WASM));
    const mem = M64 ? makeMemory64({ initial: 16, maximum: MEM64_MAX_PAGES }) : null;
    this.host = new FsHost(module, o.async ? new AsyncStorage(storage) : storage, {
      ...(mem ? { memory: mem.memory, memEnv: mem.imports() } : {}),
      log: l => { this.logs.push(l); if (process.env.FS_TEST_LOG) console.log("    | " + l); },
      saveFailed: e => { this.saveFailed.push(e); },
      arenaMore: n => { const a = this.moreAt; if (!a || n > this.moreLeft) return 0; this.moreAt += n; this.moreLeft -= n; this.moreGiven += n; return a; },
      completed: (token, r) => {
        const w = this.waiters.get(token); this.waiters.delete(token);
        w?.(r);
        for (const f of this.retry.splice(0)) f();
      },
    });
    this.x = this.host.x as FsExports & KitExports;
    const guest = o.guest ?? (8 << 20), arena = o.arena ?? (64 << 20);
    const end = Math.ceil(this.x.fs_static_end() / 0x10000) * 0x10000;
    const more = o.more ?? 0, lowTop = end + guest + arena + more;
    const have = this.host.memory.buffer.byteLength, top = HI ? Math.max(HI + guest, lowTop) : lowTop;
    if (more) { this.moreAt = HI ? end + arena : end + guest + arena; this.moreLeft = more; }
    if (top > have) { const n = Math.ceil((top - have) / 65536); if (mem) mem.grow(n); else this.x.memory.grow(n); }
    this.base = this.top = HI ? HI : end; this.limit = this.base + guest;
    this.x.fs_init(HI ? end : end + guest, arena);
    if (o.cover !== false) { this.x.kit_cover_enable(1); live.push(this); }
  }
  get red(): string[] { return this.logs.filter(l => l.startsWith("[RED] ")); }
  get dv(): DataView { return new DataView(this.host.memory.buffer); }
  get u8(): Uint8Array { return new Uint8Array(this.host.memory.buffer); }

  // ---- guest memory ----
  alloc(n: number): number {
    const p = this.top; this.top += (n + 15) & ~15;
    if (this.top > this.limit) throw new Error("the test's guest memory is used up");
    return p;
  }
  str(s: string | Uint8Array): number {
    const b = typeof s === "string" ? Buffer.from(s, "latin1") : s, p = this.alloc(b.length + 1);
    this.u8.set(b, p); this.u8[p + b.length] = 0;
    return p;
  }
  private enter(): void { this.depth++; }
  private leave(): void { if (--this.depth === 0) this.top = this.base; }

  // ---- calls ----
  lookup(name: string): number { const p = this.str(name); const r = this.x.fs_lookup(p); if (!this.depth) this.top = this.base; return r; }
  private raw(fn: number, args: Arg[]): bigint {
    const p = this.alloc(64), dv = this.dv;
    for (let i = 0; i < 8; i++) dv.setBigUint64(p + 8 * i, BigInt.asUintN(64, BigInt(args[i] ?? 0)), true);
    return this.x.fs_call(fn, p);
  }
  private static result(r: bigint): number {
    if (r < 0n || r > 0xFFFFFFFFn) throw new Error(`fs_call returned ${r}`);
    return Number(r);
  }
  // A call that must finish at once (synchronous storage)
  callSync(name: string, ...args: Arg[]): number {
    if (!(name in FN)) throw new Error(`no fs function ${name}`);
    const r = this.raw(FN[name], args);
    if (fsIsPending(r) || r === FS_RETRY) throw new Error(`${name}: pending / retry with synchronous storage`);
    return Fs.result(r);
  }
  // A call as a guest thread makes it: parked while it is pending, made again when it must be retried
  async call(name: string, ...args: Arg[]): Promise<number> {
    if (!(name in FN)) throw new Error(`no fs function ${name}`);
    this.enter();
    try {
      for (;;) {
        let r = this.raw(FN[name], args);
        if (fsIsPending(r)) { this.pendings++; const token = fsToken(r); r = await new Promise<bigint>(res => this.waiters.set(token, res)); }
        if (r === FS_RETRY) { this.retries++; await new Promise<void>(res => this.retry.push(res)); continue; }
        return Fs.result(r);
      }
    } finally { this.leave(); }
  }

  // ---- the scripted guest ----
  async open(path: string | Uint8Array, mode = MODE.R): Promise<[number, bigint]> {
    this.enter();
    try {
      const out = this.alloc(8); this.dv.setBigUint64(out, 0n, true);
      const r = await this.call("OpenFile", out, this.str(path), mode);
      return [r, this.dv.getBigUint64(out, true)];
    } finally { this.leave(); }
  }
  async read(h: bigint, off: Arg, len: number): Promise<[number, Buffer]> {
    this.enter();
    try {
      const out = this.alloc(8), buf = this.alloc(len + 16);
      this.u8.fill(0xEE, buf, buf + len + 16);
      this.dv.setBigUint64(out, 0xDEADn, true);
      const r = await this.call("ReadFile", out, h, off, buf, len);
      const got = Number(this.dv.getBigUint64(out, true));
      if (r === R.OK) {
        if (got > len) throw new Error(`ReadFile says ${got} bytes for a ${len}-byte buffer`);
        for (let i = got; i < len + 16; i++) if (this.u8[buf + i] !== 0xEE) throw new Error("ReadFile wrote past what it reported");
      }
      return [r, Buffer.from(this.u8.slice(buf, buf + (r === R.OK ? got : 0)))];
    } finally { this.leave(); }
  }
  async readExact(h: bigint, off: Arg, len: number): Promise<[number, Buffer]> {
    this.enter();
    try {
      const buf = this.alloc(len);
      const r = await this.call("ReadFileExact", h, off, buf, len);
      return [r, Buffer.from(this.u8.slice(buf, buf + len))];
    } finally { this.leave(); }
  }
  async write(h: bigint, off: Arg, data: Uint8Array): Promise<number> {
    this.enter();
    try {
      const buf = this.alloc(data.length || 1), opt = this.alloc(8);
      this.u8.set(data, buf);
      return await this.call("WriteFile", h, off, buf, data.length, opt);
    } finally { this.leave(); }
  }
  async size(h: bigint): Promise<[number, number]> {
    this.enter();
    try { const out = this.alloc(8); const r = await this.call("GetFileSize", out, h); return [r, Number(this.dv.getBigInt64(out, true))]; }
    finally { this.leave(); }
  }
  async close(h: bigint): Promise<void> { await this.call("CloseFile", h); }
  async path(name: string, path: string | Uint8Array, ...more: Arg[]): Promise<number> {
    this.enter();
    try { return await this.call(name, this.str(path), ...more); } finally { this.leave(); }
  }
  async rename(name: string, from: string, to: string): Promise<number> {
    this.enter();
    try { return await this.call(name, this.str(from), this.str(to)); } finally { this.leave(); }
  }
  async entryType(path: string | Uint8Array): Promise<[number, number]> {
    this.enter();
    try { const out = this.alloc(4); this.dv.setInt32(out, -9, true); const r = await this.call("GetEntryType", out, this.str(path)); return [r, this.dv.getInt32(out, true)]; }
    finally { this.leave(); }
  }
  async openDir(path: string | Uint8Array, mode = 3): Promise<[number, bigint]> {
    this.enter();
    try {
      const out = this.alloc(8); this.dv.setBigUint64(out, 0n, true);
      const r = await this.call("OpenDirectory", out, this.str(path), mode);
      return [r, this.dv.getBigUint64(out, true)];
    } finally { this.leave(); }
  }
  async readDir(h: bigint, max: number): Promise<[number, Entry[]]> {
    this.enter();
    try {
      const count = this.alloc(8), ents = this.alloc(0x310 * Math.max(max, 1) + 16);
      this.u8.fill(0xEE, ents, ents + 0x310 * Math.max(max, 1) + 16);
      const r = await this.call("ReadDirectory", count, ents, h, max);
      const n = Number(this.dv.getBigInt64(count, true)), out: Entry[] = [];
      if (n > max && max >= 0) throw new Error("ReadDirectory returned more entries than asked for");
      for (let i = 0; i < n; i++) {
        const e = ents + 0x310 * i, mem = this.u8;
        let len = 0; while (len < 0x301 && mem[e + len]) len++;
        for (let k = len; k < 0x304; k++) if (mem[e + k]) throw new Error("DirectoryEntry: bytes after the name");
        out.push({ name: Buffer.from(mem.slice(e, e + len)), type: this.dv.getInt8(e + 0x304), size: Number(this.dv.getBigInt64(e + 0x308, true)) });
      }
      for (let i = 0x310 * Math.max(n, 0); i < 0x310 * Math.max(max, 1) + 16; i++) if (this.u8[ents + i] !== 0xEE) throw new Error("ReadDirectory wrote past the entries it reported");
      return [r, out];
    } finally { this.leave(); }
  }
  async dirCount(h: bigint): Promise<[number, number]> {
    this.enter();
    try { const out = this.alloc(8); const r = await this.call("DirCount", out, h); return [r, Number(this.dv.getBigInt64(out, true))]; }
    finally { this.leave(); }
  }
  // Every entry of a directory (read in batches), or null when it cannot be opened
  async list(path: string | Uint8Array, mode = 3, batch = 5): Promise<Entry[] | null> {
    const [r, h] = await this.openDir(path, mode);
    if (r !== R.OK) return null;
    const out: Entry[] = [];
    for (;;) {
      const [rr, es] = await this.readDir(h, batch);
      if (rr !== R.OK) throw new Error(`ReadDirectory: ${rr.toString(16)}`);
      if (!es.length) break;
      out.push(...es);
    }
    await this.call("CloseDirectory", h);
    return out;
  }
  // The whole tree under a mount as "path -> d | f:<size>:<sha1>" (paths as latin1 strings), read through the API
  async tree(mount: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      const es = await this.list(`${mount}:/${dir}`);
      if (!es) throw new Error(`cannot list ${mount}:/${dir}`);
      for (const e of es) {
        const p = dir ? `${dir}/${e.name.toString("latin1")}` : e.name.toString("latin1");
        if (e.type === 0) { out.set(p, "d"); await walk(p); continue; }
        const [r, h] = await this.open(`${mount}:/${p}`);
        if (r !== R.OK) throw new Error(`cannot open ${p}: ${r.toString(16)}`);
        const [, data] = await this.read(h, 0, e.size + 8);
        await this.close(h);
        if (data.length !== e.size) throw new Error(`${p}: listed with ${e.size} bytes, read ${data.length}`);
        out.set(p, `f:${e.size}:${createHash("sha1").update(data).digest("hex")}`);
      }
    };
    await walk("");
    return out;
  }
  saveState(kind: number = KIND.SAVE, index = 0n): string { const s = this.x.fs_save_state(kind, index); return s < 0 ? "none" : SAVE_S[s]; }
  async mount(fn: string, name: string, ...more: Arg[]): Promise<number> { return this.path(fn, name, ...more); }
  async putFile(path: string, data: Uint8Array): Promise<void> {
    let [r, h] = await this.open(path, MODE.W);
    if (r === R.NOT_FOUND) {
      r = await this.path("CreateFile", path, 0);
      if (r !== R.OK) throw new Error(`CreateFile ${path}: ${r.toString(16)}`);
      [r, h] = await this.open(path, MODE.W);
    }
    if (r !== R.OK) throw new Error(`OpenFile ${path}: ${r.toString(16)}`);
    if ((r = await this.call("SetFileSize", h, 0)) !== R.OK || (r = await this.write(h, 0, data)) !== R.OK) throw new Error(`write ${path}: ${r.toString(16)}`);
    await this.close(h);
  }
  async getFile(path: string): Promise<Buffer | null> {
    const [r, h] = await this.open(path);
    if (r !== R.OK) return null;
    const [, n] = await this.size(h);
    const [, data] = await this.read(h, 0, n + 1);
    await this.close(h);
    return data;
  }
}
export const treeText = (t: Map<string, string>): string => [...t].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, v]) => `${p} ${v}`).join("\n");
export const fileEntry = (data: Uint8Array): string => `f:${data.length}:${createHash("sha1").update(data).digest("hex")}`;

// Storage whose every operation that may be asynchronous is: opens, image reads, flushes and removals resolve in a
// later microtask; save reads and writes stay synchronous (the interface requires that).
export class AsyncStorage implements FsStorage {
  private inner: FsStorage;
  constructor(inner: FsStorage) { this.inner = inner; }
  private static later<T>(f: () => T | Promise<T>): Promise<T> { return new Promise<void>(r => setImmediate(r)).then(f); }
  open(kind: number, index: bigint): Promise<FsDevice | number> {
    return AsyncStorage.later(async () => {
      const d = await this.inner.open(kind, index);
      if (typeof d === "number") return d;
      if (kind < FS_KIND.SAVE) {
        return { size: () => d.size(), close: () => d.close?.(),
          readAsync: (off: number, len: number) => AsyncStorage.later(async () => {
            if (d.readAsync) return d.readAsync(off, len);
            const b = new Uint8Array(len);
            if (d.readSync!(off, b) !== DEV.OK) throw new Error("read failed");
            return b;
          }) } as FsDevice;
      }
      return { size: () => d.size(), readSync: (o: number, b: Uint8Array) => d.readSync!(o, b), write: (o: number, b: Uint8Array) => d.write!(o, b),
        flush: () => AsyncStorage.later(() => (d.flush ? d.flush() : DEV.OK)), close: () => d.close?.() } as FsDevice;
    });
  }
  remove(kind: number, index: bigint): Promise<number> { return AsyncStorage.later(() => this.inner.remove(kind, index)); }
}

// ---- kit coverage of the fs machines, as the fs module itself drove them ----
export function harvest(): void {
  for (const f of live.splice(0)) {
    const ms = readMachines(f.x);
    sum ??= ms.map(m => new Uint8Array(m.hits.length));
    ms.forEach((m, i) => m.hits.forEach((h, c) => { if (h) sum![i][c] = 1; }));
  }
}
export function coverage(): { machines: WasmMachine[]; hits: Uint8Array[] } {
  harvest();
  const all = readMachines(new Fs({ open: () => DEV.NOT_FOUND, remove: () => DEV.OK }, { cover: false, arena: 1 << 16, guest: 1 << 16 }).x);
  const keep = all.map((m, i) => ({ m, i })).filter(e => e.m.name.startsWith("fs_"));
  return { machines: keep.map(e => e.m), hits: keep.map(e => sum?.[e.i] ?? new Uint8Array(e.m.hits.length)) };
}

export const tests: { name: string; fn: () => void | Promise<void> }[] = [];
export function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }
// Run a test body once with synchronous storage and once with asynchronous storage
export function both(name: string, fn: (async: boolean) => Promise<void>): void {
  test(`${name} [sync]`, () => fn(false));
  test(`${name} [async]`, () => fn(true));
}

// A small deterministic generator (the tests print their seeds)
export function rng(seed: number): { next(): number; int(n: number): number; bytes(n: number): Buffer; pick<T>(a: T[]): T } {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  return { next, int: n => Math.floor(next() * n), bytes: n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256); return b; },
    pick: a => a[Math.floor(next() * a.length)] };
}
export function python(args: string[], input?: string): string {
  return execFileSync("python3", [join(ROOT, "tools", "mkromfs.py"), ...args], { encoding: "utf8", maxBuffer: 1 << 30, input });
}
