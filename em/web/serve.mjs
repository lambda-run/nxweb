// node web/serve.mjs [port] [root]: a static server for the nxem test pages, cross-origin isolated (COOP/COEP), with
// Range support and a sink: POST /put/<name> writes the body to <root>/put/<name> (used to copy nxweb's translation
// cache out of the browser profile). Default: port 8091, root /ctl/nxweb-em/em/build/web.
import { createServer } from "node:http";
import { createReadStream, createWriteStream, statSync, mkdirSync } from "node:fs";
import { join, normalize, extname } from "node:path";
const port = Number(process.argv[2] ?? 8091), root = process.argv[3] ?? "/ctl/nxweb-em/em/build/web";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
createServer((req, res) => {
  const h = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin",
              "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Cache-Control": "no-store" };
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }
  if (req.method === "POST" && path.startsWith("/put/")) {
    mkdirSync(join(root, "put"), { recursive: true });
    const out = createWriteStream(join(root, "put", path.slice(5).replace(/[^A-Za-z0-9._-]/g, "_")));
    req.pipe(out); out.on("finish", () => { res.writeHead(200, h); res.end("ok"); }); return;
  }
  const file = join(root, path === "/" ? "index.html" : path);
  let st; try { st = statSync(file); } catch { res.writeHead(404, h); res.end("not found"); return; }
  h["Content-Type"] = types[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { ...h, "Content-Length": st.size });
  createReadStream(file).pipe(res);
}).listen(port, "0.0.0.0", () => console.log(`nxem serve: http://localhost:${port}/ from ${root}`));
