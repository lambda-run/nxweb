// Storage that fails on request: a save container in memory that counts every operation and can be killed at
// any one of them (the tab is closed, the process dies, the power goes), or made to report a failure.
import { DEV, FS_KIND, MemDevice, type FsDevice, type FsStorage } from "../../src/glue/fs_host.ts";

export class Killed extends Error { constructor() { super("the storage was killed"); } }

export interface Plan {
  killAt?: number;       // the index of the operation that does not complete (all operations count: size, read, write, flush)
  tear?: number;         // 0..1: the part of a killed write that still reaches the device
  power?: boolean;       // power loss instead of a killed process: writes since the last flush may each be lost, torn or kept
  fail?: (index: number, kind: "size" | "read" | "write" | "flush") => number | undefined;   // a DEV status to report instead of doing the operation
}

export class Disk implements FsDevice {
  mem: MemDevice;
  ops = 0;
  dead = false;
  kinds: string[] = [];
  private durable: Uint8Array;
  private unflushed: { off: number; data: Uint8Array }[] = [];
  plan: Plan;
  constructor(initial?: Uint8Array, plan: Plan = {}) { this.mem = new MemDevice(initial); this.durable = this.mem.snapshot(); this.plan = plan; }

  private step(kind: "size" | "read" | "write" | "flush"): number | undefined {
    if (this.dead) throw new Killed();
    const i = this.ops++;
    this.kinds.push(kind);
    if (i === this.plan.killAt) { this.dead = true; return -99; }
    return this.plan.fail?.(i, kind);
  }
  size(): number {
    const f = this.step("size");
    if (f === -99) throw new Killed();
    return f !== undefined ? f : this.mem.size();
  }
  readSync(off: number, dst: Uint8Array): number {
    const f = this.step("read");
    if (f === -99) throw new Killed();
    return f !== undefined ? f : this.mem.readSync(off, dst);
  }
  write(off: number, src: Uint8Array): number {
    const f = this.step("write");
    if (f === -99) {
      const n = Math.floor(src.length * (this.plan.tear ?? 0));
      if (n) { const part = src.slice(0, n); this.unflushed.push({ off, data: part }); this.mem.write(off, part); }
      throw new Killed();
    }
    if (f !== undefined) return f;
    this.unflushed.push({ off, data: src.slice() });
    return this.mem.write(off, src);
  }
  flush(): number {
    const f = this.step("flush");
    if (f === -99) throw new Killed();
    if (f !== undefined) return f;
    this.durable = this.mem.snapshot(); this.unflushed = [];
    return DEV.OK;
  }
  // What a new session finds. A killed process: everything written. Power loss: what was flushed, plus any part of what was not.
  survivor(rnd: { int(n: number): number }): Uint8Array {
    if (!this.plan.power) return this.mem.snapshot();
    const d = new MemDevice(this.durable);
    for (const w of this.unflushed) {
      const how = rnd.int(3);
      if (how === 0) continue;
      d.write(w.off, how === 1 ? w.data : w.data.subarray(0, rnd.int(w.data.length + 1)));
    }
    return d.snapshot();
  }
}

// Storage over given devices (a number: the status the open reports); saves not given are created in memory
export class TestStorage implements FsStorage {
  devices = new Map<string, FsDevice | number>();
  removed: string[] = [];
  set(kind: number, index: number | bigint, dev: FsDevice | number): this { this.devices.set(`${kind}:${index}`, dev); return this; }
  get(kind: number, index: number | bigint = 0): FsDevice | number | undefined { return this.devices.get(`${kind}:${index}`); }
  open(kind: number, index: bigint): FsDevice | number {
    const k = `${kind}:${index}`;
    let d = this.devices.get(k);
    if (d === undefined) {
      if (kind < FS_KIND.SAVE) return DEV.NOT_FOUND;
      this.devices.set(k, d = new MemDevice());
    }
    return d;
  }
  remove(kind: number, index: bigint): number { this.removed.push(`${kind}:${index}`); this.devices.delete(`${kind}:${index}`); return DEV.OK; }
}
