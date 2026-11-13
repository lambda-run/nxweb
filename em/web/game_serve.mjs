// node web/game_serve.mjs [port] [file]  (in the VM): the game container over HTTP with Range requests, for the page's
// ?game=<url> (a browser that cannot be given a file: the headless Chrome on the Mac). Any origin may read it (CORS,
// Cross-Origin-Resource-Policy: the page is cross-origin isolated). Default: port 8093, /game/zelda-oot.nup.
import { createServer } from "node:http";
import { openSync, fstatSync, readSync } from "node:fs";
const port = Number(process.argv[2] ?? 8093), file = process.argv[3] ?? "/game/zelda-oot.nup";   // (the share itself; /gamefs is a FUSE view of it, several times slower)
const fd = openSync(file, "r"), size = fstatSync(fd).size;
createServer((req, res) => {
  const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, X-Size", "Access-Control-Max-Age": "86400",
    "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store", "Accept-Ranges": "bytes", "X-Size": String(size) };
  if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }
  if (req.method === "HEAD") { res.writeHead(200, { ...h, "Content-Length": size }); res.end(); return; }
  const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ""));
  if (!m || +m[2] < +m[1] || +m[2] >= size || +m[2] - +m[1] >= 1 << 28) { res.writeHead(416, h); res.end(); return; }
  const off = +m[1], len = +m[2] - off + 1, b = Buffer.allocUnsafe(len);
  let at = 0; try { while (at < len) { const n = readSync(fd, b, at, len - at, off + at); if (!n) break; at += n; } } catch { at = -1; }
  if (at !== len) { res.writeHead(500, h); res.end(); return; }
  res.writeHead(206, { ...h, "Content-Type": "application/octet-stream", "Content-Length": len, "Content-Range": `bytes ${off}-${off + len - 1}/${size}` }); res.end(b);
}).on("connection", (s) => s.setNoDelay(true)).listen(port, "0.0.0.0", () => console.log(`game_serve: ${file} (${size} bytes) on port ${port}`));   // (no delay: head and body left in two writes, and the second waited 40 ms for the first's acknowledgement: 64 ms a read)
