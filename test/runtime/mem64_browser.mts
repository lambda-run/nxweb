// npm run rt:mem64:browser [-- --rounds 15 --launches 10 --engines chromium,firefox --tiers default,dynamic,liftoff,turbofan --doom-frames 1500 --json mem64_browser.json]
// rt:mem64's measurement (mem64_core.ts: the three memory configurations, the same-code corpus and Doom, every
// output checked) in a Worker of headless browsers driven by Playwright, the page served with COOP/COEP like
// rt:browser. Every launch is a new browser process; per launch one warm-up round and `rounds` measured rounds.
// Chromium (Playwright's full Chromium, headless; its V8 version from the DevTools protocol, Browser.getVersion) runs the four V8 tiers
// of rt:mem64 through --js-flags, with --expose-gc so the Worker can collect before every run; Firefox runs its
// default tiers, without a forced GC (content cannot call one). Run rt:mem64 first for the Doom reference
// (build/runtime/mem64/doom_ref.txt); without it, or without the Doom guest, Doom is skipped with a line.
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, OUT, corpusList } from "./harness.mts";
import { report, workloadNames, sameCode, type Flat, type Launch, type Samples } from "./mem64_core.ts";

process.chdir(ROOT);
const argv = process.argv.slice(2);
const arg = (name: string, d: string) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : d; };
const rounds = Number(arg("rounds", "15")), launches = Number(arg("launches", "10")), engines = arg("engines", "chromium,firefox").split(",");
const doomFrames = Number(arg("doom-frames", "1500")), jsonOut = arg("json", "mem64_browser.json");
const TIERS: Record<string, string[]> = { default: [], dynamic: ["--no-wasm-lazy-compilation"], liftoff: ["--liftoff-only", "--no-wasm-lazy-compilation"], turbofan: ["--no-liftoff", "--no-wasm-lazy-compilation"] };
const WHAT: Record<string, string> = { "chromium default": "V8's default: lazy compilation, Liftoff, dynamic tier-up; its execution includes the lazy Liftoff compile of the code a run reaches", "chromium dynamic": "eager Liftoff, dynamic tier-up; execution without compilation", "chromium liftoff": "eager Liftoff only", "chromium turbofan": "eager TurboFan only (steady state)", "firefox default": "SpiderMonkey's default tiers, no forced GC" };
const tiers = engines.flatMap(e => e === "chromium" ? arg("tiers", "default,dynamic,liftoff,turbofan").split(",").map(t => `chromium ${t}`) : [`${e} default`]);

const corpus = corpusList(), lo = join(ROOT, "test", "guests", "out"), hi = join(ROOT, "test", "a64", "guests", "out_hi");
const refFile = join(OUT, "mem64", "doom_ref.txt"), doomNso = join(ROOT, "build", "doom", "doom.nso");
const DOOM_WAD = process.env.DOOM_WAD ?? "/usr/share/games/doom/doom1.wad";
const doomRef = existsSync(refFile) && existsSync(doomNso) && existsSync(DOOM_WAD) ? readFileSync(refFile, "utf8").split("\n").filter(Boolean) : [];
if (!corpus.length || !existsSync(join(hi, corpus[0] + ".json"))) { console.log("[RED] rt:mem64:browser: build first (see rt:mem64)"); process.exit(1); }
const flats = (dir: string): Flat[] => corpus.map(name => { const side = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  return { name, side, image: new Uint8Array(readFileSync(join(dir, side.image))), expected: new Uint8Array(readFileSync(join(dir, side.expected_stdout))) }; });
const same = sameCode(flats(lo), flats(hi));
buildSync({ entryPoints: ["test/runtime/mem64_core.ts"], bundle: true, format: "iife", outfile: join(OUT, "web", "mem64_worker.js"), logLevel: "warning", absWorkingDir: ROOT });

const page = `<!doctype html><meta charset="utf-8"><title>rt:mem64</title><script>
window.progress = []; window.result = null;
const w = new Worker("/worker.js");
w.onmessage = ev => { if (ev.data.progress) window.progress.push(ev.data.progress); else window.result = ev.data; };
w.onerror = e => { window.result = { done: true, fatal: String(e.message) }; };
w.postMessage({});
</script>`;
const server = createServer((req, res) => {
  const url = req.url ?? "/", head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (body: Buffer | string, type: string) => { res.writeHead(200, { ...head, "Content-Type": type }); res.end(body); };
  try {
    let m: RegExpExecArray | null;
    if (url === "/") return send(page, "text/html");
    if (url === "/worker.js") return send(readFileSync(join(OUT, "web", "mem64_worker.js")), "text/javascript");
    if (url === "/config") return send(JSON.stringify({ corpus, rounds, doomFrames, doomRef: doomRef.length ? doomRef : null }), "application/json");
    if ((m = /^\/wasm\/(\w+)\.wasm$/.exec(url))) return send(readFileSync(join(OUT, m[1] + ".wasm")), "application/wasm");
    if ((m = /^\/(lo|hi)\/([\w.]+)$/.exec(url))) return send(readFileSync(join(m[1] === "lo" ? lo : hi, m[2])), "application/octet-stream");
    if (url === "/doom.nso") return send(readFileSync(doomNso), "application/octet-stream");
    if (url === "/doom1.wad") return send(readFileSync(DOOM_WAD), "application/octet-stream");
  } catch { /* 404 */ }
  res.writeHead(404, head); res.end("not found");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const pw = createRequire(import.meta.url)("playwright");

console.log(`rt:mem64:browser: ${launches} launches of ${tiers.join(", ")}; ${rounds} rounds each after one warm-up round; Doom ${doomRef.length ? doomFrames + " frames" : "SKIPPED (no build/runtime/mem64/doom_ref.txt: run rt:mem64 first, with the Doom guest and DOOM_WAD)"}`);
const runs: Record<string, Launch[]> = Object.fromEntries(tiers.map(t => [t, []]));
let failed = 0;
for (let l = 0; l < launches && !failed; l++) for (let k = 0; k < tiers.length && !failed; k++) {
  const tier = tiers[(k + l) % tiers.length], [engine, t] = tier.split(" ");
  const flags = engine === "chromium" ? ["--expose-gc", ...TIERS[t]] : [];
  const browser = await pw[engine].launch({ headless: true, ...(engine === "chromium" ? { channel: "chromium", args: [`--js-flags=${flags.join(" ")}`] } : {}) });
  try {
    let version = `${engine === "chromium" ? "Chromium" : "Firefox"} ${browser.version()}`;
    if (engine === "chromium") {
      const cdp = await browser.newBrowserCDPSession(), v = await cdp.send("Browser.getVersion");
      version += `, V8 ${v.jsVersion}`;
      await cdp.detach();
    }
    const p = await browser.newPage();
    p.on("pageerror", (e: Error) => { console.log("[RED] page error: " + e.message); failed++; });
    await p.goto(`http://localhost:${port}/`);
    let result: any = null;
    while (!result) {
      await new Promise(r => setTimeout(r, 500));
      const got = await p.evaluate(() => { const w = window as any; return { progress: w.progress.splice(0), result: w.result }; });
      for (const line of got.progress) console.error(`  [${tier} launch ${l + 1}/${launches}]${line}`);
      result = got.result;
    }
    if (result.fatal) { console.log(`[RED] ${tier}, launch ${l + 1}: ${result.fatal}`); failed++; break; }
    if (engine === "chromium" && !result.gc) { console.log(`[RED] ${tier}: --js-flags=--expose-gc did not give the Worker gc()`); failed++; break; }
    runs[tier].push({ engine: version + `, crossOriginIsolated=${result.isolated}, forced GC ${result.gc ? "yes" : "no"}`, flags: engine === "chromium" ? [`--js-flags=${flags.join(" ")}`] : [], samples: result.samples as Samples });
  } finally { await browser.close(); }
}
server.close();
if (failed) { console.log(`[RED] rt:mem64:browser: ${failed} failures`); process.exit(1); }
const insns = same.lo.reduce((a, g) => a + (g.side.insn_count ?? 0), 0);
const rep = report(tiers.map(t => ({ name: t, what: WHAT[t] ?? t })), runs,
  { rounds, ...workloadNames(`${same.lo.length} programs, ${(insns / 1e6).toFixed(1)} M guest instructions`, doomFrames), lazy: ["chromium default", "chromium dynamic"] });
for (const l of rep.lines) console.log(l);
console.log("\nsame code above 4 GB: " + same.line + "; Doom loads the same NSO file in every configuration");
writeFileSync(join(OUT, jsonOut), JSON.stringify({ rounds, launches, doomFrames, sameCode: same.line, tiers: rep.json, headline: rep.headline }, null, 1));
console.log(`\nexecution time against memory32 (median of the paired per-round ratios, 95 % CI):\n  ${rep.headline.join("\n  ")}`);
console.log(`\nrt:mem64:browser: all outputs checked; build/runtime/${jsonOut}`);
