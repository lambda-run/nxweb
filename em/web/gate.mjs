// node web/gate.mjs '<args, comma separated>' [seconds]: runs build/web/p2 in headless Chromium (served by web/serve.mjs on
// 8091), prints the page's console lines, and at every "MARK" line the memory of the browser's processes (sum of Pss).
// Kills the browser when that sum passes LIMIT_MB (default 5000): the VM is shared.
import { launch } from "/ctl/headless/cdp.mjs";
import { readFileSync, readdirSync, rmSync } from "node:fs";
const args = process.argv[2] ?? "", secs = Number(process.argv[3] ?? 240), limit = Number(process.env.LIMIT_MB ?? 5000);
const profile = "/tmp/nxem-gate-profile"; rmSync(profile, { recursive: true, force: true });
const { child, cdp } = await launch({ profile, port: 9446, log: "/ctl/nxweb-em/em/logs/gate-chromium.log", extra: (process.env.EXTRA ?? "").split(/\s+/).filter(Boolean) });
const pss = () => { let kb = 0, n = 0;
  for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue;
    try { if (!readFileSync(`/proc/${d}/cmdline`, "utf8").includes(profile)) continue; kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${d}/smaps_rollup`, "utf8"))[1]); n++; } catch { /* gone */ } }
  return { mb: Math.round(kb / 1024), n }; };
let done = null; const finish = new Promise(r => done = r);
const line = (s) => { if (/^MARK/.test(s)) { const m = pss(); s += `   [browser memory ${m.mb} MB in ${m.n} processes]`; }
  console.log(s); if (/^P2 (PASS|FAIL)|^EXIT |abort:|page error|exception:/.test(s)) setTimeout(() => done(s), 300); };
cdp.on((method, p) => {
  if (method === "Runtime.consoleAPICalled") line(p.args.map(a => a.value ?? a.description ?? "").join(" "));
  else if (method === "Runtime.exceptionThrown") line("[RED] exception: " + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split("\n")[0]);
  else if (method === "Inspector.targetCrashed") { line("[RED] the tab crashed"); done("crash"); }
  else if (method === "Target.attachedToTarget") { cdp.send("Runtime.enable", {}, p.sessionId).catch(() => {}); cdp.send("Runtime.runIfWaitingForDebugger", {}, p.sessionId).catch(() => {}); }
});
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Runtime.enable", {}, sessionId); await cdp.send("Inspector.enable", {}, sessionId);
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);   // workers' consoles too
const t0 = Date.now();
await cdp.send("Page.navigate", { url: "http://localhost:8091/p2/index.html?args=" + encodeURIComponent(args) }, sessionId);
const watch = setInterval(() => { const m = pss(); if (m.mb > limit) { line(`[RED] browser memory ${m.mb} MB is over the limit of ${limit} MB: stopped`); done("limit"); } }, 1000);
const how = await Promise.race([finish, new Promise(r => setTimeout(() => r("timeout"), secs * 1000))]);
clearInterval(watch);
const m = pss();
console.log(`gate: ended (${String(how).slice(0, 40)}) after ${((Date.now() - t0) / 1000).toFixed(0)} s; browser memory at the end ${m.mb} MB`);
cdp.close(); child.kill("SIGKILL"); process.exit(/PASS/.test(String(how)) ? 0 : 1);
