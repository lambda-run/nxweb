// `npm run a64:extra`: translator feature tests (test/a64/extra_tests.ts) under Node.
import { readFileSync } from "node:fs";
import { runExtraTests } from "./extra_tests.ts";
const m = (f: string) => new WebAssembly.Module(readFileSync(new URL("../../build/a64/" + f, import.meta.url)));
const rs = runExtraTests({ translator: m("translator.wasm"), helpers: m("helpers.wasm"), translatorShared: m("translator.shared.wasm"), helpersShared: m("helpers.shared.wasm") });
for (const r of rs) console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}\n       ${r.detail}`);
const bad = rs.filter(r => !r.ok).length;
console.log(`a64 extra: ${rs.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
