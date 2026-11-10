// EXPERIMENTAL (spike). `node test/spike_workers/one.mts <guest> <config> <runs> [key=value ...]`: one series.
import { run, modsSharedHelpers } from "./node_lib.mts";
import { series, type Config, type RunFn } from "./series.ts";
const [g = "threads", c = "4", n = "20", ...rest] = process.argv.slice(2);
const kv: Record<string, string> = Object.fromEntries(rest.map(r => r.split("=")));
const opts: any = {};
for (const [k, v] of Object.entries(kv)) opts[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v);
const runFn: RunFn = (gg, cc, o = {}) => { const { sharedHelpers, ...oo } = o; return run(gg, cc, sharedHelpers ? { ...oo, helpersPrivate: false } : oo, sharedHelpers ? modsSharedHelpers() : undefined); };
const r = await series(runFn, g, (c === "unshared" || c === "shared-green" ? c : Number(c)) as Config, Number(n), opts, rest.join(" "));
console.log(r.line);
