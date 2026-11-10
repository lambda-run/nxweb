// The hle tests' harness: fresh instances of build/hle/hle.wasm through the same glue the runtime uses
// (src/glue/hle_host.ts), with a fake outside: the module's own memory is the guest memory, kernel events are a map,
// clocks are variables, the "guest functions" a take-over calls back are JavaScript functions at made-up addresses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_DIR } from "../../src/kit/host/defs.mts";
import { readMachines, type WasmMachine } from "../../src/kit/host/reader.mts";
import { HleHost, type HleEnv, type HleRegs, type HleResult, type TextRequest, type HlePending } from "../../src/glue/hle_host.ts";

export const ROOT = join(KIT_DIR, "..", "..");
export const WASM = join(ROOT, "build", "hle", "hle.wasm");
export const NXNATIVE = process.env.NXNATIVE ?? "/home/user/nxnative";
export const RES_FAIL = 0x2A2n;
export const MACHINES = ["oe_focus", "oe_msg", "oe_notify_event", "hle_exit", "nifm_request", "swkbd_request", "swkbd_inline", "web_session"];

export interface InvRow { file: string; kind: string; mangled: string; demangled: string; signature: string; reason: string }
export function inventory(): InvRow[] {
  return readFileSync(join(ROOT, "test", "hle", "inventory.tsv"), "utf8").split("\n").slice(1).filter(Boolean).map(l => {
    const [file, kind, mangled, demangled, signature, reason] = l.split("\t");
    return { file, kind, mangled, demangled, signature, reason };
  });
}
export function status(): { file: string; mangled: string; kind: string; status: string; cname: string }[] {
  return readFileSync(join(ROOT, "test", "hle", "status.tsv"), "utf8").split("\n").slice(1).filter(Boolean).map(l => {
    const [file, mangled, kind, status, cname] = l.split("\t");
    return { file, mangled, kind, status, cname };
  });
}

interface Ev { signaled: boolean; signals: number; clears: number; open: boolean }
let module: WebAssembly.Module | undefined;
const live: Hle[] = [];
let sum: Uint8Array[] | undefined;

export class Hle {
  host: HleHost;
  logs: string[] = [];
  // the fake outside
  guestNs = 0n; monoNs = 5_000_000_000n; realNs = 1_700_000_000_123_456_789n;
  zone: (t: bigint) => { offset: number; dst: boolean; name: string } = () => ({ offset: 0, dst: false, name: "UTC" });
  events = new Map<number, Ev>();          // by handle; a pair shares one Ev
  private nextHandle = 0x2000;
  syms = new Map<string, bigint>();        // guest symbols
  fns = new Map<bigint, (...args: bigint[]) => bigint | number | void>();   // guest functions by address
  guestCalls: { fn: bigint; args: bigint[] }[] = [];
  modules: { lo: bigint; hi: bigint }[] = [];
  freezes: [number, boolean][] = [];
  textRequests: TextRequest[] = [];
  onText: ((r: TextRequest) => void) | null = null;
  web: { opens: { path: string; callback: string; hidden: boolean; delay: number; pulse: number }[]; shows: number; sent: string[]; closes: number; holds: boolean[]; result: number } =
    { opens: [], shows: 0, sent: [], closes: 0, holds: [], result: 2 };
  vsyncs: bigint[] = [];
  npad = 0;
  images: number[] = []; freed: number[] = [];
  exits: { reason: string; value: bigint; bytes: Uint8Array }[] = [];
  entropyByte = 0;
  private base: number; private top: number;

  constructor(o: { cover?: boolean } = {}) {
    module ??= new WebAssembly.Module(readFileSync(WASM));
    const t = this;
    const env: HleEnv = {
      log: l => { t.logs.push(l); if (process.env.HLE_TEST_LOG) console.log("    | " + l); },
      guestNs: () => t.guestNs, monoNs: () => t.monoNs, realNs: () => t.realNs,
      timeZone: s => t.zone(s),
      entropy: out => { for (let i = 0; i < out.length; i++) out[i] = (t.entropyByte = (t.entropyByte + 1) & 255); },
      eventNew: () => { const e: Ev = { signaled: false, signals: 0, clears: 0, open: true }, r = t.nextHandle++, w = t.nextHandle++; t.events.set(r, e); t.events.set(w, e); return { r, w }; },
      eventSignal: h => { const e = t.events.get(h); if (!e || !e.open) return false; e.signaled = true; e.signals++; return true; },
      eventClear: h => { const e = t.events.get(h); if (!e || !e.open) return false; e.signaled = false; e.clears++; return true; },
      eventDupReadable: h => { const e = t.events.get(h); if (!e) return 0; const r = t.nextHandle++; t.events.set(r, e); return r; },
      guestSym: n => t.syms.get(n) ?? 0n,
      guestCall: (fn, args) => { t.guestCalls.push({ fn, args }); const f = t.fns.get(fn); if (!f) throw new Error(`test: guest call to ${fn.toString(16)}, which is no function`); return BigInt(f(...args) ?? 0); },
      moduleOf: a => t.modules.findIndex(m => a >= m.lo && a < m.hi),
      stubAddr: id => 0x07FC_0000n + 4n * BigInt(id),
      hostAlloc: n => BigInt(t.alloc(Number(n))),
      clockFreeze: (r, on) => { t.freezes.push([r, on]); },
      textRequest: r => { t.textRequests.push(r); t.onText?.(r); },
      webOpen: (path, callback, hidden, delay, pulse) => { t.web.opens.push({ path, callback, hidden, delay, pulse }); return t.web.result; },
      webShow: () => { t.web.shows++; }, webSend: m => { t.web.sent.push(Buffer.from(m).toString("utf8")); }, webClose: () => { t.web.closes++; },
      inputHold: on => { t.web.holds.push(on); },
      vsyncEvent: b => { t.vsyncs.push(b); },
      connectedNpad: () => t.npad,
      nativeImageBlank: (w, h) => { const n = 0x100 + t.images.length; t.images.push(w << 16 | h); return n; }, nativeImageBlankFree: h => { t.freed.push(h); },
      exitRequest: (reason, value, bytes) => { t.exits.push({ reason, value, bytes }); },
    };
    this.host = new HleHost(module, env);
    const end = (this.host.x.hle_static_end() + 0xFFFF) & ~0xFFFF;
    if (this.host.memory.buffer.byteLength < end + (2 << 20)) this.host.memory.grow(Math.ceil((end + (2 << 20) - this.host.memory.buffer.byteLength) / 65536));
    this.base = this.top = end;
    if (o.cover !== false) { this.host.x.kit_cover_enable(1); live.push(this); }
  }
  get x() { return this.host.x; }
  get red(): string[] { return this.logs.filter(l => l.startsWith("[RED] ")); }
  get dv(): DataView { return new DataView(this.host.memory.buffer); }
  get u8(): Uint8Array { return new Uint8Array(this.host.memory.buffer); }

  // ---- guest memory ----
  alloc(n: number, fill = 0): number {
    const p = this.top; this.top += (n + 15) & ~15;
    if (this.top > this.host.memory.buffer.byteLength) this.host.memory.grow(Math.ceil((this.top - this.host.memory.buffer.byteLength) / 65536));
    this.u8.fill(fill, p, p + n);
    return p;
  }
  str(s: string): number { const b = Buffer.from(s, "utf8"), p = this.alloc(b.length + 1); this.u8.set(b, p); return p; }
  bytes(b: Uint8Array | number[]): number { const p = this.alloc(b.length); this.u8.set(b, p); return p; }
  read(p: number, n: number): Buffer { return Buffer.from(this.u8.slice(p, p + n)); }
  cstr(p: number, max = 4096): string { const b = this.u8; let e = p; while (b[e] && e - p < max) e++; return Buffer.from(b.slice(p, e)).toString("utf8"); }
  u16str(s: string): Uint8Array { return new Uint8Array(Buffer.from(s + "\0", "utf16le")); }
  u32(p: number): number { return this.dv.getUint32(p, true); }
  i32(p: number): number { return this.dv.getInt32(p, true); }
  u64(p: number): bigint { return this.dv.getBigUint64(p, true); }
  i64(p: number): bigint { return this.dv.getBigInt64(p, true); }

  // ---- calls ----
  id(name: string): number { const id = this.host.lookup(name); if (id < 0) throw new Error(`test: no take-over named ${name}`); return id; }
  // By mangled name, or by nxnative's identifier ("h_oe_GetFocus", "hle_net.c:h_sk_Poll" where two files use one)
  resolve(name: string): number {
    if (!name.startsWith("h_") && !name.startsWith("g_") && !name.startsWith("lib_") && !name.includes(":")) return this.id(name);
    const [file, cname] = name.includes(":") ? name.split(":") : [undefined, name];
    const rows = status().filter(r => r.cname === cname && (!file || r.file === file) && !r.status.startsWith("out of scope"));
    if (rows.length !== 1) throw new Error(`test: ${rows.length} take-overs called ${name}`);
    const forced = rows[0].kind === "forced", want = rows[0].mangled;
    const e = this.host.entries().find(e => e.name === want && e.forced === forced && !e.duplicate);
    if (!e) throw new Error(`test: ${name} is not in the module's table`);
    return e.id;
  }
  last: { id: number; pend: HlePending } | null = null;
  call(name: string | number, ...x: (bigint | number)[]): HleResult { return this.callRegs(name, { x }); }
  callRegs(name: string | number, regs: HleRegs): HleResult {
    const id = typeof name === "number" ? name : this.resolve(name);
    const r = this.host.call(id, regs);
    if (r.wait) this.last = { id, pend: this.host.pending(id) };
    return r;
  }
  // The wait the last waiting call asked for ended
  resume(how: "signaled" | "timeout" | "cancelled" = "signaled"): HleResult {
    if (!this.last) throw new Error("test: no call is waiting");
    const { id, pend } = this.last, r = this.host.resume(pend, how);
    this.last = r.wait ? { id, pend: this.host.pending(id) } : null;
    return r;
  }
  w0(name: string | number, ...x: (bigint | number)[]): number { return Number(this.call(name, ...x).x0 & 0xFFFF_FFFFn); }
  // A guest function for the take-overs to call back: its made-up address
  fn(f: (...args: bigint[]) => bigint | number | void, name?: string): bigint {
    const a = 0x0900_0000n + BigInt(this.fns.size) * 0x10n; this.fns.set(a, f); if (name) this.syms.set(name, a); return a;
  }
  // The SDK's nn::os as the binding code calls it: CreateSystemEvent(event, clear mode, inter-process) makes a kernel
  // event, GetWritableHandleOfSystemEvent gives its write end. `created` records each
  created: { ev: bigint; autoclear: bigint; interProcess: bigint; r: number; w: number }[] = [];
  sdk(): this {
    this.fn((ev, mode, ipc) => { const e = this.host.env.eventNew(); this.created.push({ ev, autoclear: mode, interProcess: ipc, r: e.r, w: e.w }); return 0; }, "_ZN2nn2os17CreateSystemEventEPNS0_15SystemEventTypeENS0_14EventClearModeEb");
    this.fn(ev => this.created.findLast(c => c.ev === ev)!.w, "_ZN2nn2os30GetWritableHandleOfSystemEventEPKNS0_15SystemEventTypeE");
    return this;
  }
  ev(h: number): Ev { const e = this.events.get(h); if (!e) throw new Error(`test: no event with handle 0x${h.toString(16)}`); return e; }
  machines(): WasmMachine[] { return readMachines(this.x); }
}

export const tests: { name: string; fn: () => void | Promise<void> }[] = [];
export function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }
// Hit bitmaps summed over every instance a test made
export function harvest(): void {
  for (const h of live.splice(0)) {
    const ms = h.machines();
    sum ??= ms.map(m => new Uint8Array(m.hits.length));
    ms.forEach((m, i) => m.hits.forEach((v, c) => { if (v) sum![i][c] = 1; }));
  }
}
export function coverage(): { machines: WasmMachine[]; hits: Uint8Array[] } {
  const machines = new Hle({ cover: false }).machines();
  const all = sum ?? machines.map(m => new Uint8Array(m.hits.length));
  const keep = machines.map((m, i) => ({ m, h: all[i] })).filter(e => MACHINES.includes(e.m.name));
  return { machines: keep.map(e => e.m), hits: keep.map(e => e.h) };
}
