// The em page's side of the audio output (bundled to audio.js by build.py page; loaded by em.html).
// The device is nxweb's, unchanged: AudioDeviceMain (src/glue/audio_device_main.ts: the AudioContext at 48 kHz, started
// on the first user gesture) and its AudioWorklet (src/glue/audio_worklet.ts) with the "direct" transport: the worklet
// reads, in place, the ring the C sink writes in the Emscripten memory (em/audio/nx_audio.c, which also describes the
// header words). Nothing goes through the owner thread or through messages per frame.
// This file: finds the ring once the renderer has opened its output, hands it to the device, writes what the browser
// decides (rate, context state, tab hidden) into the header for the C side, suspends the context while the tab is
// hidden, and shows the status line and the "click for sound" hint.
// ?audiolog=1: an [audio] line every 5 s from both sides. ?alat=<ms>: the ring's target (default 40). ?audio=off: no device.
// ?audiotone=<Hz>: the sink writes a sine in place of the game's sound (a test of the path: a break in it can be counted).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AudioDeviceMain, DEV } from "../../src/glue/audio_device_main.ts";

const H = { WR: 0, RD: 1, CAP: 2, UNDER: 3, CB: 4, LIVE: 5, RATE: 6, TARGET: 7, STATE: 8, OVER: 9, HIDDEN: 10, FRAMES: 11, DISCARD: 12, PEAK: 13, NONSILENT: 14, MODE: 15, FPS100: 16, FILL_MIN: 17, FILL_MAX: 18, OPEN: 19, WORDS: 32 };
const g = globalThis as any, q = new URLSearchParams(location.search);
const say = (s: string): void => { if (typeof g.say === "function") g.say(s); else console.log(s); };
const STATE = ["none", "starting", "running", "failed", "suspended"];

let h: Int32Array | null = null, dev: AudioDeviceMain | null = null, error = "", lastCb = 0, lastCbT = 0, cbRate = 0;
const el = document.createElement("span"); el.id = "audio"; el.style.color = "#8c8";
const hint = document.createElement("div"); hint.id = "audiohint"; hint.textContent = "click or press a key for sound"; hint.hidden = true;
hint.style.cssText = "position:absolute;right:6px;top:6px;background:rgba(0,0,0,.7);padding:3px 8px;font:12px system-ui,sans-serif;color:#fc6;border:1px solid #fc6;border-radius:3px;pointer-events:none";
const place = (): void => { document.getElementById("top")?.appendChild(el); (document.getElementById("wrap") ?? document.body).appendChild(hint); };
if (document.readyState === "loading") addEventListener("DOMContentLoaded", place); else place();

function status(): Record<string, unknown> {
  if (!h) return { state: error ? "failed" : q.get("audio") === "off" ? "off" : "no output yet", error };
  const rate = Atomics.load(h, H.RATE) || 48000, fill = (Atomics.load(h, H.WR) - Atomics.load(h, H.RD)) >>> 0;
  return { state: document.hidden && dev?.ctx?.state !== "running" ? "suspended (tab hidden)" : STATE[Atomics.load(h, H.STATE)] ?? "?", context: dev?.ctx?.state ?? "none", rate, ringMs: fill * 1000 / rate, targetMs: Atomics.load(h, H.TARGET) * 1000 / rate,
    underrun: Atomics.load(h, H.UNDER), overrun: Atomics.load(h, H.OVER), discarded: Atomics.load(h, H.DISCARD), callbacks: Atomics.load(h, H.CB), callbacksPerSecond: cbRate,
    framesPerSecond: Atomics.load(h, H.FPS100) / 100, rendered: Atomics.load(h, H.FRAMES) >>> 0, nonSilent: Atomics.load(h, H.NONSILENT) >>> 0, peak: Atomics.load(h, H.PEAK) / 32768, devicePaced: Atomics.load(h, H.MODE) === 1,
    fillMinMs: Atomics.load(h, H.FILL_MIN) * 1000 / rate, fillMaxMs: Atomics.load(h, H.FILL_MAX) * 1000 / rate, live: Atomics.load(h, H.LIVE), error };
}
function show(): void {
  const s = status() as any;
  if (!h) { el.textContent = error ? "audio: " + error : ""; hint.hidden = true; return; }
  // an underrun is counted in frames by the worklet (128 to a callback): shown as callbacks that came up short
  el.textContent = `audio: ${s.state} ${s.rate} Hz · ${Math.ceil(s.underrun / 128)} underruns · ring ${s.ringMs.toFixed(0)} ms`;
  el.style.color = s.state === "running" ? "#8c8" : "#fc6";
  hint.hidden = !(dev?.ctx && dev.ctx.state !== "running" && !document.hidden && !error);
}
function attach(): boolean {
  const M = g.Module, mem = g.wasmMemory;
  if (!M || typeof M._nx_audio_ring !== "function" || !mem) return false;
  let ptr = 0;
  try { ptr = Number(M._nx_audio_ring()); } catch { return false; }   // the runtime is not up yet
  if (!ptr) return false;
  const hd = new Int32Array(mem.buffer, ptr, H.WORDS);
  if (!Atomics.load(hd, H.OPEN)) return false;                          // the renderer has not started its output
  h = hd;
  try { M._nx_audio_config(Number(q.get("alat")) || 0, q.get("audiolog") ? 1 : -1); if (q.get("audiotone")) M._nx_audio_tone(Number(q.get("audiotone"))); } catch { /* an older runtime */ }
  if (!(mem.buffer instanceof SharedArrayBuffer)) { error = "the runtime's memory is not shared"; say("[RED] audio: " + error); return true; }
  dev = new AudioDeviceMain(m => {
    const a = m.audio as any;
    if (a.ev === "open") {
      Atomics.store(hd, H.RATE, a.rate | 0);
      if (a.error) { error = "no device (" + a.error + ")"; say("[RED] audio: " + error + ": the renderer stays on the wall clock, no sound"); }
      else say(`audio: device open, context at ${a.rate} Hz${a.rate !== 48000 ? " (not 48000: the sink resamples)" : ""}, base latency ${(a.baseLatency * 1000).toFixed(1)} ms; the worklet reads the ring in the runtime's memory`);
    } else if (a.ev === "state") {
      const was = Atomics.exchange(hd, H.STATE, a.state | 0);
      if (was !== a.state) say(`audio: ${STATE[a.state] ?? a.state} (context ${a.context})${a.state === DEV.STARTING ? ": waiting for a click or a key (the browser's autoplay rule)" : ""}`);
    } else if (a.ev === "hidden") {
      // a hidden tab is silent, as on the nxweb page: the context is suspended, the renderer goes on on the wall clock
      Atomics.store(hd, H.HIDDEN, a.hidden ? 1 : 0);
      const ctx = dev?.ctx;
      if (ctx) void (a.hidden ? ctx.suspend() : ctx.resume()).catch(() => { /* closed, or not allowed yet: the next gesture resumes it */ });
    }
    show();
  });
  dev.handle({ audio: { cmd: "open", cap: Atomics.load(hd, H.CAP), sab: mem.buffer, hdr: ptr, data: ptr + H.WORDS * 4 } });
  dev.handle({ audio: { cmd: "start" } });
  return true;
}
if (q.get("audio") !== "off") {
  const find = setInterval(() => { try { if (attach()) clearInterval(find); } catch (e) { clearInterval(find); error = String(e); say("[RED] audio: " + error); } }, 250);
  setInterval(() => {
    if (h) { const now = performance.now(), cb = Atomics.load(h, H.CB); if (lastCbT) cbRate = ((cb - lastCb) | 0) * 1000 / (now - lastCbT); lastCb = cb; lastCbT = now; }
    show();
  }, 500);
  if (q.get("audiolog")) setInterval(() => {
    if (!h) return; const s = status() as any;
    say(`[audio] page: ${s.state} (context ${s.context}) ${s.rate} Hz · ${s.callbacksPerSecond.toFixed(0)} callbacks/s (${(s.rate / 128).toFixed(0)} when running) · ${s.framesPerSecond.toFixed(1)} frames/s rendered · ring ${s.ringMs.toFixed(0)} ms (${s.fillMinMs.toFixed(0)}..${s.fillMaxMs.toFixed(0)}) · ${s.underrun} underrun frames · ${s.overrun} dropped · ${s.discarded} discarded · peak ${s.peak.toFixed(3)}`);
  }, 5000);
}
// for tests and the console: nxemAudio.status(), nxemAudio.device() (record / dump of what the worklet put out)
g.nxemAudio = { status, device: () => dev, header: () => h };
