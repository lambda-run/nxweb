// The lines a fault adds after the runtime's register dump (rt_runtime.ts faultNow): where pc and x30 are, and the
// faulting thread's last SVCs from the kernel's ring (src/kernel/ring.ts).

// SVC number -> name, the registers it takes and the registers it returns besides the result code in x0
// (resultless: x0 is a value, not a result code). Unknown numbers print x0..x3.
const SVC: Record<number, [string, number[], number[], boolean?]> = {
  0x01: ["SetHeapSize", [1], [1]], 0x02: ["SetMemoryPermission", [0, 1, 2], []], 0x03: ["SetMemoryAttribute", [0, 1, 2, 3], []],
  0x04: ["MapMemory", [0, 1, 2], []], 0x05: ["UnmapMemory", [0, 1, 2], []], 0x06: ["QueryMemory", [0, 2], [1]],
  0x07: ["ExitProcess", [0], []], 0x08: ["CreateThread", [1, 2, 3, 4, 5], [1]], 0x09: ["StartThread", [0], []],
  0x0A: ["ExitThread", [], []], 0x0B: ["SleepThread", [0], []], 0x0C: ["GetThreadPriority", [1], [1]],
  0x0D: ["SetThreadPriority", [0, 1], []], 0x0E: ["GetThreadCoreMask", [2], [1]], 0x0F: ["SetThreadCoreMask", [0, 1, 2], []],
  0x10: ["GetCurrentProcessorNumber", [], [], true], 0x11: ["SignalEvent", [0], []], 0x12: ["ClearEvent", [0], []],
  0x13: ["MapSharedMemory", [0, 1, 2, 3], []], 0x14: ["UnmapSharedMemory", [0, 1, 2], []], 0x15: ["CreateTransferMemory", [1, 2, 3], [1]],
  0x16: ["CloseHandle", [0], []], 0x17: ["ResetSignal", [0], []], 0x18: ["WaitSynchronization", [1, 2, 3], [1]],
  0x19: ["CancelSynchronization", [0], []], 0x1A: ["ArbitrateLock", [0, 1, 2], []], 0x1B: ["ArbitrateUnlock", [0], []],
  0x1C: ["WaitProcessWideKeyAtomic", [0, 1, 2, 3], []], 0x1D: ["SignalProcessWideKey", [0, 1], []],
  0x1E: ["GetSystemTick", [], [], true], 0x1F: ["ConnectToNamedPort", [1], [1]], 0x21: ["SendSyncRequest", [0], []],
  0x22: ["SendSyncRequestWithUserBuffer", [0, 1, 2], []], 0x24: ["GetProcessId", [1], [1]], 0x25: ["GetThreadId", [1], [1]],
  0x26: ["Break", [0, 1, 2], []], 0x27: ["OutputDebugString", [0, 1], []], 0x28: ["ReturnFromException", [0], []],
  0x29: ["GetInfo", [1, 2, 3], [1]], 0x2C: ["MapPhysicalMemory", [0, 1], []], 0x2D: ["UnmapPhysicalMemory", [0, 1], []],
  0x32: ["SetThreadActivity", [0, 1], []], 0x33: ["GetThreadContext3", [0, 1], []], 0x34: ["WaitForAddress", [0, 1, 2, 3], []],
  0x35: ["SignalToAddress", [0, 1, 2, 3], []], 0x45: ["CreateEvent", [], [1]],
};
export const SVC_REC = 112;   // ring.ts RING_REC
const RF_WAITING = 1, RF_WAITED = 2, RF_ENDED = 4;
const hex = (v: number | bigint) => "0x" + v.toString(16);

// One record of the ring (ring.ts layout) as a line: "#seq svc 0xNN Name(x1=..) -> 0x0 x1=.. at pc=.."
export function svcLine(dv: DataView, r: number): string {
  const seq = dv.getUint32(r, true), n = dv.getUint16(r + 4, true), flags = dv.getUint16(r + 6, true), pc = dv.getBigUint64(r + 8, true);
  const x = (i: number) => dv.getBigUint64(r + 16 + 8 * i, true);
  const [name, ins, outs, resultless] = SVC[n] ?? ["?", [0, 1, 2, 3], [], false];
  const args = ins.map(i => `x${i}=${hex(x(i))}`).join(" ");
  const res = [dv.getBigUint64(r + 64, true), dv.getBigUint64(r + 72, true)];
  let out: string;
  if (flags & RF_ENDED) out = "did not return (the thread or the process ended)";
  else if (flags & RF_WAITING) out = "waiting, not returned";
  else {
    out = (resultless ? `x0=${hex(res[0])}` : hex(res[0])) + outs.filter(i => i === 1).map(() => ` x1=${hex(res[1])}`).join("");
    if (n === 0x06 && res[0] === 0n)
      out += ` MemoryInfo{base=${hex(dv.getBigUint64(r + 80, true))} size=${hex(dv.getBigUint64(r + 88, true))} state=${hex(dv.getUint32(r + 96, true))} attr=${hex(dv.getUint32(r + 100, true))} perm=${hex(dv.getUint32(r + 104, true))}}`;
    if (flags & RF_WAITED) out += " (after a wait)";
  }
  return `#${seq} svc ${hex(n)} ${name}(${args}) -> ${out}, returns to ${hex(pc)}`;
}

// The frame records from x29 (AArch64: [fp] the caller's fp, [fp+8] the return address), at most max, while fp is
// 8-aligned, in [lo, end) and rises; each as "frame i: fp=.. returns to 0x.., <place>"
export function frameLines(dv: DataView, fp: number, lo: number, end: number, max: number, place: (a: number) => string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= max && fp % 8 === 0 && fp >= lo && fp + 16 <= end; i++) {
    const next = Number(dv.getBigUint64(fp, true)), lr = Number(dv.getBigUint64(fp + 8, true));
    if (!lr) break;
    out.push(`frame ${i}: fp=${hex(fp)} returns to ${hex(lr)}, ${place(lr)}`);
    if (next <= fp) break;
    fp = next;
  }
  return out;
}

export interface CodeRange { name: string; handle: number; base: number; lo: number; hi: number }   // lo/hi: the text
// "module+0xoff (symbol+0xoff)" (offset from the image base) for an address in a module's text; the host stub's name in the stub region
export function placeOf(addr: number, mods: CodeRange[], symbolAt: (h: number, a: number) => { name: string; value: number } | undefined,
  stub: (a: number) => string | undefined): string {
  const s = stub(addr);
  if (s !== undefined) return `the host stub of ${s}`;
  const m = mods.find(m => addr >= m.lo && addr < m.hi);
  if (!m) return "not in the text of a loaded module";
  const sym = symbolAt(m.handle, addr);
  return `${m.name}+${hex(addr - m.base)}` + (sym ? ` (${sym.name}+${hex(addr - sym.value)})` : " (no symbol)");
}
