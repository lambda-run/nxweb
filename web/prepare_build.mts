// `npm run prepare:web`: what web/prepare.html needs, in build/web/ beside the main page's files: the bundled page
// script, the prepare module, the converted profiles. `--serve` then serves build/web on http://localhost:8081
// (PORT overrides) with the cross-origin isolation headers the main page uses.
import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, extname, normalize } from "node:path";
import { ROOT, WASM, build } from "../src/prepare/host/build.mts";

export const WEB = join(ROOT, "build", "web");
export function buildPreparePage(): void {
  build();
  mkdirSync(join(WEB, "wasm"), { recursive: true }); mkdirSync(join(WEB, "profiles"), { recursive: true });
  buildSync({ entryPoints: ["web/prepare.ts"], bundle: true, format: "iife", outfile: "build/web/prepare.js", logLevel: "warning", absWorkingDir: ROOT });
  // the Shaders stage's scan Worker; the translation is the runtime's shader_worker.js and shaders/ (web:build)
  buildSync({ entryPoints: ["web/prepare_shader_worker.ts"], bundle: true, format: "iife", outfile: "build/web/prepare_shader_worker.js", logLevel: "warning", absWorkingDir: ROOT });
  copyFileSync(join(ROOT, "web", "prepare.html"), join(WEB, "prepare.html"));
  copyFileSync(WASM, join(WEB, "wasm", "prepare.wasm"));
  // the Code stage's instruction scan decodes with the translator binary itself: the one the runtime's build made
  // (rt:build; the main page ships the same file). Without it the page prepares as before and scans nothing.
  const tr = join(ROOT, "build", "runtime", "translator.wasm");
  if (existsSync(tr)) copyFileSync(tr, join(WEB, "wasm", "translator.wasm"));
  const src = join(ROOT, "src", "prepare", "profiles");
  for (const f of readdirSync(src)) if (f.endsWith(".json")) copyFileSync(join(src, f), join(WEB, "profiles", f));
}
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
export function servePrepare(port: number, extra?: (url: string) => { body: Buffer | string; type: string } | null): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    const url = (req.url ?? "/").split("?")[0];
    const x = extra?.(url);
    if (x) { res.writeHead(200, { ...head, "Content-Type": x.type }); res.end(x.body); return; }
    const path = normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, "");
    const file = join(WEB, path === "/" || path === "\\" ? "prepare.html" : path);
    if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, head); res.end("not found"); return; }
    res.writeHead(200, { ...head, "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise(r => server.listen(port, "127.0.0.1", () => r({ server, url: `http://localhost:${(server.address() as any).port}/` })));
}
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { buildPreparePage(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
  console.log("prepare:web: wrote build/web/prepare.html, prepare.js, wasm/prepare.wasm, profiles/");
  if (process.argv.includes("--serve")) { const { url } = await servePrepare(Number(process.env.PORT ?? 8081)); console.log(`nxweb prepare page: ${url}prepare.html`); }
}
