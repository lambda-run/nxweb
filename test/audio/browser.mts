// npm run audio:browser [-- <filter>]: the audio device in headless Chromium (Playwright). A real AudioContext and
// AudioWorklet on the page, the audio module with a tone-playing "guest" in a Worker, and a recording made inside
// the worklet of what it put out. Pages are served from http://localhost, with COOP same-origin and COEP
// require-corp (cross-origin isolated: SharedArrayBuffer) or without (the message-fed worklet).
// Chromium is launched twice: with --autoplay-policy=no-user-gesture-required, and without it for the run that
// needs a user gesture before the context may start.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, WASM, FN, build } from "./harness.mts";

process.chdir(ROOT);
const OUT = join(ROOT, "build", "audio");
try {
  build();
  // the same module on an imported shared memory (its static data at 1 MB), as it will sit in a shared process memory
  execFileSync(process.execPath, [join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js"), "src/audio/index.ts", "-o", join(OUT, "audio.shared.wasm"), "--runtime", "stub", "-O2",
    "--importMemory", "--sharedMemory", "--maximumMemory", "65536", "--enable", "threads", "--zeroFilledMemory", "--memoryBase", "1048576"], { cwd: ROOT, stdio: "inherit" });
  mkdirSync(join(OUT, "web"), { recursive: true });
  for (const f of ["worker", "page"]) buildSync({ entryPoints: [`test/audio/web/${f}.ts`], bundle: true, format: "iife", outfile: `build/audio/web/${f}.js`, logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] audio:browser: the build failed"); process.exit(1); }

const { chromium } = createRequire(import.meta.url)("playwright");
const only = process.argv[2];
interface Cfg { shared: boolean; transport?: string; sampleRate?: number; targetFrames?: number; freq: number; amp: number; frames: number; inflight: number; tickMs: number; event: boolean }
const CFG: Cfg = { shared: false, freq: 440, amp: 0.5, frames: 240, inflight: 4, tickMs: 4, event: true };
let pageCfg: Cfg = CFG;   // what a page that runs by itself (?auto=) is given
const html = () => `<!doctype html><meta charset="utf-8"><title>nxweb audio tests</title><body style="margin:0"><div style="width:100vw;height:100vh">audio</div><script>window.NXFN=${JSON.stringify(FN)};window.NXCFG=${JSON.stringify(pageCfg)};</script><script src="/page.js"></script>`;
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  const base = { "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" };
  const send = (body: Buffer | string, type: string, head: Record<string, string> = { "Cross-Origin-Embedder-Policy": "require-corp" }) => { res.writeHead(200, { ...base, ...head, "Content-Type": type }); res.end(body); };
  try {
    if (url.split("?")[0] === "/iso") return send(html(), "text/html", iso);
    if (url === "/plain") return send(html(), "text/html", {});
    if (url === "/favicon.ico") { res.writeHead(204, base); res.end(); return; }
    if (url === "/page.js" || url === "/worker.js") return send(readFileSync(join(OUT, "web", url.slice(1))), "text/javascript");
    if (url === "/audio.wasm") return send(readFileSync(WASM), "application/wasm");
    if (url === "/audio.shared.wasm") return send(readFileSync(join(OUT, "audio.shared.wasm")), "application/wasm");
  } catch { /* 404 */ }
  res.writeHead(404, base); res.end("not found");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

let failed = 0, ran = 0;
// Every check of a case is made; the case fails with all that did not hold
let wrong: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) wrong.push(what); };
const near = (v: number, want: number, tol: number, what: string) => check(Math.abs(v - want) <= tol, `${what}: ${v}, expected ${want} +- ${tol}`);
function wav(file: string, pcm: number[], rate: number): void {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((v, i) => b.writeInt16LE(v, 44 + 2 * i));
  writeFileSync(file, b);
}

type Page = any;   // eslint-disable-line @typescript-eslint/no-explicit-any
type Case = { name: string; page: "/iso" | "/plain" | "/iso?auto=gesture"; cfg: Partial<Cfg>; run: (p: Page, info: { transport: string; isolated: boolean }, said: (tag: string, ms?: number) => Promise<any>) => Promise<string> };   // eslint-disable-line @typescript-eslint/no-explicit-any
const nx = <T,>(p: Page, f: string, ...args: unknown[]): Promise<T> => p.evaluate(([f, args]: [string, unknown[]]) => (window as any).nx[f](...args), [f, args]);   // eslint-disable-line @typescript-eslint/no-explicit-any
const ask = <T,>(p: Page, cmd: string, extra: Record<string, unknown> = {}): Promise<T> => nx<T>(p, "ask", cmd, extra);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(p: Page, what: string, f: (s: any) => boolean, ms = 3000): Promise<any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = Date.now();
  for (;;) { const s = await ask<any>(p, "stats"); if (f(s)) return s; if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms (output ${s.state}, context ${s.context})`); await sleep(20); }   // eslint-disable-line @typescript-eslint/no-explicit-any
}

// A tone for `seconds`, recorded in the worklet; what must hold for "arrived with the right frequency and without gaps"
async function tone(p: Page, seconds: number, rate: number, expect: { transport: string; isolated: boolean; shared: boolean }, wavName?: string, perSecond = 200): Promise<string> {
  await nx(p, "record", seconds + 1.5);
  const o = await ask<{ open: number; start: number }>(p, "guest");
  if (o.open !== 0 || o.start !== 0) throw new Error(`open ${o.open} start ${o.start}`);
  const live = await until(p, "the output goes Live", s => s.state === "Live");
  check(live.transport === expect.transport, `transport ${live.transport}, expected ${expect.transport}`);
  check(live.isolated === expect.isolated && live.sharedMemory === expect.shared, `isolated ${live.isolated}, shared memory ${live.sharedMemory}`);
  check(live.rate === rate && (await nx<number>(p, "contextRate")) === rate, `device rate ${live.rate}`);
  await sleep(seconds * 1000);
  const s = await ask<any>(p, "stop");   // eslint-disable-line @typescript-eslint/no-explicit-any
  await sleep(250);                       // what is still in the ring plays out
  const h = await nx<any>(p, "heard", CFG.freq, [], !!wavName);   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (wavName) { wav(join(OUT, wavName), h.pcm, h.rate); }
  // w: the sound without its first and last 50 ms (where an abrupt start and end ring in the resampler)
  const w = h.core, sounding = (h.whole.last - h.whole.first) / h.rate;
  check(sounding >= seconds - 0.1, `${sounding.toFixed(3)} s of sound for ${seconds} s of playing`);
  near(w.freq, CFG.freq, 0.05, "frequency by zero crossings");
  check(w.snr > 60, `the tone over the whole ${sounding.toFixed(2)} s fits a ${CFG.freq} Hz sine to ${w.snr.toFixed(1)} dB only`);
  near(w.amp, CFG.amp * 32767 / 32768, 0.001, "amplitude");
  check(w.gaps === 0, `${w.gaps} gaps, the longest ${w.longestGap} samples`);
  const slope = CFG.amp * 2 * Math.PI * CFG.freq / h.rate;
  check(w.maxStep <= slope * 1.02 + 1e-4, `a jump of ${w.maxStep} between two samples (a ${CFG.freq} Hz sine steps at most ${slope.toFixed(5)})`);
  check(h.channelsDiffer === 0, "left and right differ");
  check(h.stretches.length === 1, `${h.stretches.length} stretches of sound`);
  check(s.underruns === 0, `${s.underruns} underruns of the output`);
  check(h.underrun === 0 && s.ringUnder === 0, `the device ran dry for ${h.underrun} frames`);
  check(s.orderErrors === 0 && s.appended === s.reclaimed, `appended ${s.appended}, taken back ${s.reclaimed}, out of order ${s.orderErrors}`);
  check(s.refused === 0 && s.red.length === 0, `refused ${s.refused}, red: ${s.red.join(" | ")}`);
  near(s.reclaimed, (seconds + 0.25) * perSecond, 60, "buffers played");
  check(s.states.map((x: { s: string }) => x.s).join(" ") === "SilentStarting Live", `states ${s.states.map((x: { s: string }) => x.s).join(" ")}`);
  return `${sounding.toFixed(2)} s of ${w.freq.toFixed(2)} Hz at ${h.rate} Hz, ${w.snr.toFixed(1)} dB, no gap, ${s.reclaimed} buffers, ${h.callbacks} device callbacks, 0 underruns${wavName ? `; build/audio/${wavName}` : ""}`;
}

const autoplay: Case[] = [
  { name: "tone, ring in the process's own shared memory (the worklet reads the module's ring in place)", page: "/iso", cfg: { shared: true },
    run: (p) => tone(p, 5, 48000, { transport: "direct", isolated: true, shared: true }, "tone.wav") },
  { name: "tone, cross-origin isolated with an unshared process memory (a SharedArrayBuffer ring the tick copies into)", page: "/iso", cfg: {},
    run: (p) => tone(p, 5, 48000, { transport: "sab", isolated: true, shared: false }) },
  { name: "tone, not cross-origin isolated (no SharedArrayBuffer: the worklet is fed by messages)", page: "/plain", cfg: {},
    run: (p) => tone(p, 5, 48000, { transport: "message", isolated: false, shared: false }) },
  { name: "tone on a 44.1 kHz context (the module resamples 48000 -> 44100)", page: "/iso", cfg: { shared: true, sampleRate: 44100 },
    run: (p) => tone(p, 5, 44100, { transport: "direct", isolated: true, shared: true }) },
  { name: "tone for a game that polls (no release event), 10 ms buffers, three in flight", page: "/iso", cfg: { event: false, frames: 480, inflight: 3 },
    run: async (p) => { const note = await tone(p, 3, 48000, { transport: "sab", isolated: true, shared: false }, undefined, 100); return note; } },
  { name: "underrun: the game appends nothing for 300 ms: silence for that long, counted on the output; the device never starves, the output stays Live, the tone goes on", page: "/iso", cfg: { shared: true },
    run: async (p) => {
      await nx(p, "record", 4);
      await ask(p, "guest"); await until(p, "Live", s => s.state === "Live");
      await sleep(1000);
      await ask(p, "set", { appending: false }); await sleep(300); await ask(p, "set", { appending: true });
      await sleep(1000);
      const s = await ask<any>(p, "stop"); await sleep(250);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const h = await nx<any>(p, "heard", CFG.freq);   // eslint-disable-line @typescript-eslint/no-explicit-any
      check(h.stretches.length === 2, `${h.stretches.length} stretches of sound`);
      const [a, b] = h.stretches, gap = (b.from - a.to) / h.rate;
      near(gap, 0.29, 0.05, "the silence (300 ms less what the game still had queued)");
      for (const x of [a, b]) { check(x.snr > 60, `a stretch fits to ${x.snr.toFixed(1)} dB`); near(x.freq, 440, 0.2, "frequency"); check((x.to - x.from) / h.rate > 0.9, "a stretch is short"); }
      check(s.underruns > 10, `${s.underruns} underruns counted`);
      near(s.silenceBytes / 4 / 48000, gap, 0.02, "silence counted on the output");
      check(h.underrun === 0, `the device ran dry for ${h.underrun} frames`);
      check(s.states.map((x: { s: string }) => x.s).join(" ") === "SilentStarting Live", "the output left Live");
      check(s.orderErrors === 0 && s.appended === s.reclaimed && s.refused === 0, "buffers");
      return `${(a.to - a.from) / h.rate | 0}.${Math.round((a.to - a.from) / h.rate * 100) % 100} s of tone, ${(gap * 1000).toFixed(0)} ms of silence (${s.underruns} underruns, ${(s.silenceBytes / 192).toFixed(0)} ms counted), tone again; device underrun 0`;
    } },
  { name: "the run loop is away for 300 ms (a long slice: no tick): the device runs dry and counts it, nothing is taken for a stall, no buffer is lost, the tone comes back in phase with itself", page: "/iso", cfg: {},
    run: async (p) => {
      await nx(p, "record", 4);
      await ask(p, "guest"); await until(p, "Live", s => s.state === "Live");
      await sleep(1000);
      await ask(p, "busy", { ms: 300 });
      await sleep(1000);
      const s = await ask<any>(p, "stop"); await sleep(250);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const h = await nx<any>(p, "heard", CFG.freq);   // eslint-disable-line @typescript-eslint/no-explicit-any
      check(h.underrun > 0.2 * 48000 && h.underrun < 0.32 * 48000, `the device counted ${h.underrun} frames of underrun`);
      check(s.states.map((x: { s: string }) => x.s).join(" ") === "SilentStarting Live", `states ${s.states.map((x: { s: string }) => x.s).join(" ")}`);
      check(s.red.length === 0 && s.refused === 0, `red: ${s.red.join(" | ")}`);
      check(h.stretches.length === 2, `${h.stretches.length} stretches of sound`);
      const [a, b] = h.stretches;
      for (const x of [a, b]) { check(x.snr > 60, `a stretch fits to ${x.snr.toFixed(1)} dB`); near(x.freq, 440, 0.2, "frequency"); }
      check(s.underruns === 0, `${s.underruns} underruns of the output: the game was not asked for more than the device took`);
      check(s.orderErrors === 0 && s.appended === s.reclaimed, "buffers");
      return `device underrun ${(h.underrun / 48).toFixed(0)} ms, counted; output underruns 0; still Live; ${s.reclaimed} buffers, none lost`;
    } },
  { name: "the page is hidden and shown; then the browser suspends the context on its own: Suspended, SilentRetry, Live again, and the game's buffers keep coming back at 200 a second throughout", page: "/iso", cfg: { shared: true },
    run: async (p) => {
      await nx(p, "record", 8);
      await ask(p, "guest"); await until(p, "Live", s => s.state === "Live");
      await sleep(500);
      await nx(p, "setHidden", true);
      const hid = await until(p, "Suspended", s => s.state === "Suspended");
      await sleep(700);
      check((await nx<string>(p, "context")) === "suspended", "the context still runs while hidden");
      await nx(p, "setHidden", false);
      await until(p, "Live after show", s => s.state === "Live");
      await sleep(500);
      await nx(p, "suspendBehind");
      const lost = await until(p, "SilentRetry", s => s.state === "SilentRetry");
      const back = await until(p, "Live after the retry", s => s.state === "Live", 4000);
      await sleep(500);
      const s = await ask<any>(p, "stop"); await sleep(250);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const names = s.trace.join(" ");   // every transition of the output's machine, from the kit's trace
      check(names === "SilentStarting Live Suspended SilentStarting Live SilentRetry SilentStarting Live Stopped", `states ${names}`);
      const iRetry = s.states.findIndex((x: { s: string }) => x.s === "SilentRetry"), tRetry = s.states[iRetry].t, tAgain = s.states[iRetry + 1].t;
      near(tAgain - tRetry, 1000, 120, "the retry after the device was lost");
      // the pace: releases per 100 ms window over the whole run, device or not
      const rt: number[] = s.releaseTimes, t0 = rt[0], t1 = rt.at(-1)!;
      let worst = 99;
      for (let t = t0; t + 250 <= t1 - 100; t += 50) { const n = rt.filter(x => x >= t && x < t + 250).length; if (n < worst) worst = n; }
      near(rt.length / ((t1 - t0) / 1000), 200, 12, "buffers per second over the whole run");
      check(worst >= 30, `a quarter second with only ${worst} buffers released`);
      check(s.red.length === 1 && /the browser took the device away/.test(s.red[0]), `red: ${s.red.join(" | ")}`);
      check(s.orderErrors === 0 && s.appended === s.reclaimed && s.refused === 0, "buffers");
      const h = await nx<any>(p, "heard", CFG.freq);   // eslint-disable-line @typescript-eslint/no-explicit-any
      // three runs of continuous tone: before the page was hidden, between show and the loss, after the retry
      // (one more for each time the device ran dry while the context came back, which the device counts)
      const runs = h.runs.map((x: { snr: number; from: number; to: number }) => `${(x.from / h.rate).toFixed(3)}-${(x.to / h.rate).toFixed(3)} s ${x.snr.toFixed(0)} dB`).join(", ");
      check(h.underrun === 0 ? h.runs.length === 3 : h.runs.length >= 3, `${h.runs.length} runs of continuous tone (${runs}) with a device underrun of ${h.underrun} frames`);
      check(h.runs.every((x: { snr: number; freq: number }) => x.snr > 60 && Math.abs(x.freq - 440) < 0.5), `a run is not the tone: ${runs}`);
      void hid; void lost; void back;
      return `${names}; retry ${(tAgain - tRetry).toFixed(0)} ms after the loss; ${(rt.length / ((t1 - t0) / 1000)).toFixed(1)} buffers/s over ${((t1 - t0) / 1000).toFixed(1)} s, never fewer than ${worst} in 250 ms; ${h.runs.length} runs of clean tone, device underrun ${h.underrun} frames`;
    } },
  { name: "audio renderer: the renderer take-overs with an SDK in JavaScript: the host opens it for CPU / manual rendering, its render thread is paced by the device (one render per 5 ms block the worklet took), the DeviceSink of each command list reaches the worklet: the tone, no gap; close joins the thread", page: "/iso", cfg: { shared: true },
    run: async (p) => {
      const seconds = 3;
      await nx(p, "record", seconds + 1.5);
      const o = await ask<{ open: number }>(p, "renderer");
      check(o && o.open === 0, `OpenAudioRenderer ${JSON.stringify(o)}`);
      const live = await until(p, "the render sink's output goes Live", s => s.state === "Live");
      check(live.transport === "direct", `transport ${live.transport}`);
      await sleep(seconds * 1000);
      const s = await ask<any>(p, "renclose");   // eslint-disable-line @typescript-eslint/no-explicit-any
      await sleep(250);
      const h = await nx<any>(p, "heard", CFG.freq, [], false);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const w = h.core, sounding = (h.whole.last - h.whole.first) / h.rate, r = s.ren;
      check(r.closed && r.threadEnded && r.frames === 0 && s.state === "closed", `after the close: SDK closed ${r.closed}, render thread ended ${r.threadEnded}, ${r.frames} renderer calls in progress, the sink's output ${s.state}`);
      check(sounding >= seconds - 0.1, `${sounding.toFixed(3)} s of sound for ${seconds} s of playing`);
      near(w.freq, CFG.freq, 0.05, "frequency by zero crossings");
      near(w.amp, CFG.amp * 32767 / 32768, 0.001, "amplitude");
      // a Worker timer that came later than the ring's lead leaves a gap: the machine's, not the port's (as in the gesture case)
      const late = s.lateTicks.filter((t: { gap: number }) => t.gap >= 25).length;
      check(late > 0 || (w.snr > 60 && w.gaps === 0 && h.underrun === 0 && h.stretches.length === 1), `the tone fits a ${CFG.freq} Hz sine to ${w.snr.toFixed(1)} dB, ${w.gaps} gaps, ${h.stretches.length} stretches, device underrun ${h.underrun}; late ticks ${JSON.stringify(s.lateTicks)}`);
      check(h.channelsDiffer === 0, "left and right differ");
      // every render is one ExecuteAudioRendererRendering with its signal; about 200 a second, minus what the game's updates rendered themselves (catch-up frames)
      check(r.signals + r.catchups === r.renders && r.locks === r.renders, `renders ${r.renders}, renderer event signals ${r.signals}, catch-up renders ${r.catchups}, update lock taken ${r.locks}`);
      near(r.played, (seconds + 0.25) * 200, 80, "blocks played");
      check(s.refused === 0 && s.red.length === 0, `refused ${s.refused}, red: ${s.red.join(" | ")}`);
      return `${sounding.toFixed(2)} s of ${w.freq.toFixed(2)} Hz, ${w.snr.toFixed(1)} dB, ${w.gaps} gaps; ${r.renders} renders (${r.catchups} of them catch-up frames of ${r.updates} updates), ${r.played} blocks played, device underrun ${h.underrun}` + (late ? ` [${late} ticks 25 ms or more late: gap checks waived]` : "");
    } },
  { name: "Opus: a tone encoded by the browser's encoder goes through the hardware decoder manager on WebCodecs' AudioDecoder (asynchronous) and comes back as the tone", page: "/iso", cfg: {},
    run: async (p) => {
      const r = await ask<any>(p, "opus");   // eslint-disable-line @typescript-eslint/no-explicit-any
      if (r.skipped) return "SKIPPED: " + r.skipped;
      check(!r.error, `failed at ${r.error}`);
      check(r.frames === r.packets && r.frames >= 50, `${r.frames} frames for ${r.packets} packets`);
      check(r.samples === r.frames * 960, `${r.samples} samples`);
      check(r.red.length === 0 && r.refused === 0, `red: ${r.red.join(" | ")}`);
      check(r.counts.join() === "0,0,0" && r.freeIo === 16 && r.arena === 0, `counts ${r.counts}, free I/O ${r.freeIo}, arena ${r.arena}`);
      check(r.signals >= 1, "the manager's event was never signalled");
      const a = await nx<any>(p, "analyzePcm", Array.from(r.pcm as number[]), 440, 48000, 4800, r.samples - 2400);   // eslint-disable-line @typescript-eslint/no-explicit-any
      near(a.freq, 440, 0.5, "frequency"); check(a.snr > 25, `the decoded tone fits to ${a.snr.toFixed(1)} dB`); near(a.amp, 0.5, 0.02, "amplitude");
      return `${r.packets} packets (${r.bytes} bytes) -> ${r.frames} frames of 960, ${a.freq.toFixed(2)} Hz, ${a.snr.toFixed(1)} dB against the original sine, amplitude ${a.amp.toFixed(3)}; up to ${r.maxExecuting} executing at once, ${r.signals} event signals`;
    } },
];
const gesture: Case[] = [
  { name: "no autoplay: the context waits for a user gesture: SilentStarting for as long as it takes while the game's buffers come back in real time; a click, and the tone arrives", page: "/iso?auto=gesture", cfg: { shared: true },
    run: async (p, _info, said) => {
      // the page runs by itself (see page.ts) and says what it sees; nothing is evaluated in it before the click
      const one = await said("NX1"), s1 = one.s;
      check(one.context === "suspended" && one.active === false, `without a gesture the context is ${one.context} (user activation ${one.active})`);
      check(s1.state === "SilentStarting" && s1.callbacks === 0 && s1.wr === 0, `output ${s1.state}, ${s1.callbacks} callbacks, ${s1.wr} frames mixed`);
      const rt: number[] = s1.releaseTimes;
      near(rt.length / ((rt.at(-1)! - rt[0]) / 1000), 200, 10, "buffers per second on the silent sink");
      check(s1.red.length === 0, `red: ${s1.red.join(" | ")}`);
      const t0 = Date.now();
      await p.mouse.click(50, 50);
      const live = await said("NXLIVE", 3000), took = Date.now() - t0;
      check(live.context === "running" && live.active === true, `after the click the context is ${live.context}`);
      const two = await said("NX2"), s = two.s, h = two.h;
      const w = h.core, sounding = (h.whole.last - h.whole.first) / h.rate;
      check(sounding > 1.9 && w.snr > 60 && w.gaps === 0, `${sounding.toFixed(2)} s, ${w.snr.toFixed(1)} dB, ${w.gaps} gaps`);
      near(w.freq, 440, 0.1, "frequency");
      const names = s.states.map((x: { s: string }) => x.s).join(" ");
      check(names === "SilentStarting Live" && s.red.length === 0 && s.refused === 0, `states ${names}, red: ${s.red.join(" | ")}`);
      if (process.env.AUDIO_TICK_LOG) console.log(`     late ticks (>= 12 ms): ${JSON.stringify(s.lateTicks)}; states ${JSON.stringify(s.states.map((x: { t: number; s: string }) => [Math.round(x.t), x.s]))}; output underruns ${s.underruns}, device ${h.underrun}; ring [wr, rd, under, cb, live] ${JSON.stringify(s.ringLog)}`);
      // The test's guest is driven by this Worker's 4 ms timer and keeps 20 ms in flight: a timer that comes 15 ms or
      // more late makes the guest late, and an output underrun then is the guest's (a game whose audio thread is held
      // up that long underruns the same way). Without a late timer there must be none; the device must never run dry.
      const late = (s.lateTicks as { gap: number }[]).filter(t => t.gap >= 15).length;
      check(s.orderErrors === 0 && s.appended === s.reclaimed && s.underruns <= late && h.underrun === 0, `buffers: ${s.underruns} underruns with ${late} late timers, device ${h.underrun}`);
      return `${late ? `[${late} timer(s) of this Worker came 15 ms or more late: ${s.underruns} underrun(s) of the test's guest] ` : ""}1.5 s suspended, no user activation: ${rt.length} buffers at ${(rt.length / ((rt.at(-1)! - rt[0]) / 1000)).toFixed(1)}/s on the silent sink, nothing mixed, 0 device callbacks; Live ${took} ms after the click; then ${sounding.toFixed(2)} s of ${w.freq.toFixed(2)} Hz, ${w.snr.toFixed(1)} dB, no gap`;
    } },
];

const channel = process.env.AUDIO_BROWSER_CHANNEL ?? "chromium";
const retries = Number(process.env.AUDIO_BROWSER_RETRIES ?? 1);
let retried = 0;
async function one(browser: any, c: Case): Promise<{ ok: boolean; note: string; ms: number }> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = Date.now();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(e.message));
  const heard = new Map<string, unknown>(), waiters = new Map<string, (v: unknown) => void>();
  p.on("console", (m: { type(): string; text(): string }) => {
    const t = m.text(), tag = /^(NX\w+) /.exec(t);
    if (tag) { const v = JSON.parse(t.slice(tag[0].length)); heard.set(tag[1], v); waiters.get(tag[1])?.(v); }
    else if (m.type() === "error") errors.push(t);
  });
  const said = (tag: string, ms = 10000) => new Promise((res, rej) => {
    if (heard.has(tag)) return res(heard.get(tag));
    const timer = setTimeout(() => rej(new Error(`the page did not report ${tag} within ${ms} ms`)), ms);
    waiters.set(tag, v => { clearTimeout(timer); res(v); });
  });
  try {
    pageCfg = { ...CFG, ...c.cfg };
    await p.goto(`http://localhost:${port}${c.page}`);
    const auto = c.page.includes("?auto");
    const info = auto ? { transport: "", isolated: true } : await nx<{ transport: string; isolated: boolean }>(p, "init", pageCfg, FN);
    wrong = [];
    const note = await c.run(p, info, said);
    if (wrong.length) throw new Error(wrong.join("\n     "));
    const fatal = await p.evaluate(() => (window as any).fatal);   // eslint-disable-line @typescript-eslint/no-explicit-any
    const i = errors.findIndex(e => /AudioContext was not allowed to start/.test(e)); if (i >= 0) errors.splice(i, 1);   // the browser's own note about the gesture
    if (fatal) throw new Error("worker: " + fatal);
    if (errors.length) throw new Error("page errors: " + errors.join(" | "));
    return { ok: true, note, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, note: `${e instanceof Error ? e.message : e}${errors.length ? "\n     page: " + errors.join(" | ") : ""}`, ms: Date.now() - t0 };
  } finally { await ctx.close(); }
}
for (const [flag, cases] of [[true, autoplay], [false, gesture]] as [boolean, Case[]][]) {
  const args = [...(flag ? ["--autoplay-policy=no-user-gesture-required"] : []), ...(process.env.AUDIO_BROWSER_LOG ? ["--enable-logging=stderr", "--v=0"] : [])];
  const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args });
  console.log(`browser: Chromium ${browser.version()} (${channel === "shell" ? "chrome-headless-shell" : "channel " + channel + ", headless"}), ${args[0] ?? "the default autoplay policy (a user gesture is required)"}`);
  try {
    for (const c of cases) {
      if (only && !c.name.includes(only)) continue;
      ran++;
      // These tests run in real time against a real audio thread: a machine that keeps the Worker from its timer for
      // 30 ms makes a gap that is the machine's. A case that fails is run once more; both outcomes are printed.
      let first = "";
      for (let attempt = 1; ; attempt++) {
        const r = await one(browser, c);
        if (r.ok) { console.log(`ok   ${c.name} (${r.ms} ms${first ? "; SECOND ATTEMPT, the first failed: " + first.replace(/\n\s*/g, "; ") : ""})\n     ${r.note}`); if (first) retried++; break; }
        if (attempt === 1 && retries > 0) { first = r.note; continue; }
        failed++;
        console.log(`[RED] FAIL ${c.name}\n     ${r.note}${first ? "\n     first attempt: " + first : ""}`);
        break;
      }
    }
  } finally { await browser.close(); }
}
server.close();
console.log(`\naudio:browser: ${ran} tests, ${failed} failed${retried ? `, ${retried} passed on the second attempt` : ""}`);
process.exit(failed ? 1 : 0);
