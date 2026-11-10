// EXPERIMENTAL (spike). Node side shared by the spike's runners: modules, guests, Workers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { ROOT, OUT } from "../../src/spike_workers/build.mts";
import { runGuest, type Guest, type RunCfg, type RunResult, type Spawned } from "../../src/spike_workers/coord.ts";
import type { Mods, EngineOpts } from "../../src/spike_workers/engine.ts";

const mod = (p: string) => new WebAssembly.Module(readFileSync(p));
let unsharedMods: Mods | undefined, sharedMods: Mods | undefined, sharedHelpersMods: Mods | undefined;
// today's binaries
export function modsUnshared(): Mods {
  const d = join(ROOT, "build", "runtime");
  return unsharedMods ??= { kernel: mod(join(d, "kernel.wasm")), translator: mod(join(d, "translator.wasm")), helpers: mod(join(d, "helpers.wasm")) };
}
// shared memory, mtify'd; helpers with a private memory per Worker
export function modsShared(): Mods {
  return sharedMods ??= { kernel: mod(join(OUT, "kernel.mt.wasm")), kernel2: mod(join(OUT, "kernel.mt2.wasm")), translator: mod(join(OUT, "translator.mt.wasm")),
    translator2: mod(join(OUT, "translator.mt2.wasm")), helpers: mod(join(OUT, "helpers.private.wasm")) };
}
// the same with ONE helpers static area for all Workers (to show what that breaks; pass opts.helpersPrivate = false)
export function modsSharedHelpers(): Mods { return sharedHelpersMods ??= { ...modsShared(), helpers: mod(join(OUT, "helpers.shared.wasm")) }; }

export function guest(name: string): Guest {
  const side = JSON.parse(readFileSync(join(OUT, "guests", name + ".json"), "utf8"));
  return { image: new Uint8Array(readFileSync(join(OUT, "guests", name + ".bin"))), ...side };
}
export function spawn(): Spawned {
  const w = new Worker(new URL("../../src/spike_workers/worker_node.mts", import.meta.url));
  return { post: m => w.postMessage(m), onmsg: fn => { w.on("message", fn); w.on("error", e => fn({ type: "error", text: String(e?.stack ?? e) })); }, kill: () => { void w.terminate(); } };
}
export type Config = "unshared" | "shared-green" | 1 | 2 | 3 | 4;
export function run(name: string | Guest, config: Config, opts: EngineOpts = {}, mods?: Mods): Promise<RunResult> {
  const g = typeof name === "string" ? guest(name) : name;
  const cfg: RunCfg = config === "unshared" ? { shared: false, workers: 0, mods: mods ?? modsUnshared(), guest: g, opts }
    : { shared: true, workers: config === "shared-green" ? 0 : config, mods: mods ?? modsShared(), guest: g, opts };
  return runGuest(spawn, cfg);
}
export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
