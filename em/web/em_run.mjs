// node web/em_run.mjs [seconds] [name]: the Emscripten runtime's page (http://localhost:8080/em/index.html) in headless Chromium
// with the real game: the .nup is given to the page's file input over CDP (as /ctl/headless/run.mjs does for the
// AssemblyScript page), the page's console goes to logs/<name>.console.txt, one status line every 10 s to stdout,
// a screenshot to logs/<name>.png at the end. Stops early when the browser's memory passes LIMIT_MB (the VM is shared).
// Environment: GAME (/gamefs/zelda-oot.nup), PROFILE (build/profile: its own, so the AssemblyScript runs' profile is
// not touched; shaders are translated again in it once), URL, LIMIT_MB (6500), KEEP=1 (leave the browser up).
import { launch, evaluate } from "/ctl/headless/cdp.mjs";
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
const secs = Number(process.argv[2] ?? 300), name = process.argv[3] ?? "em", L = "/ctl/nxweb-em/em/logs";
const profile = process.env.PROFILE ?? "/ctl/nxweb-em/em/build/profile", game = process.env.GAME ?? "/gamefs/zelda-oot.nup";
const url = process.env.URL ?? `http://localhost:8080/em/index.html?secs=${secs + 600}`, limit = Number(process.env.LIMIT_MB ?? 6500);
const con = `${L}/${name}.console.txt`; writeFileSync(con, "");
// (this VM boot: the default flags of cdp.mjs, ANGLE on Vulkan, give no adapter; ANGLE on SwiftShader does)
if (!process.env.GPU_FLAGS) process.env.GPU_FLAGS = "--enable-unsafe-webgpu --ignore-gpu-blocklist --disable-gpu-sandbox --use-webgpu-adapter=swiftshader --use-angle=swiftshader --enable-features=Vulkan";
const { child, cdp } = await launch({ profile, port: 9447, log: `${L}/${name}.chromium.log` });
const pss = () => { let kb = 0;
  for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue;
    try { if (!readFileSync(`/proc/${d}/cmdline`, "utf8").includes(profile)) continue; kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${d}/smaps_rollup`, "utf8"))[1]); } catch { /* gone */ } }
  return Math.round(kb / 1024); };
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
await new Promise(r => setTimeout(r, 2500));
const { result } = await cdp.send("Runtime.evaluate", { expression: `document.getElementById("fileinput")` }, sessionId);
if (!result.objectId) throw new Error("em_run: the page has no #fileinput (did it load? " + url + ")");
await cdp.send("DOM.setFileInputFiles", { files: [game], objectId: result.objectId }, sessionId);
console.log(`em_run: ${url} with ${game}`);
const t0 = Date.now(); let how = "time", last = null;
while (Date.now() - t0 < secs * 1000) {
  await new Promise(r => setTimeout(r, 10000));
  if (crashed) { how = "the tab crashed"; break; }
  let s; try { s = await evaluate(cdp, sessionId, `JSON.stringify({ state: nxem.state, presents: nxem.presents, fps: nxem.fps, threads: nxem.threads, label: nxem.label, red: nxem.red() })`); } catch (e) { s = JSON.stringify({ error: String(e.message).slice(0, 80) }); }
  const mb = pss(); last = s;
  console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${s}  browser ${mb} MB`);
  if (mb > limit) { how = `browser memory ${mb} MB over the limit of ${limit} MB`; break; }
  if (/"state":"(aborted|exited)"/.test(s)) { how = "the runtime ended"; break; }
}
// the picture itself, two ways: the canvas as the page sees it, and the replayer's own frame capture (its last pass's target)
try {
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
try { const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); writeFileSync(`${L}/${name}.png`, Buffer.from(shot.data, "base64")); } catch (e) { console.log("em_run: no screenshot: " + e.message); }
console.log(`em_run: ended (${how}); last ${last}; console in ${con}, screenshot ${L}/${name}.png`);
if (!process.env.KEEP) { cdp.close(); child.kill("SIGKILL"); }
process.exit(0);
