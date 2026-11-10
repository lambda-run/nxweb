// EXPERIMENTAL (spike). `node test/spike_workers/try.mts <guest> <config> [key=value ...]`: one run, everything printed.
//   config: unshared | shared-green | 1 | 2 | 3 | 4
//   options (EngineOpts of src/spike_workers/engine.ts): budget=N inplace=false spin=N lockSpin=N oneLock=false
//            transport=message noFence=true; helpers=shared uses one helpers scratch area for all Workers
import { run, modsSharedHelpers, type Config } from "./node_lib.mts";
const [name = "threads", c = "4", ...rest] = process.argv.slice(2);
const opts: any = {};
for (const [k, v] of rest.map(r => r.split("="))) opts[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v);
const sharedHelpers = opts.helpers === "shared"; delete opts.helpers;
if (sharedHelpers) opts.helpersPrivate = false;
const config = (c === "unshared" || c === "shared-green" ? c : Number(c)) as Config;
const r = await run(name, config, opts, sharedHelpers ? modsSharedHelpers() : undefined);
process.stdout.write(r.out);
for (const l of r.logs) console.log(l);
console.log(`exit=${r.exitCode} stop=${r.stopReason} fault=${r.fault ?? "-"} wall=${r.wallMs.toFixed(1)}ms boot=${r.bootMs.toFixed(1)}ms units relayed=${r.unitsRelayed} guest ns=${r.guestNs}`);
for (const s of r.stats) console.log(JSON.stringify(s, (k, v) => k === "out" ? undefined : typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(2)) : v));
