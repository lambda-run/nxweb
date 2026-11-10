// Node storage for the fs module: RomFS images are files read with positional reads (never loaded whole), saves
// are container files in one directory. Used by the tests and by a Node embedder.
import { openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEV, FS_KIND, MemDevice, type FsDevice, type FsStorage } from "./fs_host.ts";

export class NodeFileDevice implements FsDevice {
  readonly fd: number;
  private writable: boolean;
  constructor(path: string, writable: boolean) {
    this.writable = writable;
    this.fd = openSync(path, writable ? (existsSync(path) ? "r+" : "w+") : "r");
  }
  size(): number { return fstatSync(this.fd).size; }
  readSync(off: number, dst: Uint8Array): number {
    let got = 0;
    try {
      while (got < dst.length) {
        const n = readSync(this.fd, dst, got, dst.length - got, off + got);
        if (n <= 0) return DEV.IO;
        got += n;
      }
    } catch { return DEV.IO; }
    return DEV.OK;
  }
  write(off: number, src: Uint8Array): number {
    if (!this.writable) return DEV.IO;
    try { let put = 0; while (put < src.length) put += writeSync(this.fd, src, put, src.length - put, off + put); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOSPC" ? DEV.NO_SPACE : DEV.IO; }
    return DEV.OK;
  }
  flush(): number { try { fsyncSync(this.fd); return DEV.OK; } catch { return DEV.IO; } }
  close(): void { try { closeSync(this.fd); } catch { /* closed */ } }
}

// rom: the image file given; add-on content <i>: <aocDir>/<i>.img; saves: <saveDir>/{save,device,cache<i>}.nxsv;
// temporary storage: memory (it does not outlive the process, as on Horizon)
export class NodeStorage implements FsStorage {
  private o: { rom?: string; aocDir?: string; saveDir: string };
  private temp = new Map<string, MemDevice>();
  constructor(o: { rom?: string; aocDir?: string; saveDir: string }) { this.o = o; mkdirSync(o.saveDir, { recursive: true }); }
  private savePath(kind: number, index: bigint): string {
    return join(this.o.saveDir, kind === FS_KIND.SAVE ? "save.nxsv" : kind === FS_KIND.DEVICE_SAVE ? "device.nxsv" : `cache${index}.nxsv`);
  }
  open(kind: number, index: bigint): FsDevice | number {
    try {
      if (kind === FS_KIND.ROM) return this.o.rom && existsSync(this.o.rom) ? new NodeFileDevice(this.o.rom, false) : DEV.NOT_FOUND;
      if (kind === FS_KIND.AOC) {
        const p = this.o.aocDir ? join(this.o.aocDir, `${index}.img`) : "";
        return p && existsSync(p) ? new NodeFileDevice(p, false) : DEV.NOT_FOUND;
      }
      if (kind === FS_KIND.SYSDATA) return DEV.NOT_FOUND;
      if (kind === FS_KIND.TEMP) { let d = this.temp.get(`${index}`); if (!d) this.temp.set(`${index}`, d = new MemDevice()); return d; }
      return new NodeFileDevice(this.savePath(kind, index), true);
    } catch { return DEV.IO; }
  }
  remove(kind: number, index: bigint): number {
    try { rmSync(this.savePath(kind, index), { force: true }); return DEV.OK; } catch { return DEV.IO; }
  }
}
