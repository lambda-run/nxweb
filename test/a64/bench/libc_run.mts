// npm run a64:libc: the C library intrinsics (src/a64/libc.ts) against the native libc, in the three memory modes:
// libc_test (build.py) translated with its optimized-routines definitions, then with them named as intrinsics.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuest, defaultOpts } from "../guest_core.ts";
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "build/a64/bench");
if (!existsSync(join(out, "libc_test.json"))) { console.error("[RED] no libc_test image: run npm run a64:bench:build"); process.exit(2); }
const LIBC = ["memcpy", "memmove", "memset", "memcmp", "memchr", "strlen", "strnlen", "strcmp", "strncmp"];
const expected = readFileSync(join(out, "libc_test.out"));
let bad = 0, rows = 0;
for (const mode of ["memory32", "memory64", "memory64-high"]) {
  const m64 = mode !== "memory32", hi = mode === "memory64-high";
  const side = JSON.parse(readFileSync(join(out, "libc_test" + (hi ? "_hi" : "") + ".json"), "utf8"));
  const image = readFileSync(join(out, side.image));
  const t = new WebAssembly.Module(readFileSync(join(root, `build/a64/translator${m64 ? "64" : ""}.wasm`)));
  const h = new WebAssembly.Module(readFileSync(join(root, `build/a64/helpers${m64 ? "64" : ""}.wasm`)));
  for (const on of [false, true]) {
    const libc = on ? LIBC.map(n => ({ pc: side.symbols[n], name: n })) : undefined;
    const r = runGuest(t, h, "libc_test", side, image, expected, { ...defaultOpts, mem64: m64, libc });
    const ok = r.ok && (!on || (r.libcTook?.length === LIBC.length && (r.libcCalls ?? 0) > 0));
    rows++; if (!ok) bad++;
    console.log(`${ok ? "ok  " : "[RED] FAIL"} ${mode.padEnd(14)} ${on ? `intrinsics (${r.libcTook?.length} named, ${r.libcCalls} calls)` : "translated optimized-routines"} ${r.runMs.toFixed(1)} ms${r.ok ? "" : ": " + r.why}`);
  }
}
console.log(`a64:libc: ${rows - bad} of ${rows} ok`);
process.exit(bad ? 1 : 0);
