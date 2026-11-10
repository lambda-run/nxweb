// npm run loader:test. Compiles the loader (build/loader/loader.wasm), builds the test modules with clang, ld.lld and
// tools/elf2nso.py, runs every test of test/loader/*.test.mts, then applies the kit's coverage rule to the `module`
// machine: a transition of its table that no test took fails the run.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "../../src/loader/host/build.mts";
import { unexercised } from "../../src/kit/host/reader.mts";
import { ROOT, tests, buildModules, moduleCoverage } from "./harness.mts";

process.chdir(ROOT);
let failed = 0;
const red = (m: string) => { failed++; console.error(`[RED] ${m}`); };

try { build(); buildModules(); }
catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }

const dir = import.meta.dirname;
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mts") && !f.endsWith(".machine.test.mts")).sort()) await import(pathToFileURL(join(dir, f)).href);

const only = process.argv[2];
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  try { t.fn(); console.log(`ok   ${t.name}`); }
  catch (e) { red(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
}

const { machine, hits } = moduleCoverage();
const missing = only ? [] : unexercised([machine], [hits]);
for (const m of missing) red(`coverage: no test exercised ${m}`);
const transitions = machine.table.filter(t => t !== 0xFF).length;
console.log(`\nloader:test: ${tests.length} tests, ${failed - missing.length} failed; coverage: ${transitions - missing.length}/${transitions} transitions of the module machine exercised`);
process.exit(failed ? 1 : 0);
