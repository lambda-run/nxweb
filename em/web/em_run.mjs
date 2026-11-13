// node web/em_run.mjs [seconds] [name]: the Emscripten runtime's page (http://localhost:8080/em/index.html) in headless Chromium
// with the real game: the .nup is given to the page's file input over CDP (as /ctl/headless/run.mjs does for the
// AssemblyScript page), the page's console goes to logs/<name>.console.txt, one status line every 10 s to stdout,
// a screenshot to logs/<name>.png at the end. Stops early when the browser's memory passes LIMIT_MB (the VM is shared).
// Environment: GAME (/gamefs/zelda-oot.nup), PROFILE (build/profile: its own, so the AssemblyScript runs' profile is
// not touched; shaders are translated again in it once), URL, LIMIT_MB (6500), KEEP=1 (leave the browser up).
import { launch, evaluate } from "/ctl/headless/cdp.mjs";
import { readFileSync, readdirSync, writeFileSync, appendFileSync, openSync, readSync, closeSync } from "node:fs";
const secs = Number(process.argv[2] ?? 300), name = process.argv[3] ?? "em", L = "/ctl/nxweb-em/em/logs";
const profile = process.env.PROFILE ?? "/ctl/nxweb-em/em/build/profile", game = process.env.GAME ?? "/gamefs/zelda-oot.nup";
const url = process.env.URL ?? `http://localhost:8080/em/index.html?secs=${secs + 600}`, limit = Number(process.env.LIMIT_MB ?? 6500);
const con = `${L}/${name}.console.txt`; writeFileSync(con, "");
const { child, cdp } = await launch({ profile, port: 9447, log: `${L}/${name}.chromium.log` });
const pss = () => { let kb = 0;
  for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue;
    try { if (!readFileSync(`/proc/${d}/cmdline`, "utf8").includes(profile)) continue; kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${d}/smaps_rollup`, "utf8"))[1]); } catch { /* gone */ } }
  return Math.round(kb / 1024); };
// Where the memory is (MEM=0: off): every Chromium process by type with resident + swapped MB, and for the big renderer
// its mappings by kind (the 16 GB wasm memory, executable = compiled code, the rest by name) and the wasm memory's
// pages by GB of address (resident + swapped, from /proc/<pid>/pagemap). The guest threads' workers are threads of
// that one renderer, so "per worker" is the page's own counters (the [dm] thread tables line), not a process number.
const memProbe = (deep) => { const out = [];
  for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue;
    try { const cl = readFileSync(`/proc/${d}/cmdline`, "utf8"); if (!cl.includes(profile)) continue;
      const type = (/--type=([\w-]+)/.exec(cl) ?? [0, "browser"])[1], roll = readFileSync(`/proc/${d}/smaps_rollup`, "utf8"), kb = (k) => Number((new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(roll) ?? [0, 0])[1]);
      const p = { pid: d, type, rss: kb("Rss") >> 10, pss: kb("Pss") >> 10, swap: kb("Swap") >> 10 };
      if (p.rss + p.swap < 8) continue;
      if (deep && p.rss + p.swap > 400) { const kinds = new Map(); let cur = null, big = null;
        for (const l of readFileSync(`/proc/${d}/smaps`, "utf8").split("\n")) { const m = /^([0-9a-f]+)-([0-9a-f]+) (\S+) \S+ \S+ \S+\s*(.*)$/.exec(l);
          if (m) { const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), size = hi - lo, nm = m[4];
            const kind = size >= 2 ** 32 ? `reservation of ${Math.round(size / 2 ** 30)} GB ${m[3]} at ${m[1]}` : m[3].includes("x") && (!nm || nm.startsWith("[anon")) ? "executable anonymous (compiled code)" : nm.startsWith("/") ? "files (binaries, fonts, shm)" : nm ? nm.replace(/\d+/g, "N") : `anonymous ${m[3]} ${size >= 256 << 20 ? ">=256 MB" : size >= 32 << 20 ? "32-256 MB" : size >= 4 << 20 ? "4-32 MB" : size >= 1 << 20 ? "1-4 MB" : size >= 1 << 18 ? "256 KB-1 MB" : "<256 KB"}`;
            cur = kinds.get(kind); if (!cur) kinds.set(kind, cur = { n: 0, kb: 0 }); cur.n++; if (size >= 2 ** 32) { cur.lo = lo; cur.size = size; } }
          else { const r = /^(Rss|Swap):\s+(\d+)/.exec(l); if (r && cur) cur.kb += Number(r[2]); } }
        p.kinds = [...kinds].filter(([, v]) => v.kb >= 8192).sort((a, b) => b[1].kb - a[1].kb).map(([k, v]) => `${k} x${v.n}: ${v.kb >> 10}`);
        for (const v of kinds.values()) if (v.size && (!big || v.kb > big.kb)) big = v;   // the wasm memory: the large reservation with the most in it
        if (big && big.kb > 65536) { big.size = Math.min(big.size, 17 * 2 ** 30); try { const fd = openSync(`/proc/${d}/pagemap`, "r"), gb = [], buf = Buffer.alloc(8 << 20); const first = big.lo / 4096, pages = big.size / 4096;
            for (let at = 0; at < pages; at += buf.length / 8) { const n = readSync(fd, buf, 0, Math.min(buf.length, (pages - at) * 8), (first + at) * 8); for (let i = 7; i < n; i += 8) if (buf[i] & 0xC0) { const g = Math.floor((at + (i >> 3)) / 262144); gb[g] = (gb[g] ?? 0) + 1; } }
            closeSync(fd); p.wasmByGB = Array.from(gb, v => Math.round((v ?? 0) / 256)).join(" "); } catch (e) { p.wasmByGB = "no pagemap: " + e.message; } } }
      out.push(p); } catch { /* gone */ } }
  return out.sort((a, b) => b.rss + b.swap - a.rss - a.swap); };
const memLine = (deep) => { const ps = memProbe(deep); let s = "mem (MB resident+swapped): " + ps.map(p => `${p.type} ${p.rss}+${p.swap}`).join(", ") + `; total ${ps.reduce((a, p) => a + p.pss + p.swap, 0)} (pss+swap)`;
  for (const p of ps) { if (p.kinds) s += `\n  ${p.type} ${p.pid}: ` + p.kinds.join("; "); if (p.wasmByGB) s += `\n  ${p.type} ${p.pid}: the largest reservation by GB of address, MB resident+swapped: ${p.wasmByGB}`; }
  return s; };
let crashed = false;
cdp.on((method, p) => {
  if (method === "Runtime.consoleAPICalled") appendFileSync(con, p.args.map(a => a.value ?? a.description ?? "").join(" ") + "\n");
  else if (method === "Runtime.exceptionThrown") appendFileSync(con, "[RED] exception: " + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split("\n")[0] + "\n");
  else if (method === "Inspector.targetCrashed") { crashed = true; appendFileSync(con, "[RED] the tab crashed\n"); }
  else if (method === "Target.attachedToTarget") { cdp.send("Runtime.enable", {}, p.sessionId).catch(() => {}); }
});
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Runtime.enable", {}, sessionId); await cdp.send("Inspector.enable", {}, sessionId); await cdp.send("DOM.enable", {}, sessionId); await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
await cdp.send("Page.navigate", { url }, sessionId);
let result = {};   // (a loaded machine takes longer than the 2.5 s this waited once: looked for up to 40 s)
for (let i = 0; i < 16 && !result.objectId; i++) { await new Promise(r => setTimeout(r, 2500)); try { ({ result } = await cdp.send("Runtime.evaluate", { expression: `document.getElementById("fileinput")` }, sessionId)); } catch { /* not there yet */ } }
if (!result.objectId) { try { child.kill("SIGKILL"); } catch { /* gone */ } throw new Error("em_run: the page has no #fileinput (did it load? " + url + ")"); }
await cdp.send("DOM.setFileInputFiles", { files: [game], objectId: result.objectId }, sessionId);
console.log(`em_run: ${url} with ${game}`);
const t0 = Date.now(); let how = "time", last = null;
// KEYS="60:KeyZ,65:Enter,70-200/10:KeyZ": key presses for the page (em.html: Z/X/C/V = A/B/X/Y, Enter = +, Backspace = -),
// at a second after the file was given, or from-to/every; each is held 250 ms, or KeyZ*2000: for 2 s (a game at 1 frame a second misses a short press)
// SHOTS="100,150": the canvas as a PNG (logs/<name>.p<N>.png) when the present count first reaches N (looked at 4 times a second)
for (const item of (process.env.KEYS ?? "").split(",").filter(x => x)) { const [when, code0] = item.split(":"), [code, holdMs] = code0.split("*"), hold = Number(holdMs ?? 250), m = /^(\d+)-(\d+)\/(\d+)$/.exec(when), ts = [];
  if (m) for (let t = Number(m[1]); t <= Number(m[2]); t += Number(m[3])) ts.push(t); else ts.push(Number(when));
  const key = code === "Enter" ? "Enter" : code === "Backspace" ? "Backspace" : code.replace(/^Key/, "").toLowerCase(), vk = code === "Enter" ? 13 : code === "Backspace" ? 8 : code.charCodeAt(code.length - 1);
  for (const t of ts) setTimeout(async () => { try { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk }, sessionId); await new Promise(r => setTimeout(r, hold)); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk }, sessionId); appendFileSync(con, `[em_run] key ${code} at ${t} s\n`); } catch (e) { appendFileSync(con, `[em_run] key ${code}: ${e.message}\n`); } }, t * 1000); }
const shots = (process.env.SHOTS ?? "").split(",").filter(x => x).map(Number).sort((a, b) => a - b); let shotBusy = false;
const shotTimer = shots.length ? setInterval(async () => { if (shotBusy || !shots.length) return; shotBusy = true;
  try { const n = Number(await evaluate(cdp, sessionId, `nxem.presents`)); if (n >= shots[0]) { const want = shots.shift();
      const d = await evaluate(cdp, sessionId, `new Promise(res => requestAnimationFrame(() => { try { res(nxem.presents + "|" + document.getElementById("screen").toDataURL("image/png")); } catch (e) { res("0|error " + e.message); } }))`);
      const i = d.indexOf("|"), b = d.slice(i + 1); if (b.startsWith("data:image/png;base64,")) { writeFileSync(`${L}/${name}.p${want}.png`, Buffer.from(b.slice(22), "base64")); appendFileSync(con, `[em_run] shot for present ${want} taken at present ${d.slice(0, i)}, ${Math.round((Date.now() - t0) / 1000)} s\n`); } else appendFileSync(con, `[em_run] shot ${want}: ${b.slice(0, 80)}\n`); } } catch { /* busy */ }
  shotBusy = false; }, 250) : null;
while (Date.now() - t0 < secs * 1000) {
  await new Promise(r => setTimeout(r, 10000));
  if (crashed) { how = "the tab crashed"; break; }
  let s; try { s = await evaluate(cdp, sessionId, `JSON.stringify({ state: nxem.state, presents: nxem.presents, fps: nxem.fps, threads: nxem.threads, label: nxem.label, red: nxem.red() })`); } catch (e) { s = JSON.stringify({ error: String(e.message).slice(0, 80) }); }
  const mb = pss(); last = s;
  console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${s}  browser ${mb} MB`);
  if (process.env.MEM !== "0" && Math.round((Date.now() - t0) / 10000) % 6 === 0) console.log(memLine(true));
  if (mb > limit) { how = `browser memory ${mb} MB over the limit of ${limit} MB`; break; }
  if (/"state":"(aborted|exited)"/.test(s)) { how = "the runtime ended"; break; }
}
if (process.env.MEM !== "0" && !crashed) { try { console.log(memLine(true)); } catch (e) { console.log("em_run: mem: " + e.message); } }
// Chromium's own accounting (MEMINFRA=1): one memory-infra dump through the browser's tracing; for the process with the
// most in it, the allocators by size (PartitionAlloc's partitions, malloc, V8 by isolate where the isolate answers:
// a worker that is blocked or running wasm does not).
if (process.env.MEMINFRA && !crashed) { try {
  const ev = []; let done; const fin = new Promise(r => { done = r; });
  cdp.on((method, p) => { if (method === "Tracing.dataCollected") ev.push(...p.value); else if (method === "Tracing.tracingComplete") done(); });
  await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], excludedCategories: ["*"], memoryDumpConfig: { triggers: [] } }, transferMode: "ReportEvents" });
  const r = await Promise.race([cdp.send("Tracing.requestMemoryDump", { levelOfDetail: "detailed" }), new Promise(res => setTimeout(() => res({ timeout: true }), 90000))]);
  await cdp.send("Tracing.end"); await Promise.race([fin, new Promise(res => setTimeout(res, 30000))]);
  const by = new Map();
  for (const e of ev) { const al = e.args?.dumps?.allocators; if (!al) continue; let m = by.get(e.pid); if (!m) by.set(e.pid, m = new Map());
    for (const [name, v] of Object.entries(al)) { const sz = v.attrs?.size ?? v.attrs?.effective_size; if (!sz) continue; const key = name.replace(/0x[0-9a-fA-F]+/g, "N").split("/").slice(0, 3).join("/"); const depth = name.split("/").length; const o = m.get(key) ?? { mb: 0, depth: 99, n: 0 }; const mb = parseInt(sz.value, 16) / 1048576; if (depth < o.depth) { o.mb = mb; o.depth = depth; o.n = 1; } else if (depth === o.depth) { o.mb += mb; o.n++; } m.set(key, o); } }
  let best = null; for (const [pid, m] of by) { const t = [...m].filter(([k]) => !k.includes("/")).reduce((a, [, v]) => a + v.mb, 0); if (!best || t > best.t) best = { pid, m, t }; }
  console.log(`em_run: memory-infra dump ${JSON.stringify(r).slice(0, 80)}; ${ev.length} events, ${by.size} processes`);
  if (best) console.log(`  pid ${best.pid}, allocators over 8 MB (MB, xN = entries summed): ` + [...best.m].filter(([, v]) => v.mb >= 8).sort((a, b) => b[1].mb - a[1].mb).slice(0, 40).map(([k, v]) => `${k} ${Math.round(v.mb)}${v.n > 1 ? " x" + v.n : ""}`).join("; "));
} catch (e) { console.log("em_run: memory-infra: " + String(e.message).slice(0, 200)); } }
// the picture itself, two ways: the canvas as the page sees it, and the replayer's own frame capture (its last pass's target)
if (shotTimer) clearInterval(shotTimer);
// (after a crash the page answers nothing: the pictures are not asked for, and nothing below may wait for ever)
setTimeout(() => { console.log(`em_run: ended (${how}; the pictures at the end did not come back within 90 s)`); try { child.kill("SIGKILL"); } catch { /* gone */ } process.exit(0); }, 90000).unref();
if (!crashed) try {
  const d = await evaluate(cdp, sessionId, `new Promise(res => requestAnimationFrame(() => { try { res(document.getElementById("screen").toDataURL("image/png")); } catch (e) { res("error " + e.message); } }))`);
  if (d.startsWith("data:image/png;base64,")) writeFileSync(`${L}/${name}.canvas.png`, Buffer.from(d.slice(22), "base64")); else console.log("em_run: canvas: " + d.slice(0, 80));
  const c = await evaluate(cdp, sessionId, `(async () => { const g = globalThis.NXOWNER && NXOWNER.gfx; if (!g || !g.live) return JSON.stringify({ none: true });
    const c = await Promise.race([g.captureFrame({ png: true }), new Promise(r => setTimeout(() => r(null), 20000))]); if (!c) return JSON.stringify({ timeout: true });
    const im = c.images[c.images.length - 1]; let b64 = ""; if (im && im.png) { let s = ""; for (const v of im.png) s += String.fromCharCode(v); b64 = btoa(s); }
    return JSON.stringify({ passes: c.passes, draws: c.draws, images: c.images.length, name: im && im.name, w: im && im.width, h: im && im.height, b64, text: c.text.split("\\n").slice(0, 6).join(" | ") }); })()`);
  const j = JSON.parse(c);
  if (j.b64) writeFileSync(`${L}/${name}.frame.png`, Buffer.from(j.b64, "base64"));
  console.log(`em_run: frame capture: ${JSON.stringify({ ...j, b64: j.b64 ? j.b64.length + " chars" : "" }).slice(0, 400)}`);
} catch (e) { console.log("em_run: no capture: " + String(e.message).slice(0, 200)); }
if (!crashed) try { const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); writeFileSync(`${L}/${name}.png`, Buffer.from(shot.data, "base64")); } catch (e) { console.log("em_run: no screenshot: " + e.message); }
console.log(`em_run: ended (${how}); last ${last}; console in ${con}, screenshot ${L}/${name}.png`);
if (!process.env.KEEP) { cdp.close(); child.kill("SIGKILL"); }
process.exit(0);
