// npm run fs:test [-- <filter>]. Compiles the fs module (build/fs/fs.wasm), runs every test of test/fs/*.test.mts
// (the *.machine.test.mts files belong to `npm run kit:test`), then applies the kit's coverage rule to the fs
// machines as the module itself drove them: a transition no test made the module take fails the run.
import { readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "../../src/kit/host/gen.mts";
import { unexercised } from "../../src/kit/host/reader.mts";
import { ROOT, SCRATCH, build, tests, harvest, coverage } from "./harness.mts";

process.chdir(ROOT);
let failed = 0;
const red = (m: string) => { failed++; console.error(`[RED] ${m}`); };
for (const b of check()) red(`fs:test: ${b} (run \`npm run kit:diagrams\`)`);
if (failed) process.exit(1);
try { build(); } catch { console.error("[RED] fs:test: src/fs/index.ts did not compile"); process.exit(1); }
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

const dir = import.meta.dirname;
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mts") && !f.endsWith(".machine.test.mts")).sort()) await import(pathToFileURL(join(dir, f)).href);

const only = process.argv[2];
let ran = 0;
const t0 = Date.now();
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  ran++;
  const t1 = Date.now();
  try { await t.fn(); console.log(`ok   ${t.name} (${Date.now() - t1} ms)`); }
  catch (e) { red(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
  harvest();
}
const { machines, hits } = coverage();
const missing = only ? [] : unexercised(machines, hits);
for (const m of missing) red(`coverage: the fs module never took ${m}`);
const transitions = machines.reduce((n, m) => n + m.table.filter(t => t !== 0xFF).length, 0);
rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\nfs:test: ${ran} tests, ${failed - missing.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s); coverage: ${transitions - missing.length}/${transitions} transitions of ${machines.map(m => m.name).join(", ")} taken by the module`);
process.exit(failed ? 1 : 0);
