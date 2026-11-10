// The address-space verdict of game profiles, by the runtime's own rule: `settingsFor` / `layoutFor` of
// src/glue/rt_process.ts, the function a process's layout is made with. tools/prepare/convert_profiles.py runs this
// (profiles as JSON on stdin, verdicts as JSON on stdout) so that the profile files and the report say what the
// runtime will do, with no number of the layout written a second time.
//   in:  [{ id, apply: Record<string, string>, space: { heap_region, alias_region, stack_region } }]
//   out: { rule, space, defaults, verdicts: [{ id, fit, note, heap, alias, stack, pool, mem64? }] }
// fit / note and the sizes are the rule's answer for a 32-bit memory. mem64 is there when that answer is "short" and
// the same rule fits the profile in a 64-bit memory (layoutChoice): { fit, heap, alias, stack, pool, real, sentence },
// real being the most real memory the tab's linear memory may come to hold.
import { settingsFor, SPACE, DEFAULTS } from "../../src/glue/rt_process.ts";

let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) text += chunk;
const verdicts = (JSON.parse(text) as { id: string; apply: Record<string, string>; space: { heap_region: number; alias_region: number; stack_region: number } }[]).map(p => {
  const l = settingsFor(p.apply, { space: p.space, mem64: false }).layout, c = settingsFor(p.apply, { space: p.space, mem64: "auto" }).choice!;
  return { id: p.id, fit: l.fit, note: l.note, heap: l.heapSize, alias: l.aliasSize, stack: l.stackSize, pool: l.appPool,
    ...(c.mem64 ? { mem64: { fit: c.layout.fit, heap: c.layout.heapSize, alias: c.layout.aliasSize, stack: c.layout.stackSize, pool: c.layout.appPool, real: c.real, sentence: c.sentence } } : {}) };
});
process.stdout.write(JSON.stringify({ rule: "src/glue/rt_process.ts layoutFor", space: { lo: SPACE.lo, hi: SPACE.hi, room: SPACE.hi - SPACE.lo, alias_max: SPACE.aliasMax }, defaults: DEFAULTS, verdicts }));
