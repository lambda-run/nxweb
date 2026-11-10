// A stored translation is only as good as the translator that made it: the page keeps translated units by a key
// that holds A64_CACHE_VERSION, so a translator change without a bump leaves every player with stale code (found on
// the first real game: a fixed instruction still faulted, from the cache). This check ties the version to a hash of
// the translator's sources: change src/a64 and it fails until the version is bumped and the stamp updated
// (`node test/a64/cache_stamp.mts --update`, which refuses to keep the old version).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { A64_CACHE_VERSION } from "../../src/glue/a64_host.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."), DIR = join(ROOT, "src", "a64"), FILE = join(ROOT, "test", "a64", "cache_stamp.json");
const h = createHash("sha256");
for (const f of readdirSync(DIR).filter(f => f.endsWith(".ts")).sort()) { h.update(f + "\0"); h.update(readFileSync(join(DIR, f))); }
const sources = h.digest("hex"), old = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) as { version: number; sources: string } : null;
if (process.argv.includes("--update")) {
  if (old && old.sources !== sources && old.version === A64_CACHE_VERSION) { console.error(`[RED] a64 cache stamp: src/a64 changed; bump A64_CACHE_VERSION (src/glue/a64_host.ts, now ${A64_CACHE_VERSION}) before updating the stamp`); process.exit(1); }
  writeFileSync(FILE, JSON.stringify({ version: A64_CACHE_VERSION, sources }, null, 2) + "\n"); console.log(`a64 cache stamp: version ${A64_CACHE_VERSION}, written`);
} else if (!old || old.version !== A64_CACHE_VERSION || old.sources !== sources) {
  console.error(`[RED] a64 cache stamp: ${!old ? "no stamp" : old.sources !== sources ? "src/a64 changed since version " + old.version + " was stamped: stored translations would be stale" : "the version changed"}; bump A64_CACHE_VERSION if the sources changed, then run: node test/a64/cache_stamp.mts --update`);
  process.exit(1);
} else console.log(`a64 cache stamp: version ${A64_CACHE_VERSION} matches src/a64`);
