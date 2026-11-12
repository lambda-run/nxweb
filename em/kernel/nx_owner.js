// nxem: the proxy to the owner realm (em/owner/owner.ts), an Emscripten --js-library plus the start hook in
// build/<target>/owner_pre.js. The two functions run on the Emscripten main thread whoever calls them.
addToLibrary({
  // kind << 24 | id of the host function `name` in the owner's modules, 0 = none
  nx_owner_lookup__proxy: 'sync',
  nx_owner_lookup__sig: 'id',
  nx_owner_lookup__deps: ['$UTF8ToString'],
  nx_owner_lookup: function(name) { return globalThis.NXOWNER ? globalThis.NXOWNER.lookup(UTF8ToString(name)) : 0; },
  // one host call on the caller's context block: 0 done, 1 pending (wait on the block's cell), 2 retry
  nx_owner_call__proxy: 'sync',
  nx_owner_call__sig: 'iid',
  nx_owner_call: function(code, ctx) { return globalThis.NXOWNER.call(code, ctx); },
  // the same for a stub the loader did not make (an address the owner handed out); and that stub's name, for the log
  nx_owner_stub__proxy: 'sync',
  nx_owner_stub__sig: 'ii',
  nx_owner_stub: function(id) { return globalThis.NXOWNER ? globalThis.NXOWNER.lookupStub(id) : 0; },
  // (NVN id + 1) | abi << 16 when a guest thread may answer the stub in its own instance of the recorder, else 0
  nx_owner_stub_direct__proxy: 'sync',
  nx_owner_stub_direct__sig: 'ii',
  nx_owner_stub_direct: function(id) { return globalThis.NXOWNER ? globalThis.NXOWNER.stubDirect(id) : 0; },
  nx_owner_stub_name__proxy: 'sync',
  nx_owner_stub_name__sig: 'vidi',
  nx_owner_stub_name__deps: ['$stringToUTF8'],
  nx_owner_stub_name: function(id, out, n) { stringToUTF8(globalThis.NXOWNER ? globalThis.NXOWNER.stubName(id) : '', out, n); },
  // The fast path: one request slot in the shared memory (kernel/nx_proc.c: int32 state, code, result, pad, double ctx).
  // A caller writes its request and sets state 1; the owner answers and sets state 2. The owner learns of a request
  // through Atomics.waitAsync (it stays in its event loop), and after each call it keeps looking at the slot for a
  // moment before going back to the event loop: calls come in bursts, and a burst then costs no wake-up per call.
  nx_owner_serve__proxy: 'sync',
  nx_owner_serve__sig: 'vd',
  nx_owner_serve: function(slot) {
    const s = slot / 4, own = globalThis.NXOWNER;
    const serve = () => {
      let until = 0;
      for (;;) {
        if (own.svc()) { until = performance.now() + 0.2; continue; }   // the request of the thread that is inside the recorder (gfx_exec)
        if (Atomics.load(HEAP32, s) === 1) {
          let r = 0;
          try { r = own.call(HEAP32[s + 1], HEAPF64[slot / 8 + 2]); } catch (e) { err('[RED] owner: ' + (e && e.stack || e)); }
          HEAP32[s + 2] = r;
          Atomics.store(HEAP32, s, 2); Atomics.notify(HEAP32, s);
          until = performance.now() + 0.2;
          continue;
        }
        if (performance.now() < until) continue;
        const cur = Atomics.load(HEAP32, s);
        if (cur === 1) continue;
        const w = Atomics.waitAsync(HEAP32, s, cur);
        if (w.async) { w.value.then(serve); return; }
      }
    };
    serve();
    // the same watch on the recorder's request word (owner/owner.ts NXG + 8): a guest thread's flush reaches the replayer
    // (and on the fs module's, NXF + 8: a storage read of a guest thread's nn::fs call)
    const watch = (g) => { const flush = () => {
      let until = 0;
      for (;;) {
        if (own.svc()) { until = performance.now() + 0.2; continue; }
        if (performance.now() < until) continue;
        const cur = Atomics.load(HEAP32, g);
        if (cur === 1) continue;
        const w = Atomics.waitAsync(HEAP32, g, cur);
        if (w.async) { w.value.then(flush); return; }
      }
    }; flush(); };
    watch(0x1FF1F000 / 4 + 2); watch(0x1FF1F100 / 4 + 2);
  },
  // Compiled modules for the workers. What the translation cache published before any guest thread runs is compiled
  // once here on the main thread and handed to every worker in ONE message, which a worker takes in while it is in its
  // event loop, that is before it runs a thread; a worker made later gets the same message when it is made. Units
  // translated while the game runs are not sent (a running thread cannot receive, and the main thread is the owner
  // thread: a broadcast per unit was tried and stalled it): a thread that needs one compiles it from the registry.
  // upTo: the registry count to cover; cell: an int32 the caller waits on, set to 1 when the modules are out.
  nx_units_share__proxy: 'sync',
  nx_units_share__sig: 'vid',
  nx_units_share__deps: ['$PThread', 'nx_unit_bytes', 'nx_unit_len'],
  nx_units_share: function(upTo, cell) {
    const done = () => { Atomics.store(HEAP32, cell / 4, 1); Atomics.notify(HEAP32, cell / 4); };
    if (!upTo || globalThis.NXSHARE) { done(); return; }
    const S = globalThis.NXSHARE = { mods: [], sent: new Set() }, t0 = performance.now();
    const post = (w) => { if (S.mods.length && !S.sent.has(w)) { S.sent.add(w); w.postMessage({ nxUnits: S.mods }); } };
    (async () => {
      let bytes = 0;
      for (let k = 0; k < upTo; k += 32) {
        const jobs = [];
        for (let i = k; i < Math.min(upTo, k + 32); i++) { const p = _nx_unit_bytes(i), n = _nx_unit_len(i); bytes += n; jobs.push(WebAssembly.compile(HEAPU8.slice(p, p + n))); }
        for (const m of await Promise.all(jobs)) S.mods.push(m);
      }
      for (const w of PThread.unusedWorkers.concat(PThread.runningWorkers)) post(w);
      const load = PThread.loadWasmModuleToWorker;
      PThread.loadWasmModuleToWorker = function (w) { const r = load.apply(PThread, arguments); post(w); return r; };
      err('[owner] compiled modules: ' + S.mods.length + ' cached units, ' + (bytes / 1048576).toFixed(1) + ' MB, compiled once on the main thread in ' + (performance.now() - t0).toFixed(0) + ' ms; every worker gets them in one message');
    })().then(done, (e) => { err('[RED] nx_units_share: ' + (e && e.message || e)); done(); });
  },
  // The page: a cache file the translator wrote into the in-memory /cache goes into the Cache API (as nxweb keeps its
  // translation cache) and leaves the memory; older entries of the same module go. Node: the file is the cache.
  nx_js_cache_store__proxy: 'sync',
  nx_js_cache_store__sig: 'vd',
  nx_js_cache_store__deps: ['$UTF8ToString', '$FS'],
  nx_js_cache_store: function(path) {
    if (typeof caches === 'undefined' || typeof window === 'undefined') return;
    const p = UTF8ToString(path), name = p.split('/').pop(); let b;
    try { b = FS.readFile(p); FS.unlink(p); } catch (e) { err('[RED] translation cache: ' + name + ': ' + e.message); return; }
    caches.open('nxem-a64').then(async (c) => {
      for (const k of await c.keys()) { const n = decodeURIComponent(new URL(k.url).pathname.split('/').pop()); if (n.split('-')[0] === name.split('-')[0] && n !== name) await c.delete(k); }
      await c.put('/em-a64-cache/' + encodeURIComponent(name), new Response(b, { headers: { 'Content-Type': 'application/octet-stream' } }));
      err('[owner] translation cache: ' + name + ' stored in the browser (' + (b.length / 1048576).toFixed(1) + ' MB)');
    }).catch((e) => err('[RED] translation cache: not stored: ' + (e && e.message || e)));
  },
  // why the harness stopped, to the page (its status line and live status); runs on the main thread
  nx_js_stopped__proxy: 'sync',
  nx_js_stopped__sig: 'vd',
  nx_js_stopped__deps: ['$UTF8ToString'],
  nx_js_stopped: function(why) { if (Module.nxStopped) Module.nxStopped(UTF8ToString(why)); },
  nx_owner_stats__proxy: 'sync',
  nx_owner_stats__sig: 'vd',
  nx_owner_stats: function(out) { const s = globalThis.NXOWNER && globalThis.NXOWNER.stats; if (!s) return;
    if (HEAPF64[out / 8 + 11] === 1 && typeof process !== 'undefined') { const m = process.memoryUsage(); err('[owner] main realm: JS heap ' + (m.heapUsed >> 20) + ' MB, external ' + (m.external >> 20) + ' MB, array buffers ' + (m.arrayBuffers >> 20) + ' MB'); } HEAPF64[out / 8] = s.fsCalls; HEAPF64[out / 8 + 1] = s.fsPending; HEAPF64[out / 8 + 2] = s.fsRetry; HEAPF64[out / 8 + 3] = s.fsNs;
    const o = globalThis.NXOWNER; HEAPF64[out / 8 + 4] = o.hostCalls; HEAPF64[out / 8 + 5] = o.hostNs; HEAPF64[out / 8 + 6] = o.hostPending; HEAPF64[out / 8 + 7] = o.presents;
    HEAPF64[out / 8 + 8] = o.hostStream.calls; HEAPF64[out / 8 + 9] = o.hostStream.bytes; HEAPF64[out / 8 + 10] = o.gfx ? o.gfx.stats.nvnCalls : 0; },
});
