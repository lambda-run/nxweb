// EXPERIMENTAL (spike, see SPIKE.md). The coordinator: makes the shared memory, starts the Workers, relays compiled
// units between them and collects the result. No Node or DOM APIs (the caller says how a Worker is made).
import type { Boot, EngineOpts, EngineStats, Mods } from "./engine.ts";

// The Worker side: one Engine per Worker
export interface Port { post(msg: any): void; onmsg(fn: (m: any) => void): void }
export async function serve(port: Port): Promise<void> {
  const { Engine } = await import("./engine.ts");
  let eng: InstanceType<typeof Engine> | null = null;
  port.onmsg(async (m: any) => {
    try {
      if (m.type === "boot") { eng = new Engine(m.boot, { post: x => port.post(x), log: line => port.post({ type: "log", line }) }); port.post({ type: "ready" }); }
      else if (m.type === "unit") eng!.receive(m.unit);
      else if (m.type === "go") port.post({ type: "done", stats: await eng!.run() });
    } catch (e) { port.post({ type: "error", text: e instanceof Error ? e.stack ?? e.message : String(e) }); }
  });
}

export interface Spawned extends Port { kill(): void }
export interface Guest { image: Uint8Array; base: number; entry: number; stackTop: number; top: number }
export interface RunCfg {
  shared: boolean;            // false: today's unshared binaries (mods must be those), one engine, green threads
  workers: number;            // 0: green threads in one engine; N: N Workers
  mods: Mods;
  guest: Guest;
  opts?: EngineOpts;
  storeBytes?: number;        // transport "bytes": size of the unit store (default 64 MB)
  maxPages?: number;          // shared memory maximum (default 16384 = 1 GB)
}
export interface RunResult { out: string; exitCode: number; stopReason: number; fault?: string; wallMs: number; bootMs: number; stats: EngineStats[]; logs: string[]; unitsRelayed: number; guestNs: string }

export async function runGuest(spawn: () => Spawned, cfg: RunCfg): Promise<RunResult> {
  const n = Math.max(1, cfg.workers);
  const memory = cfg.shared ? new WebAssembly.Memory({ initial: Math.ceil((cfg.guest.top + 0x10000) / 65536), maximum: cfg.maxPages ?? 16384, shared: true }) : undefined;
  const store = cfg.shared && cfg.workers > 0 && (cfg.opts?.transport ?? "bytes") === "bytes" ? new SharedArrayBuffer(cfg.storeBytes ?? 64 << 20) : undefined;
  const epochMs = performance.timeOrigin + performance.now();
  const ws: Spawned[] = [], logs: string[] = [], stats: EngineStats[] = [];
  let unitsRelayed = 0, fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, rej) => { fail = rej; });
  const waiters: Map<string, () => void>[] = [];
  const t0 = performance.now();
  for (let w = 0; w < n; w++) {
    const s = spawn(); ws.push(s); waiters.push(new Map());
    s.onmsg((m: any) => {
      if (m.type === "log") logs.push(`[w${w}] ${m.line}`);
      else if (m.type === "unit") { unitsRelayed++; for (let o = 0; o < n; o++) if (o !== w) ws[o].post(m); }
      else if (m.type === "error") fail(new Error(`worker ${w}: ${m.text}`));
      else { if (m.type === "done") stats[w] = m.stats; const f = waiters[w].get(m.type); if (f) { waiters[w].delete(m.type); f(); } }
    });
  }
  const wait = (w: number, type: string) => Promise.race([new Promise<void>(r => waiters[w].set(type, r)), failed]);
  const boot = (w: number): Boot => ({ worker: w, workers: cfg.workers, shared: cfg.shared, memory, store, mods: cfg.mods, guest: w === 0 ? cfg.guest : undefined, epochMs, opts: cfg.opts ?? {} });
  try {
    // the primary first: it writes the static data of the kernel and the translator and loads the guest
    let p = wait(0, "ready"); ws[0].post({ type: "boot", boot: boot(0) }); await p;
    const rest: Promise<void>[] = [];
    for (let w = 1; w < n; w++) { rest.push(wait(w, "ready")); ws[w].post({ type: "boot", boot: boot(w) }); }
    await Promise.all(rest);
    const bootMs = performance.now() - t0;
    const t1 = performance.now();
    const done = ws.map((_, w) => wait(w, "done"));
    for (const s of ws) s.post({ type: "go" });
    await Promise.all(done);
    const wallMs = performance.now() - t1;
    const s0 = stats[0];
    return { out: s0.out ?? "", exitCode: s0.exitCode ?? -1, stopReason: s0.stopReason ?? -1, fault: stats.map(s => s.fault).find(f => f), wallMs, bootMs, stats, logs, unitsRelayed, guestNs: s0.guestNs ?? "" };
  } finally { for (const s of ws) s.kill(); }
}
