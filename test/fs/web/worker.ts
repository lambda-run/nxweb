// The browser side of `npm run fs:browser`: runs in a Worker of a cross-origin-isolated page. The save engine on
// real OPFS (synchronous access handles), RomFS reads through a Blob (FileReaderSync and asynchronous slices), and
// the scenario browser.mts kills by reloading the page in the middle of a commit.
import { FsHost, fsIsPending, fsToken, FS_RETRY, FS_KIND, DEV, BlobDevice, MemStorage, type FsStorage, type FsDevice } from "../../../src/glue/fs_host.ts";
import { OpfsStorage } from "../../../src/glue/fs_dev_opfs.ts";

const R = { OK: 0, FAIL: 0x2A2, NOT_FOUND: 0x202, EXISTS: 0x402 };
const SAVE_S = ["Unmounted", "Recovering", "Clean", "Dirty", "Committing", "Sealing", "Poisoned", "ReadOnly"];
type Arg = number | bigint;
const enc = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
const dec = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return s; };
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
function fnv(b: Uint8Array): string { let h = 0x811c9dc5; for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }
function check(cond: unknown, what: string): asserts cond { if (!cond) throw new Error(what); }
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  return { int: (n: number) => Math.floor(next() * n), bytes: (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)), pick: <T>(a: T[]) => a[Math.floor(next() * a.length)] };
}

let module: WebAssembly.Module, FN: Record<string, number>;

// A scripted guest (the Node tests' harness in small)
class Guest {
  host: FsHost; logs: string[] = []; saveFailed: number[] = []; pendings = 0;
  private base: number; private top: number;
  private waiters = new Map<number, (r: bigint) => void>(); private retry: (() => void)[] = [];
  constructor(storage: FsStorage) {
    this.host = new FsHost(module, storage, {
      log: l => this.logs.push(l), saveFailed: e => this.saveFailed.push(e),
      completed: (t, r) => { const w = this.waiters.get(t); this.waiters.delete(t); w?.(r); for (const f of this.retry.splice(0)) f(); },
    });
    const x = this.host.x, end = (x.fs_static_end() + 0xFFFF) & ~0xFFFF;
    x.memory.grow(Math.ceil((end + (48 << 20) - x.memory.buffer.byteLength) / 65536));
    this.base = this.top = end;
    x.fs_init(end + (16 << 20), 32 << 20);
  }
  get u8() { return new Uint8Array(this.host.memory.buffer); }
  get dv() { return new DataView(this.host.memory.buffer); }
  alloc(n: number) { const p = this.top; this.top += (n + 15) & ~15; return p; }
  str(s: string) { const b = enc(s), p = this.alloc(b.length + 1); this.u8.set(b, p); this.u8[p + b.length] = 0; return p; }
  async call(name: string, ...args: Arg[]): Promise<number> {
    for (;;) {
      const p = this.alloc(64);
      for (let i = 0; i < 8; i++) this.dv.setBigUint64(p + 8 * i, BigInt.asUintN(64, BigInt(args[i] ?? 0)), true);
      let r = this.host.x.fs_call(FN[name], p);
      if (fsIsPending(r)) { this.pendings++; const t = fsToken(r); r = await new Promise<bigint>(res => this.waiters.set(t, res)); }
      if (r === FS_RETRY) { await new Promise<void>(res => this.retry.push(res)); continue; }
      return Number(r);
    }
  }
  reset() { this.top = this.base; }
  state(kind: number = FS_KIND.SAVE, index = 0n) { const s = this.host.x.fs_save_state(kind, index); return s < 0 ? "none" : SAVE_S[s]; }
  async path(fn: string, path: string, ...more: Arg[]) { this.reset(); return this.call(fn, this.str(path), ...more); }
  async open(path: string, mode = 1): Promise<[number, bigint]> { this.reset(); const out = this.alloc(8); const r = await this.call("OpenFile", out, this.str(path), mode); return [r, this.dv.getBigUint64(out, true)]; }
  async put(path: string, data: Uint8Array) {
    let [r, h] = await this.open(path, 6);
    if (r === R.NOT_FOUND) { check(await this.path("CreateFile", path, 0) === R.OK, `create ${path}`); [r, h] = await this.open(path, 6); }
    check(r === R.OK, `open ${path}: ${r.toString(16)}`);
    const buf = this.alloc(data.length || 1); this.u8.set(data, buf);
    check(await this.call("SetFileSize", h, 0) === R.OK && await this.call("WriteFile", h, 0, buf, data.length, 0) === R.OK, `write ${path}`);
    await this.call("CloseFile", h);
  }
  async writeAt(path: string, off: number, data: Uint8Array) {
    const [r, h] = await this.open(path, 7); check(r === R.OK, `open ${path}`);
    const buf = this.alloc(data.length || 1); this.u8.set(data, buf);
    check(await this.call("WriteFile", h, off, buf, data.length, 0) === R.OK, `write ${path}`);
    await this.call("CloseFile", h);
  }
  async readAt(h: bigint, off: number, len: number): Promise<Uint8Array> {
    const out = this.alloc(8), buf = this.alloc(len || 1);
    check(await this.call("ReadFile", out, h, off, buf, len) === R.OK, "read");
    return this.u8.slice(buf, buf + Number(this.dv.getBigUint64(out, true)));
  }
  async get(path: string): Promise<Uint8Array | null> {
    const [r, h] = await this.open(path);
    if (r !== R.OK) return null;
    const out = this.alloc(8); await this.call("GetFileSize", out, h);
    const d = await this.readAt(h, 0, Number(this.dv.getBigUint64(out, true)) + 1);
    await this.call("CloseFile", h);
    return d;
  }
  async list(path: string): Promise<{ name: string; type: number; size: number }[]> {
    this.reset();
    const out = this.alloc(8), count = this.alloc(8), ents = this.alloc(0x310 * 8), res = [];
    check(await this.call("OpenDirectory", out, this.str(path), 3) === R.OK, `open directory ${path}`);
    const h = this.dv.getBigUint64(out, true);
    for (;;) {
      check(await this.call("ReadDirectory", count, ents, h, 8) === R.OK, "read directory");
      const n = Number(this.dv.getBigInt64(count, true));
      if (!n) break;
      for (let i = 0; i < n; i++) {
        const e = ents + 0x310 * i; let len = 0; while (this.u8[e + len]) len++;
        res.push({ name: dec(this.u8.slice(e, e + len)), type: this.dv.getInt8(e + 0x304), size: Number(this.dv.getBigInt64(e + 0x308, true)) });
      }
    }
    await this.call("CloseDirectory", h);
    return res;
  }
  async tree(mount: string, digest: (b: Uint8Array) => string | Promise<string> = fnv): Promise<string> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await this.list(`${mount}:/${dir}`)) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (e.type === 0) { out.push(`${p} d`); await walk(p); continue; }
        const d = await this.get(`${mount}:/${p}`);
        check(d && d.length === e.size, `${p}: listed ${e.size}, read ${d?.length}`);
        out.push(`${p} f:${e.size}:${await digest(d)}`);
      }
    };
    await walk("");
    return out.sort().join("\n");
  }
}

// A model of a save's tree, and random operations on both
class Model {
  nodes = new Map<string, Uint8Array | null>(); committed = ""; commits = 0;
  snapshot() { return [...this.nodes].map(([p, v]) => `${p} ${v === null ? "d" : `f:${v.length}:${fnv(v)}`}`).sort().join("\n"); }
  private parentOk(p: string) { const i = p.lastIndexOf("/"); return i < 0 || this.nodes.get(p.slice(0, i)) === null; }
  async random(g: Guest, rnd: ReturnType<typeof rng>): Promise<void> {
    const dirs = ["", ...[...this.nodes].filter(([, v]) => v === null).map(([k]) => k)], files = [...this.nodes].filter(([, v]) => v !== null).map(([k]) => k);
    const fresh = () => { const d = rnd.pick(dirs), n = rnd.pick(["a", "b", "c", "save.dat", "X", "x"]); return d ? `${d}/${n}` : n; };
    const k = rnd.int(100);
    if (k < 30) {
      const p = fresh(), cur = this.nodes.get(p), data = rnd.bytes(rnd.int(3) ? rnd.int(2000) : rnd.int(60000));
      if (cur === null) return;
      await g.put(`save:/${p}`, data); this.nodes.set(p, data);
    } else if (k < 50 && files.length) {
      const p = rnd.pick(files), cur = this.nodes.get(p)!, off = rnd.int(cur.length + 3000), data = rnd.bytes(1 + rnd.int(4000));
      await g.writeAt(`save:/${p}`, off, data);
      const next = new Uint8Array(Math.max(cur.length, off + data.length)); next.set(cur); next.set(data, off); this.nodes.set(p, next);
    } else if (k < 62) {
      const p = fresh(), want = !this.parentOk(p) ? R.NOT_FOUND : this.nodes.has(p) ? R.EXISTS : R.OK;
      check(await g.path("CreateDirectory", `save:/${p}`) === want, `mkdir ${p}`); if (want === R.OK) this.nodes.set(p, null);
    } else if (k < 72 && files.length) {
      const p = rnd.pick(files); check(await g.path("DeleteFile", `save:/${p}`) === R.OK, `delete ${p}`); this.nodes.delete(p);
    } else if (k < 78 && dirs.length > 1) {
      const p = rnd.pick(dirs.slice(1)); check(await g.path("DeleteDirRec", `save:/${p}`) === R.OK, `rmrf ${p}`);
      for (const q of [...this.nodes.keys()]) if (q === p || q.startsWith(p + "/")) this.nodes.delete(q);
    } else if (k < 88 && this.nodes.size) {
      const from = rnd.pick([...this.nodes.keys()]), to = fresh();
      const want = !this.parentOk(to) ? R.NOT_FOUND : this.nodes.has(to) ? R.EXISTS : (to + "/").startsWith(from + "/") ? R.FAIL : R.OK;
      g.reset(); check(await g.call("RenameFile", g.str(`save:/${from}`), g.str(`save:/${to}`)) === want, `rename ${from} ${to}`);
      if (want === R.OK) for (const q of [...this.nodes.keys()]) if (q === from || q.startsWith(from + "/")) { const v = this.nodes.get(q)!; this.nodes.delete(q); this.nodes.set(to + q.slice(from.length), v); }
    } else if (k >= 92) {
      check(await g.path("Commit", "save") === R.OK, "commit"); this.committed = this.snapshot(); this.commits++;
    }
  }
}

async function mounted(dir: string, lockWaitMs = 5000): Promise<{ g: Guest; st: OpfsStorage }> {
  const st = new OpfsStorage(dir, { lockWaitMs }), g = new Guest(st);
  check(await g.path("MountSave", "save", 0) === R.OK, "mount");
  return { g, st };
}
// After a reload the previous worker's access handle is released late: OpfsStorage waits for it (lockWaitMs)
async function mountedClean(dir: string): Promise<{ g: Guest; st: OpfsStorage; waited: number }> {
  const t0 = Date.now(), m = await mounted(dir, 20000);
  if (m.g.state() !== "Clean") throw new Error(`the save does not mount read-write: ${m.g.logs.filter(l => l.startsWith("[RED]")).join(" | ")}`);
  return { ...m, waited: Date.now() - t0 };
}
const sha256 = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));

// ---- the cases ----
const cases: Record<string, (a: any) => Promise<string>> = {
  async "opfs: a save on real OPFS against the model: random operations, commits, a new session sees the last commit"(a) {
    let ops = 0, commits = 0, pend = 0;
    for (const seed of [1, 2, 3]) {
      const dir = `${a.dir}-model${seed}`, rnd = rng(seed);
      let { g, st } = await mounted(dir);
      check(g.state() === "Clean" && g.pendings >= 1, "the mount waited for the access handle");
      const m = new Model();
      for (let i = 0; i < 300; i++) {
        await m.random(g, rnd); ops++;
        if (i % 30 === 29) check(await g.tree("save") === m.snapshot(), `seed ${seed}, operation ${i}: the tree is not the model's`);
        if (i % 100 === 99) {   // a new session: the worker's handle is closed, the save is opened again
          st.close();
          ({ g, st } = await mounted(dir));
          check(g.state() === "Clean", "remount");
          check(await g.tree("save") === m.committed, `seed ${seed}: after a remount the save is not the last commit`);
          m.nodes = new Map(m.committed ? m.committed.split("\n").map(() => ["", null]) : []);
          // rebuild the model from what is stored
          m.nodes = new Map();
          const load = async (d: string): Promise<void> => { for (const e of await g.list(`save:/${d}`)) { const p = d ? `${d}/${e.name}` : e.name; if (e.type === 0) { m.nodes.set(p, null); await load(p); } else m.nodes.set(p, (await g.get(`save:/${p}`))!); } };
          await load("");
          check(m.snapshot() === m.committed, "the model was rebuilt");
        }
      }
      commits += m.commits; pend += g.pendings;
      check(g.logs.every(l => !l.startsWith("[RED]")), g.logs.filter(l => l.startsWith("[RED]")).join(" | "));
      st.close();
    }
    return `${ops} operations, ${commits} commits, 9 sessions`;
  },
  async "opfs: a second session while the first holds the save: read-only, the front end is told; free again after the first closes"(a) {
    const dir = `${a.dir}-lock`;
    const one = await mounted(dir);
    await one.g.put("save:/f", enc("first")); check(await one.g.path("Commit", "save") === R.OK, "commit");
    const two = await mounted(dir, 0);
    check(two.g.state() === "ReadOnly", `the second session is ${two.g.state()}`);
    check(two.g.saveFailed.length === 1 && await two.g.path("CreateFile", "save:/x", 0) === R.FAIL && await two.g.path("Commit", "save") === R.OK, "read-only answers");
    one.st.close(); two.st.close();
    const three = await mounted(dir);
    check(three.g.state() === "Clean" && dec((await three.g.get("save:/f"))!) === "first", "after the first closed");
    three.st.close();
    return "second mount read-only, then read-write";
  },
  async "opfs: cache storages: separate containers, deleted through the storage"(a) {
    const st = new OpfsStorage(`${a.dir}-cache`), g = new Guest(st);
    check(await g.path("MountCache", "c1", 1) === R.OK && await g.path("MountCache", "c2", 2) === R.OK && await g.path("MountTemp", "t") === R.OK, "mounts");
    await g.put("c1:/a", enc("one")); await g.put("c2:/a", enc("two")); await g.put("t:/a", enc("temp"));
    check(await g.path("Commit", "c1") === R.OK && await g.path("Commit", "c2") === R.OK, "commits");
    st.close();
    const st2 = new OpfsStorage(`${a.dir}-cache`), g2 = new Guest(st2);
    g2.reset(); check(await g2.call("DeleteCache", 2) === R.OK, "delete");
    await g2.path("MountCache", "c1", 1); await g2.path("MountCache", "c2", 2); await g2.path("MountTemp", "t");
    check(dec((await g2.get("c1:/a"))!) === "one" && (await g2.list("c2:/")).length === 0 && (await g2.list("t:/")).length === 0, "after the delete");
    st2.close();
    return "cache 1 kept, cache 2 deleted, temporary storage empty";
  },
  async "romfs: an image in a Blob, read with FileReaderSync: every file as the Python reader has it"(a) { return romfs(a, true); },
  async "romfs: an image in a Blob, read with asynchronous slices: every read pends and is completed"(a) { return romfs(a, false); },

  // ---- the commit that browser.mts kills by reloading the page ----
  async "crash: prepare"(a) {
    const { g, st } = await mounted(a.dir);
    await g.path("CreateDirectory", "save:/profile");
    await g.put("save:/profile/slot0.sav", rng(1).bytes(30000)); await g.put("save:/profile/slot1.sav", rng(2).bytes(5000)); await g.put("save:/delete-me", rng(3).bytes(999));
    check(await g.path("Commit", "save") === R.OK, "commit");
    await g.put("save:/system.dat", rng(4).bytes(4000));
    check(await g.path("Commit", "save") === R.OK, "commit");
    const text = await g.tree("save");
    st.close();
    return text;
  },
  async "crash: run"(a) {
    // k = -1: run to the end and report; else stop the world at storage operation k (a killed write lands half)
    const st = new OpfsStorage(a.dir), kinds: string[] = [];
    const counting: FsStorage = {
      open: async (kind, index) => {
        const d = await st.open(kind, index) as FsDevice | number;
        if (typeof d === "number") return d;
        const stop = (kind_: string) => {
          (self as any).postMessage({ id: a.id, stopped: { at: kinds.length - 1, kind: kind_ } });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);   // until the page is reloaded
        };
        return { size: () => d.size(), readSync: (o: number, b: Uint8Array) => d.readSync!(o, b),
          write: (o: number, b: Uint8Array) => { kinds.push("write"); if (kinds.length - 1 === a.k) { d.write!(o, b.subarray(0, b.length >> 1)); stop("write"); } return d.write!(o, b); },
          flush: () => { kinds.push("flush"); if (kinds.length - 1 === a.k) stop("flush"); return d.flush!() as number; } } as FsDevice;
      },
      remove: (k, i) => st.remove(k, i),
    };
    const g = new Guest(counting);
    check(await g.path("MountSave", "save", 0) === R.OK && g.state() === "Clean", `mount: ${g.state()}`);
    await g.put("save:/profile/slot0.sav", rng(10).bytes(41000));
    await g.writeAt("save:/profile/slot1.sav", 1000, rng(11).bytes(300));
    check(await g.path("DeleteFile", "save:/delete-me") === R.OK, "delete");
    g.reset(); check(await g.call("RenameFile", g.str("save:/system.dat"), g.str("save:/profile/system.dat")) === R.OK, "rename");
    await g.put("save:/new", enc("new in version 3"));
    const text = await g.tree("save");
    check(await g.path("Commit", "save") === R.OK, "commit");
    st.close();
    return JSON.stringify({ text, kinds });
  },
  async "crash: verify"(a) {
    const { g, st, waited } = await mountedClean(a.dir);
    const text = await g.tree("save"), gen = Number(g.host.x.fs_save_generation(FS_KIND.SAVE, 0n));
    // the save works: one more commit, read back in one more session
    await g.put("save:/after", enc("after the reload")); check(await g.path("Commit", "save") === R.OK, "commit after the reload");
    st.close();
    const again = await mountedClean(a.dir);
    check(dec((await again.g.get("save:/after"))!) === "after the reload", "the commit after the reload");
    again.st.close();
    await (await (navigator as any).storage.getDirectory()).removeEntry(a.dir, { recursive: true });
    return JSON.stringify({ text, gen, waited });
  },
};

async function romfs(a: any, sync: boolean): Promise<string> {
  const blob: Blob = await (await fetch("/rom.img")).blob();
  const rows: { path: string; type: string; size: number; sha256?: string }[] = (await (await fetch("/rom.json")).text()).trim().split("\n").map(l => JSON.parse(l));
  const st = new MemStorage();
  const dev = new BlobDevice(blob, sync);
  check(!!dev.readSync === sync, "FileReaderSync is there in a Worker");
  st.setImage(FS_KIND.ROM, 0, dev);
  const g = new Guest(st);
  check(await g.path("MountRom", "rom", 0, 0) === R.OK, `mount: ${g.logs.join(" | ")}`);
  const mountPend = g.pendings;
  const seen = new Map((await g.tree("rom", sha256)).split("\n").map(l => { const i = l.lastIndexOf(" "); return [l.slice(0, i), l.slice(i + 1)]; }));
  let files = 0, bytes = 0;
  for (const r of rows) {
    const p = dec(Uint8Array.from(r.path.match(/../g)!.map(h => parseInt(h, 16))));
    check(seen.get(p) === (r.type === "d" ? "d" : `f:${r.size}:${r.sha256}`), `${p}: ${seen.get(p)}`);
    if (r.type === "f") { files++; bytes += r.size; }
  }
  check(seen.size === rows.length, `${seen.size} entries listed, the reader has ${rows.length}`);
  // reads at offsets, across the end
  const big = rows.filter(r => r.type === "f").sort((x, y) => y.size - x.size)[0];
  const p = dec(Uint8Array.from(big.path.match(/../g)!.map(h => parseInt(h, 16))));
  const whole = (await g.get(`rom:/${p}`))!, [, h] = await g.open(`rom:/${p}`);
  for (const [off, len] of [[0, 10], [big.size - 5, 50], [big.size, 4], [1234, 4321], [big.size >> 1, big.size]])
    check(hex(await g.readAt(h, off, len)) === hex(whole.subarray(off, off + len)), `read @${off}+${len}`);
  check(sync ? g.pendings === 0 : mountPend === 1 && g.pendings > rows.filter(r => r.type === "f" && r.size > 0).length, `pending calls: ${g.pendings}`);
  return `${rows.length} entries, ${files} files, ${bytes} bytes, ${g.pendings} pending calls`;
}

self.onmessage = async (ev: MessageEvent) => {
  const a = ev.data;
  try {
    if (!module) { module = await WebAssembly.compileStreaming(fetch("/fs.wasm")); FN = await (await fetch("/fn.json")).json(); }
    if (a.cmd === "list") { (self as any).postMessage({ id: a.id, ok: true, value: Object.keys(cases).filter(n => !n.startsWith("crash: ")) }); return; }
    const value = await cases[a.cmd](a);
    (self as any).postMessage({ id: a.id, ok: true, value });
  } catch (e) { (self as any).postMessage({ id: a.id, ok: false, value: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }); }
};
