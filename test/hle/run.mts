// npm run hle:test [-- <filter>]. Checks the generated files (inventory, table, machine tables), compiles the hle
// module (build/hle/hle.wasm), runs every test of test/hle/*.test.mts (the *.machine.test.mts files belong to
// `npm run kit:test`), then applies the kit's coverage rule to the hle machines as the module itself drove them.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "../../src/kit/host/gen.mts";
import { unexercised } from "../../src/kit/host/reader.mts";
import { hleBuild } from "../../src/hle/host/build.mts";
import { ROOT, tests, harvest, coverage } from "./harness.mts";

process.chdir(ROOT);
let failed = 0;
const red = (m: string) => { failed++; console.error(`[RED] ${m}`); };
for (const b of check()) red(`hle:test: ${b} (run \`npm run kit:diagrams\`)`);
try { execFileSync("python3", ["tools/hle_names.py", "--check"], { stdio: "inherit" }); } catch { red("hle:test: the inventory or the table is out of date"); }
if (failed) process.exit(1);
try { hleBuild(); } catch { console.error("[RED] hle:test: src/hle/index.ts did not compile"); process.exit(1); }

const dir = import.meta.dirname;
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mts") && !f.endsWith(".machine.test.mts")).sort()) await import(pathToFileURL(join(dir, f)).href);

const only = process.argv[2];
let ran = 0;
const t0 = Date.now();
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  ran++;
  try { await t.fn(); console.log(`ok   ${t.name}`); }
  catch (e) { red(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
  harvest();
}
const { machines, hits } = coverage();
const missing = only ? [] : unexercised(machines, hits);
for (const m of missing) red(`coverage: the hle module never took ${m}`);
const transitions = machines.reduce((n, m) => n + m.table.filter(t => t !== 0xFF).length, 0);
console.log(`\nhle:test: ${ran} tests, ${failed - missing.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s); coverage: ${transitions - missing.length}/${transitions} transitions of ${machines.map(m => m.name).join(", ")} taken by the module`);
process.exit(failed ? 1 : 0);
