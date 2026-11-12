// (appended to the bundled owner by build.py; a --pre-js) Start the owner realm on the main thread before main() runs.
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  if (typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD) return;
  addRunDependency('nxowner');
  var mods = function () {   // the loaded code modules, from C (kernel/nx_proc.c)
    var out = [];
    for (var i = 0; i < _nx_mod_count(); i++) { var f = function (k) { return _nx_mod_field(i, k); };
      out.push({ name: UTF8ToString(f(5)), base: f(0), imageSize: f(1), ro: { addr: f(0) + f(3), size: f(4) - f(3) } }); }
    return out;
  };
  nxLoadOwn().start(wasmMemory, function (n) { return _malloc(n); }, function (l) { err('[owner] ' + l); }, mods)
    .then(function (o) { globalThis.NXOWNER = o; removeRunDependency('nxowner'); },
          function (e) { err('[RED] owner: ' + (e && e.stack || e)); process.exit(4); });
});
