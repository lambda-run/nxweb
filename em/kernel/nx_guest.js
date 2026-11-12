// nxem: the guest execution seam, JS half (an Emscripten --js-library; the same code runs in every pthread's worker).
// Each worker keeps ONE instance of nxweb's translated code: its own function table, its own core module instance
// (the CPU state is that instance's wasm globals) and its own instance of every unit, all on the one shared memory
// (Emscripten's wasmMemory). Table indices are the same in every worker, so the pc map in the memory serves all.
// nxLoadA64() gives nxweb's src/glue/a64_host.ts, rt_layout.ts and loader glue, bundled unchanged (build.py) as a
// --pre-js. Only the translator thread's realm runs it: the script is part of every worker's source, and every guest
// thread is a worker, so what a guest thread needs of it (where the pc map is) comes from the shared memory instead.
addToLibrary({
  $NX: { t: null, host: null, published: 0 },   // pcs >= 0xFFFFFF00 return to the embedder: 0xFFFFFFF0 = thread exit, 0xFFFFFFC0 = return from a host call

  // the pc map (two levels; nxweb src/a64/README.md) read from the shared memory: pc -> table index, 0 = not translated
  $nxPcMap__deps: ['$NX', 'nx_is64', 'nx_pcmap_base'],
  $nxPcMap: function(pc) {
    const lay = NX.lay || (NX.lay = { pcmapBase: _nx_pcmap_base() }), page = Math.floor(pc / 65536);
    if (!_nx_is64()) return HEAPU32[(HEAPU32[(lay.pcmapBase + page * 4) >>> 2] + (pc % 65536 & 0xFFFC)) >>> 2];
    if (pc >= HEAPU8.length) return 0;   // memory64: the first level has 8-byte entries and covers the memory
    return HEAPU32[(Number(HEAPU64[lay.pcmapBase / 8 + page]) + (pc % 65536 & 0xFFFC)) / 4];
  },

  // A worker instantiates a unit when it first calls into it (most guest threads run a small part of the code): every
  // table slot it has not filled holds the trampoline, which lands in nxTranslate with the pc.
  $nxUnit__deps: ['$NX', 'nx_core_out', 'nx_core_in', 'nx_unit_bytes', 'nx_unit_len', 'nx_unit_base', 'nx_unit_nfuncs'],
  $nxUnit: function(t, k) {
    if (t.have[k]) return;
    const p = _nx_unit_bytes(k), len = _nx_unit_len(k), base = _nx_unit_base(k);
    _nx_core_out();   // host work: the thread's virtual core is free meanwhile (kernel/nx_cores.c)
    const t0 = performance.now();
    // the module the main thread compiled and sent to this worker before its thread started (kernel/nx_owner.js
    // nx_units_share), when there is one: a module compiled here from the bytes is a copy of the code for this thread alone
    let mod = globalThis.NXSHARED && globalThis.NXSHARED[k];
    if (mod) t.shared++; else mod = new WebAssembly.Module(HEAPU8.slice(p, p + len));
    t.compileMs += performance.now() - t0;
    const end = base + _nx_unit_nfuncs(k);
    if (end > t.table.length) t.table.grow(Math.max(end - t.table.length, 1 << 18), t.tramp);
    new WebAssembly.Instance(mod, { cpu: t.core, hlp: t.hlp, env: Object.assign({ table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, base) }, t.unitEnv) });
    t.have[k] = 1; t.n++;
    _nx_core_in();
    if (typeof process !== 'undefined' && process.env && process.env.NX_MEMDBG && (t.n === 1 || t.n === 20 || t.n === 200) && (NX.dbg = (NX.dbg || 0) + 1) < 4) { const m = process.memoryUsage(); err('[memdbg] worker with ' + t.n + ' units (' + t.shared + ' shared): JS heap used ' + (m.heapUsed / 1048576).toFixed(1) + ' MB of ' + (m.heapTotal / 1048576).toFixed(1) + ', external ' + (m.external / 1048576).toFixed(1) + ' MB; shared modules held ' + (globalThis.NXSHARED ? globalThis.NXSHARED.length : 0)); }
    t.syncMs += performance.now() - t0; t.syncBytes += len;
  },
  // the unit that holds table slot idx, instantiated here; false when the registry has none yet
  $nxNeed__deps: ['$nxUnit', 'nx_unit_count', 'nx_unit_base', 'nx_unit_nfuncs'],
  $nxNeed: function(t, idx) {
    for (let k = t.bases.length, n = _nx_unit_count(); k < n; k++) { const b = _nx_unit_base(k); t.bases.push(b); t.ends.push(b + _nx_unit_nfuncs(k)); }
    for (let k = t.bases.length - 1; k >= 0; k--) if (idx >= t.bases[k] && idx < t.ends[k]) { nxUnit(t, k); return true; }
    return false;
  },
  // every published unit (the gate's measurement)
  $nxSync__deps: ['$nxUnit', 'nx_unit_count'],
  $nxSync: function(t) { for (let k = 0, n = _nx_unit_count(); k < n; k++) nxUnit(t, k); },

  // the `translate` import of this worker's core: called through table slot 0 when the pc map has no function for pc,
  // or when it names a slot this worker has not filled yet (every empty slot holds the same trampoline)
  $nxTranslate__deps: ['$nxNeed', '$nxPcMap', 'nx_translate'],
  $nxTranslate: function(t, pcBig) {
    const pc = Number(BigInt.asUintN(64, pcBig));
    let idx = nxPcMap(pc);
    if (idx > 1 && (t.table.get(idx) !== t.tramp || nxNeed(t, idx))) return idx;
    idx = _nx_translate(pc);   // behind the translator's lock: what it returns is published
    if (idx <= 1) throw new Error('no translatable code at pc 0x' + pc.toString(16));
    if (!nxNeed(t, idx)) throw new Error('the unit of table slot ' + idx + ' (pc 0x' + pc.toString(16) + ') is not in the registry');
    return idx;
  },

  $nxThread__deps: ['$NX', '$nxTranslate', '$nxPcMap', 'nx_unit_count', 'nx_unit_base', 'nx_unit_nfuncs', 'nx_svc', 'nx_host_call', 'nx_guest_fault', 'nx_slice_budget', 'nx_note_pc', 'nx_cntpct', 'nx_mod_ptr', 'nx_mod_len', 'nx_table_cap', 'nx_is64', 'malloc', '$stringToUTF8', '$lengthBytesUTF8'],
  $nxThread: function() {
    if (NX.t) return NX.t;
    const mem = wasmMemory, t0 = performance.now();
    const bytes = (w) => HEAPU8.slice(_nx_mod_ptr(w), _nx_mod_ptr(w) + _nx_mod_len(w));
    const t = { n: 0, shared: 0, syncMs: 0, syncBytes: 0, compileMs: 0, have: [], bases: [], ends: [] };
    t.table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
    t.core = new WebAssembly.Instance(new WebAssembly.Module(bytes(0)), { env: { memory: mem, table: t.table, translate: (pc) => nxTranslate(t, pc) } }).exports;
    const hx = new WebAssembly.Instance(new WebAssembly.Module(bytes(1)), { env: { memory: mem, abort: () => { throw new Error('a64 helpers abort'); } } }).exports;
    // The helpers keep scratch blocks for their vector operations in static memory: ONE place for every instance on this
    // memory unless each is given its own (src/a64/helpers.ts setScratch; nxweb's a64_host.ts helperScratch does it for
    // its helper Workers). Until b74d623 the port did not: every guest thread's NEON helper calls (the table lookups,
    // the pairwise and polynomial operations, AES...) wrote their operands to the same 128 bytes, and two threads inside
    // such a helper at once got each other's values. That is the title's NaN transform (2026-11-12).
    if (!hx.setScratch) throw new Error('the a64 helpers have no setScratch: every thread would share one scratch block');
    if (!(typeof process !== 'undefined' && process.env && process.env.NX_TEST_SHARED_SCRATCH))   // (the test's negative control, Node only: every thread on the one static block, as it was)
    { const sc = Math.ceil(_malloc(128 + 16) / 16) * 16;   /* (not `& ~15`: the address is above 4 GB) */ HEAPU8.fill(0, sc, sc + 128); hx.setScratch(_nx_is64() ? BigInt(sc) : sc); t.scratch = sc; }
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
      cntpct: () => BigInt(_nx_cntpct()),
    };
    t.tramp = t.table.get(0);
    t.budget = _nx_slice_budget();   // instructions per slice: short when guest threads share virtual cores (kernel/nx_cores.c)
    // The table: one slot per translated function, the trampoline in every slot this thread has not filled. It is as
    // long as what is published now (plus room) and grows when a call lands beyond it (runTo): a slot costs 32 bytes
    // in every thread, and a thread that started early or runs little code need not hold the whole program's.
    t.cover = () => { let end = 4096; for (let k = 0, n = _nx_unit_count(); k < n; k++) end = Math.max(end, _nx_unit_base(k) + _nx_unit_nfuncs(k)); end = Math.ceil((end + 2048) / 4096) * 4096;
      if (end > t.table.length) t.table.grow(end - t.table.length, t.tramp); };
    t.cover();
    // slot 2: the one function every host stub's pc maps to (as nxweb's rt_runtime.ts THUNK): it calls host_call
    const THUNK = new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 0x11, 1, 3, 0x65, 0x6E, 0x76, 9, 0x68, 0x6F, 0x73, 0x74, 0x5F, 0x63, 0x61, 0x6C, 0x6C, 0, 0,
                                  3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 1, 0x0A, 6, 1, 4, 0, 0x10, 0, 0x0B]);
    t.table.set(2, new WebAssembly.Instance(new WebAssembly.Module(THUNK), { env: { host_call: () => { const c = t.enter(); t.save(c); _nx_host_call(c); t.load(c); t.depth--; } } }).exports.f);
    // run until pc is `until`; a trap in translated code ends the process with a report (pthread_exit's unwind passes through)
    t.runTo = (until) => {
      try { while (core.pc.value !== until) { core.budget.value = t.budget; core.run(); _nx_note_pc(Number(BigInt.asUintN(64, core.pc.value))); } }
      catch (e) {
        if (e === 'unwind' || (e && e.name === 'ExitStatus')) throw e;
        // a call through a table slot beyond this thread's table: a function another thread had translated since. The
        // registers were written back and pc is the target (the contract of an indirect transfer), so grow and go on
        if (e instanceof WebAssembly.RuntimeError && /table index is out of bounds/.test(e.message)) {
          const idx = nxPcMap(Number(BigInt.asUintN(64, core.pc.value))), len = t.table.length;
          if (idx >= len) { t.cover(); if (t.table.length > len) { t.grown = (t.grown || 0) + 1; return t.runTo(until); } }
        }
        const m = String(e && e.message || e), p = _malloc(lengthBytesUTF8(m) + 1); stringToUTF8(m, p, lengthBytesUTF8(m) + 1);
        err(String(e && e.stack || e).split('\n').slice(0, 6).join(' | '));
        let c = 0; try { c = t.enter(); t.save(c); } catch (e2) {}   // the registers as the core has them, for the report
        _nx_guest_fault(Number(BigInt.asUintN(64, core.pc.value)), p, c);
        throw e;
      }
    };
    NX.t = t;
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

  // A host call into guest code on the calling guest thread (nested inside whatever that thread was doing, an SVC or a
  // host call included): a[0..n-1] -> x0.., a[8] = pc; the function's x0 comes back in a[0]. The caller's registers
  // are saved and restored around it (the callee-saved ones must survive for the host function's caller).
  // This thread's instance of nxweb's NVN recorder (kernel/nx_gfx.c): the build for further instances that the owner
  // put into the memory (owner/owner.ts GFX_MOD), over the shared memory. Its imports: gfx_exec (the replayer), the
  // stub of an entry point and more table memory are the owner's, asked through the lock holder's request words at
  // NXG; a callback into guest code runs here, on the calling thread. Addresses are i64 in this build (nx.abi).
  $nxGfx__deps: ['$NX', 'nx_gfx_guest_call', 'nx_core_out', 'malloc'],
  $nxGfx: function() {
    const G = 0x1FF1F000, MOD = 0x1FF20000, s = (G + 8) / 4, f = G / 8, t0 = performance.now();
    const mod = new WebAssembly.Module(HEAPU8.slice(MOD, MOD + HEAPU32[(G + 40) / 4]));
    const ask = (kind, a, b) => {
      HEAP32[s + 1] = kind; HEAPF64[f + 2] = a; HEAPF64[f + 3] = b;
      Atomics.store(HEAP32, s, 1); Atomics.notify(HEAP32, s);
      for (let spin = 0; Atomics.load(HEAP32, s) !== 2; spin++) if (spin > 4000) { if (spin === 4001) _nx_core_out(); Atomics.wait(HEAP32, s, 1, 5); }   // (a flush is a millisecond or more: the thread's virtual core is free meanwhile)
      const r = HEAPF64[f + 4];
      Atomics.store(HEAP32, s, 0);
      return r;
    };
    const blk = _malloc(48), pages = HEAPU8.length / 65536;
    const env = {
      memory: wasmMemory, memory_size: () => pages, memory_grow: (n) => n ? -1 : pages,
      log: (p, n) => err(new TextDecoder().decode(HEAPU8.slice(Number(p), Number(p) + n))),
      abort: () => { throw new Error('abort in the gfx module'); },
      gfx_exec: (p, n) => { ask(0, Number(p), n >>> 0); },
      gfx_proc_address: (id) => BigInt(ask(1, id, 0)),
      gfx_arena_more: (n) => ask(2, n >>> 0, 0),
      gfx_guest_call: (fn, a0, a1, a2, a3) => { const q = blk / 8, v = [fn, a0, a1, a2, a3]; for (let i = 0; i < 5; i++) HEAPU64[q + i] = BigInt.asUintN(64, v[i]); _nx_gfx_guest_call(blk); return HEAPU64[q]; },
    };
    const x = new WebAssembly.Instance(mod, { env }).exports;
    NX.gfx = x; NX.gfxMs = performance.now() - t0;
    return x;
  },
  // nvn_call(id, args) in this thread's instance; the result goes to args[16]. The caller holds the recorder's lock
  nx_js_gfx_call__deps: ['$NX', '$nxGfx'],
  nx_js_gfx_call__sig: 'vid',
  nx_js_gfx_call: function(id, args) {
    const x = NX.gfx || nxGfx();
    try { HEAPU64[args / 8 + 16] = BigInt.asUintN(64, x.nvn_call(id, BigInt(args))); }
    catch (e) { if (e === 'unwind' || (e && e.name === 'ExitStatus')) throw e; HEAPU64[args / 8 + 16] = 0n; err('[RED] nvn_call(' + id + ') failed in a guest thread: ' + String(e && e.stack || e).split('\n').slice(0, 5).join(' | ')); }
  },
  // This thread's instance of nxweb's fs module (kernel/nx_gfx.c nx_fs_direct; owner/owner.ts NXF, FS_MOD). Its storage
  // imports are the owner's: asked with the arguments as i64 and the caller's context block (a storage call that is
  // not answered at once is completed by the owner, which then wakes that block's cell).
  $nxFs__deps: ['$NX'],
  $nxFs: function() {
    const F = 0x1FF1F100, MOD = 0x1FFA0000, s = (F + 8) / 4, q = F / 8;
    const mod = new WebAssembly.Module(HEAPU8.slice(MOD, MOD + HEAPU32[(F + 24) / 4]));
    const ask = (kind, a) => {
      for (let i = 0; i < 6; i++) HEAP64[q + 4 + i] = i < a.length ? BigInt(a[i]) : 0n;
      HEAP64[q + 10] = BigInt(NX.fsCtx); HEAP32[s + 1] = kind;
      Atomics.store(HEAP32, s, 1); Atomics.notify(HEAP32, s);
      for (let spin = 0; Atomics.load(HEAP32, s) !== 2; spin++) if (spin > 4000) Atomics.wait(HEAP32, s, 1, 5);
      const r = HEAP64[q + 2];
      Atomics.store(HEAP32, s, 0);
      return r;
    };
    const pages = HEAPU8.length / 65536;
    const env = { memory: wasmMemory, memory_size: () => pages, memory_grow: (n) => n ? -1 : pages, abort: () => { throw new Error('fs: abort'); },
      log: (p, n) => err('[fs] ' + new TextDecoder().decode(HEAPU8.slice(Number(p), Number(p) + n))) };
    const fs = {
      dev_open: (kind, index, token) => Number(ask(0, [kind, index, token])),
      dev_size: (dev) => ask(1, [dev]),
      dev_read: (dev, off, ptr, len, token) => Number(ask(2, [dev, off, ptr, len >>> 0, token])),
      dev_write: (dev, off, ptr, len) => Number(ask(3, [dev, off, ptr, len >>> 0])),
      dev_flush: (dev, token) => Number(ask(4, [dev, token])),
      dev_remove: (kind, index, token) => Number(ask(5, [kind, index, token])),
      save_failed: (e) => { ask(6, [e]); },
      arena_more: (n) => ask(7, [n]),
    };
    return NX.fs = new WebAssembly.Instance(mod, { env, fs }).exports;
  },
  // fs_call(id, ctx) in this thread's instance: 0 done (x0 in the block holds the result), 1 pending, 2 retry. The caller holds the module's lock
  nx_js_fs_call__deps: ['$NX', '$nxFs'],
  nx_js_fs_call__sig: 'iid',
  nx_js_fs_call: function(id, ctx) {
    const x = NX.fs || nxFs();
    NX.fsCtx = ctx;
    let r;
    try { r = x.fs_call(id, BigInt(ctx)); }
    catch (e) { if (e === 'unwind' || (e && e.name === 'ExitStatus')) throw e; err('[RED] fs_call(' + id + ') failed in a guest thread: ' + String(e && e.stack || e).split('\n').slice(0, 5).join(' | ')); r = 0n; }
    if (r === -0x200000000n) return 2;
    if ((r >> 32n) === -1n) return 1;
    HEAPU64[ctx / 8] = BigInt.asUintN(64, r);
    return 0;
  },
  nx_js_guest_callv__deps: ['$nxThread'],
  nx_js_guest_callv__sig: 'vpi',
  nx_js_guest_callv: function(a, n) {
    const t = nxThread(), c = t.core, save = t.enter(), q = a / 8;
    t.save(save);
    for (let i = 0; i < n; i++) c['x' + i].value = HEAPU64[q + i];
    const RET = BigInt(0xFFFFFFC0);
    c.x30.value = RET; c.pc.value = HEAPU64[q + 8];
    t.runTo(RET);
    HEAPU64[q] = c.x0.value; HEAPU64[q + 1] = c.x1.value;
    t.load(save); t.depth--;
  },

  // ---- the translator thread's realm
  nx_js_tr_init__deps: ['$NX', 'nx_mod_set', 'nx_is64', 'nx_pcmap_set', 'malloc', '$nxLoadGame'],
  nx_js_tr_init__sig: 'vpipiddp',
  nx_js_tr_init: function(tr, trLen, hlp, hlpLen, codeLo, codeSize, boot) {
    const stop = (what) => () => { throw new Error('the translator realm does not run guest code (' + what + ')'); };
    const NXA64 = nxLoadA64();
    _nx_pcmap_set(NXA64.A64.pcmapBase);
    const host = new NXA64.A64Host(HEAPU8.slice(tr, tr + trLen), HEAPU8.slice(hlp, hlp + hlpLen), {
      memory: wasmMemory, shared: true, layout: Object.assign({}, NXA64.A64, { codeRegionLo: codeLo }),
      registryOnly: true,   // this realm runs no guest code: it translates, assigns table slots and publishes
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
  nx_js_tr_job__deps: ['$NX', '$nxPublish', 'malloc', 'free', 'nx_file_write', 'nx_js_cache_store', '$UTF8ToString'],
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
    if (kind === 4) {   // write the translation cache (when something was translated since it was read or written): the units of each module
      if (!NX.cacheDir || !NX.mods || h.cacheHits + h.translatedInsns === NX.cacheMark) return 0;
      let bytes = 0;
      for (const m of NX.mods) {
        const blob = h.exportCache(m.base, m.imageSize); if (blob.length <= 16) continue;
        const p = _malloc(blob.length); if (!p) { err('[RED] translation cache: no memory for a blob of ' + blob.length + ' bytes'); break; }
        HEAPU8.set(blob, p);
        const path = NX.cstr(NX.cacheDir + '/' + NX.cacheKey(m));
        if (_nx_file_write(path, p, blob.length)) { bytes += blob.length; _nx_js_cache_store(path); } else err('[RED] translation cache: ' + NX.cacheKey(m) + ' was not written');
        _free(path); _free(p);
      }
      NX.cacheMark = h.cacheHits + h.translatedInsns;
      err('[loader] translation cache: ' + (bytes / 1048576).toFixed(1) + ' MB written to ' + NX.cacheDir);
      return bytes;
    }
    if (kind === 5) {   // this realm's JS memory, for the report (Node)
      if (typeof process === 'undefined' || !process.memoryUsage) return 0;
      const m = process.memoryUsage(); err('[loader] translator realm: JS heap ' + (m.heapUsed >> 20) + ' MB, external ' + (m.external >> 20) + ' MB, array buffers ' + (m.arrayBuffers >> 20) + ' MB; units in its cache not yet used: ' + (h.cache ? new Set(h.cache.values()).size : '?'));
      return 0;
    }
    if (kind === 3) {   // dm_game_imports: does a module refer to a host name that starts with the prefix
      const p = UTF8ToString(pc);
      return NX.ld && NX.ld.hostFunctions().some(f => f.refs > 0 && f.name.startsWith(p)) ? 1 : 0;
    }
    let idx = h.getPcMap(pc);
    try { if (idx <= 1) idx = h.translateUnit([BigInt(pc)])[0]; } catch (e) { err('translator: ' + (e && e.message || e)); return 0; }
    nxPublish();
    return idx;
  },
  nx_js_tid__deps: ['$NX'],
  nx_js_tid: function() { return NX.rid || (NX.rid = 1 + Math.floor(Math.random() * 0x7FFFFFF0)); },   // one per JS realm = per worker
  nx_js_thread_stats__deps: ['$NX'],
  nx_js_thread_stats__sig: 'vp',
  nx_js_thread_stats: function(out) {   // double[4]: setup ms, unit instantiate ms, unit bytes, units
    const t = NX.t; if (!t) return;
    HEAPF64[out / 8 + 5] = t.shared;
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

  // the translator's new units into the registry (their bytes into the shared memory: the one copy)
  $nxPublish__deps: ['$NX', 'nx_unit_publish', 'malloc'],
  $nxPublish: function() {
    const h = NX.host;
    for (; NX.published < h.units.length; NX.published++) {
      const u = h.units[NX.published], p = _malloc(u.bytes.length);
      HEAPU8.set(u.bytes, p);
      _nx_unit_publish(p, u.bytes.length, u.tableBase, u.pcs.length);
      u.bytes = HEAPU8.subarray(p, p + u.bytes.length);
    }
  },

  // ---- loading a real game (the translator thread's realm): nxweb's loader module and its glue, as they are.
  // boot (doubles): [0] loader64.wasm ptr, [1] len, [2] file count, [3 + 3i] name ptr, file ptr, file len, [30] first base;
  // out: [38] index of nnosInitialize in the start list, [39] nnMain, [40] start list length, [41..] the pcs to call in
  // order (nxweb rt_runtime.ts sdkStart = nxnative main.c: _init_libc0, nnosInitialize, _init_libc1,
  // nninitInitializeSdkModule, nninitStartup, _init_libc2, each module's DT_INIT).
  $nxLoadGame__deps: ['$NX', '$nxPublish', 'nx_cache_dir', 'nx_file_read', 'nx_module_add', 'nx_stub_set', 'nx_stub_base_set', 'nx_hle_name_count', 'nx_hle_name_at', 'nx_hle_name_flags', 'malloc', 'free', '$UTF8ToString', '$stringToUTF8', '$lengthBytesUTF8'],
  $nxLoadGame: function(host, B) {
    const A = nxLoadA64(), D = HEAPF64, pages = wasmMemory.buffer.byteLength / 65536;
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
    // The translation cache (nxweb's: A64Host.exportCache / importCache blobs, one per module, keyed by the module's
    // build id, its base and the translator's options). Node: files in the directory NX_CACHE names.
    // Where: the directory NX_CACHE names (Node), or /cache in the page, which the owner fills from the Cache API before
    // main() and empties into it again when something was written (kernel/nx_owner.js nx_js_cache_store).
    NX.cacheDir = UTF8ToString(_nx_cache_dir());
    NX.cacheKey = (m) => { let h = 5381; for (const ch of host.optionsKey()) h = (h * 33 ^ ch.charCodeAt(0)) >>> 0;
      return m.name + '-' + Array.from(m.buildId.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('') + '-' + m.base.toString(16) + '-' + h.toString(16) + '.a64cache'; };
    NX.cstr = cstr;
    NX.cacheInsns = 0;
    if (NX.cacheDir) {
      let units = 0, bytes = 0; const t0 = performance.now(), lenAt = _malloc(8);
      for (const m of set.modules) {
        const path = cstr(NX.cacheDir + '/' + NX.cacheKey(m)), p = _nx_file_read(path, lenAt), n = Number(HEAPU64[lenAt / 8]);
        _free(path);
        if (!p) continue;
        units += host.importCache(HEAPU8.subarray(p, p + n)); bytes += n;   // (importCache copies what it keeps)
        _free(p);
      }
      _free(lenAt);
      NX.cacheInsns = host.translatedInsns;
      // every cached unit gets its table slots and goes into the registry now, so that the main thread can compile each
      // once and hand the compiled modules to the workers before guest threads start (a running thread cannot be sent one)
      if (units && host.cache) { for (const [pc, cu] of [...host.cache]) if (host.cache.get(pc) === cu) host.translateUnit([BigInt(pc)]); nxPublish(); }
      err('[loader] translation cache: ' + (units ? units + ' units, ' + (bytes / 1048576).toFixed(1) + ' MB from ' + NX.cacheDir + ' in ' + (performance.now() - t0).toFixed(0) + ' ms' : 'nothing in ' + NX.cacheDir + ' for these modules and options yet'));
    }
  },
});
