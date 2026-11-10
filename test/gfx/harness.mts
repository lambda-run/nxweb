// Node side of the graphics tests: builds the recorder (build/gfx/gfx.wasm), the reference values compiled from
// nxnative's own headers, and gives a fake guest (guest.ts) whose host stream goes nowhere, for everything that
// needs no GPU: layouts, record sizes, recording behaviour, lookup.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../src/kit/host/gen.mts";
import { generate, OUT as NAMES_OUT } from "../../src/gfx/host/gen_names.mts";
import { Guest } from "./guest.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT = join(ROOT, "build", "gfx");
export const WASM = join(OUT, "gfx.wasm");
export const NXNATIVE = process.env.NXNATIVE ?? "/home/user/nxnative";
const NVN_DIR = join(NXNATIVE, "dm", "gfx", "nvn");

export function buildWasm(): void {
  const stale = check();
  if (stale.length) throw new Error(stale.map(b => `[RED] gfx: ${b} (run \`npm run kit:diagrams\`)`).join("\n"));
  const g = generate();
  if (!existsSync(NAMES_OUT) || readFileSync(NAMES_OUT, "utf8") !== g.source) writeFileSync(NAMES_OUT, g.source);
  mkdirSync(OUT, { recursive: true });
  execFileSync(process.execPath, [join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js"), "src/gfx/index.ts", "-o", "build/gfx/gfx.wasm", "--runtime", "stub", "-O2",
    "--importMemory", "--memoryBase", "65536"], { cwd: ROOT, stdio: "inherit" });
}
// name=value lines printed by a C program compiled against nxnative's headers
export function reference(src: string, extra: string[] = [], input?: string): string {
  const exe = join(OUT, src.replace(/\.c$/, ""));
  execFileSync("gcc", ["-w", "-O1", `-I${NVN_DIR}`, `-I${join(NVN_DIR, "include")}`, join(ROOT, "test", "gfx", src), ...extra, "-o", exe], { stdio: "inherit" });
  return execFileSync(exe, { input, encoding: "utf8" });
}
export const haveReference = () => existsSync(join(NVN_DIR, "nvn_obj.h"));
export function pairs(text: string): Map<string, bigint> { return new Map(text.trim().split("\n").map(l => { const [k, v] = l.split("="); return [k, BigInt(v)] as [string, bigint]; })); }

let wasm: Buffer | undefined;
export async function guest(): Promise<Guest> { wasm ??= readFileSync(WASM); return Guest.create(wasm, { gfx_exec: () => {} }); }

export const tests: { name: string; fn: () => void | Promise<void> }[] = [];
export function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }
