// nxem: the owner realm in a page (the Emscripten module's main thread = the page's main thread). The game is the
// user's .nup file (read where it lies, asynchronously: the fs module's calls pend and the owner completes them),
// nxweb's built modules come from the nxweb page beside this one (../wasm/), the replayer is nxweb's WebGPU replayer
// on the page's canvas, shaders are translated by nxweb's shader Workers and kept in its store (same origin, so a
// profile that ran the AssemblyScript page has them already).
import { MemStorage } from "../../src/glue/fs_host.ts";
import { GfxHost } from "../../src/glue/gfx_host.ts";
import { RtShaders, workerTranslator, webShaderStore } from "../../src/glue/rt_shaders.ts";
import { NupTree, blobBytes } from "../../src/prepare/host/nup.ts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { startOwner, sharedBuild, type Owner, type OwnerConfig } from "./owner.ts";

export interface PageSide {
  file: File;                                            // the .nup
  canvas: HTMLCanvasElement;
  root: string;                                          // the nxweb page's folder (its wasm/, shader_worker.js, shaders/), e.g. "../"
  writeFile: (path: string, bytes: Uint8Array) => void;  // into the Emscripten file system, for main()
  stage: (text: string) => void;
  modulesList: string[];                                 // the code modules to load, in order
}

export async function start(memory: WebAssembly.Memory, malloc: (n: number) => number, log: (line: string) => void, modules: OwnerConfig["modules"], p: PageSide): Promise<Owner> {
  const pages = memory.buffer.byteLength / 65536, abs = (u: string) => new URL(p.root + u, location.href).href;
  const bytes = async (u: string) => { const r = await fetch(abs(u)); if (!r.ok) throw new Error(`owner: ${u}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
  p.stage("runtime modules");
  const prep = new PrepWasm(await WebAssembly.compile(await bytes("wasm/prepare.wasm") as unknown as BufferSource), log);
  const sha256 = (b: Uint8Array) => prep.sha256(b);
  const shared = async (n: string) => WebAssembly.compile(sharedBuild(await bytes(`wasm/${n}64.wasm`), pages) as unknown as BufferSource);
  const [fsModule, gfxModule] = await Promise.all([shared("fs"), shared("gfx")]);
  for (const n of ["translator64.shared", "helpers64.shared", "loader64"]) p.writeFile(`/rt/${n}.wasm`, await bytes(`wasm/${n}.wasm`));
  p.stage("game container");
  const tree = await NupTree.open(blobBytes(p.file, false), p.file.name, { sha256, log });
  p.stage("WebGPU device");
  let device: any = null, gpuInfo = "no WebGPU here: the null replayer (nothing is drawn)";
  const requestDevice = async () => {
    const gpu = (navigator as any).gpu, adapter = gpu ? await gpu.requestAdapter() : null;
    if (!adapter) return null;
    const desc = GfxHost.deviceDescriptor(adapter), d = await adapter.requestDevice(desc);
    gpuInfo = "WebGPU: " + (adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "adapter") + `; ${desc.requiredFeatures.length} features`;
    return d;
  };
  try { device = await requestDevice(); } catch (e) { gpuInfo = `no WebGPU device (${(e as Error).message}): the null replayer`; }
  log("page: " + gpuInfo);
  const c: OwnerConfig = {
    tree, prep, fsModule, gfxModule, saves: new MemStorage(), programId: 0x0400486024DEC000n, scratch: 0x1FF00000, malloc, modules, log,
    gfx: device ? { device, canvas: p.canvas, nextFrame: () => new Promise(res => requestAnimationFrame(res)), requestDevice: async () => { device = await requestDevice(); return device; } } : undefined,
  };
  p.stage("RomFS index");
  const { owner, exefs } = await startOwner(memory, c);
  if (device && owner.gfx) {
    owner.gfx.host.fitCanvas = true;
    let translator: any;
    try {
      if ((await fetch(abs("shaders/xlate_wasm/_framework/dotnet.js"), { method: "HEAD" })).ok && (await fetch(abs("shaders/nx_naga.wasm"), { method: "HEAD" })).ok)
        translator = workerTranslator({ worker: abs("shader_worker.js"), framework: abs("shaders/xlate_wasm/_framework"), naga: abs("shaders/nx_naga.wasm"), subgroups: GfxHost.hasSubgroups(device) });
    } catch { /* none */ }
    new RtShaders(owner.gfx, { translator, store: typeof caches !== "undefined" ? webShaderStore() : undefined });
    log(translator ? "page: shaders are translated in the page (nxweb's shader Workers) and kept in its store" : "[RED] page: nxweb's shader translator is not beside this page: only stored shaders are used");
  }
  p.stage("code modules");
  if (!exefs) throw new Error("owner: no exefs/ in the container");
  const l = await tree.list();
  for (const n of p.modulesList) {
    const f = l.files.find(x => x.path === exefs + n);
    if (!f) throw new Error(`owner: ${exefs}${n} is not in the container`);
    p.writeFile(`/exefs/${n}`, await tree.read(f.path, 0, f.size));
  }
  p.stage("starting");
  return owner;
}
