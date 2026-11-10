// The converted profiles from a directory (Node)
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileSource } from "./profiles.ts";
export const PROFILES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "profiles");
export function nodeProfiles(dir = PROFILES_DIR): ProfileSource {
  const get = (n: string) => JSON.parse(readFileSync(join(dir, n), "utf8"));
  return { index: async () => get("index.json"), game: async id => existsSync(join(dir, id + ".json")) && /^[0-9A-F]{16}$/.test(id) ? get(id + ".json") : null, sdk: async () => get("_sdk.json") };
}
