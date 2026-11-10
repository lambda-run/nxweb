// node test/gfx/mem64_probe.mts: what WebGPU's data-taking calls accept of a 64-bit WebAssembly memory, in headless
// Chromium (the full build, channel "chromium", SwiftShader). The replayer (src/glue/gfx_host.ts) hands
// queue.writeBuffer / queue.writeTexture views of the guest's memory; in the 64-bit memory mode that buffer is larger
// than 4 GB and a guest's vertex data, uniform blocks and texels may lie above 4 GB. For each form of the argument the
// probe writes a pattern above 4 GB, uploads it, reads the GPU's bytes back and compares:
//   whole   a Uint8Array over the whole memory, with dataOffset / size (what the replayer did for writeBuffer)
//   sub     a subarray of it (a small view at a byte offset above 4 GB)
//   copy    a slice (a new small ArrayBuffer: the scratch copy)
// and it measures the three on a 64 KB and a 4 MB upload. Prints one JSON line; exit code 1 when no form works.
import { createServer } from "node:http";
import { chromium } from "playwright";

const PAGE = `<!doctype html><script type="module">
const out = { ok: false };
try {
  const leb = v => { const n = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; n.push(b); } while (v); return n; };
  const str = t => [t.length, ...Array.from(t, c => c.charCodeAt(0))];
  const sec = (id, body) => [id, ...leb(body.length), ...body];
  const mod = new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0, ...sec(1, [1, 0x60, 1, 0x7E, 1, 0x7E]), ...sec(3, [1, 0]), ...sec(5, [1, 0x05, ...leb(1), ...leb(262144)]),
    ...sec(7, [2, ...str("memory"), 2, 0, ...str("grow"), 0, 0]), ...sec(10, [1, 6, 0, 0x20, 0, 0x40, 0, 0x0B])]);
  const x = new WebAssembly.Instance(new WebAssembly.Module(mod)).exports;
  const HI = 0x1_4000_0000, MB = 1 << 20, SPAN = 8 * MB;
  x.grow(BigInt(Math.ceil((HI + SPAN) / 65536)));
  const u8 = new Uint8Array(x.memory.buffer);
  out.memoryBytes = u8.length;
  for (let i = 0; i < SPAN; i += 4) { const v = Math.imul(i + 12345, 2654435761) >>> 0; u8[HI + i] = v; u8[HI + i + 1] = v >>> 8; u8[HI + i + 2] = v >>> 16; u8[HI + i + 3] = v >>> 24; }
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const readBuffer = async (buf, n) => {
    const rb = device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, rb, 0, n); device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ); const got = new Uint8Array(rb.getMappedRange()).slice(); rb.unmap(); rb.destroy(); return got;
  };
  const same = (got, at, n) => { for (let i = 0; i < n; i++) if (got[i] !== u8[at + i]) return "differs at +" + i; return "same"; };
  const forms = {
    whole: (buf, at, n) => device.queue.writeBuffer(buf, 0, u8, at, n),
    sub: (buf, at, n) => device.queue.writeBuffer(buf, 0, u8.subarray(at, at + n)),
    copy: (buf, at, n) => device.queue.writeBuffer(buf, 0, u8.slice(at, at + n)),
  };
  out.writeBuffer = {};
  for (const [name, fn] of Object.entries(forms)) {
    const n = 65536, at = HI + 4096, buf = device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    try { fn(buf, at, n); out.writeBuffer[name] = same(await readBuffer(buf, n), at, n); } catch (e) { out.writeBuffer[name] = "throws: " + e.message; }
    buf.destroy();
  }
  // writeTexture: 256 x 256 rgba8
  const texForms = {
    whole: (tex, at) => device.queue.writeTexture({ texture: tex }, u8, { offset: at, bytesPerRow: 1024, rowsPerImage: 256 }, { width: 256, height: 256 }),
    sub: (tex, at) => device.queue.writeTexture({ texture: tex }, u8.subarray(at, at + 262144), { bytesPerRow: 1024, rowsPerImage: 256 }, { width: 256, height: 256 }),
    copy: (tex, at) => device.queue.writeTexture({ texture: tex }, u8.slice(at, at + 262144), { bytesPerRow: 1024, rowsPerImage: 256 }, { width: 256, height: 256 }),
  };
  out.writeTexture = {};
  for (const [name, fn] of Object.entries(texForms)) {
    const at = HI + 2 * MB, tex = device.createTexture({ size: { width: 256, height: 256 }, format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    try {
      fn(tex, at);
      const rb = device.createBuffer({ size: 262144, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow: 1024 }, { width: 256, height: 256 }); device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ); out.writeTexture[name] = same(new Uint8Array(rb.getMappedRange()), at, 262144); rb.unmap(); rb.destroy();
    } catch (e) { out.writeTexture[name] = "throws: " + e.message; }
    tex.destroy();
  }
  // other things the replayer does with the buffer above 4 GB
  out.views = {};
  try { const v = new Uint32Array(x.memory.buffer, HI, 16); out.views.Uint32Array = v[0] === ((u8[HI] | u8[HI + 1] << 8 | u8[HI + 2] << 16 | u8[HI + 3] << 24) >>> 0) ? "ok" : "wrong value"; } catch (e) { out.views.Uint32Array = "throws: " + e.message; }
  try { const dv = new DataView(x.memory.buffer); out.views.DataView = dv.getUint8(HI + 5) === u8[HI + 5] ? "ok" : "wrong value"; } catch (e) { out.views.DataView = "throws: " + e.message; }
  try { u8.copyWithin(HI + SPAN - 4096, HI, HI + 4096); out.views.copyWithin = u8[HI + SPAN - 4096 + 7] === u8[HI + 7] ? "ok" : "wrong value"; } catch (e) { out.views.copyWithin = "throws: " + e.message; }
  try { const mapped = device.createBuffer({ size: 4096, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true }); new Uint8Array(mapped.getMappedRange()).set(u8.subarray(HI, HI + 4096)); mapped.unmap(); out.views.setFromHigh = same(await readBuffer(mapped, 4096), HI, 4096); mapped.destroy(); } catch (e) { out.views.setFromHigh = "throws: " + e.message; }
  // cost: uploads per form, the queue flushed every 64
  out.cost = {};
  for (const n of [65536, 4 * MB]) {
    const buf = device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_DST }), reps = n > MB ? 60 : 600;
    for (const [name, fn] of Object.entries(forms)) {
      if (out.writeBuffer[name] !== "same") continue;
      const run = async () => { const t0 = performance.now(); for (let i = 0; i < reps; i++) { fn(buf, HI + 4096, n); if (i % 64 === 63) await device.queue.onSubmittedWorkDone(); } await device.queue.onSubmittedWorkDone(); return (performance.now() - t0) / reps; };
      await run();
      const t = []; for (let k = 0; k < 5; k++) t.push(await run());
      out.cost[name + "_" + (n >> 10) + "KB_us"] = Math.round(Math.min(...t) * 1000);
    }
    buf.destroy();
  }
  out.ok = true;
} catch (e) { out.error = String(e && e.stack || e); }
document.title = JSON.stringify(out);
</script>`;

const server = createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }); res.end(PAGE); });
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const channel = process.env.RT_BROWSER_CHANNEL ?? "chromium";
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }),
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let result: any = { ok: false, error: "the page did not answer" };
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction("document.title.startsWith('{')", undefined, { timeout: 120000 });
  result = JSON.parse(await page.title());
  result.chromium = browser.version();
} catch (e) { result.error = String(e); }
await browser.close(); server.close();
console.log(JSON.stringify(result));
const works = (o: Record<string, string> | undefined) => !!o && Object.values(o).some(v => v === "same");
process.exit(result.ok && works(result.writeBuffer) && works(result.writeTexture) ? 0 : 1);
