// A real directory as a PrepTree (Node): the tests, and a Node embedder. Reads are positional, through a small
// cache of open descriptors.
import { readdirSync, statSync, openSync, closeSync, readSync } from "node:fs";
import { join, basename } from "node:path";
import { isJunk, sortListing, type PrepTree, type TreeListing } from "./tree.ts";

export class NodeTree implements PrepTree {
  readonly name: string;
  readonly root: string;
  private fds = new Map<string, number>();
  private maxOpen: number;
  opens = 0;
  constructor(root: string, o: { maxOpen?: number } = {}) { this.root = root; this.name = basename(root); this.maxOpen = o.maxOpen ?? 64; }
  async list(onProgress?: (n: number) => void): Promise<TreeListing> { return this.listSync(onProgress); }
  listSync(onProgress?: (n: number) => void): TreeListing {
    const out: TreeListing = { files: [], dirs: [] };
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix + e.name, full = join(dir, e.name);
        if (e.isDirectory()) { out.dirs.push(path); walk(full, path + "/"); }
        else if (e.isFile() && !isJunk(path)) { const st = statSync(full); out.files.push({ path, size: st.size, mtime: Math.floor(st.mtimeMs) }); }
      }
      onProgress?.(out.files.length);
    };
    walk(this.root, "");
    return sortListing(out);
  }
  private fd(path: string): number {
    let fd = this.fds.get(path);
    if (fd !== undefined) { this.fds.delete(path); this.fds.set(path, fd); return fd; }   // most recently used last
    if (this.fds.size >= this.maxOpen) { const [old, ofd] = this.fds.entries().next().value!; closeSync(ofd); this.fds.delete(old); }
    fd = openSync(join(this.root, path), "r"); this.opens++;
    this.fds.set(path, fd);
    return fd;
  }
  readSync(path: string, off: number, dst: Uint8Array): number {
    try {
      const fd = this.fd(path);
      for (let got = 0; got < dst.length;) { const n = readSync(fd, dst, got, dst.length - got, off + got); if (n <= 0) return -2; got += n; }
      return 0;
    } catch { return -2; }
  }
  async read(path: string, off: number, len: number): Promise<Uint8Array> {
    const b = new Uint8Array(len);
    if (this.readSync(path, off, b)) throw new Error(`read ${join(this.root, path)} @${off}+${len}`);
    return b;
  }
  close(): void { for (const fd of this.fds.values()) { try { closeSync(fd); } catch { /* closed */ } } this.fds.clear(); }
}
