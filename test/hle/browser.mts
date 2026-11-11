// npm run hle:browser: nn::codec's AV1 decoder on WebCodecs in headless Chromium (Playwright): the hle module with
// the real VideoDecoder decodes the libaom stream of av1_clip.mts through the take-overs (test/hle/web/codec.ts).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { hleBuild } from "../../src/hle/host/build.mts";
import { ROOT, status } from "./harness.mts";

process.chdir(ROOT);
try {
  hleBuild();
  buildSync({ entryPoints: ["test/hle/web/codec.ts"], bundle: true, format: "iife", outfile: "build/hle/web/codec.js", logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] hle:browser: the build failed"); process.exit(1); }
const names = Object.fromEntries(status().filter(r => r.file === "hle_codec_video.c").map(r => [r.cname, r.mangled]));
const html = `<!doctype html><meta charset="utf-8"><title>nxweb nn::codec</title><script>window.NXNAMES=${JSON.stringify(names)}</script><script src="/codec.js"></script>`;
const server = createServer((req, res) => {
  const send = (b: Buffer | string, type: string) => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(b); };
  if (req.url === "/") return send(html, "text/html");
  if (req.url === "/codec.js") return send(readFileSync(join(ROOT, "build", "hle", "web", "codec.js")), "text/javascript");
  if (req.url === "/hle.wasm") return send(readFileSync(join(ROOT, "build", "hle", "hle.wasm")), "application/wasm");
  res.writeHead(404); res.end();
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch({ headless: true });
let failed = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e: Error) => console.error(`page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as unknown as { nxResult?: unknown }).nxResult !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => (window as unknown as { nxResult: { checks: [boolean, string][]; logs: string[] } }).nxResult);
  console.log(`browser: Chromium ${browser.version()}`);
  for (const l of r.logs) console.log(`    | ${l}`);
  for (const [ok, what] of r.checks) { if (!ok) failed++; console.log(`${ok ? "ok  " : "[RED] FAIL"} ${what}`); }
  console.log(`\nhle:browser: ${r.checks.length} checks, ${failed} failed`);
} finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
