// node em/tools/chrome_costs.mjs (in the VM): what two things cost in headless Chromium's renderer, measured without the
// game: a function-table slot (the port: one table per guest thread), and a compiled module handed to a worker that
// never instantiates it (the port hands every worker the whole translation cache's modules). Resident + swapped MB of
// the renderer from /proc before and after.
import { launch, evaluate } from "/ctl/headless/cdp.mjs";
import { readFileSync, readdirSync } from "node:fs";
const profile = "/tmp/nxem-costs-profile";
const { child, cdp } = await launch({ profile, port: 9461, log: "/tmp/nxem-costs.log" });
const { targetId } = await cdp.send("Target.createTarget", { url: "http://localhost:8080/em/build.json" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Runtime.enable", {}, sessionId);
await new Promise(r => setTimeout(r, 1500));
const mem = () => { let best = 0;
  for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue;
    try { const cl = readFileSync(`/proc/${d}/cmdline`, "utf8"); if (!cl.includes(profile) || !cl.includes("--type=renderer")) continue;
      const roll = readFileSync(`/proc/${d}/smaps_rollup`, "utf8"), kb = (k) => Number(new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(roll)[1]); best = Math.max(best, (kb("Rss") + kb("Swap")) / 1024); } catch { /* gone */ } }
  return best; };
const settle = () => new Promise(r => setTimeout(r, 1500));
const m0 = mem();
await evaluate(cdp, sessionId, `(() => { const T = new Uint8Array([0,0x61,0x73,0x6D,1,0,0,0,1,4,1,0x60,0,0,3,2,1,0,7,5,1,1,0x66,0,0,0x0A,4,1,2,0,0x0B]);
  const f = new WebAssembly.Instance(new WebAssembly.Module(T)).exports.f; globalThis.keep = [];
  for (let i = 0; i < 8; i++) { const t = new WebAssembly.Table({ element: "anyfunc", initial: 2 }); t.grow(1000000, f); keep.push(t); } return 1; })()`);
await settle(); const m1 = mem();
console.log(`function table: 8 tables x 1,000,000 slots = ${(m1 - m0).toFixed(0)} MB: ${((m1 - m0) * 1048576 / 8e6).toFixed(1)} bytes a slot`);
// 4000 different small modules (one function each, a different constant), compiled once, posted to W workers
const W = 16, NM = 4000;
await evaluate(cdp, sessionId, `(async () => { const mods = [];
  for (let i = 0; i < ${NM}; i++) { const b = new Uint8Array([0,0x61,0x73,0x6D,1,0,0,0,1,5,1,0x60,0,1,0x7F,3,2,1,0,7,5,1,1,0x66,0,0,0x0A,9,1,7,0,0x41,0x80 | (i & 127),0x80 | ((i >> 7) & 127),0x80 | ((i >> 14) & 127),0,0x0B]); mods.push(new WebAssembly.Module(b)); }
  globalThis.mods = mods; return mods.length; })()`);
await settle(); const m2 = mem();
await evaluate(cdp, sessionId, `(async () => { const src = "let got; onmessage = (e) => { if (e.data.mods) { got = e.data.mods; postMessage(got.length); } }"; const url = URL.createObjectURL(new Blob([src]));
  globalThis.ws = []; for (let i = 0; i < ${W}; i++) { const w = new Worker(url); ws.push(w); } await new Promise(r => setTimeout(r, 1500)); return 1; })()`);
await settle(); const m3 = mem();
await evaluate(cdp, sessionId, `(async () => { await Promise.all(ws.map(w => new Promise(r => { w.onmessage = r; w.postMessage({ mods }); }))); return 1; })()`);
await settle(); const m4 = mem();
console.log(`${NM} small modules compiled in the page: ${(m2 - m1).toFixed(0)} MB (${((m2 - m1) * 1024 / NM).toFixed(1)} KB each); ${W} idle workers: ${((m3 - m2) / W).toFixed(1)} MB each; `
  + `the ${NM} modules handed to each of them (not instantiated): ${((m4 - m3) / W).toFixed(1)} MB a worker = ${((m4 - m3) * 1048576 / W / NM).toFixed(0)} bytes per module and worker`);
cdp.close(); child.kill("SIGKILL"); process.exit(0);
