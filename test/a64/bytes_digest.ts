// `npm run a64:bytes` (`node test/a64/bytes_digest.ts [--build DIR] [--mem64]`): a digest of every wasm byte the
// translator emits, per option set: the core module, and for the guest corpus the units as the translation cache
// exports them (module bytes, function pcs, side tables). Two builds of the translator emit the same code exactly
// when these lines are the same: run it on the binaries of two source trees (`--build` names the directory of
// translator*.wasm / helpers*.wasm, default build/a64) and compare the output. That is how a change meant for one
// memory mode is shown to leave the other's code byte for byte alone.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runGuest, defaultOpts, type GuestOpts } from "./guest_core.ts";
import { A64 } from "../../src/glue/rt_layout.ts";

const root = new URL("../../", import.meta.url).pathname;
const argv = process.argv.slice(2);
const build = argv.includes("--build") ? resolve(argv[argv.indexOf("--build") + 1]) : join(root, "build/a64");
const mem64 = argv.includes("--mem64");
const dirs = [join(root, "test/guests/out"), join(root, "test/a64/guests/out")].filter(existsSync);
const sets: [string, Partial<GuestOpts>][] = [
  ["default", {}], ["no tail calls", { tailCalls: false }], ["shared", { shared: true }], ["cntYield", { cntYield: true }],
  ["preciseFaults 1", { preciseFaults: 1 }], ["preciseFaults 2", { preciseFaults: 2 }], ["guard at 0x0800_0000", { guardBase: 0x0800_0000 }],
  ["no fma, no nanFix, no rmodeArith", { fma: false, nanFix: false, rmodeArith: false }], ["maxInsns 40, chunk 0, depth 0", { maxInsns: 40, chunk: 0, depthLimit: 0 }],
];
const mods = new Map<string, WebAssembly.Module>();
const mod = (f: string) => { let m = mods.get(f); if (!m) mods.set(f, m = new WebAssembly.Module(readFileSync(join(build, f)))); return m; };
const x = mem64 ? "64" : "";
const all = createHash("sha256");
console.log(`translator binaries: ${build} (${mem64 ? "memory64" : "memory32"})`);

// the core module, straight from the translator (memory32 only: it needs no memory of a special kind to build)
if (!mem64) for (const [name, tail, shared] of [["core module", 1, 0], ["core module, no tail calls", 0, 0], ["core module, shared", 1, 1]] as [string, number, number][]) {
  const memory = shared ? new WebAssembly.Memory({ initial: 2048, maximum: 65536, shared: true }) : new WebAssembly.Memory({ initial: 2048 });
  const tr: any = new WebAssembly.Instance(mod(shared ? "translator.shared.wasm" : "translator.wasm"), { env: { memory, abort: () => { throw new Error("abort"); } } }).exports;
  tr.init();
  tr.setOpt(0, A64.pcmapBase); tr.setOpt(6, tail); tr.setOpt(12, shared);
  const len = tr.buildCore(), at = tr.outPtr();
  const d = createHash("sha256").update(new Uint8Array(memory.buffer).slice(at, at + len)).digest("hex");
  all.update(d);
  console.log(`${name.padEnd(34)} ${len} bytes, sha256 ${d}`);
}
// The lines above the rule are the images built for the first Switch's core (the corpus these digests were first
// taken on): a translator change that only adds instructions leaves them as they were. The images built for the
// Switch 2's core (sidecar "cpu": "max": pointer authentication, LSE, FP16, ...) have their own lines below it.
for (const v82 of [false, true]) for (const [name, o] of sets) {
  if (v82 && name !== "default" && name !== "shared") continue;
  const h = createHash("sha256");
  let n = 0, bytes = 0;
  const sfx = x + (o.shared ? ".shared.wasm" : ".wasm");
  for (const dir of dirs) for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "manifest.json").sort()) {
    const side = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if ((side.cpu === "max") !== v82) continue;
    // (some of these option sets change results or exhaust the wasm stack on purpose: only the code is looked at)
    const r = runGuest(mod("translator" + sfx), mod("helpers" + sfx), f, side, readFileSync(join(dir, side.image)), readFileSync(join(dir, side.expected_stdout)), { ...defaultOpts, ...o, mem64, wantCache: true });
    const blob = r.cacheBlob!.subarray(16);   // without the header (magic, cache version, count, base)
    h.update(f); h.update(blob); n++; bytes += blob.length;
  }
  const d = h.digest("hex");
  if (!v82) all.update(d);
  console.log(`${(v82 ? "ARMv8.2+ images, " + name : name).padEnd(34)} ${n} guests, ${bytes} bytes of units, sha256 ${d}`);
  if (!v82 && name === sets[sets.length - 1][0]) console.log(`all: ${all.digest("hex")}\n---`);
}
