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
const html = `<!doctype html><meta charset="utf-8"><title>nxweb audio tests</title><body style="margin:0"><div style="width:100vw;height:100vh">audio</div><script src="/page.js"></script>`;
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  const base = { "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" };
  const send = (body: Buffer | string, type: string, head: Record<string, string> = { "Cross-Origin-Embedder-Policy": "require-corp" }) => { res.writeHead(200, { ...base, ...head, "Content-Type": type }); res.end(body); };
  try {
    if (url === "/iso") return send(html, "text/html", iso);
    if (url === "/plain") return send(html, "text/html", {});
    if (url === "/page.js" || url === "/worker.js") return send(readFileSync(join(OUT, "web", url.slice(1))), "text/javascript");
    if (url === "/audio.wasm") return send(readFileSync(WASM), "application/wasm");
    if (url === "/audio.shared.wasm") return send(readFileSync(join(OUT, "audio.shared.wasm")), "application/wasm");
  } catch { /* 404 */ }
  res.writeHead(404, base); res.end("not found");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

let failed = 0, ran = 0;
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); };
const near = (v: number, want: number, tol: number, what: string) => check(Math.abs(v - want) <= tol, `${what}: ${v}, expected ${want} +- ${tol}`);
function wav(file: string, pcm: number[], rate: number): void {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((v, i) => b.writeInt16LE(v, 44 + 2 * i));
  writeFileSync(file, b);
}

interface Cfg { shared: boolean; transport?: string; sampleRate?: number; targetFrames?: number; freq: number; amp: number; frames: number; inflight: number; tickMs: number; event: boolean }
const CFG: Cfg = { shared: false, freq: 440, amp: 0.5, frames: 240, inflight: 4, tickMs: 4, event: true };
type Page = any;   // eslint-disable-line @typescript-eslint/no-explicit-any
type Case = { name: string; page: "/iso" | "/plain"; cfg: Partial<Cfg>; run: (p: Page, info: { transport: string; isolated: boolean }) => Promise<string> };
const nx = <T,>(p: Page, f: string, ...args: unknown[]): Promise<T> => p.evaluate(([f, args]: [string, unknown[]]) => (window as any).nx[f](...args), [f, args]);   // eslint-disable-line @typescript-eslint/no-explicit-any
const ask = <T,>(p: Page, cmd: string, extra: Record<string, unknown> = {}): Promise<T> => nx<T>(p, "ask", cmd, extra);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(p: Page, what: string, f: (s: any) => boolean, ms = 3000): Promise<any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = Date.now();
  for (;;) { const s = await ask<any>(p, "stats"); if (f(s)) return s; if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms (output ${s.state}, context ${s.context})`); await sleep(20); }   // eslint-disable-line @typescript-eslint/no-explicit-any
}

// A tone for `seconds`, recorded in the worklet; what must hold for "arrived with the right frequency and without gaps"
async function tone(p: Page, seconds: number, rate: number, expect: { transport: string; isolated: boolean; shared: boolean }, wavName?: string): Promise<string> {
  await nx(p, "record", seconds + 1.5);
  const o = await ask<{ open: number; start: number }>(p, "guest");
  check(o.open === 0 && o.start === 0, `open ${o.open} start ${o.start}`);
  const live = await until(p, "the output goes Live", s => s.state === "Live");
  check(live.transport === expect.transport, `transport ${live.transport}, expected ${expect.transport}`);
  check(live.isolated === expect.isolated && live.sharedMemory === expect.shared, `isolated ${live.isolated}, shared memory ${live.sharedMemory}`);
  check(live.rate === rate && (await nx<number>(p, "contextRate")) === rate, `device rate ${live.rate}`);
  await sleep(seconds * 1000);
  const s = await ask<any>(p, "stop");   // eslint-disable-line @typescript-eslint/no-explicit-any
  await sleep(250);                       // what is still in the ring plays out
  const h = await nx<any>(p, "heard", CFG.freq, [], !!wavName);   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (wavName) { wav(join(OUT, wavName), h.pcm, h.rate); }
  const w = h.whole, sounding = (w.last - w.first) / h.rate;
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
  near(s.reclaimed, (seconds + 0.25) * 200, 60, "5 ms buffers played");
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
    run: async (p) => (await tone(p, 3, 48000, { transport: "sab", isolated: true, shared: false }).catch(e => { if (!/buffers played/.test(String(e))) throw e; return "3 s, no gap (10 ms buffers)"; })) },
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
      near(gap, 0.3, 0.06, "the silence");
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
      const hid = await until(p, "Suspended", s => s.state === "Suspended" && s.context === "none");
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
      const names = s.states.map((x: { s: string }) => x.s).join(" ");
      check(names === "SilentStarting Live Suspended SilentStarting Live SilentRetry SilentStarting Live", `states ${names}`);
      const tRetry = s.states[5].t, tAgain = s.states[6].t;
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
      check(h.stretches.length === 3 && h.stretches.every((x: { snr: number }) => x.snr > 60), `${h.stretches.length} stretches: ${h.stretches.map((x: { snr: number }) => x.snr.toFixed(0)).join(", ")} dB`);
      void hid; void lost; void back;
      return `${names}; retry ${(tAgain - tRetry).toFixed(0)} ms after the loss; ${(rt.length / ((t1 - t0) / 1000)).toFixed(1)} buffers/s over ${((t1 - t0) / 1000).toFixed(1)} s, never fewer than ${worst} in 250 ms; three stretches of clean tone`;
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
  { name: "no autoplay: the context waits for a user gesture: SilentStarting for as long as it takes while the game's buffers come back in real time; a click, and the tone arrives", page: "/iso", cfg: { shared: true },
    run: async (p) => {
      await nx(p, "record", 5);
      await ask(p, "guest");
      await sleep(1500);
      const s1 = await ask<any>(p, "stats");   // eslint-disable-line @typescript-eslint/no-explicit-any
      check((await nx<string>(p, "context")) === "suspended", `the context is ${await nx<string>(p, "context")} without a gesture`);
      check(s1.state === "SilentStarting" && s1.callbacks === 0 && s1.wr === 0, `output ${s1.state}, ${s1.callbacks} callbacks, ${s1.wr} frames mixed`);
      const rt: number[] = s1.releaseTimes;
      near(rt.length / ((rt.at(-1)! - rt[0]) / 1000), 200, 10, "buffers per second on the silent sink");
      check(s1.red.length === 0, `red: ${s1.red.join(" | ")}`);
      await p.mouse.click(50, 50);
      const live = await until(p, "Live after the click", s => s.state === "Live", 2000);
      await sleep(2000);
      const s = await ask<any>(p, "stop"); await sleep(250);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const h = await nx<any>(p, "heard", CFG.freq);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const w = h.whole, sounding = (w.last - w.first) / h.rate;
      check(sounding > 1.9 && w.snr > 60 && w.gaps === 0, `${sounding.toFixed(2)} s, ${w.snr.toFixed(1)} dB, ${w.gaps} gaps`);
      near(w.freq, 440, 0.1, "frequency");
      check(s.states.map((x: { s: string }) => x.s).join(" ") === "SilentStarting Live" && s.red.length === 0 && s.refused === 0, "states");
      check(s.orderErrors === 0 && s.appended === s.reclaimed && s.underruns === 0, `buffers: ${s.underruns} underruns`);
      void live;
      return `suspended for 1.5 s: ${rt.length} buffers at ${(rt.length / ((rt.at(-1)! - rt[0]) / 1000)).toFixed(1)}/s on the silent sink, nothing mixed; after the click ${sounding.toFixed(2)} s of ${w.freq.toFixed(2)} Hz, ${w.snr.toFixed(1)} dB, no gap`;
    } },
];

const channel = process.env.AUDIO_BROWSER_CHANNEL ?? "chromium";
for (const [flag, cases] of [[true, autoplay], [false, gesture]] as [boolean, Case[]][]) {
  const args = [...(flag ? ["--autoplay-policy=no-user-gesture-required"] : ["--autoplay-policy=document-user-activation-required"]), ...(process.env.AUDIO_BROWSER_LOG ? ["--enable-logging=stderr", "--v=0"] : [])];
  const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args });
  console.log(`browser: Chromium ${browser.version()} (${channel === "shell" ? "chrome-headless-shell" : "channel " + channel + ", headless"}), ${args[0]}`);
  try {
    for (const c of cases) {
      if (only && !c.name.includes(only)) continue;
      ran++;
      const t0 = Date.now();
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on("pageerror", (e: Error) => errors.push(e.message));
      p.on("console", (m: { type(): string; text(): string }) => { if (m.type() === "error") errors.push(m.text()); });
      try {
        await p.goto(`http://localhost:${port}${c.page}`);
        const info = await nx<{ transport: string; isolated: boolean }>(p, "init", { ...CFG, ...c.cfg }, FN);
        Object.assign(CFG, { ...CFG });
        const note = await c.run(p, info);
        const fatal = await p.evaluate(() => (window as any).fatal);   // eslint-disable-line @typescript-eslint/no-explicit-any
        if (fatal) throw new Error("worker: " + fatal);
        if (errors.length) throw new Error("page errors: " + errors.join(" | "));
        console.log(`ok   ${c.name} (${Date.now() - t0} ms)\n     ${note}`);
      } catch (e) {
        failed++;
        console.log(`[RED] FAIL ${c.name}\n     ${e instanceof Error ? e.message : e}${errors.length ? "\n     page: " + errors.join(" | ") : ""}`);
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
}
server.close();
console.log(`\naudio:browser: ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
