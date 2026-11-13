// The proof of the lock-free recording path (kernel/nx_gfx.c, tools/gfx_audit.mjs): nxweb's recorder on its own, no game.
// T command buffers, each with its own command memory. The same sequence of recording commands is written
//   A. into each of them by one thread, one after the other (the first instance of the recorder), and
//   B. into T further ones by T workers at the same time, each through its own instance of the recorder, with no lock;
// the command memory of every buffer of B must be byte for byte that of A. Every command used must be one the audit
// lets through without the lock. node em/test/gfx_lockfree_test.mts [dir with gfx64.wasm]
// The sequence is the FULL list of recording commands the two audits let through (tools/gfx_audit.mjs, static;
// tools/gfx_dynaudit.mjs, dynamic, which also names the static scratch that the build gives every instance for
// itself): six of them with arguments that change from call to call (a value another thread left in shared scratch
// then shows), the others with the arguments the dynamic audit found to record. NX_NO_TLS=1 is the negative control:
// the same test on a build whose scratch is still shared must FAIL. NX_ONLY=<0..5>: one of the six alone.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { globalsToMemory, writeGlobalInits } from "../tools/globals_to_memory.mjs";
import { dynamicAudit, auditLine } from "../tools/gfx_dynaudit.mjs";

const PAGES = 8192, GLOBALS = 0x1FF10000, T = 6, MEM = 4 << 20;
let N = 1200;   // rounds of the sequence; fewer when a round is so large that 1200 would not leave the buffers room   // (N = 1500 runs the buffers out of room: the allocator's slow path then runs, which is exactly what must stay under the lock; 4 of 6 buffers came out different)
const SEQ = ["nvnCommandBufferSetScissor", "nvnCommandBufferSetStencilRef", "nvnCommandBufferSetStencilMask", "nvnCommandBufferSetStencilValueMask", "nvnCommandBufferBindVertexBuffer", "nvnCommandBufferBindProgram"];
// the arguments of step k of the sequence for command j (x1..x4; x0 is the command buffer)
const argsOf = (j: number, k: number): bigint[] => [[k, k + 1, 100 + (k & 63), 200], [1, k & 255], [3, k & 255], [2, (k * 7) & 255], [k & 3, 0x40000000 + 64 * k, 4096], [0x50000000 + 256 * (k & 15), 3]][j].map(BigInt);
// seq: { id, j (which of the six, -1: none), a (fixed arguments) }
type Step = { id: number; j: number; a: bigint[] };
function record(call: (id: number, args: number) => unknown, u64: BigUint64Array, args: number, seq: Step[], c: number): void {
  for (let k = 0; k < N; k++) for (const s of seq) { const a = s.j >= 0 ? argsOf(s.j, k) : s.a; u64[args / 8] = BigInt(c); for (let i = 0; i < 7; i++) u64[args / 8 + 1 + i] = a[i] ?? 0n; call(s.id, args); }
}
if (!isMainThread) {
  const { memory, wasm, ids, c, args, tls } = workerData, pages = PAGES; N = workerData.N;
  const env = { memory, memory_size: () => pages, memory_grow: () => -1, log: () => {}, abort: () => { throw new Error("abort"); }, gfx_exec: () => {}, gfx_proc_address: () => 0n, gfx_arena_more: () => 0,
    gfx_guest_call: () => { throw new Error("the recorder called back into the guest: the slow path ran without the lock"); } };
  const x: any = new WebAssembly.Instance(new WebAssembly.Module(wasm), { env }).exports;
  if (tls) x.nx_tls.value = BigInt(tls);   // this instance's own scratch block
  const gate = new Int32Array(memory.buffer, 0x1F000000, 2);
  Atomics.add(gate, 0, 1); Atomics.wait(gate, 1, 0);   // every worker starts its recording at the same moment
  record((id, a) => x.nvn_call(id, BigInt(a)), new BigUint64Array(memory.buffer), args, ids, c);
  parentPort!.postMessage(0);
} else {
  const { sharedBuild } = await import("../../src/glue/wasm_shared.ts"), { instantiate } = await import("../../src/glue/wasm_abi.ts"), { range } = await import("../../src/glue/rt_layout.ts");
  const dir = process.argv[2] ?? "/mnt/build/web/wasm", plain = sharedBuild(readFileSync(`${dir}/gfx64.wasm`), PAGES);
  const memory = new WebAssembly.Memory({ initial: BigInt(PAGES), maximum: BigInt(PAGES), shared: true, address: "i64" } as any);
  const d = dynamicAudit(new Uint8Array(readFileSync(`${dir}/gfx64.wasm`)), { sharedBuild, instantiate, range });
  console.log(auditLine(d));
  const statics = process.env.NX_NO_TLS ? [] : d.statics;
  const first = globalsToMemory(plain, { base: GLOBALS, statics }), second = globalsToMemory(plain, { base: GLOBALS, secondary: true, statics });
  writeGlobalInits(memory, first.globals);
  const lines: string[] = [], dec = new TextDecoder();
  const env = { memory, memory_size: () => PAGES, memory_grow: () => -1, abort: () => { throw new Error("abort"); }, log: (p: number, n: number) => lines.push(dec.decode(new Uint8Array(memory.buffer).slice(p, p + n))),
    gfx_exec: () => {}, gfx_proc_address: () => 0n, gfx_arena_more: (n: number) => { const at = tables; tables += ((n >>> 0) + 0xFFFF) & ~0xFFFF; return at; }, gfx_guest_call: () => 0n };
  let tables = 0x18000000;   // the recorder's tables beyond its arena (fresh memory: zero)
  const x: any = instantiate(new WebAssembly.Module(first.wasm as any), { env }, { mem64: true, name: "gfx64.wasm" });
  const arena = range("gfx arena"), u8 = new Uint8Array(memory.buffer), u64 = new BigUint64Array(memory.buffer);
  let bad = 0; const check = (ok: boolean, what: string) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) bad++; };
  check(!!x.gfx_init(arena.lo, x.gfx_arena_bytes()), "the recorder starts on a shared 64-bit memory with its globals in the memory");
  x.kit_trace_enable(0);
  const nameOf = (id: number) => { const p = x.nvn_name(id); let e = p; while (u8[e]) e++; return String.fromCharCode(...u8.slice(p, e)); };
  const idOf = new Map<string, number>(); for (let id = 0; id < x.nvn_count(); id++) idOf.set(nameOf(id), id);
  const only = process.env.NX_ONLY;   // one command of the six alone (to find which one differs)
  const six = SEQ.map((n, j) => ({ id: idOf.get(n)!, j, a: [] as bigint[] })).filter(s => only === undefined || s.j === Number(only));
  const rest: Step[] = []; if (only === undefined) for (let id = 0; id < d.table.length; id++) if (d.table[id] === 3 && d.args.has(id) && !SEQ.includes(nameOf(id))) rest.push({ id, j: -1, a: d.args.get(id) });
  const ids: Step[] = [...six, ...rest];
  check(six.every(s => d.table[s.id] === 3), `both audits let the six commands with changing arguments through without the lock while there is room`);
  check(only !== undefined || ids.length === d.report.room, `the sequence is every recording command the audits let through: ${ids.length} of ${d.report.room}`);
  // objects, by the game's calls (under "the lock": this thread alone)
  let bump = d.bumpEnd; const alloc = (n: number) => { const a = bump; bump += (n + 4095) & ~4095; u8.fill(0, a, a + n); return a; };
  const ARGS = alloc(4096), call = (name: string, ...a: (number | bigint)[]) => { a.forEach((v, i) => u64[ARGS / 8 + i] = BigInt(v)); return x.nvn_call(idOf.get(name)!, ARGS); };
  const devb = alloc(64), dev = alloc(64); call("nvnDeviceBuilderSetDefaults", devb); call("nvnDeviceBuilderSetFlags", devb, 0); call("nvnDeviceInitialize", dev, devb);
  const bufs: { c: number; mem: number }[] = [];
  for (let i = 0; i < 2 * T; i++) {
    const pb = alloc(64), pool = alloc(64), mem = alloc(MEM), c = alloc(256), ctl = alloc(4096);
    call("nvnMemoryPoolBuilderSetDefaults", pb); call("nvnMemoryPoolBuilderSetDevice", pb, dev); call("nvnMemoryPoolBuilderSetStorage", pb, mem, MEM); call("nvnMemoryPoolBuilderSetFlags", pb, 0x22); call("nvnMemoryPoolInitialize", pool, pb);
    call("nvnCommandBufferInitialize", c, dev); call("nvnCommandBufferAddCommandMemory", c, pool, 0, MEM); call("nvnCommandBufferAddControlMemory", c, ctl, 4096); call("nvnCommandBufferBeginRecording", c);
    bufs.push({ c, mem });
  }
  // The made-up arguments were found one command at a time; in a sequence a command may meet state another one left
  // (a program that is no program) and trap. Those are taken out first, on command buffers used for nothing else:
  // the sequence is run three times over; a command that traps goes, and the trial starts again on a fresh buffer.
  const dropped: string[] = [];
  for (let clean = false; !clean && ids.length; ) {
    const pb = alloc(64), pool = alloc(64), mem = alloc(1 << 20), c = alloc(256), ctl = alloc(4096); clean = true;
    call("nvnMemoryPoolBuilderSetDefaults", pb); call("nvnMemoryPoolBuilderSetDevice", pb, dev); call("nvnMemoryPoolBuilderSetStorage", pb, mem, 1 << 20); call("nvnMemoryPoolBuilderSetFlags", pb, 0x22); call("nvnMemoryPoolInitialize", pool, pb);
    call("nvnCommandBufferInitialize", c, dev); call("nvnCommandBufferAddCommandMemory", c, pool, 0, 1 << 20); call("nvnCommandBufferAddControlMemory", c, ctl, 4096); call("nvnCommandBufferBeginRecording", c);
    trial: for (let k = 0; k < 3; k++) for (let i = 0; i < ids.length; i++) { const st = ids[i], a = st.j >= 0 ? argsOf(st.j, k) : st.a; u64[ARGS / 8] = BigInt(c); for (let q = 0; q < 7; q++) u64[ARGS / 8 + 1 + q] = a[q] ?? 0n;
      try { x.nvn_call(st.id, ARGS); } catch { dropped.push(nameOf(st.id)); ids.splice(i, 1); clean = false; break trial; } }
    if (clean) { const perRound = (Number(u64[(c + 8) / 8]) - mem) / 3; N = Math.max(1, Math.min(N, Math.floor((MEM - 65536) / Math.max(1, perRound)))); }
  }
  check(dropped.length <= 8 && six.every(s6 => ids.includes(s6)), `the sequence runs: ${ids.length} commands (${dropped.length} taken out because they trap after the others: ${dropped.join(", ") || "none"})`);
  // A: one thread
  for (let i = 0; i < T; i++) record((id, a) => x.nvn_call(id, a), u64, ARGS, ids, bufs[i].c);
  const used = Number(u64[(bufs[0].c + 64) / 8]);
  check(used > 10000 && used + 32768 < MEM, `one thread recorded ${N * ids.length} commands into each of ${T} command buffers: ${used} bytes each, room left`);
  // B: T threads at once, each its own instance, no lock
  const gate = new Int32Array(memory.buffer, 0x1F000000, 2); gate[0] = 0; gate[1] = 0;
  const done = Array.from({ length: T }, (_, i) => new Promise((ok, no) => { const w = new Worker(new URL(import.meta.url), { workerData: { memory, wasm: second.wasm, ids, c: bufs[T + i].c, args: alloc(4096), tls: first.tls ? alloc(first.tls.span + 64) : 0, N } }); w.once("message", ok); w.once("error", no); }));
  while (Atomics.load(gate, 0) < T) await new Promise(r => setTimeout(r, 5));
  Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
  await Promise.all(done);
  let diff = 0;
  for (let i = 0; i < T; i++) { const a = u8.subarray(bufs[i].mem, bufs[i].mem + MEM), b = u8.subarray(bufs[T + i].mem, bufs[T + i].mem + MEM); for (let k = 0; k < MEM; k++) if (a[k] !== b[k]) { diff++; break; } if (u64[(bufs[i].c + 64) / 8] !== u64[(bufs[T + i].c + 64) / 8]) diff++; }
  check(diff === 0, `${T} threads recorded the same commands at the same time without the lock: ${diff} command buffers differ from the single thread's (bytes of the command memory, bytes used)`);
  check(lines.filter(l => /RED/.test(l)).length === 0, `no red line from the recorder${lines.length ? " (" + lines.slice(0, 2).join(" | ") + ")" : ""}`);
  console.log(bad ? `gfx_lockfree_test: ${bad} FAILED` : "gfx_lockfree_test: all passed");
  process.exit(bad ? 1 : 0);
}
