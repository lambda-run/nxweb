// Translation cache storage for Node tests: one file per key in a directory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { A64CacheStore } from "../../src/glue/a64_host.ts";

export function nodeFileStore(dir: string): A64CacheStore {
  mkdirSync(dir, { recursive: true });
  const file = (key: string) => join(dir, createHash("sha256").update(key).digest("hex").slice(0, 32) + ".a64c");
  return {
    async get(key) { const f = file(key); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; },
    async put(key, bytes) { writeFileSync(file(key), bytes); },
  };
}
