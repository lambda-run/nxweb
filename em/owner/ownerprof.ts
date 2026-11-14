// ?ownerprof=<seconds>@<present n | area> (&ownerprofname=<name>, &logto=<receiver>, default http://localhost:8082): a profile of the owner where it runs
// (the page, or the worker with ?owner=worker), taken live. At present n (or once 30 presents in a row had at least 500 draws: area) the JS
// Self-Profiling API starts (sampleInterval 1 ms; the document or worker script must be served with Document-Policy: js-profiling, web/serve.mts),
// and for <seconds> the replayer's records are timed one by one (by type) and every WebGPU method by name; then everything stops and one JSON goes
// to the receiver as ownerprof-<name>.json: functions by self and total time, ms per record type, per WebGPU method, the replayer's counters over
// the window (pipelines built synchronously vs in the background among them), per present.
const IFACES = ["GPUDevice", "GPUQueue", "GPUCommandEncoder", "GPURenderPassEncoder", "GPUComputePassEncoder", "GPUBuffer", "GPUTexture", "GPUCanvasContext"];
type C = { count: number; ms: number; bytes: number };

export function ownerProf(search: string, owner: any, log: (l: string) => void): void {
  const q = new URLSearchParams(search), spec = q.get("ownerprof");
  if (!spec) return;
  const m = /^(\d+(?:\.\d+)?)@(area|\d+)$/.exec(spec);
  if (!m) { log(`[RED] ownerprof=${spec}: expected <seconds>@<present number|area>`); return; }
  const secs = +m[1], at = m[2], host: any = owner.gfx?.host, G = globalThis as any;
  if (!host) { log("[RED] ownerprof: no replayer in this owner"); return; }
  const to = (q.get("logto") || "http://localhost:8082").replace(/\/+$/, ""), name = (q.get("ownerprofname") || `${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, "");
  log(`ownerprof: ${secs} s of the owner's profile from ${at === "area" ? "the area (30 presents in a row with 500 draws or more)" : `present ${at}`}, then ownerprof-${name}.json to ${to}${typeof G.Profiler === "function" ? "" : " — [RED] but this realm has no Profiler (Document-Policy: js-profiling missing on the document or worker script)"}`);
  let presents = 0, busy = 0, lastDraws = 0, started = false, done = false;
  const present0 = host.present.bind(host);
  host.present = (dv: DataView, p: number) => {
    const r = present0(dv, p);
    if (started || done) { if (started) presents++; return r; }
    presents++;
    const d = host.stats.draws, n = d >= lastDraws ? d - lastDraws : d; lastDraws = d;
    busy = n >= 500 ? busy + 1 : 0;
    if (at === "area" ? busy >= 30 : presents >= +at) { started = true; queueMicrotask(() => { void begin(); }); }
    return r;
  };
  const begin = async () => {
    let prof: any = null;
    try { prof = typeof G.Profiler === "function" ? new G.Profiler({ sampleInterval: 1, maxBufferSize: 1 << 20 }) : null; } catch (e) { log(`[RED] ownerprof: the Profiler did not start: ${(e as Error).message}`); }
    // the records one by one, timed by type (the owner's exec wrapper calls execInner instead of the replayer's own exec while this is set)
    const raw = owner.rawExec, byOp = new Map<number, C>();
    if (raw) owner.execInner = (p: number, n: number) => {
      const dv = new DataView(host.memory.buffer);
      for (let q2 = p, end = p + n; q2 < end;) {
        const op = dv.getUint32(q2, true), sz = dv.getUint32(q2 + 4, true);
        if (sz < 8) { raw(q2, end - q2); break; }
        const t = performance.now(); raw(q2, sz); const ms = performance.now() - t;
        let c = byOp.get(op); if (!c) byOp.set(op, c = { count: 0, ms: 0, bytes: 0 }); c.count++; c.ms += ms; c.bytes += sz; q2 += sz;
      }
    };
    const gpu = new Map<string, C>(), undo: (() => void)[] = [];
    for (const iface of IFACES) {
      const proto = G[iface]?.prototype; if (!proto) continue;
      for (const k of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, k)!; if (k === "constructor" || typeof d.value !== "function") continue;
        const orig = d.value, c: C = { count: 0, ms: 0, bytes: 0 }; gpu.set(`${iface.slice(3)}.${k}`, c);
        const bytes = k === "writeBuffer" ? (a: any[]) => a[4] !== undefined ? a[4] * (a[2].BYTES_PER_ELEMENT || 1) : a[2].byteLength - (a[3] || 0) * (a[2].BYTES_PER_ELEMENT || 1) : k === "writeTexture" ? (a: any[]) => a[1].byteLength - (a[2]?.offset || 0) : null;
        Object.defineProperty(proto, k, { ...d, value: function (this: any, ...a: any[]) { c.count++; if (bytes) c.bytes += bytes(a); const t = performance.now(); try { return orig.apply(this, a); } finally { c.ms += performance.now() - t; } } });
        undo.push(() => Object.defineProperty(proto, k, d));
      }
    }
    const s0 = { ...host.stats }, p0 = presents, t0 = performance.now();
    log(`ownerprof: started at present ${presents}${prof ? "" : " (no sampling profiler: records and WebGPU methods only)"}`);
    await new Promise(res => setTimeout(res, secs * 1000));
    const trace = prof ? await prof.stop().catch((e: any) => { log(`[RED] ownerprof: Profiler.stop: ${e?.message ?? e}`); return null; }) : null;
    owner.execInner = undefined; for (const u of undo) u(); done = true; started = false;
    const wall = performance.now() - t0, np = Math.max(1, presents - p0), per = (v: number) => +(v / np).toFixed(3);
    const stats: any = {}; for (const k of Object.keys(host.stats)) if (typeof host.stats[k] === "number" && typeof s0[k] === "number") stats[k] = per(host.stats[k] - s0[k]);
    const out: any = { name, wallMs: +wall.toFixed(1), presents: presents - p0, msPerPresent: per(wall), stats,
      pipelines: { sync: stats.pipelinesSync, async: stats.pipelinesAsync, failed: stats.pipelinesFailed, note: "per present" },
      records: [...byOp].map(([op, c]) => ({ op, name: host.opName?.(op) ?? String(op), count: per(c.count), ms: per(c.ms), kb: per(c.bytes / 1024) })).sort((a, b) => b.ms - a.ms),
      webgpu: [...gpu].filter(([, c]) => c.count).map(([k, c]) => ({ method: k, count: per(c.count), ms: per(c.ms), kb: per(c.bytes / 1024) })).sort((a, b) => b.ms - a.ms) };
    if (trace) {
      const self = new Map<number, number>(), total = new Map<number, number>(), label = (f: any) => `${f.name || "(anonymous)"} ${f.resourceId !== undefined ? (trace.resources[f.resourceId] ?? "").split("/").pop() : ""}:${f.line ?? ""}`;
      let idle = 0;
      for (let i = 0; i < trace.samples.length; i++) {
        const s = trace.samples[i], dt = Math.min(10, (trace.samples[i + 1]?.timestamp ?? s.timestamp + 1) - s.timestamp);
        if (s.stackId === undefined) { idle += dt; continue; }
        const st = trace.stacks[s.stackId]; self.set(st.frameId, (self.get(st.frameId) ?? 0) + dt);
        const seen = new Set<number>(); for (let k: any = s.stackId; k !== undefined; k = trace.stacks[k].parentId) { const f = trace.stacks[k].frameId; if (!seen.has(f)) { seen.add(f); total.set(f, (total.get(f) ?? 0) + dt); } }
      }
      const top = (mp: Map<number, number>) => [...mp].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([f, ms]) => ({ fn: label(trace.frames[f]), ms: per(ms) }));
      out.profile = { samples: trace.samples.length, idleMs: per(idle), self: top(self), total: top(total) };
    }
    const body = JSON.stringify(out);
    fetch(`${to}/ownerprof-${name}.json`, { method: "POST", body }).then(() => log(`ownerprof: ownerprof-${name}.json posted (${body.length} bytes; ${out.presents} presents, ${out.msPerPresent} ms each)`), e => log(`[RED] ownerprof: not posted to ${to}: ${e?.message ?? e}`));
  };
}
