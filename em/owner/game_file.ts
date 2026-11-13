// nxem: the game container as the reader wants it (src/prepare/host/nup.ts NupBytes), from a File the user chose or
// from a URL (?game=<url>, em.html: a server that answers Range requests, web/game_serve.mjs; for a browser that
// cannot be given a file, like a headless one driven over CDP). A remote game is { remote: true, url, size, name }:
// a plain object, so it goes to the workers as the File does. Nothing of it is kept in the browser.
import { blobBytes, type NupBytes } from "../../src/prepare/host/nup.ts";
export interface RemoteGame { remote: true; url: string; size: number; name: string }
const IO = -5;
export function gameBytes(file: Blob | RemoteGame, sync: boolean): NupBytes {
  if (!(file as RemoteGame).remote) return blobBytes(file as Blob, sync);
  const g = file as RemoteGame, range = (off: number, len: number) => `bytes=${off}-${off + len - 1}`;
  return {
    size: g.size,
    read: async (off, len) => {
      if (len <= 0) return new Uint8Array(0);
      for (let tries = 0; ; tries++) {
        try { const r = await fetch(g.url, { headers: { Range: range(off, len) } }); if (r.status !== 206) throw new Error("HTTP " + r.status); const b = new Uint8Array(await r.arrayBuffer()); if (b.length !== len) throw new Error(`${b.length} of ${len} bytes`); return b; }
        catch (e) { if (tries >= 3) throw new Error(`game: reading ${len} bytes at ${off} of ${g.url} failed: ${(e as Error).message}`); await new Promise(r => setTimeout(r, 200 << tries)); }
      }
    },
    // (a worker only: synchronous requests with a binary answer are not allowed on a page)
    readSync: sync ? (off, dst) => {
      if (!dst.length) return 0;
      try { const x = new XMLHttpRequest(); x.open("GET", g.url, false); x.responseType = "arraybuffer"; x.setRequestHeader("Range", range(off, dst.length)); x.send();
        if (x.status !== 206) return IO; const b = new Uint8Array(x.response as ArrayBuffer); if (b.length !== dst.length) return IO; dst.set(b); return 0; }
      catch { return IO; }
    } : undefined,
  } as NupBytes;
}
