// (a --pre-js, in every realm) A worker keeps the compiled unit modules the main thread posts to it (kernel/nx_owner.js
// nx_units_share): messages without a `cmd`, which Emscripten's own handler passes by.
(function () {
  var take = function (d) { if (d && d.nxUnit !== undefined) (globalThis.NXSHARED || (globalThis.NXSHARED = []))[d.nxUnit] = d.module; };
  if (typeof importScripts === 'function') self.addEventListener('message', function (e) { take(e.data); });
  else if (typeof require === 'function') { try { var wt = require('worker_threads'); if (!wt.isMainThread && wt.parentPort) wt.parentPort.on('message', take); } catch (e) { /* not Node */ } }
})();
