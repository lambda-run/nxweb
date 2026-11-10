// A reference model of one save's tree. Every method makes the fs calls a guest would make, asserts nxnative's
// result for the state the model is in, and updates the model: the save tests' oracle, and the crash tests'
// record of what was committed.
import assert from "node:assert/strict";
import { Fs, R, MODE, fileEntry } from "./harness.mts";

type Rnd = { next(): number; int(n: number): number; bytes(n: number): Buffer; pick<T>(a: T[]): T };

export class Model {
  fs: Fs; mount: string;
  nodes = new Map<string, Buffer | null>();   // path -> content, or null for a directory
  committed = "";                              // snapshot() of the last commit that returned
  committing: string | null = null;            // snapshot() of a commit that was called and has not returned
  commits = 0;
  constructor(fs: Fs, mount = "save") { this.fs = fs; this.mount = mount; }
  adopt(m: Model): this { this.nodes = new Map(m.nodes); return this; }
  private p(path: string): string { return `${this.mount}:/${path}`; }
  private parentOk(path: string): boolean { const i = path.lastIndexOf("/"); return i < 0 || this.nodes.get(path.slice(0, i)) === null; }
  private under(path: string): string[] { return [...this.nodes.keys()].filter(k => k.startsWith(path + "/")); }
  snapshot(): string {
    return [...this.nodes].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, v]) => `${p} ${v === null ? "d" : fileEntry(v)}`).join("\n");
  }

  async create(path: string, size = 0): Promise<void> {
    const want = !this.parentOk(path) ? R.NOT_FOUND : this.nodes.has(path) ? R.EXISTS : R.OK;
    assert.equal(await this.fs.path("CreateFile", this.p(path), size), want, `CreateFile ${path}`);
    if (want === R.OK) this.nodes.set(path, Buffer.alloc(size));
  }
  async mkdir(path: string): Promise<void> {
    const want = !this.parentOk(path) ? R.NOT_FOUND : this.nodes.has(path) ? R.EXISTS : R.OK;
    assert.equal(await this.fs.path("CreateDirectory", this.p(path)), want, `CreateDirectory ${path}`);
    if (want === R.OK) this.nodes.set(path, null);
  }
  async writeAt(path: string, off: number, data: Buffer): Promise<void> {
    const cur = this.nodes.get(path);
    const [r, h] = await this.fs.open(this.p(path), MODE.W | MODE.A);
    assert.equal(r, cur === undefined || !this.parentOk(path) ? R.NOT_FOUND : cur === null ? R.FAIL : R.OK, `OpenFile ${path}`);
    if (r !== R.OK) return;
    assert.equal(await this.fs.write(h, off, data), R.OK, `WriteFile ${path}`);
    await this.fs.close(h);
    if (!data.length) return;
    const next = Buffer.alloc(Math.max(cur!.length, off + data.length));
    cur!.copy(next); data.copy(next, off);
    this.nodes.set(path, next);
  }
  async setSize(path: string, size: number): Promise<void> {
    const cur = this.nodes.get(path);
    if (!cur) return;
    const [r, h] = await this.fs.open(this.p(path), MODE.W);
    assert.equal(r, R.OK);
    assert.equal(await this.fs.call("SetFileSize", h, size), R.OK, `SetFileSize ${path}`);
    await this.fs.close(h);
    const next = Buffer.alloc(size); cur.copy(next, 0, 0, Math.min(size, cur.length));
    this.nodes.set(path, next);
  }
  // The usual way a game saves: create if missing, cut to 0, write everything
  async put(path: string, data: Buffer): Promise<void> {
    if (!this.nodes.has(path)) await this.create(path);
    if (this.nodes.get(path) === null || this.nodes.get(path) === undefined) return;
    await this.setSize(path, 0);
    await this.writeAt(path, 0, data);
  }
  async del(path: string): Promise<void> {
    const cur = this.nodes.get(path);
    assert.equal(await this.fs.path("DeleteFile", this.p(path)), cur === undefined ? R.NOT_FOUND : cur === null ? R.FAIL : R.OK, `DeleteFile ${path}`);
    if (cur) this.nodes.delete(path);
  }
  async rmdir(path: string): Promise<void> {
    const cur = this.nodes.get(path);
    const want = cur === undefined ? R.NOT_FOUND : cur !== null ? R.NOT_FOUND : this.under(path).length ? R.FAIL : R.OK;
    assert.equal(await this.fs.path("DeleteDir", this.p(path)), want, `DeleteDirectory ${path}`);
    if (want === R.OK) this.nodes.delete(path);
  }
  async rmrf(path: string, keep = false): Promise<void> {
    const cur = this.nodes.get(path);
    const want = cur === undefined ? R.NOT_FOUND : cur !== null ? R.NOT_FOUND : R.OK;
    assert.equal(await this.fs.path(keep ? "CleanDirRec" : "DeleteDirRec", this.p(path)), want, `${keep ? "Clean" : "Delete"}DirectoryRecursively ${path}`);
    if (want !== R.OK) return;
    for (const k of this.under(path)) this.nodes.delete(k);
    if (!keep) this.nodes.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const cur = this.nodes.get(from);
    const want = cur === undefined ? R.NOT_FOUND : !this.parentOk(to) ? R.NOT_FOUND : this.nodes.has(to) ? R.EXISTS : (to + "/").startsWith(from + "/") ? R.FAIL : R.OK;
    assert.equal(await this.fs.rename(cur === null ? "RenameDir" : "RenameFile", this.p(from), this.p(to)), want, `Rename ${from} -> ${to}`);
    if (want !== R.OK) return;
    for (const k of [from, ...this.under(from)]) { const v = this.nodes.get(k)!; this.nodes.delete(k); this.nodes.set(to + k.slice(from.length), v); }
  }
  async commit(want = R.OK): Promise<void> {
    this.committing = this.snapshot();
    const r = await this.fs.path("Commit", this.mount);
    assert.equal(r, want, "Commit");
    if (r === R.OK) { this.committed = this.committing; this.commits++; }
    this.committing = null;
  }
  // What the module shows is what the model has
  async check(what = "the working tree"): Promise<void> {
    const { treeText } = await import("./harness.mts");
    assert.equal(treeText(await this.fs.tree(this.mount)), this.snapshot(), what);
  }

  // One random operation over a small name space, so that names collide and every result code comes up
  async random(rnd: Rnd): Promise<string> {
    const dirs = ["", ...[...this.nodes].filter(([, v]) => v === null).map(([k]) => k)];
    const files = [...this.nodes].filter(([, v]) => v !== null).map(([k]) => k);
    const name = () => rnd.pick(["a", "b", "c", "save.dat", "slot0", "X", "x", "long-name-" + "z".repeat(40)]);
    const fresh = () => { const d = rnd.pick(dirs); return d ? `${d}/${name()}` : name(); };
    const any = () => (this.nodes.size && rnd.int(8) ? rnd.pick([...this.nodes.keys()]) : fresh());
    const size = () => { const k = rnd.int(10); return k < 4 ? rnd.int(64) : k < 8 ? rnd.int(3000) : k < 9 ? rnd.int(70000) : 0; };
    const k = rnd.int(100);
    let op: string;
    if (k < 22) { const p = fresh(), n = size(); op = `put ${p} ${n}`; await this.put(p, rnd.bytes(n)); }
    else if (k < 40 && files.length) {
      const p = rnd.pick(files), cur = this.nodes.get(p)!.length, off = rnd.int(4) ? rnd.int(cur + 1) : cur + rnd.int(5000), n = size();
      op = `write ${p} @${off}+${n}`; await this.writeAt(p, off, rnd.bytes(n));
    }
    else if (k < 50 && files.length) { const p = rnd.pick(files), n = rnd.int(3) ? rnd.int(this.nodes.get(p)!.length + 1) : size(); op = `setsize ${p} ${n}`; await this.setSize(p, n); }
    else if (k < 58) { const p = fresh(); op = `create ${p}`; await this.create(p, rnd.int(3) ? 0 : size()); }
    else if (k < 68) { const p = fresh(); op = `mkdir ${p}`; await this.mkdir(p); }
    else if (k < 76) { const p = any(); op = `delete ${p}`; await this.del(p); }
    else if (k < 80) { const p = any(); op = `rmdir ${p}`; await this.rmdir(p); }
    else if (k < 84) { const p = any(); op = `rmrf ${p}`; await this.rmrf(p, rnd.int(3) === 0); }
    else if (k < 94) { const a = any(), b = fresh(); op = `rename ${a} ${b}`; await this.rename(a, b); }
    else { op = "commit"; await this.commit(); }
    return op;
  }
}
