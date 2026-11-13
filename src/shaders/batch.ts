// One run of nxnative's translator (build/shaders/xlate_wasm, a started .NET runtime) over a batch of stages, then the SPIR-V pass and naga a stage at a time:
// what the page's translator Worker does (src/glue/rt_shader_worker.ts) and what the offline pack of a chain (tools/shaders/pack.mts) does, so both give the same
// WGSL and reflection. No Node or DOM API.
import { convertStage } from "./convert.ts";
import { jobFor } from "./job.ts";
import type { FixOptions } from "./spv.ts";

let serial = 0;
export type BatchReq = { id: number; key: string; control: Uint8Array; code: Uint8Array };
export interface BatchEnv { dotnet: any; naga: { spvToWgsl(spv: Uint8Array, flags?: number): string }; lines: string[] }
export interface BatchOptions { subgroups: "native" | "single"; storageBuffers?: number; samplers?: number }
// A batch is one run of the translator's main over all its jobs (the main's own start is paid once a batch), then the
// pass and naga a stage at a time; each stage is answered on its own, with what its part of the batch cost (timing)
export async function translateBatch(env: BatchEnv, reqs: BatchReq[], post: (m: unknown) => void, o: BatchOptions) {
  const { subgroups, storageBuffers, samplers } = o;
  const t0 = performance.now();
  const { dotnet, naga, lines } = env;
  const t1 = performance.now(), FS = dotnet.Module.FS, n = ++serial, out = `/w/out${n}`, jobs: unknown[] = [], mesh: Record<string, unknown> = {}, c1: Record<string, unknown> = {}, ok: BatchReq[] = [];
  for (const r of reqs) {
    try {
      const { job, body } = jobFor(r.key, r.control, r.code, `/w/${r.key}.bin`);
      FS.writeFile(`/w/${r.key}.bin`, body);
      const { mesh: m, ...xjob } = job;
      jobs.push(xjob); mesh[r.key] = m; c1[r.key] = job.c1; ok.push(r);
    } catch (e) { post({ id: r.id, error: e instanceof Error ? e.message : String(e) }); }
  }
  if (!ok.length) return;
  FS.writeFile(`/w/jobs${n}.json`, JSON.stringify(jobs));
  lines.length = 0;
  const rc = await dotnet.runMain("xlate_wasm", [`/w/jobs${n}.json`, out]);
  const t2 = performance.now(), share = (t2 - t1) / ok.length;
  for (const r of ok) {
    const key = r.key, t3 = performance.now();
    try {
      let spv: Uint8Array;
      try { spv = FS.readFile(`${out}/${key}.spv`); } catch {
        const mine = lines.filter(l => l.includes("[RED]") && (ok.length === 1 || l.includes(key)));
        throw new Error(`the translator wrote no SPIR-V (exit ${rc}): ${mine.join(" | ").replace(/\[RED\] /g, "") || lines.slice(-2).join(" | ")}`);
      }
      let res: { sbufs?: FixOptions["sbufs"] } = {};
      try { res = JSON.parse(FS.readFile(`${out}/${key}.res.json`, { encoding: "utf8" })); } catch { /* not written: no storage buffers to place */ }
      const c = convertStage(naga, spv, { bindings: "nxweb", sbufs: res.sbufs ?? [], mesh: mesh[key] as any, c1: c1[key] as any, subgroups, storageBuffers, samplers });
      post({ id: r.id, wgsl: c.wgsl, reflection: c.reflection, timing: { startMs: t1 - t0, xlateMs: share, convertMs: performance.now() - t3, batch: ok.length } });
    } catch (e) { post({ id: r.id, error: e instanceof Error ? e.message : String(e) }); }
    for (const f of [`/w/${key}.bin`, `${out}/${key}.spv`, `${out}/${key}.res.json`]) { try { FS.unlink(f); } catch { /* not written */ } }
  }
  try { FS.unlink(`/w/jobs${n}.json`); } catch { /* gone */ }
}
