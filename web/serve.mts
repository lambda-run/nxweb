// `npm run web`: builds build/web and serves it on http://localhost:8080 (PORT overrides) with the headers that make
// the page cross-origin isolated (COOP same-origin, COEP require-corp).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { buildWeb, WEB } from "./build.mts";
import { indexCapture } from "../src/glue/gfx_stream_capture.ts";

// The replayer's profile page (web/gfxprof.ts) reads a stream capture from the reports directory (NX_REPORTS, default /ctl/reports: where the log
// receiver writes) and may leave its result there:
//   GET  /__cap/<name>?index   the capture's chunk index (JSON)        GET /__cap/<name> with `Range: bytes=a-b`   those bytes
//   POST /__report/<name>      the body is written to the reports directory (.json and .txt names only)
const REPORTS = process.env.NX_REPORTS ?? "/ctl/reports";
const capIndex = new Map<string, string>();
function capRoutes(req: IncomingMessage, res: ServerResponse, path: string, head: Record<string, string>): boolean {
  const cap = /^[/\\]__cap[/\\]([A-Za-z0-9._-]+)$/.exec(path), rep = /^[/\\]__report[/\\]([A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:json|txt))$/.exec(path);
  if (rep && req.method === "POST") {
    const parts: Buffer[] = [];
    req.on("data", c => parts.push(c)); req.on("end", () => { try { writeFileSync(join(REPORTS, rep[1]), Buffer.concat(parts)); res.writeHead(200, head); res.end("ok"); } catch (e) { res.writeHead(500, head); res.end(String(e)); } });
    return true;
  }
  if (!cap || req.method !== "GET") return false;
  const file = join(REPORTS, cap[1]);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, head); res.end("no such capture"); return true; }
  const st = statSync(file), fd = openSync(file, "r");
  const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); };
  if ((req.url ?? "").includes("?index")) {
    const key = `${file}:${st.size}:${st.mtimeMs}`, send = (code: number, body: string) => { closeSync(fd); res.writeHead(code, { ...head, "Content-Type": code === 200 ? "application/json" : "text/plain" }); res.end(body); };
    if (capIndex.has(key)) send(200, capIndex.get(key)!);
    else indexCapture(read, st.size).then(ix => { capIndex.set(key, JSON.stringify(ix)); send(200, capIndex.get(key)!); }, e => send(400, String(e?.message ?? e)));
    return true;
  }
  try {
    const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ""));
    if (!m || +m[2] < +m[1] || +m[2] >= st.size) { res.writeHead(416, head); res.end(); return true; }
    res.writeHead(206, { ...head, "Content-Type": "application/octet-stream", "Content-Range": `bytes ${m[1]}-${m[2]}/${st.size}` }); res.end(read(+m[1], +m[2] - +m[1] + 1));
  } finally { closeSync(fd); }
  return true;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".nso": "application/octet-stream", ".wad": "application/octet-stream" };
export function serve(port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    if (capRoutes(req, res, path, head)) return;
    const file = join(WEB, path === "/" || path === "\\" ? "index.html" : path);
    if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, head); res.end("not found"); return; }
    // gfxprof.html samples itself with the JS Self-Profiling API, which a document may use only when it is served with this policy
    res.writeHead(200, { ...head, ...(/gfxprof[^/]*\.html$/.test(file) || /[\\/]em-next[\\/][^/\\]*\.(html|js)$/.test(file) ? { "Document-Policy": "js-profiling" } : {}), "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
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
