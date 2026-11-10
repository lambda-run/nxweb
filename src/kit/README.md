# kit: table-driven state machines

Every subsystem with a lifecycle defines it here as a table. The table is the only place that says which state
follows which; the code, the diagram in `docs/machines/` and the coverage rule all come from it.

| File | What |
|---|---|
| `defs/<name>.json` | **The definition of a machine: the single source of truth.** |
| `gen/tables.ts` | Generated AssemblyScript: all tables in one static blob, and the constants `<NAME>`, `<Name>S.*`, `<Name>E.*`. |
| `machine.ts` | The kit (AssemblyScript): `Inst`, `step`, `can`, the trace ring, the hit bitmap. |
| `exports.ts` | The `kit_*` exports a module gives its embedder (trace, tables, hits). |
| `host/defs.mts`, `host/gen.mts` | Node: loads and validates the definitions, generates `gen/tables.ts` and `docs/machines/*.md`. |
| `host/reader.mts` | Embedder side (Node or browser): decodes the trace, reads tables and hits from a module. |
| `home_quit.ts` | The Home button's quit machine (port of nxnative `dm/host/home_quit.h`). |

`npm run kit:diagrams` generates, `npm run kit:check` fails when a generated file is out of date, `npm run kit:test`
checks, compiles `test/kit/entry.ts`, runs `test/kit/*.test.mts` and fails if a transition of any table was never taken.

## Defining a machine

1. Write `defs/<name>.json`: `id` (the next free number; ids are 0..n-1 without gaps), `name` (lower_snake_case, also
   the file name), `doc`, `states` and `events` (PascalCase, at most 128 each), `initial`, optionally `final`, and
   `transitions` as `[from, event, to]`. One target per (from, event). The generator rejects unknown names, a state
   that is never entered, an event in no transition, and a transition out of a final state.
2. A state that carries a value declares it under `data`: `{"Waiting": {"name": "waitKind", "values": ["lock", ...]}}`
   for an enumeration (values are 1..n, constants `<Name><DataName>.*`), or `{"name": "since", "type": "..."}` for a
   free 64-bit value.
3. `npm run kit:diagrams`, and commit `gen/tables.ts` and `docs/machines/<name>.md` with the definition.
4. In AssemblyScript: `import { Inst } from ".../kit/machine"` and the constants from `.../kit/gen/tables`. An `Inst`
   is 16 unmanaged bytes that you place yourself (static memory, a pool, a field range of your own record:
   `Inst.at(ptr)`); `inst.init(KTHREAD, threadIndex)` puts it in the initial state.
5. `inst.step(KthreadE.Block, KthreadWaitKind.lock)` is the only way the state changes. It returns false, leaves
   everything as it was and logs a `[RED] ` line when the table has no entry. Read `inst.state` and `inst.data` freely;
   never write them.
6. Where an event is one of several things that may or may not apply, ask first with `inst.can(event)` (a pure
   table lookup). A refusal is for what must not happen, not for control flow.
7. Your module's entry file needs `export * from ".../kit/exports"` and the import `env.log(ptr, len)` (UTF-8 bytes).
8. Add tests under `test/kit/` (or drive the machine from your own area's tests with coverage on) until
   `npm run kit:test` reports every transition exercised.

## Rules of the kit

- **State.** `Inst` = `state` u8, `machine` u8, `id` u32 (which thread, which prompt: only for the trace and the log),
  `data` u64. The definition is shared by all instances; thousands of instances cost 16 bytes each.
- **Data.** `data` is what the current state carries. `step(event, arg)` stores `arg` when the target state declares
  data, and clears `data` to 0 when it does not; a transition from a state to itself keeps it. For an enumerated value
  an argument outside 1..n is refused. So data also changes only through `step`, and only as the table declares.
- **Refusals**, three classes, all leave state and data untouched, return false, add to `kit_refused_total()` and log
  `[RED] kit: kthread#7 refused Start in Running (no transition)`: no table entry (this includes every event in a final
  state), `(unknown event)` for an event id the machine does not have, `(bad data)` for an enumerated value out of range.
  `init` with an unknown machine id logs red and traps.
- **Trace.** A ring of 4096 records of 16 bytes at `kit_trace_ptr()`; `kit_trace_total()` counts all records ever
  written, record n is in slot n % 4096. Layout: `+0 u32 seq, +4 u32 instance, +8 u16 machine, +10 u8 from, +11 u8 to,
  +12 u8 event, +13 u8 flags` (bit 0 refused, bits 1-2 the refusal class 1..3). On by default; `kit_trace_enable(0)`
  turns it off. `step` tests one global word for "trace or coverage on" and otherwise does nothing extra (measured by
  `kit:test`, which prints ns/step for both). Refusals are counted and logged red whether tracing is on or not.
- **Coverage.** `kit_cover_enable(1)` (the test harness does it) makes every accepted transition set a byte in a hit
  bitmap with the same cells as the tables. Off by default.
- **No allocation.** Everything is static memory; the kit works with `--runtime stub`.

## Guards and inputs: how the Home button fits

`hq_step(q, now, home, a, b)` in nxnative takes button levels and a time, not an event, and keeps `since`, `home`,
`a_up`, `b_up` next to the phase. Here:

- A **guard** is a plain function that reads the inputs and the instances and decides which event happened. It keeps
  nothing between calls and changes nothing except through `step`. `HomeQuit.step` and `HomeQuit.cancel` in
  `home_quit.ts` are guards; the conditions of `hq_step` are there line for line.
- Everything that was a field is machine state, so it is in a table, in the trace and under the coverage rule:

  | home_quit.h | here |
  |---|---|
  | `phase` | machine `home_quit`, the same five phases with the same numbers |
  | `since` | the data the state `Holding` carries (the `now` of the press, as f64 bits) |
  | `home` (down at the last step) | a `button_latch` instance: `Spent` = 1, `Armed` = 0 |
  | `a_up`, `b_up` | a `button_latch` instance each: `Armed` = 1 |

- **Time is an input.** The guard compares the `now` it is given with `since` and offers `HoldElapsed`; nothing reads
  a clock. As in nxnative the prompt opens at the first step at or after 2 s, so the embedder steps from a timer while
  Home is held.
- Events the guard does not offer are not refusals: A pressed in `Idle` is simply not this machine's business, and a
  focus loss after `Quit` changes nothing (`can(FocusLost)` is false there). With correct guards this machine never
  logs red; the random comparison with `home_quit.h` in the tests asserts that.
- Two differences nobody can observe: after the prompt has closed, the A and B latches keep their last state (in C
  `a_up`/`b_up` also keep stale values) and are set again when the next prompt opens; and a focus loss in `Idle` is a
  traced transition `Idle -FocusLost-> Idle`.
- Not ported, because they are not part of the machine: `hq_enabled` (an environment switch), `hq_text_line`
  (the front end's texts), `hq_in_app_name` (a macOS setting's log word).
