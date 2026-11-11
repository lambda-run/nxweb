// One process of `npm run shaders:sweep` (tools/shaders/sweep.mts): the page's translator (build/shaders/xlate_wasm, the
// browser-WASM build src/glue/rt_shader_worker.ts starts), then convertStage (fixForWgsl, then naga) on each stage the
// parent sends. The parent kills this process on a timeout and starts another after a crash, so a stage that hangs or
// takes the runtime down is a result there. Messages: in { key, control, code, keep }, out { ready } then one reply each.
import { pathToFileURL } from "node:url";
import { load } from "./naga_node.mts";
import { convertStage } from "../../src/shaders/convert.ts";
import { jobFor } from "../../src/shaders/job.ts";
import type { FixOptions } from "../../src/shaders/spv.ts";

export interface SweepJob { key: string; control: Uint8Array; code: Uint8Array; keep: boolean }
export type Phase = "translate" | "fix" | "naga";
export interface SweepReply {
  key: string; ok: boolean; phase?: Phase; error?: string;
  translateMs: number; fixMs: number; nagaMs: number;
  refused?: string | null;          // what the runtime's RtShaders.register would refuse (shader_prewarm.ts says the same)
  restart?: boolean;                // the translator's runtime threw: this process is not trusted with another stage
  spv?: Uint8Array; wgsl?: string;  // only with keep (--keep-binaries)
}

const send = (m: unknown) => new Promise<void>(res => process.send!(m, () => res()));
// test hooks (test/shaders/sweep.mts): SWEEP_SIMULATE="<key>:hang,<key>:crash" stands in for a translator that hangs or dies
const simulate = new Map((process.env.SWEEP_SIMULATE ?? "").split(",").filter(Boolean).map(s => s.split(":") as [string, string]));

const { dotnet } = await import(pathToFileURL(process.env.SWEEP_FRAMEWORK! + "/dotnet.js").href);
const lines: string[] = [];
const rt = await dotnet.withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create();
const FS = rt.Module.FS;
FS.mkdir("/w");
const naga = await load(process.env.SWEEP_NAGA!);
let serial = 0;

function refused(r: any): string | null {
  if (r?.extra?.length) return `bindings src/gfx does not provide: ${r.extra.map((x: any) => x.kind).join(", ")}`;
  return null;
}

async function run(m: SweepJob): Promise<SweepReply> {
  const out: SweepReply = { key: m.key, ok: false, translateMs: 0, fixMs: 0, nagaMs: 0 };
  let phase: Phase = "translate";
  const t0 = performance.now();
  try {
    const sim = simulate.get(m.key);
    if (sim === "hang") for (;;);
    if (sim === "crash") process.abort();
    // the same steps as rt_shader_worker.ts translateBatch() (one stage a batch here)
    const n = ++serial, dir = `/w/out${n}`, bin = `/w/${m.key}.bin`, jobs = `/w/jobs${n}.json`;
    const { job, body } = jobFor(m.key, m.control, m.code, bin);
    FS.writeFile(bin, body);
    const { mesh, ...xjob } = job;
    FS.writeFile(jobs, JSON.stringify([xjob]));
    lines.length = 0;
    let rc: number;
    try { rc = await rt.runMain("xlate_wasm", [jobs, dir]); } catch (e) { out.restart = true; throw e; }
    let spv: Uint8Array;
    try { spv = FS.readFile(`${dir}/${m.key}.spv`); } catch {
      throw new Error(`the translator wrote no SPIR-V (exit ${rc}): ${lines.filter(l => l.includes("[RED]")).join(" | ").replace(/\[RED\] /g, "") || lines.slice(-2).join(" | ")}`);
    }
    let res: { sbufs?: FixOptions["sbufs"] } = {};
    try { res = JSON.parse(FS.readFile(`${dir}/${m.key}.res.json`, { encoding: "utf8" })); } catch {}
    for (const f of [bin, jobs, `${dir}/${m.key}.spv`, `${dir}/${m.key}.res.json`]) { try { FS.unlink(f); } catch {} }
    try { FS.rmdir(dir); } catch {}
    const t1 = performance.now();
    out.translateMs = t1 - t0;
    // convertStage is fixForWgsl, then naga, then the reflection: naga's share is timed inside, the rest is the fix
    phase = "fix";
    const timed = { spvToWgsl(s: Uint8Array, flags?: number) {
      phase = "naga"; const a = performance.now();
      try { const w = naga.spvToWgsl(s, flags); phase = "fix"; return w; } finally { out.nagaMs += performance.now() - a; }
    } };
    const c = convertStage(timed, spv, { bindings: "nxweb", sbufs: res.sbufs ?? [], mesh, c1: job.c1 });
    out.fixMs = performance.now() - t1 - out.nagaMs;
    out.ok = true;
    out.refused = refused(c.reflection);
    if (m.keep) { out.spv = spv; out.wgsl = c.wgsl; }
  } catch (e) {
    const t = performance.now() - t0;
    if (phase === "translate") out.translateMs = t; else if (phase === "fix") out.fixMs = t - out.translateMs - out.nagaMs;
    out.phase = phase;
    out.error = String((e as Error)?.message ?? e);
  }
  return out;
}

let chain = Promise.resolve();
process.on("message", (m: SweepJob) => { chain = chain.then(async () => await send(await run(m))); });
process.on("disconnect", () => process.exit(0));
await send({ ready: true });
