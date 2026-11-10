// The in-page shader translator's Worker (a module Worker): nxnative's translator driver over Ryujinx.Graphics.Shader
// published for browser-wasm (tools/shaders/build_xlate_wasm.sh; the .NET runtime interprets it), then the SPIR-V
// pass (src/shaders/spv.ts) and naga as WebAssembly. One stage per request:
//   (over a BroadcastChannel named like the Worker, see the end of the file)
//   in:  { init: { framework, naga } }  once: where `_framework/dotnet.js` and nx_naga.wasm are served
//        { id, key, control, code }     a stage as the game passed it (control section, code area)
//   out: { id, wgsl, reflection } | { id, error }
// The job is what tools/shaders/xlate.py job_for makes (nxnative dmsh_build.py), without a per-game answer table:
// texture types, attribute and output classes are the translator's defaults.
import { instantiate, type Naga } from "../../tools/shaders/naga.mts";
import { convertStage } from "../shaders/convert.ts";

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
// the stage of a code area: graphics code starts with a 0x30-byte header (magic 0x12345678) and the shader program
// header, whose first word holds the shader type in bits 10..13 (1 vertex, 5 pixel); compute code has magic 0x12345679
function stageOf(code: Uint8Array): { stage: string; body: Uint8Array } {
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  if (code.length < 4) throw new Error("the code area is empty");
  const magic = dv.getUint32(0, true);
  if (magic === 0x12345679) return { stage: "cs", body: code.subarray(0x100) };
  if (magic !== 0x12345678) throw new Error(`the code area does not start with a Maxwell header (0x${magic.toString(16)})`);
  if (code.length < 0x30 + 0x50 + 8) throw new Error(`the code area (${code.length} bytes) holds no shader program`);
  const type = (dv.getUint32(0x30, true) >>> 10) & 15;
  if (type !== 1 && type !== 5) throw new Error(`shader type ${type} (tessellation or geometry) is not translated`);
  return { stage: type === 1 ? "vs" : "ps", body: code.subarray(0x30) };
}
let serial = 0;
async function translate(key: string, control: Uint8Array, code: Uint8Array) {
  const { dotnet, naga, lines } = await ready!;
  const FS = dotnet.Module.FS, cdv = new DataView(control.buffer, control.byteOffset, control.byteLength);
  if (control.length < 0x708 || cdv.getUint32(0, true) !== 0x98761234) throw new Error("no control section magic");
  if (cdv.getUint32(4, true) === 0xc9) throw new Error("an NVN2 control section (Ampere code) is not handled");
  const { stage, body } = stageOf(code);
  const c1o = cdv.getUint32(0x700, true), c1t = cdv.getUint32(0x704, true), c1 = c1t > c1o && c1t <= code.length ? code.subarray(c1o, c1t) : new Uint8Array(0);
  const n = ++serial, out = `/w/out${n}`;
  FS.writeFile(`/w/${key}.bin`, body);
  const job: any = { key, stage, code: `/w/${key}.bin`, tex: {}, img: {}, attr: {}, fout: {}, c1: Array.from(c1, b => b.toString(16).padStart(2, "0")).join(""), debug: true, reduced: true };
  if (stage === "ps" && control.length > 0x71c && (cdv.getUint32(0x718, true) & 1)) job.early_fragment_tests = true;
  FS.writeFile(`/w/jobs${n}.json`, JSON.stringify([job]));
  lines.length = 0;
  const rc = await dotnet.runMain("xlate_wasm", [`/w/jobs${n}.json`, out]);
  let spv: Uint8Array;
  try { spv = FS.readFile(`${out}/${key}.spv`); } catch { throw new Error(`the translator wrote no SPIR-V (exit ${rc}): ${lines.filter(l => l.includes("[RED]")).join(" | ").replace(/\[RED\] /g, "") || lines.slice(-2).join(" | ")}`); }
  for (const f of [`/w/${key}.bin`, `/w/jobs${n}.json`, `${out}/${key}.spv`, `${out}/${key}.res.json`]) { try { FS.unlink(f); } catch { /* not written */ } }
  const c = convertStage(naga, spv, { bindings: "nxweb" });
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
