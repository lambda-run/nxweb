// npm run kit:test. Checks that the generated tables and diagrams are up to date, compiles test/kit/entry.ts,
// runs every test of test/kit/*.test.mts in this process, then applies the coverage rule: a transition of any
// machine's table that no test exercised fails the run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "../../src/kit/host/gen.mts";
import { unexercised } from "../../src/kit/host/reader.mts";
import { ROOT, WASM, tests, fresh, allHits, defs } from "./harness.mts";

let failed = 0;
const red = (m: string) => { failed++; console.error(`[RED] ${m}`); };

for (const b of check()) red(`kit:test: ${b} (run \`npm run kit:diagrams\`)`);
if (failed) process.exit(1);

mkdirSync(dirname(WASM), { recursive: true });
try {
  execFileSync(process.execPath, [join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js"), "test/kit/entry.ts", "-o", WASM, "--runtime", "stub", "-O3"],
    { cwd: ROOT, stdio: "inherit" });
} catch { red("kit:test: test/kit/entry.ts did not compile"); process.exit(1); }

const dir = import.meta.dirname;
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mts")).sort()) await import(pathToFileURL(join(dir, f)).href);
// Other areas test their own machines here too: test/<area>/*.machine.test.mts, written against this harness, so the
// coverage rule below covers every machine in the tree.
for (const area of readdirSync(join(dir, "..")).sort()) {
  const d = join(dir, "..", area);
  if (area === "kit" || !statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d).filter(f => f.endsWith(".machine.test.mts")).sort()) await import(pathToFileURL(join(d, f)).href);
}

for (const t of tests) {
  try { t.fn(); console.log(`ok   ${t.name}`); }
  catch (e) { red(`FAIL ${t.name}\n${e instanceof Error ? e.stack : e}`); }
}

const machines = fresh(false).machines;
const missing = unexercised(machines, allHits());
for (const m of missing) red(`coverage: no test exercised ${m}`);
const transitions = defs.reduce((n, d) => n + d.transitions.length, 0);

console.log(`\nkit:test: ${tests.length} tests, ${failed - missing.length} failed; coverage: ${transitions - missing.length}/${transitions} transitions of ${defs.length} machines exercised`);
process.exit(failed ? 1 : 0);
