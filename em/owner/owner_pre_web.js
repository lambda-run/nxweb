// (appended to the bundled web owner by build.py; a --pre-js) Start the owner realm on the page's main thread before
// main() runs. Module.nxPage is set by index.html: { file, canvas, root, stage, modulesList }.
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  if (typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD) return;
  if (Module.nxEnv) for (var k in Module.nxEnv) ENV[k] = Module.nxEnv[k];   // the page's options the C side reads with getenv (NX_CORES)
  addRunDependency('nxowner');
  var mods = function () {
    var out = [];
    for (var i = 0; i < _nx_mod_count(); i++) { var f = function (k) { return _nx_mod_field(i, k); };
      out.push({ name: UTF8ToString(f(5)), base: f(0), imageSize: f(1), ro: { addr: f(0) + f(3), size: f(4) - f(3) } }); }
    return out;
  };
  var niBuf = 0;
  var nativeImage = function (h) { if (!niBuf) niBuf = _malloc(64); if (!_nx_native_image(h, niBuf)) return null; var q = niBuf / 8; return { mem: Number(HEAPU64[q]), size: Number(HEAPU64[q + 1]), w: Number(HEAPU64[q + 2]), h: Number(HEAPU64[q + 3]), stride: Number(HEAPU64[q + 4]) }; };
  var page = Object.assign({ nativeImage: nativeImage, mkdir: function (path) { FS.mkdirTree(path); }, writeFile: function (path, bytes) { FS.mkdirTree(path.slice(0, path.lastIndexOf('/'))); FS.writeFile(path, bytes); } }, Module.nxPage);
  globalThis.NXGUESTNS = function () { return BigInt(Math.round(_nx_guest_ns_d())); };
  nxLoadOwn().start(wasmMemory, function (n) { return _malloc(n); }, function (l) { err('[owner] ' + l); }, mods, page)
    .then(function (o) { globalThis.NXOWNER = o; Module.nxLiveThreads = function () { return _nx_live_threads(); }; removeRunDependency('nxowner'); },
          function (e) { err('[RED] owner: ' + (e && e.stack || e)); Module.nxPage.stage('failed: ' + (e && e.message || e)); });
});
