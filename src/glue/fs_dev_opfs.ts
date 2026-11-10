// Browser storage for the fs module, for a Worker: saves are container files in the Origin Private File System,
// opened once with a synchronous access handle (opening is asynchronous, so a mount pends; every read, write and
// flush after that is synchronous). RomFS images are Blobs / Files (BlobDevice).
import { DEV, FS_KIND, MemDevice, BlobDevice, type FsDevice, type FsStorage } from "./fs_host.ts";

// The parts of FileSystemSyncAccessHandle used here
interface SyncHandle {
  read(buf: Uint8Array, o: { at: number }): number;
  write(buf: Uint8Array, o: { at: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

export class OpfsDevice implements FsDevice {
  private h: SyncHandle;
  constructor(h: SyncHandle) { this.h = h; }
  size(): number { return this.h.getSize(); }
  readSync(off: number, dst: Uint8Array): number {
    try { return this.h.read(dst, { at: off }) === dst.length ? DEV.OK : DEV.IO; } catch { return DEV.IO; }
  }
  write(off: number, src: Uint8Array): number {
    try { return this.h.write(src, { at: off }) === src.length ? DEV.OK : DEV.NO_SPACE; }
    catch (e) { return (e as { name?: string }).name === "QuotaExceededError" ? DEV.NO_SPACE : DEV.IO; }
  }
  flush(): number { try { this.h.flush(); return DEV.OK; } catch { return DEV.IO; } }
  close(): void { try { this.h.close(); } catch { /* closed */ } }
}

// Saves live in <OPFS root>/<dir>/{save,device,cache<i>}.nxsv. One tab at a time: a second synchronous access
// handle on the same file is refused by the browser, and the mount falls back to read-only. After a page reload
// the handle of the Worker that died is released only after a while (about 2 s in Chromium 153, measured by
// `npm run fs:browser`), so an open that is refused is tried again for lockWaitMs before it gives up.
export class OpfsStorage implements FsStorage {
  private dir: string;
  private lockWaitMs: number;
  private images = new Map<string, Blob>();
  private temp = new Map<string, MemDevice>();
  private open_ = new Map<string, OpfsDevice>();
  constructor(dir: string, o: { lockWaitMs?: number } = {}) { this.dir = dir; this.lockWaitMs = o.lockWaitMs ?? 5000; }
  setRom(blob: Blob): void { this.images.set(`${FS_KIND.ROM}:0`, blob); }
  setAddOnContent(index: number, blob: Blob): void { this.images.set(`${FS_KIND.AOC}:${index}`, blob); }
  private name(kind: number, index: bigint): string {
    return kind === FS_KIND.SAVE ? "save.nxsv" : kind === FS_KIND.DEVICE_SAVE ? "device.nxsv" : `cache${index}.nxsv`;
  }
  private async folder(): Promise<any> {
    const root = await (navigator as any).storage.getDirectory();
    return root.getDirectoryHandle(this.dir, { create: true });
  }
  open(kind: number, index: bigint): FsDevice | number | Promise<FsDevice | number> {
    if (kind < FS_KIND.SAVE) {
      const b = this.images.get(`${kind}:${index}`);
      return b ? new BlobDevice(b) : DEV.NOT_FOUND;
    }
    if (kind === FS_KIND.TEMP) { let d = this.temp.get(`${index}`); if (!d) this.temp.set(`${index}`, d = new MemDevice()); return d; }
    const name = this.name(kind, index);
    return (async () => {
      try {
        const file = await (await this.folder()).getFileHandle(name, { create: true });
        for (const t0 = Date.now(); ;) {
          try {
            const dev = new OpfsDevice(await file.createSyncAccessHandle());
            this.open_.set(name, dev);
            return dev;
          } catch (e) {
            if ((e as { name?: string }).name !== "NoModificationAllowedError" || Date.now() - t0 >= this.lockWaitMs) return DEV.IO;
            await new Promise(r => setTimeout(r, 50));
          }
        }
      } catch { return DEV.IO; }
    })();
  }
  remove(kind: number, index: bigint): Promise<number> {
    const name = this.name(kind, index);
    return (async () => {
      try { this.open_.get(name)?.close(); this.open_.delete(name); await (await this.folder()).removeEntry(name); return DEV.OK; }
      catch { return DEV.OK; }   // not there: nothing to delete
    })();
  }
  close(): void { for (const d of this.open_.values()) d.close(); this.open_.clear(); }
}
