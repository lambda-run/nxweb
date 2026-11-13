// The in-page shader translator's Worker (a module Worker): nxnative's translator driver over Ryujinx.Graphics.Shader
// published for browser-wasm (tools/shaders/build_xlate_wasm.sh; the .NET runtime interprets it), then the SPIR-V
// pass (src/shaders/spv.ts) and naga as WebAssembly. Stages come one a request or as a batch:
//   (over a BroadcastChannel named like the Worker, see the end of the file)
//   in:  { init: { framework, naga, subgroups, storageBuffers, samplers } }  once: where `_framework/dotnet.js` and nx_naga.wasm are served; whether the device has WebGPU
//        subgroups; its maxStorageBuffersPerShaderStage and maxSamplersPerShaderStage
//        { id, key, control, code }     a stage as the game passed it (control section, code area)
//        { batch: [{ id, key, control, code }, ...] }  stages translated by one run of the translator
//   out: { id, wgsl, reflection, timing: { startMs, xlateMs, convertMs, batch } } | { id, error }   one a stage
// The job is src/shaders/job.ts jobFor (nxnative dmsh_build.py job_for, NVN and NVN2), without a per-game answer table:
// texture types, attribute and output classes are the translator's defaults.
import { instantiate, type Naga } from "../../tools/shaders/naga.mts";
import { translateBatch as batch, type BatchReq } from "../shaders/batch.ts";

let ready: Promise<{ dotnet: any; naga: Naga; lines: string[] }> | null = null;
let subgroups: "native" | "single" = "single";   // FixOptions.subgroups for every stage (init)
let storageBuffers: number | undefined, samplers: number | undefined;   // FixOptions.storageBuffers, .samplers
async function start(init: { framework: string; naga: string; subgroups?: boolean; storageBuffers?: number; samplers?: number }) {
  subgroups = init.subgroups ? "native" : "single"; storageBuffers = init.storageBuffers; samplers = init.samplers;
  const { dotnet } = await import(/* @vite-ignore */ init.framework + "/dotnet.js");
  const lines: string[] = [];
  // (no console forwarding: in a Worker the runtime's start waits on its forwarding socket and never finishes)
  const rt = await dotnet.withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create();
  rt.Module.FS.mkdir("/w");
  const naga = await instantiate(await (await fetch(init.naga)).arrayBuffer());
  return { dotnet: rt, naga, lines };
}
// One run of the translator over a batch: src/shaders/batch.ts (shared with the offline pack, tools/shaders/pack.mts)
async function translateBatch(reqs: Req[], post: (m: unknown) => void) { return batch(await ready!, reqs, post, { subgroups, storageBuffers, samplers }); }
type Req = BatchReq;
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
