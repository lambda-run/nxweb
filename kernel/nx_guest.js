// nxem: the guest execution seam, JS half (an Emscripten --js-library; the same code runs in every pthread's worker).
// Each worker keeps ONE instance of nxweb's translated code: its own function table, its own core module instance
// (the CPU state is that instance's wasm globals) and its own instance of every unit, all on the one shared memory
// (Emscripten's wasmMemory). Table indices are the same in every worker, so the pc map in the memory serves all.
// NXA64 is nxweb's src/glue/a64_host.ts + rt_layout.ts, bundled unchanged (build_p2.sh) and included as --pre-js.
addToLibrary({
  $NX: { t: null, host: null, published: 0 },   // pcs >= 0xFFFFFF00 return to the embedder: 0xFFFFFFF0 = thread exit, 0xFFFFFFC0 = return from a host call

  // the pc map (two levels; nxweb src/a64/README.md) read from the shared memory: pc -> table index, 0 = not translated
  $nxPcMap__deps: ['$NX', 'nx_is64'],
  $nxPcMap: function(pc) {
    const lay = NXA64.A64, page = Math.floor(pc / 65536);
    if (!_nx_is64()) return HEAPU32[(HEAPU32[(lay.pcmapBase + page * 4) >>> 2] + (pc % 65536 & 0xFFFC)) >>> 2];
    if (pc >= HEAPU8.length) return 0;   // memory64: the first level has 8-byte entries and covers the memory
    return HEAPU32[(Number(HEAPU64[lay.pcmapBase / 8 + page]) + (pc % 65536 & 0xFFFC)) / 4];
  },

  // instantiate the units this worker does not have yet
  $nxSync__deps: ['$NX', 'nx_unit_count', 'nx_unit_bytes', 'nx_unit_len', 'nx_unit_base', 'nx_unit_nfuncs'],
  $nxSync: function(t) {
    const n = _nx_unit_count();
    for (; t.n < n; t.n++) {
      const p = _nx_unit_bytes(t.n), len = _nx_unit_len(t.n), base = _nx_unit_base(t.n);
      const t0 = performance.now();
      const mod = new WebAssembly.Module(HEAPU8.slice(p, p + len));
      t.compileMs += performance.now() - t0;
      const end = base + _nx_unit_nfuncs(t.n);   // only the cache stage of the gate publishes beyond the pre-sized table
      if (end > t.table.length) t.table.grow(Math.max(end - t.table.length, 1 << 18), t.tramp);
      new WebAssembly.Instance(mod, { cpu: t.core, hlp: t.hlp, env: Object.assign({ table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, base) }, t.unitEnv) });
      t.syncMs += performance.now() - t0; t.syncBytes += len;
    }
  },

  // the `translate` import of this worker's core: called through table slot 0 when the pc map has no function for pc,
  // or when it names a slot this worker has not filled yet (every empty slot holds the same trampoline)
  $nxTranslate__deps: ['$nxSync', '$nxPcMap', 'nx_translate'],
  $nxTranslate: function(t, pcBig) {
    const pc = Number(BigInt.asUintN(64, pcBig));
    nxSync(t);
    let idx = nxPcMap(pc);
    if (idx <= 1 || t.table.get(idx) === t.tramp) { idx = _nx_translate(pc); nxSync(t); }
    return idx;
  },

  $nxThread__deps: ['$NX', '$nxSync', '$nxTranslate', 'nx_svc', 'nx_mod_ptr', 'nx_mod_len', 'nx_table_cap', 'nx_is64', 'malloc'],
  $nxThread: function() {
    if (NX.t) return NX.t;
    const mem = wasmMemory, t0 = performance.now();
    const bytes = (w) => HEAPU8.slice(_nx_mod_ptr(w), _nx_mod_ptr(w) + _nx_mod_len(w));
    const t = { n: 0, syncMs: 0, syncBytes: 0, compileMs: 0 };
    t.table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
    t.core = new WebAssembly.Instance(new WebAssembly.Module(bytes(0)), { env: { memory: mem, table: t.table, translate: (pc) => nxTranslate(t, pc) } }).exports;
    const hx = new WebAssembly.Instance(new WebAssembly.Module(bytes(1)), { env: { memory: mem, abort: () => { throw new Error('a64 helpers abort'); } } }).exports;
    t.hlp = {};
    for (const k in hx) if (!['staticBase', 'staticEnd', 'memory', 'libcStat', 'libcGuard'].includes(k)) t.hlp[k] = hx[k];
    t.ctx = _malloc(0x400);
    const core = t.core, m64 = _nx_is64();
    t.save = m64 ? (p) => core.save_ctx(BigInt(p)) : core.save_ctx;   // the wasm64 core takes its pointer as an i64
    t.load = m64 ? (p) => core.load_ctx(BigInt(p)) : core.load_ctx;
    t.unitEnv = {
      memory: mem, table: t.table,
      svc: (n) => { t.save(t.ctx); _nx_svc(n, t.ctx); t.load(t.ctx); },
      unimpl: (pc, w) => { throw new Error('unimplemented instruction ' + (w >>> 0).toString(16) + ' at ' + pc.toString(16)); },
      brk: (pc) => { throw new Error('brk at ' + pc.toString(16)); },
      cntpct: () => BigInt(Math.round(performance.now() * 19200)),
    };
    t.tramp = t.table.get(0);
    t.table.grow(_nx_table_cap() - t.table.length, t.tramp);
    NX.t = t;
    nxSync(t);
    t.setupMs = performance.now() - t0;
    return t;
  },

  // Run guest code on the calling pthread from a fresh CPU state until it returns to the exit pc.
  nx_js_guest_run__deps: ['$nxThread'],
  nx_js_guest_run__sig: 'vp',
  nx_js_guest_run: function(io) {
    const t = nxThread(), c = t.core, q = io / 8;
    HEAPU8.fill(0, t.ctx, t.ctx + 0x330); t.load(t.ctx);
    c.x0.value = HEAPU64[q]; c.x1.value = HEAPU64[q + 1]; c.x2.value = HEAPU64[q + 2]; c.x3.value = HEAPU64[q + 3]; c.x4.value = HEAPU64[q + 4];
    c.pc.value = HEAPU64[q + 5]; c.sp.value = HEAPU64[q + 6]; const EXIT = BigInt(0xFFFFFFF0);
    c.x30.value = EXIT; c.excl_addr.value = BigInt(-1);
    while (c.pc.value !== EXIT) { c.budget.value = 1 << 30; c.run(); }
    HEAPU64[q] = c.x0.value;
  },

  // A host call into guest code on the calling guest thread (nested inside whatever that thread was doing, an SVC included).
  nx_guest_call__deps: ['$nxThread', 'malloc', 'free'],
  nx_guest_call__sig: 'jjjjj',
  nx_guest_call: function(pc, a0, a1, a2) {
    const t = nxThread(), c = t.core, save = _malloc(0x400);
    t.save(save);
    c.x0.value = a0; c.x1.value = a1; c.x2.value = a2; const RET = BigInt(0xFFFFFFC0);
    c.x30.value = RET; c.pc.value = pc;
    while (c.pc.value !== RET) { c.budget.value = 1 << 30; c.run(); }
    const r = c.x0.value;
    t.load(save); _free(save);
    return r;
  },

  // ---- the translator thread's realm
  nx_js_tr_init__deps: ['$NX', 'nx_mod_set', 'nx_is64', 'malloc'],
  nx_js_tr_init__sig: 'vpipidd',
  nx_js_tr_init: function(tr, trLen, hlp, hlpLen, codeLo, codeSize) {
    const stop = (what) => () => { throw new Error('the translator realm does not run guest code (' + what + ')'); };
    const host = new NXA64.A64Host(HEAPU8.slice(tr, tr + trLen), HEAPU8.slice(hlp, hlp + hlpLen), {
      memory: wasmMemory, shared: true, layout: Object.assign({}, NXA64.A64, { codeRegionLo: codeLo }),
      mem64: !!_nx_is64(), memoryMaxPages: wasmMemory.buffer.byteLength / 65536,   // no growth: the maximum is the size
      imports: { svc: stop('svc'), unimpl: stop('unimpl'), brk: stop('brk'), cntpct: () => BigInt(0) },
    });
    host.keepBytes = true;
    host.addCode(codeLo, codeSize);
    NX.host = host;
    const put = (which, b) => { const p = _malloc(b.length); HEAPU8.set(b, p); _nx_mod_set(which, p, b.length); };
    // the core module's bytes: A64Host keeps only the compiled module, so build it once more (same options, same bytes)
    const len = host.tr.buildCore(), out = Number(host.tr.outPtr());
    put(0, HEAPU8.slice(out, out + len));
    put(1, HEAPU8.slice(hlp, hlp + hlpLen));
  },
  nx_js_tr_translate__deps: ['$NX', 'nx_unit_publish', 'malloc'],
  nx_js_tr_translate__sig: 'id',
  nx_js_tr_translate: function(pc) {
    const h = NX.host;
    let idx = h.getPcMap(pc);
    if (idx <= 1) idx = h.translateUnit([BigInt(pc)])[0];
    for (; NX.published < h.units.length; NX.published++) {
      const u = h.units[NX.published], p = _malloc(u.bytes.length);
      HEAPU8.set(u.bytes, p);
      _nx_unit_publish(p, u.bytes.length, u.tableBase, u.pcs.length);
    }
    return idx;
  },
  nx_js_tid__deps: ['$NX'],
  nx_js_tid: function() { return NX.rid || (NX.rid = 1 + Math.floor(Math.random() * 0x7FFFFFF0)); },   // one per JS realm = per worker
  nx_js_thread_stats__deps: ['$NX'],
  nx_js_thread_stats__sig: 'vp',
  nx_js_thread_stats: function(out) {   // double[4]: setup ms, unit instantiate ms, unit bytes, units
    const t = NX.t; if (!t) return;
    HEAPF64[out / 8] = t.setupMs; HEAPF64[out / 8 + 1] = t.syncMs; HEAPF64[out / 8 + 2] = t.syncBytes; HEAPF64[out / 8 + 3] = t.n; HEAPF64[out / 8 + 4] = t.compileMs;
  },

  // ---- the Chrome gate (test/p2_main.c "cache" stage): nxweb's real translation cache for the game through the registry
  // Make sure this thread has its table / core / helpers and every published unit; out: double[5] as nx_js_thread_stats
  nx_js_thread_prepare__deps: ['$nxThread', '$nxSync', 'nx_js_thread_stats'],
  nx_js_thread_prepare__sig: 'vp',
  nx_js_thread_prepare: function(out) {
    const t = nxThread(); t.syncMs = 0; t.syncBytes = 0; t.compileMs = 0;
    nxSync(t);
    _nx_js_thread_stats(out);
  },
  // Fetch one A64Host.exportCache() blob (synchronously: this is a worker) and publish its units. Units of nxweb's
  // unshared mode import an unshared memory: their memory import is rewritten to shared with a maximum (the code
  // itself is valid on a shared memory). Returns the unit count; out: double[3] = wasm bytes, functions, fetch ms
  nx_js_cache_publish__deps: ['$NX', 'nx_unit_publish', 'nx_unit_count', 'nx_unit_base', 'malloc'],
  nx_js_cache_publish__sig: 'ipdp',
  nx_js_cache_publish: function(urlPtr, maxPages, out) {
    const t0 = performance.now();
    const x = new XMLHttpRequest(); x.open('GET', UTF8ToString(urlPtr), false); x.responseType = 'arraybuffer'; x.send();
    if (x.status !== 200) { err('cache blob: HTTP ' + x.status); return 0; }
    const blob = new Uint8Array(x.response), dv = new DataView(x.response), fetchMs = performance.now() - t0;
    const m64 = dv.getUint32(0, true) === 0x44343641, n = dv.getUint32(8, true);
    const leb = (v) => { const o = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 128; o.push(b); } while (v); return o; };
    const share = (u) => {   // rewrite `(import "env" "memory" (memory ...))` to shared, max = maxPages
      let p = 8;
      const rd = () => { let v = 0, m = 1, b; do { b = u[p++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
      while (p < u.length) {
        const sec = p, id = u[p++], size = rd(), start = p;
        if (id !== 2) { p = start + size; continue; }
        const cnt = rd();
        for (let i = 0; i < cnt; i++) {
          let l = rd(); p += l; l = rd(); p += l;
          const kind = u[p++];
          if (kind === 0) rd();
          else if (kind === 1) { p++; const f = u[p++]; rd(); if (f & 1) rd(); }
          else if (kind === 3) p += 2;
          else if (kind === 2) {
            const at = p, f = u[p++], min = rd(); if (f & 1) rd();
            if (f & 2) return u;   // already shared
            const repl = [f | 3, ...leb(min), ...leb(maxPages)], body = [...u.subarray(start, at), ...repl, ...u.subarray(p, start + size)];
            const head = [...u.subarray(0, sec), 2, ...leb(body.length)];
            const o = new Uint8Array(head.length + body.length + u.length - (start + size));
            o.set(head, 0); o.set(body, head.length); o.set(u.subarray(start + size), head.length + body.length);
            return o;
          }
        }
        return u;
      }
      return u;
    };
    let p = 16, bytes = 0, funcs = 0, base = 2;
    const have = _nx_unit_count();
    for (let i = 0; i < have; i++) base = Math.max(base, _nx_unit_base(i) + 4096);   // past the units published so far
    if (NX.cacheBase) base = NX.cacheBase;
    for (let k = 0; k < n; k++) {
      const np = dv.getUint32(p, true), ns = dv.getUint32(p + 4, true), nb = dv.getUint32(p + 8, true);
      p += 16 + np * (m64 ? 8 : 4) + ns * 4;
      const u = share(blob.subarray(p, p + nb)); p += (nb + 3) & ~3;
      const q = _malloc(u.length);
      if (!q) { err('cache blob: out of memory for the registry after ' + k + ' units'); break; }
      HEAPU8.set(u, q);
      _nx_unit_publish(q, u.length, base, np);
      base += np; bytes += u.length; funcs += np;
    }
    NX.cacheBase = base;
    HEAPF64[out / 8] = bytes; HEAPF64[out / 8 + 1] = funcs; HEAPF64[out / 8 + 2] = fetchMs;
    return n;
  },
});
