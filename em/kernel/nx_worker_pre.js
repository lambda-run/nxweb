// (a --pre-js, in every realm) A worker keeps the compiled unit modules the main thread posts to it (kernel/nx_owner.js
// nx_units_share): messages without a `cmd`, which Emscripten's own handler passes by.
(function () {
  var take = function (d) { if (d && d.nxUnits) globalThis.NXSHARED = d.nxUnits; };   // unit k of the registry is nxUnits[k]
  if (typeof importScripts === 'function') self.addEventListener('message', function (e) { take(e.data); });
  else if (typeof require === 'function') { try { var wt = require('worker_threads'); if (!wt.isMainThread && wt.parentPort) wt.parentPort.on('message', take); } catch (e) { /* not Node */ } }
})();

// A trap that no run loop caught (host code of a thread that runs no guest code: the audio renderer, a decoder; or a
// thread's own start-up) used to reach the page only as "worker sent an error", and the process went on without that
// thread. It is a fault like any other: the stack, the thread's ring and the stop report (kernel/nx_guest.c nx_guest_fault).
(function () {
  var seen = false;
  var fault = function (e) {
    if (seen || !e || e === 'unwind' || e.name === 'ExitStatus') return;
    if (!(typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) && !(e instanceof RangeError)) return;
    seen = true;
    try {
      var text = 'outside translated code: ' + String(e.message || e);
      (typeof err === 'function' ? err : console.error)('[RED] a thread trapped outside its run loop: ' + String(e.stack || e).split('\n').slice(0, 14).join(' | '));
      if (typeof _nx_guest_fault === 'function') { var n = text.length + 1, p = _malloc(n); for (var i = 0; i < text.length; i++) HEAPU8[p + i] = text.charCodeAt(i) & 127; HEAPU8[p + text.length] = 0; _nx_guest_fault(0, p, 0); }
    } catch (e2) { /* the report itself failed: the page's error event still says something */ }
  };
  if (typeof importScripts === 'function') { self.addEventListener('error', function (ev) { fault(ev.error); }); self.addEventListener('unhandledrejection', function (ev) { fault(ev.reason); }); }
  else if (typeof process !== 'undefined' && process.on) { try { if (!require('worker_threads').isMainThread) process.on('uncaughtException', function (e) { fault(e); }); } catch (e) { /* not Node */ } }
})();
