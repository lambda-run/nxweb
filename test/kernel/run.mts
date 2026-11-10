// npm run kernel:test. Compiles the kernel (build/kernel/kernel.wasm), runs every test of test/kernel/*.test.mts
// (the *.machine.test.mts files belong to `npm run kit:test`), then applies the kit's coverage rule to the kernel's
// machines as the kernel itself drove them: a transition no test made the kernel take fails the run.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unexercised } from "../../src/kit/host/reader.mts";
import { ROOT, build, tests, harvest, coverage } from "./harness.mts";

process.chdir(ROOT);
let failed = 0;
const red = (m: string) => { failed++; console.error(`[RED] ${m}`); };
try { build(); } catch { console.error("[RED] kernel:test: src/kernel/index.ts did not compile"); process.exit(1); }

const dir = import.meta.dirname;
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mts") && !f.endsWith(".machine.test.mts")).sort()) await import(pathToFileURL(join(dir, f)).href);

const only = process.argv[2];
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  try { t.fn(); console.log(`ok   ${t.name}`); }
  catch (e) { red(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
  harvest();
}
const { machines, hits } = coverage();
const missing = only ? [] : unexercised(machines, hits);
for (const m of missing) red(`coverage: the kernel never took ${m}`);
const transitions = machines.reduce((n, m) => n + m.table.filter(t => t !== 0xFF).length, 0);
console.log(`\nkernel:test: ${only ? tests.filter(t => t.name.includes(only)).length : tests.length} tests, ${failed - missing.length} failed; coverage: ${transitions - missing.length}/${transitions} transitions of ${machines.map(m => m.name).join(", ")} taken by the kernel`);
process.exit(failed ? 1 : 0);
