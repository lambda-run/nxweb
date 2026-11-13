// The whole runtime in a dedicated worker (?owner=worker): the Emscripten module's main thread, and with it the owner
// (WebGPU on the page's canvas as an OffscreenCanvas, WebCodecs, the request slot), is this worker; the page keeps the
// DOM, the input and the audio device. The page (em.html startWorker) sends { start, file, canvas, search, cfg } and
// then { input: [...] } / { call: [name, ...] }; this side sends { lines }, { stage }, { status }, { stopped }, { mem }.
// (in a function: em.js, loaded below into this global scope, has globals of its own named out, err, ...)
(function () {
var q = null, out = [], red = 0, nxem = { state: "starting", reason: "", presents: 0, threads: 0, fps: 0, label: "" };
var say = function (s) {
  if (q && !q.get("shaderlog") && /^\[owner\] shader [0-9a-f]+ (arrived|is not in)/.test(s)) return;
  if (/\[RED\]/.test(s)) red++;
  out.push(s);
};
setInterval(function () { if (out.length) { postMessage({ lines: out }); out = []; } }, 100);
onmessage = function (e) {
  var d = e.data;
  if (d.start) boot(d);
  else if (d.input) { if (self.Module && Module._nx_input && self.NXOWNER) Module._nx_input.apply(null, d.input); }
  else if (d.call) { try { if (self.Module && Module[d.call[0]]) Module[d.call[0]].apply(null, d.call.slice(1)); } catch (err) { say("[RED] worker: " + d.call[0] + ": " + err.message); } }
};
addEventListener("unhandledrejection", function (e) { say("[RED] rejection: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)); });
function boot(d) {
  q = new URLSearchParams(d.search);
  self.Module = {
    mainScriptUrlOrBlob: new URL("em.js", self.location.href).href,   // (the pthread workers load em.js, not this file)
    arguments: d.cfg.arguments, nxEnv: d.cfg.nxEnv, print: say, printErr: say,
    onAbort: function (w) { say("[RED] abort: " + w); nxem.state = "aborted"; if (!nxem.reason) Module.nxStopped("abort() in host code: " + w); },
    nxStopped: function (why) { if (nxem.reason) return; nxem.reason = why; postMessage({ stopped: why }); },
    onExit: function (c) { say("EXIT " + c); nxem.state = "exited"; },
    nxPage: Object.assign({}, d.cfg.page, { file: d.file, canvas: d.canvas, stage: function (t) { if (nxem.reason) return; nxem.state = t; postMessage({ stage: t }); } }),
  };
  say("page: the runtime and its owner thread are in a dedicated worker (?owner=worker): the page does the DOM, the input and the audio device only");
  importScripts("em.js");
  var last = 0, lastT = performance.now(), sentMem = false, ownerAt = 0, buf = 0;
  setInterval(function () {
    var o = self.NXOWNER, M = self.Module; if (!o || !M) return;
    var now = performance.now(), n = o.presents, dN = n - last, fps = dN * 1000 / (now - lastT), threads = 0; last = n; lastT = now;
    try { threads = M.nxLiveThreads ? M.nxLiveThreads() : 0; } catch (e) {}
    if (!sentMem && M._nx_audio_ring) { try { postMessage({ mem: wasmMemory, audioRing: Number(M._nx_audio_ring()) }); sentMem = true; } catch (e) {} }
    var split = "", running = -1;
    try { if (M._nx_thread_split) { if (!buf) buf = M._malloc(2400); running = M._nx_thread_split(buf, 2400, dN, 0); var e1 = buf; while (HEAPU8[e1] && e1 < buf + 2399) e1++; split = new TextDecoder().decode(HEAPU8.slice(buf, e1)); } } catch (e) {}
    var owner = null;
    if (o.report && now - ownerAt >= 10000) { ownerAt = now; try { owner = o.report(true); if (owner.wallMs > 5000) say("[owner] time, last " + (owner.wallMs / 1000).toFixed(0) + " s: " + JSON.stringify(owner)); } catch (e) { say("[RED] owner report: " + e.message); } }
    if (n > 0 && !nxem.reason && nxem.state !== "aborted" && nxem.state !== "exited") nxem.state = "running";
    nxem.presents = n; nxem.threads = threads; nxem.fps = fps;
    var st = { nxem: { state: nxem.state, reason: nxem.reason, presents: n, threads: threads, fps: fps, threadSplit: split, threadsRunning: running, redCount: red }, threads: threads,
               fps: fps.toFixed(1) + " fps · frame " + n + (running >= 0 ? " · guest threads running at once " + running.toFixed(2) + " · per frame ms: " + split : "") };
    if (owner) st.nxem.owner = owner;
    postMessage({ status: st });
  }, 1000);
}
})();
