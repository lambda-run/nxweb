// nxweb runtime glue: nn::ro (modules loaded at run time, NRO) as host functions over Runtime.loadModule /
// unloadModule, after nxnative dm/host/hle_ro.c. On Horizon nn::ro maps the image through the ldr:ro service and the
// SDK relocates it through rtld's module lists; the runtime plays rtld, so the whole calls are taken over.
// Departure from nxnative: there the NROs are rewritten offline and found by the image's SHA-256; here the image the
// game passes is loaded as it is (copied out of guest memory, since a module must be mapped from a pristine copy).
// The SDK take-overs in general are another area's (src/hle); these stand for nn::ro until they are joined there.
import type { Runtime, HostCpu } from "./rt_runtime.ts";

export const RO_FAIL = 22 | (1 << 9);    // a failure under ro module 22 (games check IsSuccess only)
export const RO_NOT_NRO = 0x816;         // the SDK's result for an image without NRO0
const RED_ONCE = new WeakMap<Runtime, Set<string>>();

export interface RoStats { loads: number; unloads: number; lookups: number; initCalls: number; finiCalls: number }

// nn::ro::Module as the SDK fills it: +0 the module object (here: the image's guest base), +8 state (1 = loaded),
// +0x10 image, +0x18 buffer
export function registerRo(rt: Runtime): RoStats {
  const stats: RoStats = { loads: 0, unloads: 0, lookups: 0, initCalls: 0, finiCalls: 0 };
  const byBase = new Map<number, number>();   // image base -> loader handle of a loaded module
  const red = (key: string, line: string) => { let s = RED_ONCE.get(rt); if (!s) RED_ONCE.set(rt, s = new Set()); if (!s.has(key)) { s.add(key); rt.log("[RED] " + line); } };
  const f = (name: string, fn: (cpu: HostCpu) => number | bigint | void) => rt.register({ name, forced: true, fn });
  const moduleOf = (cpu: HostCpu, p: bigint): number | undefined => {
    if (!p) return undefined;
    const dv = cpu.dv(), a = Number(p);
    return dv.getUint32(a + 8, true) === 1 ? byBase.get(Number(dv.getBigUint64(a, true))) : undefined;
  };
  const put64 = (cpu: HostCpu, p: bigint, v: number) => { if (p) cpu.dv().setBigUint64(Number(p), BigInt(v), true); };

  f("_ZN2nn2ro10InitializeEv", () => { rt.log("ro::Initialize (no ldr:ro service: symbol lookups search the loaded modules)"); return 0; });
  f("_ZN2nn2ro8FinalizeEv", () => { });
  f("_ZN2nn2ro12LookupSymbolEPmPKc", cpu => {
    const out = cpu.x(0), name = cpu.x(1) ? cpu.cstr(cpu.x(1)) : "";
    const a = name ? rt.ld.lookup(name) : undefined;
    stats.lookups++;
    if (!a) { red("lookup", `ro::LookupSymbol cannot find ${name || "(null)"} (first case)`); return RO_FAIL; }
    put64(cpu, out, a);
    return 0;
  });
  f("_ZN2nn2ro18LookupModuleSymbolEPmPKNS0_6ModuleEPKc", cpu => {
    const out = cpu.x(0), h = moduleOf(cpu, cpu.x(1)), name = cpu.x(2) ? cpu.cstr(cpu.x(2)) : "";
    stats.lookups++;
    if (h === undefined) { red("modsym", `ro::LookupModuleSymbol ${name || "(null)"}: not a loaded module`); return RO_FAIL; }
    // a name the loaded module does not define fails on Horizon too, and games probe for one
    const a = name ? rt.ld.lookupIn(h, name) : undefined;
    if (!a) return RO_FAIL;
    put64(cpu, out, a);
    return 0;
  });
  // as the SDK computes it, no service: the bss size from the NRO header
  f("_ZN2nn2ro13GetBufferSizeEPmPKv", cpu => {
    const out = cpu.x(0), image = Number(cpu.x(1)), dv = cpu.dv();
    if (!image || dv.getUint32(image + 0x10, true) !== 0x304F524E) return RO_NOT_NRO;
    put64(cpu, out, dv.getUint32(image + 0x38, true));
    return 0;
  });
  const load = (cpu: HostCpu): number => {
    const mod = cpu.x(0), image = Number(cpu.x(1)), buffer = cpu.x(2), size = cpu.x(3), flag = cpu.w(4), dv = cpu.dv();
    if (!image || dv.getUint32(image + 0x10, true) !== 0x304F524E) return RO_NOT_NRO;
    const n = dv.getUint32(image + 0x18, true);
    if (n < 0x80 || image + n > cpu.u8().length) { red("size", `ro::LoadModule: the NRO header at ${image.toString(16)} gives a size of ${n} bytes`); return RO_FAIL; }
    let m;
    try { m = rt.loadModule(`nro@${image.toString(16)}`, cpu.read(image, n)); }
    catch (e) { rt.log(`[RED] ro::LoadModule: ${(e instanceof Error ? e.message : String(e)).replace(/^\[RED\] /, "")}`); return RO_FAIL; }
    byBase.set(m.base, m.handle);
    if (mod) { const a = Number(mod), d = cpu.dv(); d.setBigUint64(a, BigInt(m.base), true); d.setUint32(a + 8, 1, true); d.setUint32(a + 12, 0, true); d.setBigUint64(a + 16, BigInt(image), true); d.setBigUint64(a + 24, buffer, true); }
    stats.loads++;
    // as RoModule::CallInit: the module's _init, which in an SDK module runs its init_array; a module without one
    // gets its init_array run here
    const inits = m.init ? [m.init] : m.initArray.filter(a => a);
    rt.log(`ro::LoadModule ${m.name} (${n} bytes, buffer ${size.toString(16)}, bind ${flag & 1 ? "now" : "lazy"}) at 0x${m.base.toString(16)}: ${inits.length} init call${inits.length === 1 ? "" : "s"}`);
    for (const fn of inits) { cpu.call(fn); stats.initCalls++; }
    rt.activateModule(m.handle);
    return 0;
  };
  f("_ZN2nn2ro10LoadModuleEPNS0_6ModuleEPKvPvmi", load);
  f("_ZN2nn2ro10LoadModuleEPNS0_6ModuleEPKvPvmib", load);   // SDK 19 adds a bool after the bind flag
  f("_ZN2nn2ro12UnloadModuleEPNS0_6ModuleE", cpu => {
    const mod = cpu.x(0), h = moduleOf(cpu, mod);
    if (h === undefined) { rt.log(`[RED] ro::UnloadModule: not a loaded module (0x${mod.toString(16)})`); return; }
    const m = rt.ld.info(h);
    // as RoModule::CallFini
    const finis = m.fini ? [m.fini] : [...m.finiArray].reverse().filter(a => a);
    for (const fn of finis) { cpu.call(fn); stats.finiCalls++; }
    rt.unloadModule(h);
    byBase.delete(m.base);
    const a = Number(mod), d = cpu.dv();
    d.setUint32(a + 8, 0, true); d.setBigUint64(a, 0n, true);
    stats.unloads++;
  });
  // an NRR only registers hashes with the service, which checks a module's hash at load: nothing to check here
  f("_ZN2nn2ro18RegisterModuleInfoEPNS0_16RegistrationInfoEPKv", cpu => {
    const nrr = Number(cpu.x(1));
    return nrr && cpu.dv().getUint32(nrr, true) === 0x3052524E ? 0 : RO_FAIL;
  });
  f("_ZN2nn2ro20UnregisterModuleInfoEPNS0_16RegistrationInfoE", () => { });
  return stats;
}
