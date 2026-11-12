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
    if (idx <= 1) throw new Error('no translatable code at pc 0x' + pc.toString(16));
    return idx;
  },

  $nxThread__deps: ['$NX', '$nxSync', '$nxTranslate', 'nx_svc', 'nx_host_call', 'nx_guest_fault', 'nx_note_pc', 'nx_mod_ptr', 'nx_mod_len', 'nx_table_cap', 'nx_is64', 'malloc', '$stringToUTF8', '$lengthBytesUTF8'],
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
    // context blocks, one per nesting level: an SVC or a host call may run guest code (nx_guest_call), whose own SVCs
    // and host calls must not write over the block the outer one is still working on
    t.ctx = _malloc(0x400 * 32); t.depth = 0;
    t.enter = () => { if (t.depth >= 31) throw new Error('guest calls nested more than 31 deep'); return t.ctx + 0x400 * ++t.depth; };
    const core = t.core, m64 = _nx_is64();
    t.save = m64 ? (p) => core.save_ctx(BigInt(p)) : core.save_ctx;   // the wasm64 core takes its pointer as an i64
    t.load = m64 ? (p) => core.load_ctx(BigInt(p)) : core.load_ctx;
    t.unitEnv = {
      memory: mem, table: t.table,
      svc: (n) => { const c = t.enter(); t.save(c); _nx_svc(n, c); t.load(c); t.depth--; },
      unimpl: (pc, w) => { throw new Error('unimplemented instruction ' + (w >>> 0).toString(16) + ' at ' + pc.toString(16)); },
      brk: (pc) => { throw new Error('brk at ' + pc.toString(16)); },
      cntpct: () => BigInt(Math.round(performance.now() * 19200)),
    };
    t.tramp = t.table.get(0);
    t.table.grow(_nx_table_cap() - t.table.length, t.tramp);
    // slot 2: the one function every host stub's pc maps to (as nxweb's rt_runtime.ts THUNK): it calls host_call
    const THUNK = new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 0x11, 1, 3, 0x65, 0x6E, 0x76, 9, 0x68, 0x6F, 0x73, 0x74, 0x5F, 0x63, 0x61, 0x6C, 0x6C, 0, 0,
                                  3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 1, 0x0A, 6, 1, 4, 0, 0x10, 0, 0x0B]);
    t.table.set(2, new WebAssembly.Instance(new WebAssembly.Module(THUNK), { env: { host_call: () => { const c = t.enter(); t.save(c); _nx_host_call(c); t.load(c); t.depth--; } } }).exports.f);
    // run until pc is `until`; a trap in translated code ends the process with a report (pthread_exit's unwind passes through)
    t.runTo = (until) => {
      try { while (core.pc.value !== until) { core.budget.value = 1 << 26; core.run(); _nx_note_pc(Number(BigInt.asUintN(64, core.pc.value))); } }
      catch (e) {
        if (e === 'unwind' || (e && e.name === 'ExitStatus')) throw e;
        const m = String(e && e.message || e), p = _malloc(lengthBytesUTF8(m) + 1); stringToUTF8(m, p, lengthBytesUTF8(m) + 1);
        err(String(e && e.stack || e).split('\n').slice(0, 6).join(' | '));
        _nx_guest_fault(Number(BigInt.asUintN(64, core.pc.value)), p);
        throw e;
      }
    };
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
    c.x0.value = HEAPU64[q]; c.x1.value = HEAPU64[q + 1]; c.x2.value = HEAPU64[q + 2]; c.x3.value = HEAPU64[q + 3]; c.x4.value = HEAPU64[q + 4];
    c.pc.value = HEAPU64[q + 5]; c.sp.value = HEAPU64[q + 6]; const EXIT = BigInt(0xFFFFFFF0);
    c.x30.value = EXIT;
    t.runTo(EXIT);
    HEAPU64[q] = c.x0.value;
  },
  // A fresh CPU state for the calling thread: everything zero, then sp and the thread's TLS block / thread-local region
  nx_js_guest_setup__deps: ['$nxThread', 'nx_tlr', 'nx_tls'],
  nx_js_guest_setup__sig: 'vd',
  nx_js_guest_setup: function(sp) {
    const t = nxThread(), c = t.core;
    t.depth = 0;   // a worker that a thread left by pthread_exit (inside an SVC) starts clean
    HEAPU8.fill(0, t.ctx, t.ctx + 0x330); t.load(t.ctx);
    c.sp.value = BigInt(sp); c.tpidr.value = BigInt(_nx_tls()); c.tpidrro.value = BigInt(_nx_tlr()); c.excl_addr.value = BigInt(-1);
  },

  // A host call into guest code on the calling guest thread (nested inside whatever that thread was doing, an SVC included).
  nx_guest_call__deps: ['$nxThread', 'malloc', 'free'],
  nx_guest_call__sig: 'jjjjj',
  nx_guest_call: function(pc, a0, a1, a2) {
    const t = nxThread(), c = t.core, save = _malloc(0x400);
    t.save(save);
    c.x0.value = a0; c.x1.value = a1; c.x2.value = a2; const RET = BigInt(0xFFFFFFC0);
    c.x30.value = RET; c.pc.value = pc;
    t.runTo(RET);
    const r = c.x0.value;
    t.load(save); _free(save);
    return r;
  },

  // ---- the translator thread's realm
  nx_js_tr_init__deps: ['$NX', 'nx_mod_set', 'nx_is64', 'malloc', '$nxLoadGame'],
  nx_js_tr_init__sig: 'vpipiddp',
  nx_js_tr_init: function(tr, trLen, hlp, hlpLen, codeLo, codeSize, boot) {
    const stop = (what) => () => { throw new Error('the translator realm does not run guest code (' + what + ')'); };
    const host = new NXA64.A64Host(HEAPU8.slice(tr, tr + trLen), HEAPU8.slice(hlp, hlp + hlpLen), {
      memory: wasmMemory, shared: true, layout: Object.assign({}, NXA64.A64, { codeRegionLo: codeLo }),
      mem64: !!_nx_is64(), memoryMaxPages: wasmMemory.buffer.byteLength / 65536,   // no growth: the maximum is the size
      leafAlloc: () => _malloc(65536),   // pc-map leaves beyond the fixed arena (64 KB per 64 KB of code that has translations)
      imports: { svc: stop('svc'), unimpl: stop('unimpl'), brk: stop('brk'), cntpct: () => BigInt(0) },
    });
    host.keepBytes = true;
    host.table.grow(1);   // slot 2 is the host stubs' thunk in every guest thread's table: no unit may take it
    NX.host = host;
    if (boot && HEAPF64[boot / 8]) nxLoadGame(host, boot / 8); else host.addCode(codeLo, codeSize);
    const put = (which, b) => { const p = _malloc(b.length); HEAPU8.set(b, p); _nx_mod_set(which, p, b.length); };
    put(0, host.coreBytes);
    put(1, HEAPU8.slice(hlp, hlp + hlpLen));
  },
  nx_js_tr_job__deps: ['$NX', 'nx_unit_publish', 'malloc', '$UTF8ToString'],
  nx_js_tr_job__sig: 'did',
  nx_js_tr_job: function(kind, pc) {
    const h = NX.host;
    if (kind === 1) {   // a symbol's address, by name, from the loader's tables (0: none, or it is a host stub)
      const a = NX.ld ? NX.ld.lookup(UTF8ToString(pc)) : undefined;
      return a === undefined || NX.ld.stubId(a) >= 0 ? 0 : a;
    }
    if (kind === 2) {   // module_sym: a symbol of one module; pc -> { name address, module index }
      const q = pc / 8, m = NX.mods && NX.mods[Number(HEAPU64[q + 1])];
      const a = m ? NX.ld.lookupIn(m.handle, UTF8ToString(Number(HEAPU64[q]))) : undefined;
      return a === undefined || NX.ld.stubId(a) >= 0 ? 0 : a;
    }
    if (kind === 3) {   // dm_game_imports: does a module refer to a host name that starts with the prefix
      const p = UTF8ToString(pc);
      return NX.ld && NX.ld.hostFunctions().some(f => f.refs > 0 && f.name.startsWith(p)) ? 1 : 0;
    }
    let idx = h.getPcMap(pc);
    try { if (idx <= 1) idx = h.translateUnit([BigInt(pc)])[0]; } catch (e) { err('translator: ' + (e && e.message || e)); return 0; }
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

  // ---- loading a real game (the translator thread's realm): nxweb's loader module and its glue, as they are.
  // boot (doubles): [0] loader64.wasm ptr, [1] len, [2] file count, [3 + 3i] name ptr, file ptr, file len, [30] first base;
  // out: [38] index of nnosInitialize in the start list, [39] nnMain, [40] start list length, [41..] the pcs to call in
  // order (nxweb rt_runtime.ts sdkStart = nxnative main.c: _init_libc0, nnosInitialize, _init_libc1,
  // nninitInitializeSdkModule, nninitStartup, _init_libc2, each module's DT_INIT).
  $nxLoadGame__deps: ['$NX', 'nx_module_add', 'nx_stub_set', 'nx_stub_base_set', 'nx_hle_name_count', 'nx_hle_name_at', 'nx_hle_name_flags', 'malloc', 'free', '$UTF8ToString', '$stringToUTF8', '$lengthBytesUTF8'],
  $nxLoadGame: function(host, B) {
    const A = NXA64, D = HEAPF64, pages = wasmMemory.buffer.byteLength / 65536;
    const cstr = (s) => { const n = lengthBytesUTF8(s) + 1, p = _malloc(n); stringToUTF8(s, p, n); return p; };
    const env = { memory: wasmMemory, memory_size: () => pages, memory_grow: (n) => n ? -1 : pages, debug_string: () => {}, abort: () => { throw new Error('abort in the loader module'); },
                  log: (p, n) => err('[loader] ' + new TextDecoder().decode(HEAPU8.slice(p, p + n))) };
    const lx = A.instantiate(new WebAssembly.Module(A.sharedBuild(HEAPU8.slice(D[B], D[B] + D[B + 1]), pages)), { env }, { mem64: true, name: 'loader64.wasm' });
    if (!lx.memory) lx.memory = wasmMemory;
    const arena = A.range('loader arena');
    const ld = new A.Loader(lx, { arena: arena.lo, arenaLen: arena.hi - arena.lo, stubBase: A.STUBS.base, stubCap: A.STUBS.cap });
    // the names nxnative's host answers (the generated HLE table, when it is linked): forced ones win over a module's own definition
    // flags (hle/nx_hle.h): 1 an import's answer, 2 / 4 forced, 16 libc pass-through; NVN names (8) are handed out by the bootstrap loader, not bound
    let nNames = 0;
    for (let i = 0, n = _nx_hle_name_count(); i < n; i++) { const f = _nx_hle_name_flags(i); if (f & 23) { ld.hostAdd(UTF8ToString(_nx_hle_name_at(i)), !!(f & 6)); nNames++; } }
    const files = [];
    for (let i = 0; i < D[B + 2]; i++) files.push({ name: UTF8ToString(D[B + 3 + 3 * i]), ptr: D[B + 4 + 3 * i], len: D[B + 5 + 3 * i] });
    let next = D[B + 30];
    const set = ld.loadSet(files, (size) => { const b = next; next = Math.ceil((b + size + 0x1000) / 0x1000) * 0x1000; return b; }, { verifyHash: false });
    for (const m of set.modules) {
      const n = cstr(m.name); _nx_module_add(n, m.base, m.imageSize, m.text.addr + m.text.size - m.base, m.ro.addr - m.base, m.data.addr - m.base); _free(n);
      host.addCode(m.base, m.imageSize, { text: { lo: m.text.addr, hi: m.text.addr + m.text.size } });
      ld.pin(m.handle);
    }
    _nx_stub_base_set(A.STUBS.base);
    const hf = ld.hostFunctions();
    for (const f of hf) { const n = cstr(f.name); _nx_stub_set(f.id, n); _free(n); }
    host.fillPcMap(A.STUBS.base, A.STUBS.cap, 2);
    const find = (name) => { for (const m of set.modules) { const a = ld.lookupIn(m.handle, name); if (a !== undefined && ld.stubId(a) < 0) return a; } return 0; };
    const list = [];
    for (const n of ['_init_libc0', 'nnosInitialize', '_init_libc1', 'nninitInitializeSdkModule', 'nninitStartup', '_init_libc2']) { const a = find(n); if (a) { if (n === 'nnosInitialize') D[B + 38] = list.length; list.push(a); } }
    for (const m of set.modules) { if (m.init) list.push(m.init); else list.push(...m.initArray); }
    D[B + 39] = find('nnMain'); D[B + 40] = list.length;
    list.forEach((a, i) => { D[B + 41 + i] = a; });
    NX.ld = ld; NX.mods = set.modules;
    err('[loader] ' + set.modules.map(m => m.name + ' at 0x' + m.base.toString(16) + ' +0x' + m.imageSize.toString(16)).join(', ') + '; ' + nNames + ' host names registered, ' + hf.filter(f => f.refs).length + ' of ' + hf.length + ' stubs referred to, ' + set.unresolved.length + ' imports nothing answers');
  },
});
