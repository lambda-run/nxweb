// A .nup file on disk as a container's bytes (Node): positional reads through one descriptor. The tests, and a Node
// embedder; the page reads a File (nup.ts blobBytes).
import { openSync, closeSync, readSync, fstatSync } from "node:fs";
import type { NupBytes } from "./nup.ts";

export function nodeBytes(path: string): NupBytes & { close(): void; reads: number; bytesRead: number } {
  const fd = openSync(path, "r");
  const src = {
    size: fstatSync(fd).size, reads: 0, bytesRead: 0,
    readSync(off: number, dst: Uint8Array): number {
      src.reads++; src.bytesRead += dst.length;
      try { for (let got = 0; got < dst.length;) { const n = readSync(fd, dst, got, dst.length - got, off + got); if (n <= 0) return -2; got += n; } return 0; } catch { return -2; }
    },
    async read(off: number, len: number): Promise<Uint8Array> {
      const b = new Uint8Array(Math.max(0, Math.min(len, src.size - off)));
      if (src.readSync(off, b)) throw new Error(`read ${path} @${off}+${len}`);
      return b;
    },
    close(): void { try { closeSync(fd); } catch { /* closed */ } },
  };
  return src;
}
