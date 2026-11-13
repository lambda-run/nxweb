// node test/gfx/capstat.mts <capture file> [--json <file>] [--passes]      (test/gfx/REPLAY.md)
// Counts and classifies what a stream capture holds WITHOUT a GPU: per presented frame the batches, passes, draws, dispatches, pipeline creations, binds and
// upload records; the draws per pass (passes named by their targets' size and format); and how many draws repeat an earlier one of the same frame
// (same pipeline, same vertex/index ranges, same arguments; and, stricter, the same uniform/texture bindings and targets too).
import { openSync, readSync, fstatSync, writeFileSync } from "node:fs";
import { indexCapture } from "../../src/glue/gfx_stream_capture.ts";
import { hostFormat } from "../../src/glue/gfx_formats.ts";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const jsonOut = opt("--json"), showPasses = flag("--passes"), file = args[0];
if (!file) { console.error("usage: node test/gfx/capstat.mts <capture file> [--json <file>] [--passes]"); process.exit(1); }
const fd = openSync(file, "r"), size = fstatSync(fd).size;
const read = (off: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); };
const index = await indexCapture(read, size);

const OP: Record<number, string> = { 1: "TEX_CREATE", 2: "TEX_DESTROY", 3: "BEGIN_PASS", 4: "END_PASS", 5: "VIEWPORT", 6: "SCISSOR", 7: "PIPELINE_CREATE", 8: "PIPELINE", 9: "VBUF", 10: "UBO", 11: "TEX", 12: "BLEND_COLOR",
  13: "STENCIL_REF", 14: "DRAW", 15: "DRAW_IDX", 16: "CLEAR_RECT", 17: "COPY_B2T", 18: "COPY_T2T", 19: "SNAPSHOT", 20: "PRESENT", 21: "FENCE", 22: "FLUSH", 23: "MEM_DIRTY", 24: "TEX_DATA", 25: "COPY_T2B", 26: "FIXUP",
  27: "UBO_DATA", 28: "SSBO", 29: "IMG", 30: "BEGIN_COMPUTE", 31: "DISPATCH", 32: "BUF_READBACK", 33: "REPORT", 34: "REPORT_COMMIT", 35: "MESH_BEGIN", 36: "MESH_TASK", 37: "MESH_RUN", 38: "MESH_DRAW", 39: "CLEAR_TEX",
  40: "DISPATCH_SKIPPED", 41: "SKIP" };
const SKIP = ["shader", "no stage", "pipeline", "state", "render condition"];
const u64 = (dv: DataView, p: number) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
function fnv(u8: Uint8Array, a: number, b: number, v = 0x811c9dc5): number { for (let i = a; i < b; i++) v = Math.imul(v ^ u8[i], 0x01000193); return v >>> 0; }

interface TexD { w: number; h: number; d: number; fmt: string; samples: number }
const tex = new Map<number, TexD>();
const texName = (s: number) => { const t = tex.get(s); return t ? `${t.w}x${t.h}${t.d > 1 ? "x" + t.d : ""} ${t.fmt}${t.samples > 1 ? " x" + t.samples : ""}` : `tex#${s}?`; };
for (const c of index.chunks) if (c.h.type === "tex") tex.set(c.h.serial, { w: c.h.width, h: c.h.height, d: c.h.depth, fmt: c.h.gpuFormat ?? hostFormat(c.h.format, 3)?.tex ?? `nvn${c.h.format}`, samples: c.h.samples });

interface Pass { kind: "render" | "compute"; sig: string; targets: string; draws: number; zero: number; skips: number; dispatches: number; recs: number; hash: number; dupLoose: number; dupStrict: number; indices: number; instances: number }
interface Frame { n: number; batches: number; bytes: number; recs: Record<string, number>; passes: Pass[]; draws: number; drawsOutside: number; zero: number; skips: Record<string, number>; dupLoose: number; dupStrict: number;
  dupPasses: number; dupBatches: number; vbufBytes: number; vbufDistinct: number; vbufDistinctBytes: number; idxBytes: number; idxDistinct: number; idxDistinctBytes: number; uboBytes: number; uboDistinct: number; uboDistinctBytes: number;
  uboDataBytes: number; texDataBytes: number; b2tRecords: number; pipelinesUsed: number; pipelineSwitches: number; pipelineRedundant: number; texRedundant: number; uboRedundant: number; vbufRedundant: number; pages: number;
  instances: number; indices: number }
const newFrame = (n: number): Frame => ({ n, batches: 0, bytes: 0, recs: {}, passes: [], draws: 0, drawsOutside: 0, zero: 0, skips: {}, dupLoose: 0, dupStrict: 0, dupPasses: 0, dupBatches: 0, vbufBytes: 0, vbufDistinct: 0,
  vbufDistinctBytes: 0, idxBytes: 0, idxDistinct: 0, idxDistinctBytes: 0, uboBytes: 0, uboDistinct: 0, uboDistinctBytes: 0, uboDataBytes: 0, texDataBytes: 0, b2tRecords: 0, pipelinesUsed: 0, pipelineSwitches: 0,
  pipelineRedundant: 0, texRedundant: 0, uboRedundant: 0, vbufRedundant: 0, pages: 0, instances: 0, indices: 0 });

const frames: Frame[] = [];
let fr = newFrame(0);
// per-frame sets
let seenLoose = new Set<string>(), seenStrict = new Set<string>(), seenPass = new Set<number>(), seenBatch = new Set<number>(), vb = new Set<string>(), ib = new Set<string>(), ub = new Set<string>(), pipes = new Set<number>();
// state across records
let pass: Pass | null = null, passStart = 0, pipe = -1;
const vbuf = new Map<number, string>(), ubo = new Map<number, string>(), tx = new Map<number, string>();
const stateStr = (m: Map<number, string>) => [...m].sort((a, b) => a[0] - b[0]).map(e => e[0] + "=" + e[1]).join(",");
const endPass = (u8: Uint8Array, p: number) => {
  if (!pass) return;
  pass.hash = fnv(u8, passStart, p, pass.hash);
  if (seenPass.has(pass.hash) && pass.draws) fr.dupPasses++; else seenPass.add(pass.hash);
  fr.passes.push(pass); pass = null;
};
const endFrame = () => {
  fr.vbufDistinct = vb.size; fr.idxDistinct = ib.size; fr.uboDistinct = ub.size; fr.pipelinesUsed = pipes.size;
  for (const k of vb) fr.vbufDistinctBytes += +k.split(":")[1]; for (const k of ib) fr.idxDistinctBytes += +k.split(":")[1]; for (const k of ub) fr.uboDistinctBytes += +k.split(":")[1];
  frames.push(fr); fr = newFrame(frames.length);
  seenLoose = new Set(); seenStrict = new Set(); seenPass = new Set(); seenBatch = new Set(); vb = new Set(); ib = new Set(); ub = new Set(); pipes = new Set();
};

for (const c of index.chunks) {
  if (c.h.type !== "batch") continue;
  const n = c.h.len as number, u8 = read(c.off, (n + 7) & ~7), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  fr.batches++; fr.bytes += n; for (const r of c.h.runs as [number, number][]) fr.pages += r[1];
  const bh = fnv(u8, 0, n); if (seenBatch.has(bh)) fr.dupBatches++; else seenBatch.add(bh);
  if (pass) passStart = 0;      // a pass that goes on across batches: its hash goes on
  for (let p = 0; p < n;) {
    const op = dv.getUint32(p, true), sz = dv.getUint32(p + 4, true);
    if (!sz) break;
    const name = OP[op] ?? `op${op}`;
    fr.recs[name] = (fr.recs[name] ?? 0) + 1;
    if (pass) pass.recs++;
    switch (op) {
      case 1: { const d = p + 16; tex.set(u64(dv, p + 8), { w: dv.getUint32(d + 16, true), h: dv.getUint32(d + 20, true), d: dv.getUint32(d + 24, true), fmt: hostFormat(dv.getInt32(d + 4, true), 3)?.tex ?? `nvn${dv.getInt32(d + 4, true)}`, samples: dv.getInt32(d + 12, true) }); break; }
      case 3: {
        endPass(u8, p);
        const nc = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 12, true), parts: string[] = [], tg: string[] = [];
        for (let i = 0; i < nc; i++) { const o = p + 32 + i * 40, s = u64(dv, o); parts.push(texName(s) + (dv.getUint32(o + 20, true) ? " clear" : "")); tg.push(`${s}/${dv.getUint32(o + 8, true)}/${dv.getUint32(o + 12, true)}`); }
        if (flags & 1) { const s = u64(dv, p + 352); parts.push("D:" + texName(s) + (flags & 2 ? " clear" : "")); tg.push(`d${s}/${dv.getUint32(p + 360, true)}/${dv.getUint32(p + 364, true)}`); }
        pass = { kind: "render", sig: parts.join(" + ") || "(no targets)", targets: tg.join(" "), draws: 0, zero: 0, skips: 0, dispatches: 0, recs: 1, hash: 0x811c9dc5, dupLoose: 0, dupStrict: 0, indices: 0, instances: 0 };
        passStart = p; pipe = -1; vbuf.clear(); ubo.clear(); tx.clear(); break;
      }
      case 30: endPass(u8, p); pass = { kind: "compute", sig: "compute", targets: "", draws: 0, zero: 0, skips: 0, dispatches: 0, recs: 1, hash: 0x811c9dc5, dupLoose: 0, dupStrict: 0, indices: 0, instances: 0 }; passStart = p; pipe = -1; ubo.clear(); tx.clear(); break;
      case 4: if (pass) pass.recs--; endPass(u8, p + sz); break;
      case 8: { const id = dv.getUint32(p + 8, true); fr.pipelineSwitches++; if (id === pipe) fr.pipelineRedundant++; pipe = id; pipes.add(id); break; }
      case 9: { const k = `${u64(dv, p + 16)}:${dv.getUint32(p + 12, true)}`, slot = dv.getUint32(p + 8, true); if (vbuf.get(slot) === k) fr.vbufRedundant++; vbuf.set(slot, k); vb.add(k); fr.vbufBytes += dv.getUint32(p + 12, true); break; }
      case 10: { const k = `${u64(dv, p + 16)}:${dv.getUint32(p + 24, true)}`, slot = dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true); if (ubo.get(slot) === k) fr.uboRedundant++; ubo.set(slot, k); ub.add(k); fr.uboBytes += dv.getUint32(p + 24, true); break; }
      case 27: fr.uboDataBytes += dv.getUint32(p + 16, true); ubo.set(dv.getUint32(p + 8, true) * 16 + dv.getUint32(p + 12, true), "d" + fnv(u8, p + 24, p + 24 + dv.getUint32(p + 16, true))); break;
      case 11: { const k = `${u64(dv, p + 16)}:${dv.getUint32(p + 24, true)}:${dv.getUint32(p + 28, true)}:${fnv(u8, p + 32, p + 48)}`, slot = dv.getUint32(p + 8, true) * 64 + dv.getUint32(p + 12, true); if (tx.get(slot) === k) fr.texRedundant++; tx.set(slot, k); break; }
      case 14: case 15: {
        const idx = op === 15, count = dv.getUint32(p + 12, true), inst = dv.getUint32(p + 16, true);
        fr.draws++; fr.instances += inst; fr.indices += count * inst;
        if (!pass || pass.kind !== "render") fr.drawsOutside++; else { pass.draws++; pass.indices += count * inst; pass.instances += inst; }
        if (!count || !inst) { fr.zero++; if (pass) pass.zero++; }
        if (idx) { const isz = dv.getUint32(p + 8, true) === 2 ? 4 : dv.getUint32(p + 8, true) === 1 ? 2 : 1; fr.idxBytes += count * isz; ib.add(`${u64(dv, p + 32)}:${count * isz}`); }
        // the multi-draw index (+28 / +40) is not part of the draw's identity
        const argsKey = idx ? `i${dv.getUint32(p + 8, true)},${count},${inst},${dv.getUint32(p + 20, true)},${dv.getInt32(p + 24, true)},${u64(dv, p + 32)}` : `d${dv.getUint32(p + 8, true)},${count},${inst},${dv.getUint32(p + 20, true)}`;
        const loose = `${pipe}|${stateStr(vbuf)}|${argsKey}`, strict = `${loose}|${stateStr(ubo)}|${stateStr(tx)}|${pass?.targets}`;
        if (seenLoose.has(loose)) { fr.dupLoose++; if (pass) pass.dupLoose++; } else seenLoose.add(loose);
        if (seenStrict.has(strict)) { fr.dupStrict++; if (pass) pass.dupStrict++; } else seenStrict.add(strict);
        break;
      }
      case 31: if (pass) pass.dispatches++; break;
      case 41: { const r = SKIP[dv.getUint32(p + 8, true)] ?? "?", kind = ["draw", "dispatch", "mesh draw"][u8[p + 12]] ?? "?"; fr.skips[`${kind}: ${r}`] = (fr.skips[`${kind}: ${r}`] ?? 0) + 1; if (pass) pass.skips++; break; }
      case 24: { fr.texDataBytes += dv.getUint32(p + 48, true) * dv.getUint32(p + 32, true) * Math.max(1, dv.getUint32(p + 36, true)); break; }
      case 17: fr.b2tRecords++; break;
      case 20: endPass(u8, p); endFrame(); break;
    }
    p += sz;
  }
  if (pass) { pass.hash = fnv(u8, passStart, n, pass.hash); passStart = 0; }
}
const tail = fr.batches ? fr : null;

const count = (t: string) => index.chunks.filter(c => c.h.type === t).length;
console.log(`${file}: ${(size / 1048576).toFixed(1)} MB, ${frames.length} presented frames, ${count("batch")} batches, ${count("tex")} textures, ${count("shader")} shaders, ${count("pipe")} pipelines made before`);
const kb = (n: number) => n >= 1 << 20 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(0) + " KB";
for (const f of [...frames, ...(tail ? [tail] : [])]) {
  const rp = f.passes.filter(p => p.kind === "render"), cp = f.passes.filter(p => p.kind === "compute"), r = f.recs;
  console.log(`\n== frame ${f.n}${f === tail ? " (records after the last present)" : ""}: ${f.batches} batches (${f.dupBatches} byte-identical to an earlier one), ${kb(f.bytes)} of records, ${f.pages} memory pages (${kb(f.pages * 4096)}) changed`);
  console.log(`   ${rp.length} render passes (${rp.filter(p => !p.draws).length} without a draw), ${cp.length} compute passes, ${f.draws} draws (${r.DRAW ?? 0} + ${r.DRAW_IDX ?? 0} indexed; ${f.zero} with count or instances 0; ${f.drawsOutside} outside a pass), ${r.DISPATCH ?? 0} dispatches, ${r.MESH_DRAW ?? 0} mesh draws`);
  console.log(`   instances ${f.instances}, vertices/indices drawn ${f.indices}`);
  console.log(`   skipped by the recorder: ${Object.entries(f.skips).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`);
  console.log(`   repeats of an earlier draw of the frame: ${f.dupLoose} by pipeline+vertex ranges+arguments, ${f.dupStrict} also by uniform ranges, textures and targets; ${f.dupPasses} passes byte-identical to an earlier one`);
  console.log(`   pipelines: ${r.PIPELINE_CREATE ?? 0} created, ${f.pipelinesUsed} distinct used, ${f.pipelineSwitches} PIPELINE records (${f.pipelineRedundant} name the one already set)`);
  console.log(`   binds: ${r.UBO ?? 0} UBO (${f.uboRedundant} unchanged; ${f.uboDistinct} distinct ranges, ${kb(f.uboDistinctBytes)}; ${kb(f.uboBytes)} named), ${r.UBO_DATA ?? 0} UBO_DATA (${kb(f.uboDataBytes)}), ${r.TEX ?? 0} TEX (${f.texRedundant} unchanged), ${r.SSBO ?? 0} SSBO, ${r.IMG ?? 0} IMG`);
  console.log(`   vertex: ${r.VBUF ?? 0} VBUF (${f.vbufRedundant} unchanged; ${f.vbufDistinct} distinct ranges, ${kb(f.vbufDistinctBytes)}; ${kb(f.vbufBytes)} named); index: ${f.idxDistinct} distinct ranges, ${kb(f.idxDistinctBytes)} (${kb(f.idxBytes)} named)`);
  console.log(`   uploads/copies: ${r.TEX_DATA ?? 0} TEX_DATA (${kb(f.texDataBytes)}), ${r.COPY_B2T ?? 0} COPY_B2T, ${r.COPY_T2T ?? 0} COPY_T2T, ${r.COPY_T2B ?? 0} COPY_T2B, ${r.CLEAR_TEX ?? 0} CLEAR_TEX, ${r.CLEAR_RECT ?? 0} CLEAR_RECT, ${r.SNAPSHOT ?? 0} SNAPSHOT, ${r.BUF_READBACK ?? 0} BUF_READBACK`);
  console.log(`   other: ${r.VIEWPORT ?? 0} VIEWPORT, ${r.SCISSOR ?? 0} SCISSOR, ${r.BLEND_COLOR ?? 0} BLEND_COLOR, ${r.STENCIL_REF ?? 0} STENCIL_REF, ${r.FIXUP ?? 0} FIXUP, ${r.FLUSH ?? 0} FLUSH, ${r.FENCE ?? 0} FENCE, ${r.MEM_DIRTY ?? 0} MEM_DIRTY, ${r.TEX_CREATE ?? 0} TEX_CREATE, ${r.TEX_DESTROY ?? 0} TEX_DESTROY, ${r.REPORT ?? 0} REPORT`);
  // passes by signature
  const by = new Map<string, { passes: number; draws: number; dupLoose: number; dupStrict: number; skips: number; zero: number; indices: number }>();
  for (const p of rp) { const e = by.get(p.sig) ?? { passes: 0, draws: 0, dupLoose: 0, dupStrict: 0, skips: 0, zero: 0, indices: 0 }; e.passes++; e.draws += p.draws; e.dupLoose += p.dupLoose; e.dupStrict += p.dupStrict; e.skips += p.skips; e.zero += p.zero; e.indices += p.indices; by.set(p.sig, e); }
  console.log(`   render passes by targets (draws desc):`);
  for (const [sig, e] of [...by].sort((a, b) => b[1].draws - a[1].draws).slice(0, 30)) console.log(`     ${String(e.draws).padStart(6)} draws in ${String(e.passes).padStart(3)} passes (${e.dupLoose} loose / ${e.dupStrict} strict repeats, ${e.skips} skipped, ${e.indices} indices)  ${sig}`);
  if (by.size > 30) console.log(`     … ${by.size - 30} more signatures`);
  if (showPasses) f.passes.forEach((p, i) => console.log(`     #${String(i).padStart(3)} ${p.kind === "compute" ? `compute: ${p.dispatches} dispatches` : `${String(p.draws).padStart(5)} draws (${p.dupLoose}/${p.dupStrict} repeats, ${p.skips} skipped) ${p.sig}`}`));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ file, size, frames, tail }, null, 1));
