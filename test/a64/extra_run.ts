// `npm run a64:extra`: translator feature tests (test/a64/extra_tests.ts) under Node. `--mem64`: in the memory64
// mode (wasm64 translator, 64-bit memory); with `--high` at addresses above 4 GB.
import { readFileSync } from "node:fs";
import { runExtraTests } from "./extra_tests.ts";
const m = (f: string) => new WebAssembly.Module(readFileSync(new URL("../../build/a64/" + f, import.meta.url)));
const mem64 = process.argv.includes("--mem64"), high = process.argv.includes("--high"), x = mem64 ? "64" : "";
const rs = runExtraTests({ translator: m(`translator${x}.wasm`), helpers: m(`helpers${x}.wasm`), translatorShared: m(`translator${x}.shared.wasm`), helpersShared: m(`helpers${x}.shared.wasm`) }, { mem64, high });
const brief = process.argv.includes("--brief");   // names only; details of the failures
for (const r of rs) console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}` + (brief && r.ok ? "" : `\n       ${r.detail}`));
const bad = rs.filter(r => !r.ok).length;
console.log(`a64 extra${mem64 ? " (memory64" + (high ? ", above 4 GB)" : ")") : ""}: ${rs.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
