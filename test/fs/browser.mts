// npm run fs:browser: the fs module in headless Chromium (Playwright), in a Worker of a page served from
// http://localhost with COOP same-origin and COEP require-corp. Saves on real OPFS, RomFS through a Blob, and a
// commit killed at each of its storage operations by reloading the page.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, WASM, SCRATCH, FN, build, python } from "./harness.mts";
import { mkdirSync } from "node:fs";

process.chdir(ROOT);
try {
  build();
  buildSync({ entryPoints: ["test/fs/web/worker.ts"], bundle: true, format: "iife", outfile: "build/fs/web/worker.js", logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] fs:browser: the build failed"); process.exit(1); }
mkdirSync(SCRATCH, { recursive: true });
const rom = join(SCRATCH, "browser-rom.img");
python(["synth", rom, "--seed", "77", "--files", "250", "--dirs", "30", "--depth", "6", "--max-size", "60000", "--max-name", "40"]);
const romList = python(["ls", rom]);

const { chromium } = createRequire(import.meta.url)("playwright");
const page = `<!doctype html><meta charset="utf-8"><title>nxweb fs tests</title><script>
let worker, next = 1; const waiting = new Map();
window.stopped = null;
function start() { worker = new Worker("/worker.js");
  worker.onmessage = (ev) => { if (ev.data.stopped) { window.stopped = ev.data.stopped; return; } const w = waiting.get(ev.data.id); waiting.delete(ev.data.id); w && w(ev.data); };
  worker.onerror = (e) => { for (const w of waiting.values()) w({ ok: false, value: "worker error: " + e.message }); }; }
window.run = (a) => { if (!worker) start(); const id = next++; return new Promise(res => { waiting.set(id, res); worker.postMessage({ ...a, id }); }); };
window.launch = (a) => { window.stopped = null; window.result = null; window.run(a).then(r => { window.result = r; }); };
</script>`;
const server = createServer((req, res) => {
  const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (body: Buffer | string, type: string) => { res.writeHead(200, { ...head, "Content-Type": type }); res.end(body); };
  try {
    switch (req.url) {
      case "/": return send(page, "text/html");
      case "/worker.js": return send(readFileSync(join(ROOT, "build", "fs", "web", "worker.js")), "text/javascript");
      case "/fs.wasm": return send(readFileSync(WASM), "application/wasm");
      case "/fn.json": return send(JSON.stringify(FN), "application/json");
      case "/rom.img": return send(readFileSync(rom), "application/octet-stream");
      case "/rom.json": return send(romList, "text/plain");
    }
  } catch { /* 404 */ }
  res.writeHead(404, head); res.end("not found");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const channel = process.env.FS_BROWSER_CHANNEL ?? "chromium";
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }) });
let failed = 0, ran = 0;
const red = (m: string) => { failed++; console.log(`[RED] ${m}`); };
const dir = `nxweb-fs-test-${Date.now().toString(36)}`;
try {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e: Error) => red("page error: " + e.message));
  await p.goto(`http://localhost:${port}/`);
  const info = await p.evaluate(() => ({ isolated: (self as any).crossOriginIsolated, opfs: !!(navigator as any).storage?.getDirectory }));
  console.log(`browser: Chromium ${browser.version()} (${channel === "shell" ? "chrome-headless-shell" : "channel " + channel + ", headless"}), crossOriginIsolated=${info.isolated}, OPFS=${info.opfs}`);
  const run = (a: object): Promise<{ ok: boolean; value: any }> => p.evaluate((a: object) => (window as any).run(a), a);

  for (const name of (await run({ cmd: "list" })).value as string[]) {
    const t0 = Date.now(), r = await run({ cmd: name, dir });
    ran++;
    if (r.ok) console.log(`ok   ${name} (${r.value}; ${Date.now() - t0} ms)`); else red(`FAIL ${name}\n${r.value}`);
  }

  // A page reload in the middle of a commit, at every storage operation of the transaction
  ran++;
  const t0 = Date.now();
  try {
    const crashDir = (k: number) => `${dir}-crash${k}`;
    const must = async (a: object) => { const r = await run(a); if (!r.ok) throw new Error(r.value); return r.value as string; };
    const v2 = await must({ cmd: "crash: prepare", dir: crashDir(-1) });
    const full = JSON.parse(await must({ cmd: "crash: run", dir: crashDir(-1), k: -1 })) as { text: string; kinds: string[] };
    const done = JSON.parse(await must({ cmd: "crash: verify", dir: crashDir(-1) }));
    if (done.text !== full.text || done.gen !== 3) throw new Error(`without a reload the save is not version 3 (generation ${done.gen})`);
    const kinds = full.kinds, slotWrite = kinds.lastIndexOf("write");
    if (kinds.filter(k => k === "flush").length !== 2 || kinds[slotWrite - 1] !== "flush" || kinds[slotWrite + 1] !== "flush") throw new Error(`unexpected commit sequence: ${kinds.join(" ")}`);
    const seen: string[] = [];
    let tries = 0;
    for (let k = 0; k < kinds.length; k++) {
      await must({ cmd: "crash: prepare", dir: crashDir(k) });
      await p.evaluate((a: object) => (window as any).launch(a), { cmd: "crash: run", dir: crashDir(k), k });
      await p.waitForFunction(() => (window as any).stopped || (window as any).result, null, { timeout: 30000 });
      const st = await p.evaluate(() => ({ stopped: (window as any).stopped, result: (window as any).result }));
      if (!st.stopped) throw new Error(`operation ${k}: the worker did not stop: ${JSON.stringify(st.result)}`);
      if (st.stopped.at !== k || st.stopped.kind !== kinds[k]) throw new Error(`operation ${k}: stopped at ${JSON.stringify(st.stopped)}`);
      await p.reload();   // the worker dies inside the storage operation, holding the save's access handle
      const got = JSON.parse(await must({ cmd: "crash: verify", dir: crashDir(k) }));
      // the commit is real once the superblock slot is written whole: here that is every operation after the slot write
      const want = k <= slotWrite ? v2 : full.text;
      const which = got.text === v2 ? "old" : got.text === full.text ? "new" : "MIXED";
      seen.push(`${k}:${kinds[k]}${k === slotWrite ? "(slot)" : ""}=${which}`);
      tries = Math.max(tries, got.waited);
      if (got.text !== want) throw new Error(`reload at operation ${k} (${kinds[k]}): the save is the ${which} version, expected the ${k <= slotWrite ? "old" : "new"} one\n${got.text}`);
      if (got.gen !== (k <= slotWrite ? 2 : 3)) throw new Error(`reload at operation ${k}: generation ${got.gen}`);
    }
    console.log(`ok   crash: the page is reloaded at each of the ${kinds.length} storage operations of a transaction and its commit: old version up to the superblock write, new after it (${seen.join(" ")}; the mount after a reload waited up to ${tries} ms for the dead worker's access handle; ${Date.now() - t0} ms)`);
  } catch (e) { red(`FAIL crash: a page reload in the middle of a commit\n${e instanceof Error ? e.stack : e}`); }
} finally {
  await browser.close();
  server.close();
}
console.log(`\nfs:browser (Chromium ${browser.version()}): ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
