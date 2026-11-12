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
  },
  nx_owner_stats__proxy: 'sync',
  nx_owner_stats__sig: 'vd',
  nx_owner_stats: function(out) { const s = globalThis.NXOWNER && globalThis.NXOWNER.stats; if (!s) return;
    if (HEAPF64[out / 8 + 11] === 1 && typeof process !== 'undefined') { const m = process.memoryUsage(); err('[owner] main realm: JS heap ' + (m.heapUsed >> 20) + ' MB, external ' + (m.external >> 20) + ' MB, array buffers ' + (m.arrayBuffers >> 20) + ' MB'); } HEAPF64[out / 8] = s.fsCalls; HEAPF64[out / 8 + 1] = s.fsPending; HEAPF64[out / 8 + 2] = s.fsRetry; HEAPF64[out / 8 + 3] = s.fsNs;
    const o = globalThis.NXOWNER; HEAPF64[out / 8 + 4] = o.hostCalls; HEAPF64[out / 8 + 5] = o.hostNs; HEAPF64[out / 8 + 6] = o.hostPending; HEAPF64[out / 8 + 7] = o.presents;
    HEAPF64[out / 8 + 8] = o.hostStream.calls; HEAPF64[out / 8 + 9] = o.hostStream.bytes; HEAPF64[out / 8 + 10] = o.gfx ? o.gfx.stats.nvnCalls : 0; },
});
