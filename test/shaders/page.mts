// The page of `npm run shaders:test`'s browser half: raw WebGPU, nothing of src/gfx. It reads shader libraries with the loader (src/shaders/library.ts) and
//   validate(lib): compiles every entry's WGSL with the browser's own compiler (Tint) and returns its diagnostics;
//   render(lib, vsKey, fsKey, fix): draws the end-to-end scene with the two stages, the layouts built from their reflection records exactly as
//     src/glue/gfx_host.ts builds them (group 0 uniform slots at stage * 16 + i, group 1 textures at stage * 64 + slot * 2 and samplers at + 1, group 2 the fix-up),
//     and returns the 64 x 64 RGBA8 pixels;
//   convertInPage(nagaWasm, spv): the SPIR-V pass and naga run in the page.
import { ShaderLibrary } from "../../src/shaders/library.ts";
import { convertStage } from "../../src/shaders/convert.ts";
import { instantiate } from "../../tools/shaders/naga.mts";
import { jobFor } from "../../src/shaders/job.ts";

const g: any = globalThis;
let device: any;
async function dev() {
  if (device) return device;
  const adapter = await g.navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  device = await adapter.requestDevice();
  g.__adapter = `${adapter.info?.vendor ?? ""} ${adapter.info?.architecture ?? ""} ${adapter.info?.description ?? ""}`.trim();
  return device;
}
const fetchBytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

g.validate = async (url: string) => {
  const d = await dev(), lib = new ShaderLibrary(await fetchBytes(url)), out: any[] = [];
  for (const e of lib.entries()) {
    const t = performance.now();
    const info = await d.createShaderModule({ code: e.wgsl }).getCompilationInfo();
    out.push({ key: e.key, stage: e.reflection.stage, ms: performance.now() - t, errors: info.messages.filter((m: any) => m.type === "error").map((m: any) => `${m.lineNum}:${m.linePos} ${m.message}`) });
  }
  return out;
};

const W = 64, H = 64;
// position.xy, uv: the whole clip square, uv (0, 0) at the top left
const QUAD = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);
g.render = async (url: string, vsKey: string, fsKey: string, fix: number[], scene: { vsUbo: number[]; fsUbo: number[]; texels: number[] }) => {
  const d = await dev(), lib = new ShaderLibrary(await fetchBytes(url));
  const vs = lib.get(vsKey), fs = lib.get(fsKey);
  if (!vs || !fs) throw new Error("a key is not in the library");
  d.pushErrorScope("validation");
  const g0: any[] = [], g1: any[] = [], e0: any[] = [], e1: any[] = [];
  const tex = d.createTexture({ size: [2, 2], format: "rgba8unorm", usage: 0x04 | 0x02 });
  d.queue.writeTexture({ texture: tex }, new Uint8Array(scene.texels), { bytesPerRow: 8 }, [2, 2]);
  const sampler = d.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  [vs, fs].forEach((s, st) => {
    const r = s.reflection, visibility = st ? 2 : 1, data = st ? scene.fsUbo : scene.vsUbo;
    if (r.extra.length) throw new Error(`stage ${st} needs bindings this page does not provide: ${JSON.stringify(r.extra)}`);
    for (const i of r.ubos) {
      // the host's duty: a buffer of at least the size the WGSL type covers, zero past what the game bound
      const size = Math.max(r.uboSize[i] ?? 0, data.length * 4), buf = d.createBuffer({ size, usage: 0x40 | 0x08 });
      d.queue.writeBuffer(buf, 0, new Float32Array(data));
      g0.push({ binding: st * 16 + i, visibility, buffer: { type: "uniform" } }); e0.push({ binding: st * 16 + i, resource: { buffer: buf } });
    }
    for (const t of r.textures) {
      g1.push({ binding: st * 64 + t.slot * 2, visibility, texture: { sampleType: t.depth ? "depth" : "float", viewDimension: t.dim } });
      g1.push({ binding: st * 64 + t.slot * 2 + 1, visibility, sampler: { type: t.depth ? "comparison" : "filtering" } });
      e1.push({ binding: st * 64 + t.slot * 2, resource: tex.createView() }, { binding: st * 64 + t.slot * 2 + 1, resource: sampler });
    }
  });
  const layouts = [d.createBindGroupLayout({ entries: g0 }), d.createBindGroupLayout({ entries: g1 })];
  const groups = [d.createBindGroup({ layout: layouts[0], entries: e0 }), d.createBindGroup({ layout: layouts[1], entries: e1 })];
  if (vs.reflection.fixup) {
    const fb = d.createBuffer({ size: 16, usage: 0x40 | 0x08 });
    d.queue.writeBuffer(fb, 0, new Float32Array(fix));
    layouts.push(d.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: { type: "uniform" } }] }));
    groups.push(d.createBindGroup({ layout: layouts[2], entries: [{ binding: 0, resource: { buffer: fb } }] }));
  }
  const pipeline = d.createRenderPipeline({
    layout: d.createPipelineLayout({ bindGroupLayouts: layouts }),
    vertex: { module: d.createShaderModule({ code: vs.wgsl }), entryPoint: vs.reflection.entry,
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }].filter(a => vs.reflection.attributes!.includes(a.shaderLocation)) }] },
    fragment: { module: d.createShaderModule({ code: fs.wgsl }), entryPoint: fs.reflection.entry, targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-strip" },
  });
  const vb = d.createBuffer({ size: QUAD.byteLength, usage: 0x20 | 0x08 });
  d.queue.writeBuffer(vb, 0, QUAD);
  const target = d.createTexture({ size: [W, H], format: "rgba8unorm", usage: 0x10 | 0x01 });
  const enc = d.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 1, a: 1 } }] });
  pass.setPipeline(pipeline); groups.forEach((b, i) => pass.setBindGroup(i, b)); pass.setVertexBuffer(0, vb); pass.draw(4); pass.end();
  const out = d.createBuffer({ size: W * H * 4, usage: 0x01 | 0x08 });
  enc.copyTextureToBuffer({ texture: target }, { buffer: out, bytesPerRow: W * 4 }, [W, H]);
  d.queue.submit([enc.finish()]);
  const err = await d.popErrorScope();
  if (err) throw new Error(`WebGPU validation: ${err.message}`);
  await out.mapAsync(1);
  return Array.from(new Uint8Array(out.getMappedRange()));
};

g.convertInPage = async (nagaUrl: string, spvUrl: string, mode: "nxweb" | "keep") => {
  const t0 = performance.now(), naga = await instantiate(await fetchBytes(nagaUrl)), t1 = performance.now();
  const c = convertStage(naga, await fetchBytes(spvUrl), { bindings: mode }), t2 = performance.now();
  const info = await (await dev()).createShaderModule({ code: c.wgsl }).getCompilationInfo();
  return { wgsl: c.wgsl, reflection: c.reflection, instantiateMs: t1 - t0, convertMs: t2 - t1, errors: info.messages.filter((m: any) => m.type === "error").map((m: any) => m.message) };
};

// The whole chain in the page: nxnative's translator published for browser-wasm (tools/shaders/build_xlate_wasm.sh; the .NET runtime interprets it), fed the code areas
// through the runtime's in-memory file system as its command line expects, then the SPIR-V pass and naga
g.translateInPage = async (frameworkUrl: string, nagaUrl: string, base: string, corpus: any[]) => {
  const t0 = performance.now();
  const { dotnet } = await import(/* @vite-ignore */ frameworkUrl + "/dotnet.js");
  const lines: string[] = [];
  const rt = await dotnet.withConsoleForwarding?.(false).withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create(), FS = rt.Module.FS, t1 = performance.now();
  FS.mkdir("/w");
  const jobs = [];
  for (const r of corpus) {
    const code = await fetchBytes(`${base}/${r.code}`), ctl = new DataView((await fetchBytes(`${base}/${r.control}`)).buffer);
    const c1 = Array.from(code.subarray(ctl.getUint32(0x700, true), ctl.getUint32(0x704, true)), b => b.toString(16).padStart(2, "0")).join("");   // xlate.py job_for
    FS.writeFile(`/w/${r.key}.bin`, code.subarray(0x30));
    jobs.push({ key: r.key, stage: r.stage, code: `/w/${r.key}.bin`, tex: {}, img: {}, attr: {}, fout: {}, c1, debug: true, reduced: true, ...r.facts });
  }
  FS.writeFile("/w/jobs.json", JSON.stringify(jobs));
  const t2 = performance.now(), rc = await rt.runMain("xlate_wasm", ["/w/jobs.json", "/w/out"]), t3 = performance.now();
  const again = performance.now(); await rt.runMain("xlate_wasm", ["/w/jobs.json", "/w/out2"]); const t4 = performance.now();
  const naga = await instantiate(await fetchBytes(nagaUrl)), out: any = {};
  for (const r of corpus) {
    let spv; try { spv = FS.readFile(`/w/out/${r.key}.spv`); } catch { throw new Error(`the translator wrote no ${r.key}.spv (exit ${rc}): ${lines.join(" | ")}`); }
    const c = convertStage(naga, spv, { bindings: "nxweb", c1: jobs.find(j => j.key === r.key)!.c1 }); out[r.key] = { wgsl: c.wgsl, reflection: c.reflection };
  }
  return { rc, startMs: t1 - t0, firstMs: t3 - t2, warmMs: t4 - again, convertMs: performance.now() - t4, out };
};
// translateJobsInPage(framework, naga, base, corpus): as translateInPage, the jobs made by src/shaders/job.ts jobFor (as the page's shader worker,
// src/glue/rt_shader_worker.ts) from each row's control section and code area
g.translateJobsInPage = async (frameworkUrl: string, nagaUrl: string, base: string, corpus: any[]) => {
  const { dotnet } = await import(/* @vite-ignore */ frameworkUrl + "/dotnet.js");
  const lines: string[] = [];
  const rt = await dotnet.withConsoleForwarding?.(false).withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create(), FS = rt.Module.FS;
  try { FS.mkdir("/w"); } catch { /* the runtime of translateInPage: the same module */ }
  const jobs = [];
  for (const r of corpus) {
    const { job, body } = jobFor(r.key, await fetchBytes(`${base}/${r.control}`), await fetchBytes(`${base}/${r.code}`), `/w/${r.key}.bin`);
    FS.writeFile(`/w/${r.key}.bin`, body); jobs.push(job);
  }
  FS.writeFile("/w/jobs.json", JSON.stringify(jobs));
  const rc = await rt.runMain("xlate_wasm", ["/w/jobs.json", "/w/out"]);
  const naga = await instantiate(await fetchBytes(nagaUrl)), out: any = {};
  for (const r of corpus) {
    let spv; try { spv = FS.readFile(`/w/out/${r.key}.spv`); } catch { throw new Error(`the translator wrote no ${r.key}.spv (exit ${rc}): ${lines.join(" | ")}`); }
    const c = convertStage(naga, spv, { bindings: "nxweb", c1: jobs.find(j => j.key === r.key)!.c1 }); out[r.key] = { wgsl: c.wgsl, reflection: c.reflection };
  }
  return { rc, jobs, out };
};
g.__ready = true;
