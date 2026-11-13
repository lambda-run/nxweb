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
  // Requests are whole 1 MiB blocks, and the last 96 are kept: the game reads a file in many small pieces one after
  // the other, and a request costs 15-45 ms whatever its size (measured against web/game_serve.mjs in the VM).
  const BLK = 1 << 20, KEEP = 96, blocks = new Map<number, Uint8Array>();
  const keep = (i: number, b: Uint8Array) => { blocks.delete(i); blocks.set(i, b); if (blocks.size > KEEP) blocks.delete(blocks.keys().next().value as number); };
  const have = (i: number) => { const b = blocks.get(i); if (b) { blocks.delete(i); blocks.set(i, b); } return b; };
  // the blocks [i0, i1] that are missing as one run from the first to the last missing one (null: none missing)
  const missing = (i0: number, i1: number): [number, number] | null => { let a = -1, z = -1; for (let i = i0; i <= i1; i++) if (!blocks.has(i)) { if (a < 0) a = i; z = i; } return a < 0 ? null : [a, z]; };
  const split = (a: number, bytes: Uint8Array) => { for (let o = 0; o < bytes.length; o += BLK) keep(a + o / BLK, bytes.subarray(o, Math.min(bytes.length, o + BLK))); };
  const copy = (off: number, dst: Uint8Array): boolean => { for (let at = 0; at < dst.length; ) { const i = Math.floor((off + at) / BLK), b = have(i); if (!b) return false; const o = off + at - i * BLK, n = Math.min(dst.length - at, b.length - o); if (n <= 0) return false; dst.set(b.subarray(o, o + n), at); at += n; } return true; };
  const span = (a: number, z: number): [number, number] => [a * BLK, Math.min(g.size, (z + 1) * BLK) - a * BLK];
  const fetchRun = async (a: number, z: number): Promise<void> => {
    const [off, len] = span(a, z);
    for (let tries = 0; ; tries++) {
      try { const r = await fetch(g.url, { headers: { Range: range(off, len) } }); if (r.status !== 206) throw new Error("HTTP " + r.status); const b = new Uint8Array(await r.arrayBuffer()); if (b.length !== len) throw new Error(`${b.length} of ${len} bytes`); split(a, b); return; }
      catch (e) { if (tries >= 3) throw new Error(`game: reading ${len} bytes at ${off} of ${g.url} failed: ${(e as Error).message}`); await new Promise(r => setTimeout(r, 200 << tries)); }
    }
  };
  return {
    size: g.size,
    read: async (off, len) => {
      const dst = new Uint8Array(Math.max(0, len)); if (len <= 0) return dst;
      if (off < 0 || off + len > g.size) throw new Error(`game: a read of ${len} bytes at ${off} is outside the container`);
      const i0 = Math.floor(off / BLK), i1 = Math.floor((off + len - 1) / BLK);
      // (a large read does not go through the kept blocks: it would push them all out)
      if (i1 - i0 + 1 > KEEP / 2) { const r = await fetch(g.url, { headers: { Range: range(off, len) } }); if (r.status !== 206) throw new Error("game: HTTP " + r.status); return new Uint8Array(await r.arrayBuffer()); }
      for (let tries = 0; tries < 4; tries++) { const m = missing(i0, i1); if (m) await fetchRun(m[0], m[1]); if (copy(off, dst)) return dst; }   // (another read's blocks may have pushed some out meanwhile)
      throw new Error(`game: reading ${len} bytes at ${off} failed`);
    },
    // (a worker only: synchronous requests with a binary answer are not allowed on a page)
    readSync: sync ? (off, dst) => {
      if (!dst.length) return 0;
      if (off < 0 || off + dst.length > g.size) return IO;
      const sget = (o: number, n: number): Uint8Array | null => { try { const x = new XMLHttpRequest(); x.open("GET", g.url, false); x.responseType = "arraybuffer"; x.setRequestHeader("Range", range(o, n)); x.send(); if (x.status !== 206) return null; const b = new Uint8Array(x.response as ArrayBuffer); return b.length === n ? b : null; } catch { return null; } };
      const i0 = Math.floor(off / BLK), i1 = Math.floor((off + dst.length - 1) / BLK);
      if (i1 - i0 + 1 > KEEP / 2) { const b = sget(off, dst.length); if (!b) return IO; dst.set(b); return 0; }
      const m = missing(i0, i1);
      if (m) { const [o, n] = span(m[0], m[1]), b = sget(o, n); if (!b) return IO; split(m[0], b); }
      return copy(off, dst) ? 0 : IO;
    } : undefined,
  } as NupBytes;
}
