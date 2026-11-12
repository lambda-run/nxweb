// node audio/audio_headless.mjs [seconds] [name]: the em page in headless Chromium with the real game (as web/em_run.mjs:
// /ctl/headless/cdp.mjs's flags, which include --autoplay-policy=no-user-gesture-required), watching the audio output:
// one line of nxemAudio.status() every 10 s to stdout, and at the end what the worklet itself put out during the last
// REC seconds (AudioDeviceMain.record / dump) as logs/<name>.wav with its peak and the share of frames that are not silence.
// The page's console goes to logs/<name>.console.txt. Environment: GAME, PROFILE, URL, LIMIT_MB, REC (5), QUERY (extra query, e.g. audiotone=440:
// the sink's test tone, whose breaks in the worklet's output are then counted).
import { launch, evaluate } from "/ctl/headless/cdp.mjs";
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
const secs = Number(process.argv[2] ?? 200), name = process.argv[3] ?? "audio_headless", L = "/ctl/nxweb-em/em/logs", rec = Number(process.env.REC ?? 5);
const profile = process.env.PROFILE ?? "/ctl/nxweb-em/em/build/profile", game = process.env.GAME ?? "/gamefs/zelda-oot.nup";
const url = process.env.URL ?? `http://localhost:8080/em/index.html?secs=${secs + 600}&audiolog=1${process.env.QUERY ? "&" + process.env.QUERY : ""}`, limit = Number(process.env.LIMIT_MB ?? 6500);
const con = `${L}/${name}.console.txt`; writeFileSync(con, "");
const { child, cdp } = await launch({ profile, port: 9448, log: `${L}/${name}.chromium.log` });
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
if (!result.objectId) throw new Error("audio_headless: the page has no #fileinput (did it load? " + url + ")");
await cdp.send("DOM.setFileInputFiles", { files: [game], objectId: result.objectId }, sessionId);
console.log(`audio_headless: ${url} with ${game}`);
const t0 = Date.now(); let how = "time", last = "", recording = false;
const status = `(() => { const s = nxemAudio.status(); const r = v => typeof v === "number" ? Math.round(v * 100) / 100 : v; const o = { presents: nxem.presents, line: document.getElementById("audio").textContent, hint: !document.getElementById("audiohint").hidden };
  for (const k of ["state", "context", "rate", "ringMs", "underrun", "overrun", "discarded", "callbacksPerSecond", "framesPerSecond", "nonSilent", "peak", "devicePaced", "fillMinMs", "fillMaxMs", "error"]) o[k] = r(s[k]); return JSON.stringify(o); })()`;
while (Date.now() - t0 < secs * 1000) {
  await new Promise(r => setTimeout(r, 10000));
  if (crashed) { how = "the tab crashed"; break; }
  let s; try { s = await evaluate(cdp, sessionId, status); } catch (e) { s = JSON.stringify({ error: String(e.message).slice(0, 120) }); }
  const mb = pss(); last = s;
  console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${s}  browser ${mb} MB`);
  if (mb > limit) { how = `browser memory ${mb} MB over the limit of ${limit} MB`; break; }
  if (/"state":"(aborted|exited)"/.test(await evaluate(cdp, sessionId, `JSON.stringify({ state: nxem.state })`).catch(() => ""))) { how = "the runtime ended"; break; }
  // the worklet records its own output for the last REC seconds of the run
  if (!recording && Date.now() - t0 >= (secs - rec - 12) * 1000) { recording = true; try { await evaluate(cdp, sessionId, `(() => { const d = nxemAudio.device(); if (!d || !d.node) return "no device"; d.record(${rec} * d.ctx.sampleRate); return "recording"; })()`).then(r => console.log("audio_headless: " + r)); } catch (e) { console.log("audio_headless: no recording: " + e.message); } }
}
try {
  const j = JSON.parse(await evaluate(cdp, sessionId, `(async () => { const d = nxemAudio.device(); if (!d || !d.node) return JSON.stringify({ none: true });
    const x = await Promise.race([d.dump(), new Promise(r => setTimeout(() => r(null), 10000))]); if (!x) return JSON.stringify({ timeout: true });
    const n = x.frames, pcm = new Int16Array(n * 2); let peak = 0, loud = 0, breaks = -1;
    const tone = Number(new URLSearchParams(location.search).get("audiotone"));   // a sine continues as x[n+1] = 2cos(w)x[n] - x[n-1]: every sample that does not is a break
    if (tone) { breaks = 0; const c2 = 2 * Math.cos(2 * Math.PI * tone / x.sampleRate); for (let i = 2; i < n; i++) if (Math.abs(x.dump[2 * i] - (c2 * x.dump[2 * i - 2] - x.dump[2 * i - 4])) > 0.01) breaks++; }
    for (let i = 0; i < n; i++) { const l = x.dump[2 * i], r = x.dump[2 * i + 1], a = Math.max(Math.abs(l), Math.abs(r)); if (a > peak) peak = a; if (a > 1e-4) loud++; pcm[2 * i] = Math.max(-32768, Math.min(32767, l * 32767)); pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, r * 32767)); }
    const u8 = new Uint8Array(pcm.buffer); let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return JSON.stringify({ frames: n, rate: x.sampleRate, peak, loud, toneBreaks: breaks, underrun: x.underrun, callbacks: x.callbacks, b64: btoa(s) }); })()`));
  if (j.b64) {
    const pcm = Buffer.from(j.b64, "base64"), hd = Buffer.alloc(44);
    hd.write("RIFF", 0); hd.writeUInt32LE(36 + pcm.length, 4); hd.write("WAVEfmt ", 8); hd.writeUInt32LE(16, 16); hd.writeUInt16LE(1, 20); hd.writeUInt16LE(2, 22);
    hd.writeUInt32LE(j.rate, 24); hd.writeUInt32LE(j.rate * 4, 28); hd.writeUInt16LE(4, 32); hd.writeUInt16LE(16, 34); hd.write("data", 36); hd.writeUInt32LE(pcm.length, 40);
    writeFileSync(`${L}/${name}.wav`, Buffer.concat([hd, pcm]));
  }
  console.log(`audio_headless: the worklet's own output: ${JSON.stringify({ ...j, b64: j.b64 ? `${L}/${name}.wav` : "" })}`);
} catch (e) { console.log("audio_headless: no dump: " + String(e.message).slice(0, 200)); }
try { const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); writeFileSync(`${L}/${name}.png`, Buffer.from(shot.data, "base64")); } catch (e) { console.log("audio_headless: no screenshot: " + e.message); }
console.log(`audio_headless: ended (${how}); last ${last}; console in ${con}`);
if (!process.env.KEEP) { cdp.close(); child.kill("SIGKILL"); }
process.exit(0);
