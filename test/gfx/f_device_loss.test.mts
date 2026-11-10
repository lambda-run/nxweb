// GfxHost's device loss under Node, with a fake device: the replacement it asks for after a loss
import assert from "node:assert/strict";
import { test } from "./harness.mts";
import { GfxHost } from "../../src/glue/gfx_host.ts";

const tick = () => new Promise(r => setTimeout(r, 5));
function setup() {
  let lose: (i: unknown) => void = () => {}, give: (d: unknown) => void = () => {};
  const device = () => ({ features: new Set(), limits: {}, queue: {}, destroy() {}, lost: new Promise(r => { lose = r; }) });
  const h = new GfxHost(device() as any, new WebAssembly.Memory({ initial: 1 }), { log: () => {}, requestDevice: () => new Promise(r => { give = r; }) });
  let restored = 0;
  (h as any).x = { gfx_device_lost() {}, gfx_host_caps() {}, gfx_device_restored() { restored++; return 0; } };
  return { h, device, lose: (i: unknown) => lose(i), give: (d: unknown) => give(d), restored: () => restored };
}

test("device loss: the new device is adopted when it comes", async () => {
  const s = setup();
  s.lose({ reason: "destroyed", message: "test" }); await tick();
  s.give(s.device()); await tick();
  assert.deepEqual([s.h.stats.deviceLosses, s.restored()], [1, 1]);
});

test("device loss: a host disposed while the new device is asked for does not take it (the process had ended)", async () => {
  const s = setup();
  s.lose({ reason: "destroyed", message: "test" }); await tick();
  s.h.dispose();
  s.give(s.device()); await tick();
  assert.deepEqual([s.h.stats.deviceLosses, s.restored()], [1, 0]);
});
