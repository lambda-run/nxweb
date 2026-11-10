// npm run rt:test [-- <filter>]. Builds the runtime's wasm modules and test NSOs, then runs every case of cases.ts
// under Node. The process machine's table alone is tested in process.machine.test.mts (`npm run kit:test`).
import { ROOT, build, buildModules, loadEnv } from "./harness.mts";
import { runCases, formatResult } from "./cases.ts";

process.chdir(ROOT);
try { build(); buildModules(); }
catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] rt:test: the build failed"); process.exit(1); }
const env = loadEnv();
if (!env.corpus.length) console.error("[RED] rt:test: test/guests/out is empty (run `npm run guests:build`): the corpus case will fail");
const only = process.argv[2];
const results = runCases(env, only, r => console.log(formatResult(r)));
const failed = results.filter(r => !r.ok).length;
console.log(`\nrt:test (node ${process.version}): ${results.length} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
