// The in-page shader translator's Worker (a module Worker): nxnative's translator driver over Ryujinx.Graphics.Shader
// published for browser-wasm (tools/shaders/build_xlate_wasm.sh; the .NET runtime interprets it), then the SPIR-V
// pass (src/shaders/spv.ts) and naga as WebAssembly. Stages come one a request or as a batch:
//   (over a BroadcastChannel named like the Worker, see the end of the file)
//   in:  { init: { framework, naga } }  once: where `_framework/dotnet.js` and nx_naga.wasm are served
//        { id, key, control, code }     a stage as the game passed it (control section, code area)
//        { batch: [{ id, key, control, code }, ...] }  stages translated by one run of the translator
//   out: { id, wgsl, reflection, timing: { startMs, xlateMs, convertMs, batch } } | { id, error }   one a stage
// The job is src/shaders/job.ts jobFor (nxnative dmsh_build.py job_for, NVN and NVN2), without a per-game answer table:
// texture types, attribute and output classes are the translator's defaults.
import { instantiate, type Naga } from "../../tools/shaders/naga.mts";
import { convertStage } from "../shaders/convert.ts";
import { jobFor } from "../shaders/job.ts";
import type { FixOptions } from "../shaders/spv.ts";

let ready: Promise<{ dotnet: any; naga: Naga; lines: string[] }> | null = null;
async function start(init: { framework: string; naga: string }) {
  const { dotnet } = await import(/* @vite-ignore */ init.framework + "/dotnet.js");
  const lines: string[] = [];
  // (no console forwarding: in a Worker the runtime's start waits on its forwarding socket and never finishes)
  const rt = await dotnet.withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create();
  rt.Module.FS.mkdir("/w");
  const naga = await instantiate(await (await fetch(init.naga)).arrayBuffer());
  return { dotnet: rt, naga, lines };
}
let serial = 0;
type Req = { id: number; key: string; control: Uint8Array; code: Uint8Array };
// A batch is one run of the translator's main over all its jobs (the main's own start is paid once a batch), then the
// pass and naga a stage at a time; each stage is answered on its own, with what its part of the batch cost (timing)
async function translateBatch(reqs: Req[], post: (m: unknown) => void) {
  const t0 = performance.now();
  const { dotnet, naga, lines } = await ready!;
  const t1 = performance.now(), FS = dotnet.Module.FS, n = ++serial, out = `/w/out${n}`, jobs: unknown[] = [], mesh: Record<string, unknown> = {}, ok: Req[] = [];
  for (const r of reqs) {
    try {
      const { job, body } = jobFor(r.key, r.control, r.code, `/w/${r.key}.bin`);
      FS.writeFile(`/w/${r.key}.bin`, body);
      const { mesh: m, ...xjob } = job;
      jobs.push(xjob); mesh[r.key] = m; ok.push(r);
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
      const c = convertStage(naga, spv, { bindings: "nxweb", sbufs: res.sbufs ?? [], mesh: mesh[key] as any });
      post({ id: r.id, wgsl: c.wgsl, reflection: c.reflection, timing: { startMs: t1 - t0, xlateMs: share, convertMs: performance.now() - t3, batch: ok.length } });
    } catch (e) { post({ id: r.id, error: e instanceof Error ? e.message : String(e) }); }
    for (const f of [`/w/${key}.bin`, `${out}/${key}.spv`, `${out}/${key}.res.json`]) { try { FS.unlink(f); } catch { /* not written */ } }
  }
  try { FS.unlink(`/w/jobs${n}.json`); } catch { /* gone */ }
}
// Requests do not come as messages to the Worker itself: the .NET runtime, started in a Worker, never finishes its
// start once the Worker's own `message` event has fired (measured in Chromium 153). They come over a
// BroadcastChannel whose name is the Worker's name; { ready: true } says the channel is listened to.
const channel = new BroadcastChannel((self as any).name);
let chain: Promise<unknown> = Promise.resolve();
channel.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.ready || m.wgsl !== undefined || m.error !== undefined) return;
  if (m.init) { ready = start(m.init); ready.catch(() => { /* reported per request */ }); return; }
  const reqs: Req[] = m.batch ?? (m.id !== undefined ? [m] : []);
  if (!reqs.length) return;
  // one batch at a time: the translator's runtime runs one main at a time
  chain = chain.then(() => translateBatch(reqs, r => channel.postMessage(r)).catch(e => {
    for (const r of reqs) channel.postMessage({ id: r.id, error: e instanceof Error ? e.message : String(e) });
  }));
};
channel.postMessage({ ready: true });
