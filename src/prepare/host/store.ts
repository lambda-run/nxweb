// Where the prepare step keeps its manifest and outputs (cut modules, RomFS tables): named byte blobs.
// MemStore (tests), OpfsStore (the Origin Private File System, main thread or Worker); NodeStore is in store_node.ts.
export interface PrepStore {
  get(name: string): Promise<Uint8Array | null>;
  put(name: string, bytes: Uint8Array): Promise<void>;   // whole or not at all: a reader never sees half a blob
  remove(name: string): Promise<void>;
  // Browser: the stored blob as a Blob (a reference, for a Worker), without reading it
  blob?(name: string): Promise<Blob | null>;
}
export class MemStore implements PrepStore {
  blobs = new Map<string, Uint8Array>();
  puts = 0;
  async get(name: string): Promise<Uint8Array | null> { return this.blobs.get(name)?.slice() ?? null; }
  async put(name: string, bytes: Uint8Array): Promise<void> { this.puts++; this.blobs.set(name, bytes.slice()); }
  async remove(name: string): Promise<void> { this.blobs.delete(name); }
}
// <OPFS root>/<dir>/<name with '/' as '!'>. createWritable writes to a swap file that replaces the target when it
// is closed, so a page closed mid-write leaves the old blob (or none).
export class OpfsStore implements PrepStore {
  private dir: string;
  constructor(dir: string) { this.dir = dir; }
  private async folder(): Promise<any> { return (await (navigator as any).storage.getDirectory()).getDirectoryHandle(this.dir, { create: true }); }
  private file(name: string): string { return name.replace(/\//g, "!"); }
  async blob(name: string): Promise<Blob | null> {
    try { return await (await (await this.folder()).getFileHandle(this.file(name))).getFile(); }
    catch (e) { if ((e as { name?: string }).name === "NotFoundError") return null; throw e; }
  }
  async get(name: string): Promise<Uint8Array | null> { const b = await this.blob(name); return b ? new Uint8Array(await b.arrayBuffer()) : null; }
  async put(name: string, bytes: Uint8Array): Promise<void> {
    const h = await (await this.folder()).getFileHandle(this.file(name), { create: true });
    const w = await h.createWritable();
    await w.write(bytes); await w.close();
  }
  async remove(name: string): Promise<void> {
    try { await (await this.folder()).removeEntry(this.file(name)); } catch (e) { if ((e as { name?: string }).name !== "NotFoundError") throw e; }
  }
  // everything of this store (the page's "forget this game")
  static async destroy(dir: string): Promise<void> {
    try { await (await (navigator as any).storage.getDirectory()).removeEntry(dir, { recursive: true }); } catch { /* not there */ }
  }
}
