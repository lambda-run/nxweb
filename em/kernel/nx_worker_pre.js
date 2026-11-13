// (a --pre-js, in every realm) A worker keeps the compiled unit modules the main thread posts to it (kernel/nx_owner.js
// nx_units_share): messages without a `cmd`, which Emscripten's own handler passes by.
// In a browser the message comes with a (dummy) MessagePort, which marks it without its data being looked at: the
// event is kept as it is and Emscripten's handler does not see it. Its data, the list of modules, is only unpacked when
// this worker's thread first needs a unit (NXMODS(), kernel/nx_guest.js): unpacking costs about 0.7 KB a module in every
// worker (measured, tools/chrome_costs.mjs: 3.5 MB for the game's cache), and a third of the threads never run guest code.
(function () {
  var take = function (d) { if (d && d.nxUnits) globalThis.NXSHARED = d.nxUnits; };   // unit k of the registry is nxUnits[k]
  globalThis.NXMODS = function () { var ev = globalThis.NXMODEVT; if (ev) { globalThis.NXMODEVT = null; take(ev.data); } return globalThis.NXSHARED; };
  if (typeof importScripts === 'function') self.addEventListener('message', function (e) { if (e.ports && e.ports.length) { e.stopImmediatePropagation(); globalThis.NXMODEVT = e; } });
  else if (typeof require === 'function') { try { var wt = require('worker_threads'); if (!wt.isMainThread && wt.parentPort) wt.parentPort.on('message', take); } catch (e) { /* not Node */ } }
})();

// (the main thread) The bytes of the translation cache's units, as the translator thread sends them (kernel/nx_guest.js
// nxPublish, through Emscripten's callHandler message): unit k of the registry; nx_units_share compiles and drops them.
Module['nxUnitBytes'] = function (k0, list) { var B = globalThis.NXUNITBYTES || (globalThis.NXUNITBYTES = { at: [], n: 0 }); for (var i = 0; i < list.length; i++) { B.at[k0 + i] = list[i]; B.n++; } };

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
