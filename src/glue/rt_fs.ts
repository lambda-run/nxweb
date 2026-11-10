// nxweb runtime glue: the file system (src/fs: nn::fs on RomFS images and save containers) attached to a guest
// process. The module is instantiated in the process's linear memory (static data in "fs static", its arena in "fs
// arena"), every nn::fs name it takes over becomes a host function that lands in fs_call, and a call that cannot
// finish at once parks the calling guest thread (Runtime waitFor): `pending` until the storage call it waits for has
// settled (FsHost completes it), `retry` until any pending call has completed, after which the same call is made
// again. With storage that answers at once (Node files; in a Worker OPFS containers opened ahead with
// OpfsStorage.preopen() and images in Blobs read through FileReaderSync) nothing ever parks.
import type { Runtime, HostCpu, HostResult } from "./rt_runtime.ts";
import { FsHost, FS_RETRY, fsIsPending, fsToken, type FsStorage } from "./fs_host.ts";
import { range } from "./rt_layout.ts";

export interface RtFsOptions {
  programId?: bigint;       // the running program's id (IsSaveDataExisting)
  // true (default): the names win over a module's own definitions, as nxnative's take-overs do (a game brings the
  // SDK, whose nn::fs would talk to the fsp-srv service, which nobody serves). false: they only fill imports.
  forced?: boolean;
  saveFailed?: (errno: number) => void;
}

export class RtFs {
  readonly rt: Runtime;
  readonly host: FsHost;
  readonly x: FsHost["x"];
  stats = { calls: 0, pended: 0, retried: 0, names: 0 };
  private done = new Map<number, (r: bigint) => void>();   // token -> the wake of the thread parked under it
  private anyDone: (() => void)[] = [];                    // threads parked on `retry`

  // Before rt.loadNso()
  constructor(rt: Runtime, module: WebAssembly.Module, storage: FsStorage, o: RtFsOptions = {}) {
    this.rt = rt;
    this.host = new FsHost(module, storage, {
      memory: rt.memory, log: l => rt.log(l), saveFailed: o.saveFailed ?? (e => rt.log(`[RED] fs: a save could not be written (error ${e})`)),
      completed: (token, result) => {
        const wake = this.done.get(token);
        this.done.delete(token);
        wake?.(result);
        for (const w of this.anyDone.splice(0)) w();
      },
    });
    this.x = this.host.x;
    const st = range("fs static"), arena = range("fs arena");
    if (rt.r.rt_static_check(98, BigInt(st.lo), BigInt(st.hi), BigInt(this.x.fs_static_end() >>> 0))) throw new Error("runtime: the fs module's static data is outside its range (was it built with --memoryBase " + st.lo + "?)");
    this.x.fs_init(arena.lo, arena.hi - arena.lo);
    if (o.programId !== undefined) this.x.fs_set_program_id(o.programId);
    const names = this.host.names();
    // whether the game imports MountSaveData decides what device save data is (src/fs/README.md): the module learns
    // it from the lookups, so every name is looked up as a loader would
    const p = (rt.r.rt_scratch_ptr() >>> 0) + 3200, enc = new TextEncoder();
    for (const n of names) {
      rt.u8().set(enc.encode(n.name + "\0"), p);
      const id = this.x.fs_lookup(p);
      if (id !== n.id) throw new Error(`runtime: fs_lookup(${n.name}) gives ${id}, the table says ${n.id}`);
      rt.register({ name: n.name, forced: o.forced !== false, fn: cpu => this.call(n.id, cpu) });
    }
    this.x.fs_set_account_save(-1);
    this.stats.names = names.length;
    // the storage's handles (OPFS access handles are exclusive) go with the process
    // (and the storage's own: a container opened ahead of its mount is the storage's until something mounts it)
    rt.onDispose(() => { this.host.closeDevices(); (storage as { close?: () => void }).close?.(); });
  }
  private call(id: number, cpu: HostCpu): HostResult {
    this.stats.calls++;
    return this.step(id, cpu, cpu.read(cpu.args(), 64));
  }
  // One fs_call with the guest's x0..x7 (kept: the registers are gone when a parked thread comes back)
  private step(id: number, cpu: HostCpu, saved: Uint8Array): HostResult {
    const args = cpu.args();
    cpu.write(args, saved);
    const r: bigint = this.x.fs_call(id, args);
    if (r === FS_RETRY) {
      // the save or image is busy with another thread's pending call: after any completion the same call again
      this.stats.retried++;
      return cpu.waitFor(new Promise<void>(res => this.anyDone.push(res)), undefined, c => this.step(id, c, saved));
    }
    if (fsIsPending(r)) {
      // a storage call is in flight: FsHost completes it, and the result is this call's
      this.stats.pended++;
      let result = 0n;
      const settled = new Promise<void>(res => this.done.set(fsToken(r), v => { result = v; res(); }));
      return cpu.waitFor(settled, undefined, () => BigInt.asUintN(64, result));
    }
    return BigInt.asUintN(64, r);
  }
}
