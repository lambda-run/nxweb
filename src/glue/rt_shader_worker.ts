// The in-page shader translator's Worker (a module Worker): nxnative's translator driver over Ryujinx.Graphics.Shader
// published for browser-wasm (tools/shaders/build_xlate_wasm.sh; the .NET runtime interprets it), then the SPIR-V
// pass (src/shaders/spv.ts) and naga as WebAssembly. One stage per request:
//   (over a BroadcastChannel named like the Worker, see the end of the file)
//   in:  { init: { framework, naga } }  once: where `_framework/dotnet.js` and nx_naga.wasm are served
//        { id, key, control, code }     a stage as the game passed it (control section, code area)
//   out: { id, wgsl, reflection } | { id, error }
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
async function translate(key: string, control: Uint8Array, code: Uint8Array) {
  const { dotnet, naga, lines } = await ready!;
  const FS = dotnet.Module.FS, n = ++serial, out = `/w/out${n}`;
  const { job, body } = jobFor(key, control, code, `/w/${key}.bin`);
  FS.writeFile(`/w/${key}.bin`, body);
  const { mesh, ...xjob } = job;
  FS.writeFile(`/w/jobs${n}.json`, JSON.stringify([xjob]));
  lines.length = 0;
  const rc = await dotnet.runMain("xlate_wasm", [`/w/jobs${n}.json`, out]);
  let spv: Uint8Array;
  try { spv = FS.readFile(`${out}/${key}.spv`); } catch { throw new Error(`the translator wrote no SPIR-V (exit ${rc}): ${lines.filter(l => l.includes("[RED]")).join(" | ").replace(/\[RED\] /g, "") || lines.slice(-2).join(" | ")}`); }
  let res: { sbufs?: FixOptions["sbufs"] } = {};
  try { res = JSON.parse(FS.readFile(`${out}/${key}.res.json`, { encoding: "utf8" })); } catch { /* not written: no storage buffers to place */ }
  for (const f of [`/w/${key}.bin`, `/w/jobs${n}.json`, `${out}/${key}.spv`, `${out}/${key}.res.json`]) { try { FS.unlink(f); } catch { /* not written */ } }
  const c = convertStage(naga, spv, { bindings: "nxweb", sbufs: res.sbufs ?? [], mesh, c1: job.c1 });
  return { wgsl: c.wgsl, reflection: c.reflection };
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
  if (m.id === undefined) return;
  // one at a time: the translator's runtime runs one main at a time
  chain = chain.then(async () => {
    try { channel.postMessage({ id: m.id, ...(await translate(m.key, m.control, m.code)) }); }
    catch (e) { channel.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) }); }
  });
};
channel.postMessage({ ready: true });
