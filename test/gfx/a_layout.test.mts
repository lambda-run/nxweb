// Layouts and sizes against nxnative's own headers (compiled by gcc: test/gfx/layout_ref.c, texlayout_ref.c), and the
// recording behaviour that needs no GPU. `npm run gfx:test` runs these in Node before the scenes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, guest, reference, pairs, ROOT, haveReference, NXNATIVE } from "./harness.mts";
import { Game, SIZEOF, FMT, PRIM, STAGE } from "./nvn.mts";

const mine = new Map<string, bigint>();
for (const m of readFileSync(join(ROOT, "src/gfx/obj.ts"), "utf8").matchAll(/^export const (\w+): \w+ = (\w+);/gm)) mine.set(m[1], BigInt(m[2]));
const ref = haveReference() ? pairs(reference("layout_ref.c")) : new Map<string, bigint>();
// Where src/gfx/obj.ts departs from nxnative on purpose (README "Departures"): [nxnative, here]
const DEPARTS: Record<string, [bigint, bigint]> = { SYNC_SIZE: [16n, 24n], CMD_SIZE: [112n, 128n] };

test("layout: every offset and size of the guest objects and record payloads is nxnative's (nvn_obj.h compiled)", () => {
  assert.ok(ref.size > 300, `the reference tree is needed for this check (${NXNATIVE})`);
  let n = 0;
  for (const [k, v] of ref) {
    if (k.startsWith("NVN_") || k.startsWith("BITS_") || k.startsWith("REC_")) continue;
    assert.ok(mine.has(k), `obj.ts has no ${k}`);
    if (DEPARTS[k]) { assert.deepEqual([v, mine.get(k)], DEPARTS[k], k); continue; }
    assert.equal(mine.get(k), v, k); n++;
  }
  assert.ok(n >= 265, `${n} values compared`);
});

test("layout: every object fits the size NVN reserves for it, and the test game's sizes are nvn.h's", () => {
  const fits: [string, string][] = [["DEV", "DEVICE"], ["DEVB", "DEVICE_BUILDER"], ["QUEUE", "QUEUE"], ["QB", "QUEUE_BUILDER"], ["POOL", "MEMORY_POOL"], ["PB", "MEMORY_POOL_BUILDER"], ["DPOOL", "TEXTURE_POOL"],
    ["DPOOL", "SAMPLER_POOL"], ["BUF", "BUFFER"], ["BB", "BUFFER_BUILDER"], ["TEX", "TEXTURE"], ["TB", "TEXTURE_BUILDER"], ["VIEW", "TEXTURE_VIEW"], ["SAMP", "SAMPLER"], ["SB", "SAMPLER_BUILDER"], ["PROG", "PROGRAM"],
    ["SYNC", "SYNC"], ["WIN", "WINDOW"], ["WB", "WINDOW_BUILDER"], ["CMD", "COMMAND_BUFFER"], ["BLEND_ST", "BLEND_STATE"], ["COLOR_ST", "COLOR_STATE"], ["CHMASK_ST", "CHANNEL_MASK_STATE"], ["MS_ST", "MULTISAMPLE_STATE"],
    ["POLY_ST", "POLYGON_STATE"], ["DS_ST", "DEPTH_STENCIL_STATE"], ["VA_ST", "VERTEX_ATTRIB_STATE"], ["VS_ST", "VERTEX_STREAM_STATE"]];
  for (const [m, n] of fits) {
    assert.equal(BigInt((SIZEOF as any)[n]), ref.get(`NVN_${n}`), `SIZEOF.${n}`);
    assert.ok(mine.get(`${m}_SIZE`)! <= ref.get(`NVN_${n}`)!, `${m} (${mine.get(`${m}_SIZE`)}) exceeds NVN${n} (${ref.get(`NVN_${n}`)})`);
  }
  // the sizes newer SDKs really allocate (nvn_obj.h's own asserts): NVNtexture 0x80, NVNtextureView 16; samplers are hashed from byte 8
  assert.ok(mine.get("TEX_SIZE")! <= 0x80n); assert.ok(mine.get("VIEW_SIZE")! <= 16n);
  assert.equal(mine.get("SAMP_p"), 8n); assert.equal(mine.get("SP_SIZE"), 40n);
  assert.equal(mine.get("BUF_off"), 0x18n); assert.equal(mine.get("BUF_size"), 0x20n); assert.equal(mine.get("P_BIND_TEX1_h"), 8n);
});

test("state objects: the bytes a game copies are nxnative's bit-fields (defaults and one sample each)", async () => {
  const g = await guest(), G = new Game(g), u64 = (p: number) => g.dv.getBigUint64(p, true), u32 = (p: number) => BigInt(g.dv.getUint32(p, true));
  const o = g.alloc(64);
  G.c("BlendStateSetDefaults", [o]); assert.equal(u64(o), ref.get("BITS_BLEND_DEFAULT"));
  G.c("BlendStateSetBlendTarget", [o, 5]); G.c("BlendStateSetBlendFunc", [o, 5, 6, 0x63, 9]); G.c("BlendStateSetBlendEquation", [o, 5, 2]);
  assert.equal(u64(o), ref.get("BITS_BLEND_SAMPLE"));
  G.c("ColorStateSetDefaults", [o]); assert.equal(u32(o), ref.get("BITS_COLOR_DEFAULT"));
  G.c("ColorStateSetBlendEnable", [o, 0, 1]); G.c("ColorStateSetBlendEnable", [o, 5, 0xAB00_0001]); G.c("ColorStateSetBlendEnable", [o, 3, 0x100]);   // a boolean is its low 8 bits
  assert.equal(u32(o), ref.get("BITS_COLOR_SAMPLE"));
  G.c("PolygonStateSetDefaults", [o]); assert.equal(u32(o), ref.get("BITS_POLY_DEFAULT"));
  G.c("PolygonStateSetCullFace", [o, 2]); G.c("PolygonStateSetFrontFace", [o, 0]); G.c("PolygonStateSetPolygonMode", [o, 1]); G.c("PolygonStateSetPolygonOffsetEnables", [o, 4]);
  assert.equal(u32(o), ref.get("BITS_POLY_SAMPLE"));
  G.c("DepthStencilStateSetDefaults", [o]); assert.equal(u64(o), ref.get("BITS_DS_DEFAULT"));
  G.c("DepthStencilStateSetDepthTestEnable", [o, 1]); G.c("DepthStencilStateSetDepthWriteEnable", [o, 0]); G.c("DepthStencilStateSetDepthFunc", [o, 7]); G.c("DepthStencilStateSetStencilTestEnable", [o, 1]);
  G.c("DepthStencilStateSetStencilFunc", [o, 1, 3]); G.c("DepthStencilStateSetStencilFunc", [o, 2, 6]); G.c("DepthStencilStateSetStencilOp", [o, 1, 2, 3, 4]); G.c("DepthStencilStateSetStencilOp", [o, 2, 5, 6, 7]);
  assert.equal(u64(o), ref.get("BITS_DS_SAMPLE"));
  G.c("VertexAttribStateSetDefaults", [o]); G.c("VertexAttribStateSetFormat", [o, FMT.RGBA32F, 12345]); G.c("VertexAttribStateSetStreamIndex", [o, 3]);
  assert.equal(u32(o), ref.get("BITS_VA_SAMPLE"));
  G.c("ChannelMaskStateSetDefaults", [o]); G.c("ChannelMaskStateSetChannelMask", [o, 2, 1, 0, 1, 0]); assert.equal(u32(o), ref.get("BITS_CHMASK_SAMPLE"));
  G.c("TextureViewSetDefaults", [o]); G.c("TextureViewSetLevels", [o, 2, 3]); G.c("TextureViewSetLayers", [o, 4, 5]); G.c("TextureViewSetFormat", [o, FMT.RGBA8_SRGB]); G.c("TextureViewSetDepthStencilMode", [o, 1]);
  assert.equal(u64(o), ref.get("BITS_VIEW_SAMPLE_LO")); assert.equal(u64(o + 8), ref.get("BITS_VIEW_SAMPLE_HI"));
  assert.deepEqual(g.red(), []);
});

test("record sizes: what GetCommandMemoryUsed reports for each command is what nxnative's records take", async () => {
  const g = await guest(), G = new Game(g).init(), cmd = G.cmd, R = (k: string) => Number(ref.get(`REC_${k}`));
  const t = G.texture({ w: 64, h: 64, format: FMT.RGBA8 }), t2 = G.texture({ w: 64, h: 64, format: FMT.RGBA8 }), region = g.u32([0, 0, 0, 4, 4, 1]);
  G.begin();
  let last = 0;
  const took = (what: string, f: () => void, want: number) => { f(); const u = G.used(); assert.equal(u - last, want, `${what}: ${u - last} bytes, nxnative ${want}`); last = u; };
  took("SetRenderTargets(1)", () => G.targets(cmd, [t]), R("SET_RT_1"));
  took("SetRenderTargets(0)", () => G.targets(cmd, []), R("SET_RT_0"));
  took("ClearColor", () => G.clear(cmd, [0, 0, 0, 1]), R("CLEAR_COLOR"));
  took("ClearDepthStencil", () => G.c("CommandBufferClearDepthStencil", [cmd, 1, 0, 0xff], [1]), R("CLEAR_DS"));
  took("SetViewport", () => G.c("CommandBufferSetViewport", [cmd, 0, 0, 64, 64]), R("VIEWPORTS"));
  took("SetViewports", () => G.c("CommandBufferSetViewports", [cmd, 0, 1, g.f32([0, 0, 64, 64])]), R("VIEWPORTS"));
  took("SetScissor", () => G.c("CommandBufferSetScissor", [cmd, 0, 0, 64, 64]), R("SCISSOR"));
  took("SetDepthRange", () => G.c("CommandBufferSetDepthRange", [cmd], [0, 1]), R("DEPTH_RANGE"));
  took("BindProgram", () => G.c("CommandBufferBindProgram", [cmd, g.alloc(SIZEOF.PROGRAM), 3]), R("BIND_PROGRAM"));
  const s = g.alloc(64);
  took("BindBlendState", () => G.c("CommandBufferBindBlendState", [cmd, s]), R("BIND_BLEND"));
  took("BindColorState", () => G.c("CommandBufferBindColorState", [cmd, s]), R("BIND_COLOR"));
  took("BindChannelMaskState", () => G.c("CommandBufferBindChannelMaskState", [cmd, s]), R("BIND_CHMASK"));
  took("BindMultisampleState", () => G.c("CommandBufferBindMultisampleState", [cmd, s]), R("BIND_MS"));
  took("BindPolygonState", () => G.c("CommandBufferBindPolygonState", [cmd, s]), R("BIND_POLY"));
  took("BindDepthStencilState", () => G.c("CommandBufferBindDepthStencilState", [cmd, s]), R("BIND_DS"));
  took("BindVertexAttribState(3)", () => G.c("CommandBufferBindVertexAttribState", [cmd, 3, s]), R("BIND_VATTR_3"));
  took("BindVertexStreamState(2)", () => G.c("CommandBufferBindVertexStreamState", [cmd, 2, s]), R("BIND_VSTREAM_2"));
  took("BindVertexBuffer", () => G.c("CommandBufferBindVertexBuffer", [cmd, 0, 0x2000000, 64]), R("BIND_VBUF1"));
  took("BindVertexBuffers(2)", () => G.c("CommandBufferBindVertexBuffers", [cmd, 0, 2, g.u64([0x2000000, 64, 0x2000100, 64])]), R("BIND_VBUF_2"));
  took("BindUniformBuffer", () => G.c("CommandBufferBindUniformBuffer", [cmd, STAGE.VERTEX, 0, 0x2000000, 64]), R("BIND_UBO_SMALL"));
  took("BindTexture", () => G.c("CommandBufferBindTexture", [cmd, STAGE.FRAGMENT, 0, G.handle(256, 256)]), R("BIND_TEX1"));
  took("BindTextures(3)", () => G.c("CommandBufferBindTextures", [cmd, STAGE.FRAGMENT, 0, 3, g.u64([1, 2, 3])]), R("BIND_TEX_3"));
  took("SetStencilRef", () => G.c("CommandBufferSetStencilRef", [cmd, 3, 1]), R("STENCIL"));
  took("SetPolygonOffsetClamp", () => G.c("CommandBufferSetPolygonOffsetClamp", [cmd], [1, 2, 3]), R("POLY_OFFSET"));
  took("SetBlendColor", () => G.c("CommandBufferSetBlendColor", [cmd, g.f32([1, 1, 1, 1])]), R("BLEND_COLOR"));
  took("DrawArrays", () => G.c("CommandBufferDrawArrays", [cmd, PRIM.TRIANGLES, 0, 3]), R("DRAW"));
  took("DrawArraysInstanced", () => G.c("CommandBufferDrawArraysInstanced", [cmd, PRIM.TRIANGLES, 0, 3, 0, 2]), R("DRAW"));
  took("DrawElements", () => G.c("CommandBufferDrawElements", [cmd, PRIM.TRIANGLES, 1, 6, 0x2000000]), R("DRAW_IDX"));
  took("DrawElementsBaseVertex", () => G.c("CommandBufferDrawElementsBaseVertex", [cmd, PRIM.TRIANGLES, 1, 6, 0x2000000, 4]), R("DRAW_IDX"));
  took("DrawElementsInstanced", () => G.c("CommandBufferDrawElementsInstanced", [cmd, PRIM.TRIANGLES, 1, 6, 0x2000000, 0, 0, 2]), R("DRAW_IDX"));
  took("Barrier", () => G.c("CommandBufferBarrier", [cmd, 0x10]), R("BARRIER"));
  took("SetTexturePool", () => G.c("CommandBufferSetTexturePool", [cmd, G.texPool]), R("SET_POOL"));
  took("SetSamplerPool", () => G.c("CommandBufferSetSamplerPool", [cmd, G.sampPool]), R("SET_POOL"));
  took("CopyBufferToTexture", () => G.c("CommandBufferCopyBufferToTexture", [cmd, 0x2000000, t, 0, region, 0]), R("COPY_B2T"));
  took("SetCopyRowStride takes no command memory", () => G.c("CommandBufferSetCopyRowStride", [cmd, 32]), 0);
  took("CopyBufferToTexture with a stride", () => G.c("CommandBufferCopyBufferToTexture", [cmd, 0x2000000, t, 0, region, 0]), R("COPY_B2T_STRIDES"));
  took("CopyTextureToTexture", () => G.c("CommandBufferCopyTextureToTexture", [cmd, t, 0, region, t2, 0, region, 0]), R("COPY_T2T"));
  took("CopyBufferToBuffer", () => G.c("CommandBufferCopyBufferToBuffer", [cmd, 0x2000000, 0x2000100, 16, 0]), R("COPY_B2B"));
  took("UpdateUniformBuffer(20 bytes)", () => G.c("CommandBufferUpdateUniformBuffer", [cmd, 0x2000000, 64, 0, 20, g.alloc(20)]), R("UPDATE_UB_20"));
  took("FenceSync", () => G.c("CommandBufferFenceSync", [cmd, g.alloc(SIZEOF.SYNC), 0, 0]), R("FENCE_SYNC"));
  took("CallCommands(2)", () => G.c("CommandBufferCallCommands", [cmd, 2, g.u64([0, 0])]), 2 * R("CALL"));
  const h = G.end();
  assert.equal(G.used() - last, R("END"));
  assert.equal(h, G.cmdPool.mem, "the handle is the address of the recording's first record");
  // an empty recording takes only its END, and a recording starts with its first command (no BEGIN record)
  G.begin(); const h2 = G.end(); assert.equal(G.used() - last, 2 * R("END")); assert.equal(h2, h + last + R("END"));
  assert.deepEqual(g.red(), []);
});

test("texture storage: size, alignment and level offsets equal nvn_tex.c over 420 shapes", async () => {
  const g = await guest(), shapes: number[][] = [];
  const fmts = [0x01, 0x0d, 0x25, 0x29, 0x2e, 0x32, 0x33, 0x34, 0x35, 0x38, 0x3d, 0x3f, 0x41, 0x42, 0x44, 0x49, 0x4b, 0x4d, 0x79, 0x7d, 0x9a];
  const dims = [[1, 1], [4, 4], [16, 16], [64, 64], [100, 60], [256, 256], [320, 320], [672, 160], [1280, 720], [1920, 1080], [2048, 2048], [4096, 2048]];
  for (const f of fmts) for (const [w, h] of dims) shapes.push([1, f, 0, 0, w, h, 1, 1 + Math.floor(Math.log2(Math.max(w, h))), 0, 0]);
  for (const f of [0x25, 0x42, 0x4d]) for (const [w, h] of dims.slice(1, 8)) {
    shapes.push([4, f, 0, 0, w, h, 6, 3, 0, 0], [8, f, 0, 0, w, w, 1, 2, 0, 0], [2, f, 0, 0, w, h, 16, 2, 0, 0], [1, f, 0x10, 0, w, h, 1, 1, 0, 0], [1, f, 0x40, 0, w, h, 1, 1, 0, 0],
      [1, f, 0x200, 0, w, h, 1, 4, 0, 0], [1, f, 0x20, 0, w * 8, h * 8, 1, 3, 0, 0], [1, f, 0, 0, w, h, 1, 2, 0, 3], [1, f, 0, 4, w, h, 1, 1, 0, 0]);
  }
  const want = reference("texlayout_ref.c", [join(NXNATIVE, "dm/gfx/nvn/nvn_tex.c")], shapes.map(s => s.join(" ")).join("\n") + "\n").trim().split("\n");
  assert.equal(want.length, shapes.length);
  const d = g.alloc(40), o = g.alloc(40), dv = g.dv;
  shapes.forEach((s, i) => {
    s.forEach((v, k) => dv.setInt32(d + k * 4, v, true));
    g.x.gfx_tex_layout(d, o);
    const got = [dv.getBigUint64(o, true), dv.getBigUint64(o + 8, true), dv.getUint32(o + 16, true), dv.getUint32(o + 20, true), dv.getUint32(o + 28, true), dv.getUint32(o + 32, true),
      g.x.gfx_tex_level_offset(d, 1) >>> 0, g.x.gfx_tex_level_offset(d, s[7] ? s[7] - 1 : 0) >>> 0].join(" ");
    assert.equal(got, want[i], `shape ${s.join(" ")}`);
  });
  assert.ok(shapes.length >= 420);
});

test("lookup: all 743 NVN names resolve; an unimplemented one logs red once and returns 0; nvnDeviceGetProcAddress", async () => {
  const g = await guest(), names = readFileSync(join(ROOT, "src/gfx/names.txt"), "utf8").trim().split("\n");
  assert.equal(names.length, 743); assert.equal(g.x.nvn_count(), 743);
  const ids = new Set<number>(), by = [0, 0, 0];
  for (const n of names) { const id = g.id(n); assert.ok(id >= 0 && id < 743, n); ids.add(id); by[g.x.nvn_status(id)]++; }
  assert.equal(ids.size, 743);
  assert.deepEqual(g.red(), []);
  assert.equal(by[0] + by[1] + by[2], 743);
  const stub = names.find(n => g.x.nvn_status(g.id(n)) === 0)!;
  assert.equal(g.call(stub, [1, 2, 3]), 0); assert.equal(g.call(stub, [1, 2, 3]), 0);
  assert.deepEqual(g.red(), [`[RED] ${stub} unimplemented`]);
  assert.equal(g.call("nvnCommandBufferPushDebugGroup", [0, 0]), 0);        // empty by design: no line
  assert.equal(g.red().length, 1);
  const G = new Game(g).init(), name = g.bytes(new TextEncoder().encode("nvnQueueSubmitCommands\0"));
  assert.equal(G.c("DeviceGetProcAddress", [G.dev, name]), 0xE000_0000 + g.id("nvnQueueSubmitCommands") * 16);
  assert.equal(g.x.nvn_lookup(g.bytes(new TextEncoder().encode("nvnNoSuchFunction\0"))), -1);
  assert.match(g.red()[1], /unknown name: nvnNoSuchFunction/);
  console.log(`     NVN functions: ${by[1]} implemented, ${by[2]} empty by design, ${by[0]} red stubs, of ${names.length}`);
});

test("device: GetInteger answers with nxnative's values for what games ask at init", async () => {
  const g = await guest(), G = new Game(g).init(), out = g.alloc(4);
  const get = (item: number) => { G.c("DeviceGetInteger", [G.dev, item, out]); return g.dv.getInt32(out, true); };
  const src = readFileSync(join(NXNATIVE, "dm/gfx/nvn/hle_nvn.c"), "utf8"), tab = src.slice(src.indexOf("static const int g_devinfo[]"), src.indexOf("enum { DEVINFO_RT"));
  let n = 0;
  for (const m of tab.matchAll(/\[(0x[0-9A-F]+)\] = (\d+)/g)) {
    const item = Number(m[1]), want = item === 0x2e ? 1 : item === 0x30 ? 16 : Number(m[2]);     // 0x2E / 0x30: the GPU code version the shader chain translates, 1.16
    assert.equal(get(item), want, `item 0x${item.toString(16)}`); n++;
  }
  assert.equal(n, 0x60);
  assert.equal(get(0x60), 0); assert.match(g.red().at(-1)!, /nvnDeviceGetInteger unknown item 0x60/);
  g.x.gfx_set_api(53, 313); assert.deepEqual([get(0), get(1)], [53, 313]);
  assert.equal(G.c("DeviceGetWindowOriginMode", [G.dev]), 1); assert.equal(G.c("DeviceGetDepthMode", [G.dev]), 1);
  assert.equal(G.handle(300, 7), 300 + 7 * 2 ** 20);
});

test("objects: pool Map, buffer, texture and sampler objects as the game reads them back", async () => {
  const g = await guest(), G = new Game(g).init();
  assert.equal(G.c("MemoryPoolMap", [G.data.obj]), G.data.mem); assert.equal(G.c("MemoryPoolMap", [G.texStore.obj]), 0, "CPU_NO_ACCESS maps to null");
  assert.equal(G.c("MemoryPoolGetSize", [G.data.obj]), G.data.size);
  const bb = g.alloc(SIZEOF.BUFFER_BUILDER), buf = g.alloc(SIZEOF.BUFFER);
  G.c("BufferBuilderSetDevice", [bb, G.dev]); G.c("BufferBuilderSetDefaults", [bb]); G.c("BufferBuilderSetStorage", [bb, G.data.obj, 0x400, 0x200]);
  assert.equal(G.c("BufferInitialize", [buf, bb]), 1);
  assert.equal(G.c("BufferGetAddress", [buf]), G.data.mem + 0x400); assert.equal(G.c("BufferMap", [buf]), G.data.mem + 0x400); assert.equal(G.c("BufferGetSize", [buf]), 0x200);
  const t = G.texture({ w: 320, h: 180, format: FMT.RGBA8, levels: 3 });
  assert.deepEqual([G.c("TextureGetWidth", [t]), G.c("TextureGetHeight", [t]), G.c("TextureGetLevels", [t]), G.c("TextureGetFormat", [t])], [320, 180, 3, FMT.RGBA8]);
  const copy = g.alloc(0x80); g.u8.copyWithin(copy, t, t + 0x80);          // games copy NVNtexture by value
  assert.equal(G.c("TextureGetStorageSize", [copy]), G.c("TextureGetStorageSize", [t]));
  const s = g.alloc(SIZEOF.SAMPLER), sb = g.alloc(SIZEOF.SAMPLER_BUILDER);
  g.u8.fill(0xEE, s, s + 0x30);
  G.c("SamplerBuilderSetDevice", [sb, G.dev]); G.c("SamplerBuilderSetDefaults", [sb]); G.c("SamplerBuilderSetLodClamp", [sb], [-2, 9]); G.c("SamplerBuilderSetMaxAnisotropy", [sb], [8]);
  G.c("SamplerInitialize", [s, sb]);
  const p = s + 8, dv = g.dv;       // every byte written; the state from byte 8 (games hash it): GL defaults, then what was set
  assert.deepEqual([...g.u8.subarray(p, p + 8)], [4, 1, 1, 1, 1, 0, 2, 0]);
  assert.deepEqual([dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true)], [-2, 9, 0, 8]);
  assert.equal(dv.getUint32(s + 4, true), 0);
  assert.deepEqual(g.red(), []);
});

test("recording: BeginRecording twice is red and restarts; a command outside a recording is refused, red, and takes no memory", async () => {
  const g = await guest(), G = new Game(g).init();
  G.clear(G.cmd, [0, 0, 0, 0]);
  assert.match(g.red()[0], /kit: gfx_cmdbuf#\d+ refused Record in Idle/);
  assert.equal(G.c("CommandBufferGetCommandMemoryFree", [G.cmd]), G.cmdPool.size);
  assert.equal(G.end(), 0); assert.match(g.red()[1], /refused End in Idle/);
  G.begin(); assert.equal(G.c("CommandBufferIsRecording", [G.cmd]), 1);
  G.begin(); assert.equal(g.red()[2], "[RED] BeginRecording re-entered");
  G.clear(G.cmd, [0, 0, 0, 0]);
  assert.equal(G.end(), G.cmdPool.mem); assert.equal(G.c("CommandBufferIsRecording", [G.cmd]), 0);
  assert.equal(g.red().length, 3);
});

test("command memory: the callback is asked for what the record needs plus a JUMP; no callback or a callback that adds nothing gets a host-lent segment", async () => {
  const g = await guest(), G = new Game(g).init(), dv = () => g.dv;
  const walk = (h: number) => { const ops: number[] = []; for (let p = h; ;) { const op = dv().getUint32(p, true), size = dv().getUint32(p + 4, true); ops.push(op); if (op === 0) break; p = op === 1 ? Number(dv().getBigUint64(p + 8, true)) : p + size; } return ops; };
  // (a) a callback that adds 4 KB each time it is asked
  const asked: bigint[][] = [];
  let next = 256;
  const cmd = G.commandBuffer(G.cmdPool, 0, 256);
  G.c("CommandBufferSetMemoryCallback", [cmd, g.fn((c, ev, size, data) => { asked.push([c, ev, size, data]); G.c("CommandBufferAddCommandMemory", [cmd, G.cmdPool.obj, next, 4096]); next += 4096; })]);
  G.c("CommandBufferSetMemoryCallbackData", [cmd, 0x1234_5678]);
  G.begin(cmd);
  for (let i = 0; i < 40; i++) G.c("CommandBufferDrawArrays", [cmd, 4, 0, 3]);     // 40 x 32 bytes into 256
  const h = G.end(cmd);
  assert.equal(h, G.cmdPool.mem);
  assert.deepEqual(asked, [[BigInt(cmd), 0n, 48n, 0x1234_5678n]], "asked once: OUT_OF_COMMAND_MEMORY, 32 bytes of record + 16 kept for a JUMP");
  const ops = walk(h);
  assert.equal(ops.filter(o => o === 25).length, 40); assert.equal(ops.filter(o => o === 1).length, 1); assert.equal(ops.at(-1), 0);
  assert.equal(dv().getUint32(G.cmdPool.mem + 224, true), 1, "the JUMP stands where the record that did not fit was to go");
  assert.equal(Number(dv().getBigUint64(G.cmdPool.mem + 232, true)), G.cmdPool.mem + 256);
  assert.equal(G.used(cmd), 33 * 32 + 8, "used counts from the memory the game last added");
  assert.equal(g.x.gfx_stat(7), 0);
  // (b) a callback that cannot add: asked twice, then the host lends a segment and the recording goes on there
  let calls = 0;
  const cmd2 = G.commandBuffer(G.cmdPool, 0x10000, 128);
  G.c("CommandBufferSetMemoryCallback", [cmd2, g.fn(() => { calls++; })]);
  G.begin(cmd2);
  for (let i = 0; i < 10; i++) G.c("CommandBufferDrawArrays", [cmd2, 4, 0, 3]);
  const h2 = G.end(cmd2);
  assert.equal(calls, 2); assert.equal(g.x.gfx_stat(7), 1);
  assert.equal(walk(h2).filter(o => o === 25).length, 10);
  assert.match(g.logs.at(-1)!, /the game's command memory ran short, the host lends a segment of 256 KB/);
  // (c) no callback at all
  const cmd3 = G.commandBuffer(G.cmdPool, 0x20000, 128);
  G.begin(cmd3);
  for (let i = 0; i < 10; i++) G.c("CommandBufferDrawArrays", [cmd3, 4, 0, 3]);
  assert.equal(walk(G.end(cmd3)).filter(o => o === 25).length, 10); assert.equal(g.x.gfx_stat(7), 2);
  // (d) every record but the END keeps 16 bytes for a JUMP behind it; the END needs none
  const cmd4 = G.commandBuffer(G.cmdPool, 0x30000, 64);
  let asked4 = 0;
  G.c("CommandBufferSetMemoryCallback", [cmd4, g.fn(() => { asked4++; G.c("CommandBufferAddCommandMemory", [cmd4, G.cmdPool.obj, 0x31000, 4096]); })]);
  G.begin(cmd4); G.c("CommandBufferDrawArrays", [cmd4, 4, 0, 3]); G.c("CommandBufferBarrier", [cmd4, 0]);     // 32 + 16, and 16 kept: 64
  assert.equal(asked4, 0); assert.equal(G.c("CommandBufferGetCommandMemoryFree", [cmd4]), 16);
  G.end(cmd4);
  assert.equal(asked4, 0); assert.equal(G.c("CommandBufferGetCommandMemoryFree", [cmd4]), 8);
  G.begin(cmd4); G.c("CommandBufferBarrier", [cmd4, 0]);                                                      // 16 + 16 kept do not fit in 8
  assert.equal(asked4, 1);
  assert.equal(G.end(cmd4), G.cmdPool.mem + 0x31000, "a recording with no record yet starts in the new memory: no JUMP");
  assert.deepEqual(g.red(), []);
});
