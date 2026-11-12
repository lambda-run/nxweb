// nxem: the guest execution seam, JS half (an Emscripten --js-library; the same code runs in every pthread's worker).
// Each worker keeps ONE instance of nxweb's translated code: its own function table, its own core module instance
// (the CPU state is that instance's wasm globals) and its own instance of every unit, all on the one shared memory
// (Emscripten's wasmMemory). Table indices are the same in every worker, so the pc map in the memory serves all.
// NXA64 is nxweb's src/glue/a64_host.ts + rt_layout.ts, bundled unchanged (build_p2.sh) and included as --pre-js.
addToLibrary({
  $NX: { t: null, host: null, published: 0 },   // pcs >= 0xFFFFFF00 return to the embedder: 0xFFFFFFF0 = thread exit, 0xFFFFFFC0 = return from a host call

  // the pc map (two levels; nxweb src/a64/README.md) read from the shared memory: pc -> table index, 0 = not translated
  $nxPcMap__deps: ['$NX'],
  $nxPcMap: function(pc) {
    const lay = NXA64.A64, page = Math.floor(pc / 65536);
    const leaf = HEAPU32[(lay.pcmapBase + page * 4) >>> 2];
    return HEAPU32[(leaf + (pc % 65536 & 0xFFFC)) >>> 2];
  },

  // instantiate the units this worker does not have yet
  $nxSync__deps: ['$NX', 'nx_unit_count', 'nx_unit_bytes', 'nx_unit_len', 'nx_unit_base'],
  $nxSync: function(t) {
    const n = _nx_unit_count();
    for (; t.n < n; t.n++) {
      const p = _nx_unit_bytes(t.n), len = _nx_unit_len(t.n), base = _nx_unit_base(t.n);
      const t0 = performance.now();
      const mod = new WebAssembly.Module(HEAPU8.slice(p, p + len));
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

  $nxThread__deps: ['$NX', '$nxSync', '$nxTranslate', 'nx_svc', 'nx_mod_ptr', 'nx_mod_len', 'nx_table_cap', 'malloc'],
  $nxThread: function() {
    if (NX.t) return NX.t;
    const mem = wasmMemory, t0 = performance.now();
    const bytes = (w) => HEAPU8.slice(_nx_mod_ptr(w), _nx_mod_ptr(w) + _nx_mod_len(w));
    const t = { n: 0, syncMs: 0, syncBytes: 0 };
    t.table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
    t.core = new WebAssembly.Instance(new WebAssembly.Module(bytes(0)), { env: { memory: mem, table: t.table, translate: (pc) => nxTranslate(t, pc) } }).exports;
    const hx = new WebAssembly.Instance(new WebAssembly.Module(bytes(1)), { env: { memory: mem, abort: () => { throw new Error('a64 helpers abort'); } } }).exports;
    t.hlp = {};
    for (const k in hx) if (!['staticBase', 'staticEnd', 'memory', 'libcStat', 'libcGuard'].includes(k)) t.hlp[k] = hx[k];
    t.ctx = _malloc(0x400);
    const core = t.core;
    t.unitEnv = {
      memory: mem, table: t.table,
      svc: (n) => { core.save_ctx(t.ctx); _nx_svc(n, t.ctx); core.load_ctx(t.ctx); },
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
    HEAPU8.fill(0, t.ctx, t.ctx + 0x330); c.load_ctx(t.ctx);
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
    c.save_ctx(save);
    c.x0.value = a0; c.x1.value = a1; c.x2.value = a2; const RET = BigInt(0xFFFFFFC0);
    c.x30.value = RET; c.pc.value = pc;
    while (c.pc.value !== RET) { c.budget.value = 1 << 30; c.run(); }
    const r = c.x0.value;
    c.load_ctx(save); _free(save);
    return r;
  },

  // ---- the translator thread's realm
  nx_js_tr_init__deps: ['$NX', 'nx_mod_set', 'malloc'],
  nx_js_tr_init__sig: 'vpipidd',
  nx_js_tr_init: function(tr, trLen, hlp, hlpLen, codeLo, codeSize) {
    const stop = (what) => () => { throw new Error('the translator realm does not run guest code (' + what + ')'); };
    const host = new NXA64.A64Host(HEAPU8.slice(tr, tr + trLen), HEAPU8.slice(hlp, hlp + hlpLen), {
      memory: wasmMemory, shared: true, layout: Object.assign({}, NXA64.A64, { codeRegionLo: codeLo }),
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
  nx_js_tid: function() { return typeof require === 'function' ? require('worker_threads').threadId : -1; },
  nx_js_thread_stats__deps: ['$NX'],
  nx_js_thread_stats__sig: 'vp',
  nx_js_thread_stats: function(out) {   // double[4]: setup ms, unit instantiate ms, unit bytes, units
    const t = NX.t; if (!t) return;
    HEAPF64[out / 8] = t.setupMs; HEAPF64[out / 8 + 1] = t.syncMs; HEAPF64[out / 8 + 2] = t.syncBytes; HEAPF64[out / 8 + 3] = t.n;
  },
});
