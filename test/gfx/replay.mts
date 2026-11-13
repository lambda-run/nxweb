// node test/gfx/replay.mts <capture file> [--out <dir>] [--limits name:value,...] [--shaders <dir>]      (test/gfx/REPLAY.md)
// Replays a stream capture (`?gfxcapture=`, src/glue/gfx_stream_capture.ts) in headless Chromium (WebGPU on SwiftShader) without the game: writes each
// presented frame as frame-<n>.png (and the image the live run presented as frame-<n>.live.png), every red line of the replayer and of WebGPU with its
// count as errors.txt, the replayer's whole log as replay.log and the summary as summary.json into <dir> (default: <capture>.replay). Exit code 0 when the
// replay ran (red lines or not), 1 when it could not.
import { createServer } from "node:http";
import { openSync, readSync, fstatSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, normalize, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { indexCapture } from "../../src/glue/gfx_stream_capture.ts";

const ROOT = resolve(import.meta.dirname, "../.."), args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const trace = args.includes("--trace") ? (args.splice(args.indexOf("--trace"), 1), true) : false;
const skipbig = opt("--skipbig") ?? "", keepKeys = opt("--keep") ?? "";
const raw = args.includes("--raw") ? (args.splice(args.indexOf("--raw"), 1), true) : false;   // --raw: every dumped texture also as its texel bytes (f<frame>-tex<serial>.<format>.<w>x<h>.raw)
const outDir = opt("--out"), limits = opt("--limits") ?? "", shaderDir = opt("--shaders"), dump = opt("--dump") ?? "", dumpat = opt("--dumpat") ?? "", texmax = opt("--texmax") ?? "", file = args[0];
if (!file || !existsSync(file)) { console.error("usage: node test/gfx/replay.mts <capture file> [--out <dir>] [--limits maxStorageBuffersPerShaderStage:8,...]"); process.exit(1); }
const out = resolve(outDir ?? file + ".replay");
mkdirSync(out, { recursive: true });
const fd = openSync(file, "r"), size = fstatSync(fd).size;
const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); };
const index = await indexCapture(read, size), count = (t: string) => index.chunks.filter(c => c.h.type === t).length;
const meta = index.chunks.find(c => c.h.type === "meta")?.h ?? {};
console.log(`${file}: ${(size / 1048576).toFixed(1)} MB, ${count("frame")} frames in ${count("batch")} batches from present ${meta.startPresent}, ${count("tex")} textures, ${count("pipe")} pipelines made before, ${count("shader")} shaders${index.complete ? "" : " (INCOMPLETE: no end chunk)"}`);

execFileSync(join(ROOT, "node_modules", "esbuild", "bin", "esbuild"), ["test/gfx/replay_page.mts", "--bundle", "--format=esm", "--outdir=build/gfx", "--log-level=warning"], { cwd: ROOT, stdio: "inherit" });
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  if (path === "/__shaders") {      // --shaders <dir>: <key>.wgsl and <key>.refl.json (the reflection record) of stages translated again; they replace the capture's
    const o: Record<string, { wgsl: string; refl: unknown }> = {};
    if (shaderDir) for (const c of index.chunks) { const k = c.h.type === "shader" ? String(c.h.key) : "", w = join(shaderDir, k + ".wgsl"), r = join(shaderDir, k + ".refl.json"); if (k && existsSync(w) && existsSync(r)) o[k] = { wgsl: readFileSync(w, "utf8"), refl: JSON.parse(readFileSync(r, "utf8")) }; }
    res.writeHead(200, { ...head, "Content-Type": "application/json" }); res.end(JSON.stringify(o)); return;
  }
  if (path === "/__index") { res.writeHead(200, { ...head, "Content-Type": "application/json" }); res.end(JSON.stringify(index)); return; }
  if (path === "/__cap") {
    const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ""));
    if (!m) { res.writeHead(416, head); res.end(); return; }
    res.writeHead(206, { ...head, "Content-Type": "application/octet-stream" }); res.end(read(+m[1], +m[2] - +m[1] + 1)); return;
  }
  if (path.startsWith("/__out/") && req.method === "POST") {
    const name = path.slice(7).replace(/[^A-Za-z0-9._-]/g, ""), parts: Buffer[] = [];
    req.on("data", c => parts.push(c)); req.on("end", () => { writeFileSync(join(out, name), Buffer.concat(parts)); res.writeHead(200, head); res.end("ok"); }); return;
  }
  const f = join(ROOT, path);
  if (!f.startsWith(ROOT) || !existsSync(f) || !MIME[extname(f)]) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { ...head, "Content-Type": MIME[extname(f)] }); res.end(readFileSync(f));
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${(server.address() as any).port}`;
const req = createRequire(import.meta.url);
let pw: any;
for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { pw = req(p); break; } catch { /* next */ } }
if (!pw) { console.error("playwright is not installed"); process.exit(1); }
// --cdp <http endpoint>: a browser that is already running (the Mac's headless Chrome with the real GPU, http://192.168.64.1:9334) instead of one
// launched here. It cannot reach this server, and WebGPU needs a secure origin: the page's requests to a localhost origin are answered over the
// DevTools connection from this server (page.route), so nothing has to be forwarded
const cdp = opt("--cdp"), capUrl = opt("--capurl") ?? "http://localhost:8080", pageUrl = cdp ? "http://localhost:8099" : url;
const browser = cdp ? await pw.chromium.connectOverCDP(cdp) : await pw.chromium.launch({ args: (process.env.GPU_FLAGS ?? "--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-vulkan=swiftshader --disable-gpu-watchdog --disable-gpu-process-crash-limit").split(" ") });
let code = 0;
try {
  const ctx = cdp ? await browser.newContext() : null; (globalThis as any).__ctx = ctx;
  // (the page's origin is answered over DevTools, so Chrome sees its fetch of the web server as a public page reaching the loopback network: allowed by hand)
  if (ctx && capUrl) for (const perm of ["local-network-access", "loopback-network", "local-network"]) { try { await ctx.grantPermissions([perm], { origin: pageUrl }); } catch { /* a name this Chrome does not have */ } }
  const page = ctx ? await ctx.newPage() : await browser.newPage(), errors: string[] = [];
  if (cdp) await page.route(pageUrl + "/**", async (route: any) => {
    // the capture's bytes come from the web server the browser reaches itself (web/serve.mts on the Mac's localhost:8080, /__cap/<name> in ranges, for a
    // capture in its reports directory): a gigabyte through the DevTools connection took over half an hour. --capurl "" sends them through it all the same
    if (capUrl && route.request().url().startsWith(pageUrl + "/__cap")) { await route.continue({ url: `${capUrl}/__cap/${basename(file)}` }); return; }
    const rq = route.request(), h = rq.headers(), init: any = { method: rq.method(), headers: h.range ? { range: h.range } : {} };
    if (rq.method() === "POST") init.body = rq.postDataBuffer() ?? Buffer.alloc(0);
    try { const r = await fetch(url + rq.url().slice(pageUrl.length), init), headers: Record<string, string> = {}; r.headers.forEach((v, k) => { if (!/^(content-length|connection|transfer-encoding|date|keep-alive)$/.test(k)) headers[k] = v; });
      await route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) }); } catch (e) { await route.abort().catch(() => {}); }
  });
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()); });
  await page.goto(`${pageUrl}/test/gfx/replay.html?limits=${encodeURIComponent(limits)}&dump=${encodeURIComponent(dump)}&texmax=${encodeURIComponent(texmax)}&trace=${trace ? 1 : 0}&raw=${raw ? 1 : 0}&dumpat=${encodeURIComponent(dumpat)}&skipbig=${encodeURIComponent(skipbig)}&keep=${encodeURIComponent(keepKeys)}`);
  const r = await page.evaluate("window.__replay");
  if (r.fatal) throw new Error(`the replay page failed: ${r.fatal}\n${errors.join("\n")}`);
  writeFileSync(join(out, "summary.json"), JSON.stringify({ file, size, meta, ...r, browser: errors }, null, 1));
  console.log(`replayed on ${r.adapter || "(no adapter info)"} in ${r.ms} ms: ${r.stats.passes} passes, ${r.stats.draws} draws, ${r.stats.dispatches} dispatches, ${r.stats.pipelinesFailed} pipelines failed, ${r.stats.errors} WebGPU errors`);
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const f of r.frames) console.log(`frame ${f.n}: tex#${f.serial} ${f.width}x${f.height} ${f.format} -> frame-${f.n}.png; against the live image: ${f.live === "same" ? "identical" : f.live === "differs" ? `${f.differing} of ${f.width * f.height} texels differ` : "none to compare"}${f.note ? ` (${f.note})` : ""}${f.line ? `\n         ${f.line}` : ""}`);
  for (const f of r.frames) { console.log(`frame ${f.n}, causes of red lines by count:`); for (const [l, n] of (f.reds ?? []).slice(0, 25)) console.log(`${String(n).padStart(6)}  ${l.length > 220 ? l.slice(0, 220) + "…" : l}`); }
  for (const d of r.dumps ?? []) console.log(`  frame ${d.frame}${d.pass !== undefined ? ` pass ${d.pass}` : ""} tex#${d.serial} ${d.width}x${d.height} ${d.format}: ${d.nonZero} of ${d.width * d.height} texels not zero${d.note ? ` (${d.note})` : ` -> f${d.frame}-tex${d.serial}.png`}`);
  const total = r.errors.reduce((n: number, e: [string, number]) => n + e[1], 0);
  console.log(`${r.errors.length} distinct red lines (${total} in all)${r.errors.length ? ", by count:" : ""}`);
  for (const [l, n] of r.errors.slice(0, 40)) console.log(`${String(n).padStart(6)}  ${l.length > 300 ? l.slice(0, 300) + "…" : l}`);
  if (r.errors.length > 40) console.log(`        … ${r.errors.length - 40} more in ${join(out, "errors.txt")}`);
  console.log(`written to ${out}`);
} catch (e) { console.error(e instanceof Error ? e.message : e); code = 1; }
finally { if (cdp) { for (const c of browser.contexts()) if (c === (globalThis as any).__ctx) await c.close(); } else await browser.close(); server.close(); }
process.exit(code);
