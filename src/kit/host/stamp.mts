// A wasm module that uses the kit compiles src/kit/gen/tables.ts in, and machine ids are positions in that table:
// after `npm run kit:diagrams` adds or changes a machine, every such module must be built again. A build writes
// `<file>.kit` beside its output (the hash of the tables it was built from); whoever loads a module it did not just
// build calls checkStamp, which refuses a module built from other tables.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { KIT_DIR } from "./defs.mts";

export function kitStamp(): string { return createHash("sha256").update(readFileSync(join(KIT_DIR, "gen", "tables.ts"))).digest("hex").slice(0, 32); }
export function writeStamp(wasmPath: string): void { writeFileSync(wasmPath + ".kit", kitStamp() + "\n"); }
// throws when the module was built from other kit tables, or carries no stamp
export function checkStamp(wasmPath: string): void {
  const f = wasmPath + ".kit";
  if (!existsSync(wasmPath)) throw new Error(`[RED] ${wasmPath} is not built`);
  const have = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  if (have !== kitStamp()) throw new Error(`[RED] ${wasmPath} is stale: it was built from ${have ? "other kit tables (src/kit/gen/tables.ts changed since)" : "kit tables nobody recorded"}; build it again`);
}
