// A folder of game files as the prepare step sees it: a listing, and reads. Implementations here need no Node API:
// MemTree (tests), HandleTree (File System Access: the directory picker, a dropped directory's handle, an OPFS
// directory), EntryTree (webkitGetAsEntry of a dropped directory), FileListTree (<input webkitdirectory>).
// NodeTree is in tree_node.ts.
export interface TreeFile { path: string; size: number; mtime: number }
export interface TreeListing { files: TreeFile[]; dirs: string[] }   // paths relative to the folder, '/' separated, sorted
export interface PrepTree {
  readonly name: string;
  // Every file and directory under the folder. onProgress gets the number of files seen so far.
  list(onProgress?: (files: number) => void): Promise<TreeListing>;
  read(path: string, off: number, len: number): Promise<Uint8Array>;
  // Synchronous reads where the platform has them (Node; a Worker with FileReaderSync). 0, or -2 on an error
  readSync?(path: string, off: number, dst: Uint8Array): number;
  // Browser: the File behind a path, to hand to a Worker (structured clone keeps it a reference to the user's file)
  blob?(path: string): Blob | undefined;
  close?(): void;
}
export const sortListing = (l: TreeListing): TreeListing => {
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  l.files.sort((a, b) => cmp(a.path, b.path)); l.dirs.sort(cmp);
  return l;
};
const OS_JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/;   // files a desktop adds to a folder (nxnative skips dot files in exefs)
export const isJunk = (path: string) => OS_JUNK.test(path);

export class MemTree implements PrepTree {
  readonly name: string;
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  dirs = new Set<string>();
  reads = 0;
  constructor(name = "mem") { this.name = name; }
  set(path: string, bytes: Uint8Array, mtime = 1): this {
    this.files.set(path, { bytes, mtime });
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) this.dirs.add(path.slice(0, i));
    return this;
  }
  mkdir(path: string): this { this.dirs.add(path); for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) this.dirs.add(path.slice(0, i)); return this; }
  delete(path: string): void { this.files.delete(path); }
  async list(onProgress?: (n: number) => void): Promise<TreeListing> {
    onProgress?.(this.files.size);
    return sortListing({ files: [...this.files].map(([path, f]) => ({ path, size: f.bytes.length, mtime: f.mtime })), dirs: [...this.dirs] });
  }
  readSync(path: string, off: number, dst: Uint8Array): number {
    const f = this.files.get(path); this.reads++;
    if (!f || off < 0 || off + dst.length > f.bytes.length) return -2;
    dst.set(f.bytes.subarray(off, off + dst.length)); return 0;
  }
  async read(path: string, off: number, len: number): Promise<Uint8Array> {
    const b = new Uint8Array(len);
    if (this.readSync(path, off, b)) throw new Error(`read ${path} @${off}+${len}`);
    return b;
  }
}

// What the browser trees share: the File of every path, kept from the listing
abstract class FileTree implements PrepTree {
  readonly name: string;
  protected got = new Map<string, File>();
  private reader: any;
  constructor(name: string) { this.name = name; }
  abstract list(onProgress?: (n: number) => void): Promise<TreeListing>;
  blob(path: string): Blob | undefined { return this.got.get(path); }
  async read(path: string, off: number, len: number): Promise<Uint8Array> {
    const f = this.got.get(path);
    if (!f) throw new Error(`no file ${path} in ${this.name}`);
    const b = new Uint8Array(await f.slice(off, off + len).arrayBuffer());
    if (b.length !== len) throw new Error(`${path}: ${b.length} of ${len} bytes at ${off} (the file changed)`);
    return b;
  }
  // only where FileReaderSync exists (a Worker)
  get readSync(): ((path: string, off: number, dst: Uint8Array) => number) | undefined {
    if (typeof (globalThis as any).FileReaderSync !== "function") return undefined;
    return (path, off, dst) => {
      const f = this.got.get(path);
      if (!f || off < 0 || off + dst.length > f.size) return -2;
      try { this.reader ??= new (globalThis as any).FileReaderSync(); dst.set(new Uint8Array(this.reader.readAsArrayBuffer(f.slice(off, off + dst.length)))); return 0; } catch { return -2; }
    };
  }
}

// A FileSystemDirectoryHandle: showDirectoryPicker(), DataTransferItem.getAsFileSystemHandle(), or a directory of
// the Origin Private File System. Listing asks every file for its File (size and time are nowhere else).
export class HandleTree extends FileTree {
  private root: any;
  constructor(root: any /* FileSystemDirectoryHandle */) { super(root.name || "folder"); this.root = root; }
  async list(onProgress?: (n: number) => void): Promise<TreeListing> {
    const out: TreeListing = { files: [], dirs: [] };
    this.got.clear();
    const walk = async (dir: any, prefix: string): Promise<void> => {
      const pending: Promise<void>[] = [];
      for await (const [name, h] of dir.entries()) {
        const path = prefix + name;
        if (h.kind === "directory") { out.dirs.push(path); await walk(h, path + "/"); }
        else if (!isJunk(path)) pending.push(h.getFile().then((f: File) => { this.got.set(path, f); out.files.push({ path, size: f.size, mtime: f.lastModified }); }));
        if (pending.length >= 64) { await Promise.all(pending.splice(0)); onProgress?.(out.files.length); }
      }
      await Promise.all(pending); onProgress?.(out.files.length);
    };
    await walk(this.root, "");
    return sortListing(out);
  }
}

// A dropped directory as FileSystemDirectoryEntry (DataTransferItem.webkitGetAsEntry(): every browser has it)
export class EntryTree extends FileTree {
  private root: any;
  constructor(root: any /* FileSystemDirectoryEntry */) { super(root.name || "folder"); this.root = root; }
  async list(onProgress?: (n: number) => void): Promise<TreeListing> {
    const out: TreeListing = { files: [], dirs: [] };
    this.got.clear();
    const entries = (dir: any) => new Promise<any[]>((res, rej) => {
      const r = dir.createReader(), all: any[] = [];
      const more = () => r.readEntries((batch: any[]) => { if (!batch.length) res(all); else { all.push(...batch); more(); } }, rej);   // readEntries gives at most 100 a call
      more();
    });
    const walk = async (dir: any, prefix: string): Promise<void> => {
      for (const e of await entries(dir)) {
        const path = prefix + e.name;
        if (e.isDirectory) { out.dirs.push(path); await walk(e, path + "/"); }
        else if (!isJunk(path)) {
          const f = await new Promise<File>((res, rej) => e.file(res, rej));
          this.got.set(path, f); out.files.push({ path, size: f.size, mtime: f.lastModified });
        }
      }
      onProgress?.(out.files.length);
    };
    await walk(this.root, "");
    return sortListing(out);
  }
}

// The files of <input type="file" webkitdirectory>: each has webkitRelativePath "<folder>/<path>". Empty
// directories are not in such a list.
export class FileListTree extends FileTree {
  private input: File[];
  constructor(files: ArrayLike<File>) {
    const list = Array.from(files);
    super(list.length ? ((list[0] as any).webkitRelativePath as string || "").split("/")[0] || "folder" : "folder");
    this.input = list;
  }
  async list(onProgress?: (n: number) => void): Promise<TreeListing> {
    const out: TreeListing = { files: [], dirs: [] }, dirs = new Set<string>();
    this.got.clear();
    for (const f of this.input) {
      const rel = ((f as any).webkitRelativePath as string || f.name).split("/").slice(1).join("/") || f.name;
      if (isJunk(rel)) continue;
      this.got.set(rel, f); out.files.push({ path: rel, size: f.size, mtime: f.lastModified });
      for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) dirs.add(rel.slice(0, i));
    }
    out.dirs = [...dirs]; onProgress?.(out.files.length);
    return sortListing(out);
  }
}
