// npm run gfx:test. Builds the recorder, runs the Node tests (layouts against nxnative's headers, recording), then
// serves the scenes to headless Chromium (WebGPU on SwiftShader), prints each scene's result and saves the demo's
// screenshot to build/gfx/demo.png.   `node test/gfx/run.mts [filter]`, `--no-browser` for the Node part alone.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWasm, tests, ROOT } from "./harness.mts";
import { browserTests } from "./browser.mts";

process.chdir(ROOT);
let failed = 0, ran = 0;
const red = (m: string) => { failed++; console.error(`[RED] ${m}`); };
try { buildWasm(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }

const dir = import.meta.dirname, args = process.argv.slice(2), only = args.find(a => !a.startsWith("--"));
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mts") && !f.endsWith(".machine.test.mts")).sort()) await import(pathToFileURL(join(dir, f)).href);
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  ran++;
  try { await t.fn(); console.log(`ok   ${t.name}`); }
  catch (e) { red(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
}
let scenes = 0, sceneFailed = 0, extra = "";
if (!args.includes("--no-browser")) {
  try { const r = await browserTests(only); scenes = r.ran; sceneFailed = r.failed; failed += r.failed; extra = r.summary; }
  catch (e) { red(`browser run failed\n${e instanceof Error ? e.stack : e}`); }
}
console.log(`\ngfx:test: ${ran} node tests, ${failed - sceneFailed} failed; ${scenes} browser scenes, ${sceneFailed} failed${extra}`);
process.exit(failed ? 1 : 0);
