// `npm run web`: builds build/web and serves it on http://localhost:8080 (PORT overrides) with the headers that make
// the page cross-origin isolated (COOP same-origin, COEP require-corp).
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { buildWeb, WEB } from "./build.mts";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".nso": "application/octet-stream", ".wad": "application/octet-stream" };
export function serve(port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const file = join(WEB, path === "/" || path === "\\" ? "index.html" : path);
    if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, head); res.end("not found"); return; }
    res.writeHead(200, { ...head, "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise(r => server.listen(port, "127.0.0.1", () => r({ server, url: `http://localhost:${(server.address() as any).port}/` })));
}
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  // --no-build serves what is there: refused when its modules were built from other kit tables than today's
  try { if (!process.argv.includes("--no-build")) await buildWeb(); else (await import("../src/runtime/host/build.mts")).checkBuilt(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
  const { url } = await serve(Number(process.env.PORT ?? 8080));
  console.log(`nxweb: ${url}   (${url}?demo starts the built-in demo)`);
}
