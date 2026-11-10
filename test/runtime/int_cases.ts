// End-to-end cases of the parts joined in the integration round: controllers through the take-over table (several
// players, the applet's prompt, vibration), nn::audio attached (the silent sink's exact release times), the NVN
// waits (timeouts, device loss). Shared by run.mts (Node) and web/worker.ts (browser); no Node APIs.
import { Runtime, type RuntimeOptions } from "../../src/glue/rt_runtime.ts";
import type { CaseResult } from "./cases.ts";
import type { MoreEnv } from "./more_cases.ts";
import { bootGfx, type Gpu, type GfxProcess } from "./gfx_cases.ts";
import { attachHle } from "../../src/glue/hle_rt.ts";
import { RtInput, KEYBOARD, BTN } from "../../src/glue/rt_input.ts";
import { RtAudio } from "../../src/glue/rt_audio.ts";
import type { VibrationState } from "../../src/glue/hle_host.ts";
import { analyzeTone } from "../audio/analyze.ts";

function fail(msg: string): never { throw new Error(msg); }
function eq(got: unknown, want: unknown, what: string): void {
  const str = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
  if (str(got) !== str(want)) fail(`${what}:\n--- got ---\n${str(got)}\n--- want ---\n${str(want)}`);
}
function ok(c: unknown, what: string): void { if (!c) fail(what); }
const notForce = (l: string) => !l.includes("forced take-over entry with no reference");

// What the page or the test's page offers the audio cases: the device's page side and what its worklet put out
export interface AudioPage {
  send: (m: { audio: Record<string, unknown> }, transfer?: Transferable[]) => void;
  onMessage: (fn: ((m: unknown) => void) | null) => void;   // { audio } messages of the page side
  record: (frames: number) => Promise<void>;
  dump: () => Promise<{ pcm: Float32Array; frames: number; sampleRate: number; underrun: number; callbacks: number; context: string }>;
}
export interface IntEnv extends MoreEnv { audioPage?: AudioPage }

export interface IntCase { name: string; fn: () => Promise<string[]> }
export function intCases(env: IntEnv, gpu: Gpu | undefined): IntCase[] {
  const list: IntCase[] = [];
  const test = (name: string, fn: () => Promise<string[] | void>) => list.push({ name, fn: async () => (await fn()) ?? [] });
  const where = gpu ? "WebGPU" : "null replayer";
  void where;

  // ---- controllers ----
  if (env.mods.hle) test("input: keyboard and several controllers as several players by source id, a controller that leaves and comes back, the controller applet's prompt as a wait, vibration routed to the player's controller", async () => {
    const rt = new Runtime(env.mods);
    const prompts: [number, number][] = [], rumble: { source: number; state: VibrationState }[] = [];
    let input!: RtInput;
    const hle = attachHle(rt, env.mods.hle!, { config: { opmode: 1 }, front: {
      // the prompt stays up while the test connects two controllers, then OK
      ctrlPrompt: (min, max, answer) => {
        prompts.push([min, max]);
        setTimeout(() => { input.set(77, { buttons: 0, rumble: true }); input.set(88, { buttons: 0, rumble: true }); answer(true); }, 5);
        return true;
      },
      vibration: state => { if (input) rumble.push({ source: input.sourceOf(state.player), state }); },   // (the table reports every motor idle when the output is attached)
    } });
    input = new RtInput(hle);
    const players: string[] = [];
    rt.register({ name: "pads_step", fn: cpu => {
      const step = cpu.w(0);
      if (step === 1) input.set(KEYBOARD, { buttons: BTN.A });
      else if (step === 2) input.set(77, { buttons: BTN.B, rumble: true });
      else if (step === 3) input.set(88, { buttons: BTN.X, lx: 32767, rumble: true });
      else if (step === 4) input.set(77, null);                       // it went away: the keyboard is still player 1
      else if (step === 5) input.set(99, { buttons: BTN.Y });         // a new controller takes the free player 1
      else if (step === 6) input.set(77, { buttons: BTN.B });         // back: its player is taken, it gets the next one nobody held
      else return 0;
      players.push(`step ${step}: ` + input.players.map(p => `source ${p.source} = player ${p.player + 1}`).join(", "));
      return 1;
    } });
    ok(rt.loadNso([{ name: "pads", bytes: env.nso("pads") }]), "load failed: " + rt.red.join(" | "));
    const r = await rt.runAsync();
    eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + rt.red.join(" | "));
    eq(rt.stdout().split("\n"), [
      "step 0: No1 buttons 0x0 lx 0 No2 - No3 - No4 -",
      "controller applet: rc 0x0, players 2",
      "step 1: No1 buttons 0x1 lx 0 No2 buttons 0x0 lx 0 No3 - No4 -",
      "step 2: No1 buttons 0x3 lx 0 No2 buttons 0x0 lx 0 No3 - No4 -",
      "step 3: No1 buttons 0x3 lx 0 No2 buttons 0x40004 lx 32767 No3 - No4 -",
      "step 4: No1 buttons 0x1 lx 0 No2 buttons 0x40004 lx 32767 No3 - No4 -",
      "step 5: No1 buttons 0x9 lx 0 No2 buttons 0x40004 lx 32767 No3 - No4 -",
      "step 6: No1 buttons 0x9 lx 0 No2 buttons 0x40004 lx 32767 No3 buttons 0x2 lx 0 No4 -",
      "vibration handles of No2: 2", ""], "what the npads read");
    eq(prompts, [[2, 4]], "the controller prompt was asked for once, for 2 to 4 players");
    eq(players.at(-1), "step 6: source 99 = player 1, source 88 = player 2, source 77 = player 3", "players at the end");
    const last = rumble.at(-1) ?? fail("no vibration reached the front end");
    eq([last.source, last.state.player], [88, 1], "the vibration went to player 2's controller");
    const m = last.state.motors[0];
    ok(Math.abs(m.amplitudeLow - 0.5) < 1e-6 && Math.abs(m.frequencyLow - 160) < 1e-3 && Math.abs(m.amplitudeHigh - 0.25) < 1e-6 && Math.abs(m.frequencyHigh - 320) < 1e-3, "the left motor's value: " + JSON.stringify(m));
    eq(rt.red.filter(notForce), [], "red lines");
    return [...players.slice(-1), `the prompt asked for ${prompts[0][0]} to ${prompts[0][1]} players and waited; ${rumble.length} vibration reports, the last to source ${last.source}: ${JSON.stringify(m)}`,
      rt.logs.find(l => l.startsWith("hid controller applet")) ?? ""];
  });

  // ---- audio ----
  const toneBoot = (o: RuntimeOptions, total: number, extra: (rt: Runtime) => Partial<ConstructorParameters<typeof RtAudio>[2] & object> = () => ({})) => {
    const rt = new Runtime(env.mods, o), hle = attachHle(rt, env.mods.hle!, { config: { opmode: 1 } });
    const signals: bigint[] = [];
    const audio = new RtAudio(rt, env.mods.audio!, { hle, onSignal: (_t, ns) => signals.push(ns), ...extra(rt) });
    rt.register({ name: "tone_buffers", fn: () => total });
    ok(rt.loadNso([{ name: "tone", bytes: env.nso("tone") }]), "load failed: " + rt.red.join(" | "));
    return { rt, hle, audio, signals };
  };
  const NAME = "the output's name: DeviceOut; localtime of day 400: year 1971";
  const OPEN = "OpenDefaultAudioOut rc 0x0, 48000 Hz, 2 channels, volume x1000 1000, the event was created by this module's nn::os";
  if (env.mods.hle && env.mods.audio) test("audio (no device: the silent sink): a guest opens an AudioOut with a SystemEvent bound through the take-over table, keeps four 5 ms buffers of a tone in flight driven by the buffer-released event, and every buffer comes back at exactly its time on the guest clock", async () => {
    const N = 400, lines: string[] = [];
    const run = async (budget: number) => {
      const t = toneBoot({ budget }, N);
      const before = [0, 3].map(w => Number(t.rt.k.kernel_count(w)));
      const r = await t.rt.runAsync();
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], `how it ended (budget ${budget}): ` + t.rt.red.join(" | ") + t.rt.stdout());
      const out = t.rt.stdout().split("\n");
      eq(out.slice(0, 3), [OPEN, NAME, "StartAudioOut rc 0x0"], "the guest's first lines");
      ok(new RegExp(`^tone: ${N} buffers came back in ${N} wake-ups, (1999\\d\\d\\d|2000000) us of guest time, the longest gap 500\\d us$`).test(out[3]), "the guest's summary: " + out[3]);
      eq(t.signals.length, N, "release signals");
      // 240 frames at 48 kHz are 5 ms: buffer k comes back 5 ms after buffer k - 1, to the nanosecond
      const gaps = new Set(t.signals.slice(1).map((s, i) => s - t.signals[i]));
      eq([...gaps], [5_000_000n], `the times between two releases, in guest ns (budget ${budget})`);
      eq(t.rt.red.filter(notForce), [], "red lines");
      eq([t.audio.host.outs().length, Number(t.audio.x.audio_red_total())], [0, 0], "outputs left open, red lines of the module");
      return { t, out, before };
    };
    const a = await run(100000), b = await run(100000), c = await run(50);
    eq(b.t.signals, a.t.signals, "release times of a second run");
    eq([b.out[3], b.t.rt.stats.slices, b.t.rt.units, b.t.rt.guestNs()], [a.out[3], a.t.rt.stats.slices, a.t.rt.units, a.t.rt.guestNs()], "summary, slices, units and guest clock of a second run");
    eq(c.t.signals.length, N, "with budget 50");
    lines.push(a.out[0], a.out[1], a.out[3], `first release at guest ${a.t.signals[0]} ns, then every 5000000 ns exactly, ${N} times; identical on a second run (slices ${a.t.rt.stats.slices}, units ${a.t.rt.units}); budget 50: ${c.t.rt.stats.slices} slices, the same 5000000 ns between releases`,
      `${a.t.audio.stats.calls} nn::audio calls, ${a.t.audio.stats.ticks} ticks, ${a.t.audio.stats.binds} event bound by the guest's own CreateSystemEvent (${a.t.hle.x.hle_event_count()} bindings in the table at the end)`);
    // the wall clock: the same guest paced by real time, with the catch-up limit set
    const w = toneBoot({ clock: "wall" }, 60), t0 = performance.now(), r = await w.rt.runAsync(), ms = performance.now() - t0;
    eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "wall clock: how it ended");
    // a host timer that comes late lets two buffers come back in one tick: one signal for both (a signal an entry that released something)
    ok(/^tone: 60 buffers came back in \d+ wake-ups/.test(w.rt.stdout().split("\n")[3]) && w.signals.length <= 60 && w.signals.length >= 20, `wall clock: ${w.rt.stdout().split("\n")[3]}; ${w.signals.length} signals`);
    ok(ms > 280 && ms < 2000, `wall clock: 60 buffers of 5 ms took ${ms.toFixed(0)} ms`);
    lines.push(`wall clock: 60 buffers in ${ms.toFixed(0)} ms (300 ms of audio) with ${w.signals.length} signals, run loop busy ${w.rt.stats.runMs.toFixed(0)} ms`);
    return lines;
  });
  // ---- the audio renderer: the guest's stand-in SDK driven by the host's take-overs (src/audio/ren.ts) ----
  const renBoot = (o: RuntimeOptions, rounds: number, tail: number, extra: (rt: Runtime) => Partial<ConstructorParameters<typeof RtAudio>[2] & object> = () => ({})) => {
    const rt = new Runtime(env.mods, o), hle = attachHle(rt, env.mods.hle!, { config: { opmode: 1 } });
    const blocks: { sink: number; ns: bigint; pcm: Int16Array }[] = [];
    const audio = new RtAudio(rt, env.mods.audio!, { hle, onRenderBlock: (sink, pcm, ns) => blocks.push({ sink, ns, pcm: pcm.slice() }), ...extra(rt) });
    rt.register({ name: "audren_frames", fn: () => tail });
    rt.register({ name: "audren_rounds", fn: () => rounds });
    ok(rt.loadNso([{ name: "audren", bytes: env.nso("audren") }]), "load failed: " + rt.red.join(" | "));
    return { rt, hle, audio, blocks };
  };
  // what the guest's two voices must sound like at the sink, frame for frame (test/runtime/src/audren.c, ren_sdk.h)
  const renExpected = (): Int16Array => {
    const resonate = (n: number, k: number, first: number) => { const p = new Int16Array(n); let s2 = 0, s1 = first; for (let i = 1; i < n; i++) { p[i] = s1; const s = ((k * s1) >> 14) - s2; s2 = s1; s1 = s; } return p; };
    const voices = [{ data: resonate(2160, 32714, 471), pitch: 0x10000, vol: [0x8000, 0x4000], pos: 0, frac: 0 }, { data: resonate(2400, 32671, 499), pitch: 0x18000, vol: [0x2000, 0x6000], pos: 0, frac: 0 }];
    const out = new Int16Array(2160 * 2);
    for (let i = 0; i < 2160; i++) {
      let l = 0, r = 0;
      for (const v of voices) {
        if (v.pos >= v.data.length) continue;
        const x = v.data[v.pos];
        v.frac += v.pitch; v.pos += v.frac >>> 16; v.frac &= 0xffff;
        l += (x * v.vol[0]) >> 15; r += (x * v.vol[1]) >> 15;
      }
      out[2 * i] = l; out[2 * i + 1] = r;
    }
    return out;
  };
  // the blocks a sink played against the expected signal: the silent blocks before it, and what differs
  const renCompare = (blocks: { pcm: Int16Array }[]): { lead: number; sounding: number; tail: number; wrong: number } => {
    const want = renExpected(), all = new Int16Array(blocks.length * 480);
    blocks.forEach((b, i) => { ok(b.pcm.length === 480, `block ${i} has ${b.pcm.length / 2} frames`); all.set(b.pcm, i * 480); });
    let first = 0; while (first < blocks.length && blocks[first].pcm.every(v => v === 0)) first++;
    let wrong = 0;
    for (let i = 0; i < want.length; i++) if (all[first * 480 + i] !== want[i]) wrong++;
    let tail = 0; for (let i = first * 480 + want.length; i < all.length; i++) if (all[i] !== 0) wrong++; else tail++;
    return { lead: first, sounding: want.length / 480, tail: tail / 480, wrong };
  };
  if (env.mods.hle && env.mods.audio) test("audio renderer (no device): a guest opens a renderer for the DSP with an event; the host opens the guest SDK's renderer for CPU / manual rendering, runs it from a render thread the SDK starts for it, and takes the DeviceSink; two voices with queued wave buffers, pitch and volume come out as the expected signal, sample for sample, one 5 ms block per 5 ms of guest time; every wave buffer is reported consumed; close joins the thread", async () => {
    const run = async (budget: number, rounds = 1) => {
      const t = renBoot({ budget }, rounds, 6);
      const r = await t.rt.runAsync();
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], `how it ended (budget ${budget}): ` + t.rt.red.join(" | ") + t.rt.stdout());
      eq(t.rt.red.filter(notForce), [], "red lines");
      eq([t.audio.host.outs().length, Number(t.audio.x.audio_red_total()), t.audio.x.audio_ren_frames(), t.audio.x.kit_refused_total()], [0, 0, 0, 0], "outputs left open, red lines of the module, renderer calls in progress, refused transitions");
      return t;
    };
    const a = await run(100000), out = a.rt.stdout().split("\n");
    ok(/^GetAudioRendererWorkBufferSize 0x[0-9a-f]+000 \(the SDK's own for its CPU renderer: 0x[0-9a-f]+000\)$/.test(out[0]), out[0]);
    eq(out[1], "OpenAudioRenderer rc 0x0; the SDK was opened 1 time with device 1 mode 1; the SDK keeps an event of the host's, the game's has a read end attached; render thread priority 9", "the open");
    ok(/^audren: 5 wave buffers of 2 voices came back consumed, in order yes; at renderer events( \d+){5}; \d+ events in \d+ us of guest time$/.test(out[2]), out[2]);
    ok(/^CloseAudioRenderer: the SDK's close ran 1 time after \d+ renders and \d+ updates; render threads created 1 destroyed 1, stacks 1 freed 1$/.test(out[3]), out[3]);
    ok(/^audren: 1 rounds; events created 2 destroyed 3; threads 1 \/ 1; update lock taken \d+ times, \d+ through the kernel$/.test(out[4]), out[4]);
    // the wave buffers come back in the order they were queued, each voice's at the event after the frame that played its last sample
    const when = /events((?: \d+){5});/.exec(out[2])![1].trim().split(" ").map(Number);
    ok(when[0] < when[1] && when[1] < when[2] && when[3] < when[4], "release order: " + when.join(" "));
    eq([when[1] - when[0], when[2] - when[1], when[4] - when[3]], [3, 4, 3], "frames between two releases (720 and 960 frames at pitch 1; 1200 frames at pitch 1.5 are 800 output frames: 3.33 frames)");
    for (const want of ["audren: OpenAudioRenderer rate 48000 samples per frame 240 mix buffers 3 submixes 0 voices 4 sinks 1 effects 0 splitters 0 (original device 0 mode 0 -> CPU / manual)",
      "audren: renderer 0 opened from ", "audren: render thread 0 started (4 buffers in flight, paced by the output)", "audren: AudioRenderSystem at +0x60 in AudioRendererImpl",
      "audren: AudioRenderSystem in the SDK 16 layout (update lock SdkMutexType at +0x1d8)", "audren: first-frame commands 8, by command ID: 1x1 2x2 3x4 19x1", "audren: DeviceSink inputs 2 rate 48000 samples per frame 240 mix buffer "])
      ok(a.rt.logs.some(l => l.startsWith(want)), `no log line "${want}": ` + a.rt.logs.filter(l => l.startsWith("audren")).join(" | "));
    const c = renCompare(a.blocks);
    eq([c.wrong, c.sounding], [0, 9], `samples that differ from the expected signal, blocks of sound (${a.blocks.length} blocks, ${c.lead} silent before, ${c.tail} after)`);
    ok(c.lead >= 4 && c.tail >= 4, `silent blocks before (${c.lead}) and after (${c.tail})`);
    // pacing: four blocks at once (they are in flight), then one for each block the silent sink hands back, 5 ms apart
    const times = a.blocks.map(b => b.ns);
    ok(times[3] - times[0] < 100_000n && times[4] - times[0] > 4_900_000n && times[4] - times[0] <= 5_000_000n, "the first five blocks, guest ns: " + times.slice(0, 5).join(" "));
    // (a block is handed over when its render is done: the output's release, exact to the nanosecond, plus the render's own time)
    const gaps = times.slice(5).map((t, i) => Number(t - times[i + 4]));
    ok(gaps.every(g => Math.abs(g - 5_000_000) < 200_000), "guest ns between two blocks from the fifth on: " + gaps.join(" "));
    ok(Math.abs(Number(times.at(-1)! - times[4]) - 5_000_000 * gaps.length) < 200_000, "no drift over the run: " + (times.at(-1)! - times[4]));
    const b = await run(100000);
    eq([b.rt.stdout(), b.blocks.length, b.rt.units, b.rt.guestNs()], [a.rt.stdout(), a.blocks.length, a.rt.units, a.rt.guestNs()], "a second run: output, blocks, units, guest clock");
    // forced preemption every 50 units: the render thread and the game's update meet on the SDK's update lock
    const p = await run(50), pc = renCompare(p.blocks);
    eq([pc.wrong, pc.sounding], [0, 9], "budget 50: samples that differ, blocks of sound");
    // the game holds the SDK's update lock for 12 ms: the render thread blocks on it inside the SDK's Lock (a take-over
    // that waits in guest code), renders when it is free again, and nothing is lost or repeated
    const h = await run(100000, 0x101), hc = renCompare(h.blocks), hl = h.rt.stdout().split("\n")[4];
    eq([hc.wrong, hc.sounding], [0, 9], "lock held: samples that differ, blocks of sound");
    ok(/, [1-9]\d* through the kernel$/.test(hl), "the render thread did not block on the update lock: " + hl);
    const held = h.blocks.map(b => b.ns), longest = Math.max(...held.slice(1).map((t, i) => Number(t - held[i])));
    ok(longest > 11_000_000 && longest < 13_000_000, `the longest time between two blocks with the lock held for 12 ms: ${longest} ns`);
    // open and close twelve times: threads, stacks, events, outputs and the module's memory all come back
    const m = await run(100000, 12), last = m.rt.stdout().split("\n").at(-2)!;
    ok(/^audren: 12 rounds; events created 24 destroyed 36; threads 12 \/ 12; /.test(last), last);
    eq([0, 1, 2, 3].map(i => Number(m.audio.x.audio_ren_stat(i, 0))), [0, 0, 0, 0], "renderer slots at the end (Free)");
    const sounding = m.blocks.filter(b => b.pcm.some(v => v !== 0)).length;
    eq(sounding, 12 * 9, "blocks of sound in twelve rounds");
    const st = a.audio.stats;
    return [out[0], out[1], out[2], out[3], out[4],
      `${a.blocks.length} blocks at the sink: ${c.lead} silent, 9 that equal the expected mix of the two voices sample for sample (4320 samples), ${c.tail} silent; the first four within ${times[3] - times[0]} ns, then one per 5 ms of guest time (${Math.min(...gaps)} to ${Math.max(...gaps)} ns apart: a render's own time varies); identical on a second run`,
      `${st.calls} nn::audio calls, ${st.sdkCalls} SDK functions run for the take-overs on the calling guest thread, ${st.waits} waits, ${st.guestCalls} nested SDK calls; budget 50: ${p.rt.stats.slices} slices, the same samples, ${p.rt.stdout().split("\n")[4].replace(/^.*; update/, "update")}`,
      `update lock held by the game for 12 ms: ${hl.replace(/^.*; update/, "update")}; the longest time between two blocks ${longest} ns, the same samples`,
      `12 open / close rounds: ${last}; arena in use at the end ${m.audio.x.audio_arena_used()} bytes`];
  });
  // ---- audio on the real device (browser) ----
  if (env.audioPage && env.mods.hle && env.mods.audio) test("audio (browser: AudioContext and AudioWorklet): the same guest on the wall clock with the device attached through the page; the tone reaches the device: 440 Hz, no gap, no underrun, as audio:browser checks it", async () => {
    const page = env.audioPage!, N = 600;
    const t = toneBoot({ clock: "wall" }, N, () => ({ send: page.send, openDeviceAtStart: true }));
    const dev = t.audio.device!;
    let worstTick = 0, lastTick = 0;
    t.rt.onTick(() => { const n = performance.now(); if (lastTick && n - lastTick > worstTick) worstTick = n - lastTick; lastTick = n; });
    page.onMessage(m => { t.audio.handle(m); t.rt.requestWake(); });
    try {
      const t0 = performance.now();
      while (!dev.rate && !dev.error) { if (performance.now() - t0 > 10000) fail("the page did not open an AudioContext within 10 s"); await new Promise(r => setTimeout(r, 5)); }
      ok(!dev.error, "no device: " + dev.error);
      await page.record(dev.rate * 4);
      const states: string[] = [];
      const watch = setInterval(() => { const s = t.audio.host.outs()[0]?.state; if (s && states.at(-1) !== s) states.push(s); }, 2);
      lastTick = 0;
      const r = await t.rt.runAsync();
      clearInterval(watch);
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + t.rt.red.join(" | ") + t.rt.stdout());
      await new Promise(r => setTimeout(r, 200));   // what is still in the ring is played
      const d = await page.dump(), left = new Float32Array(d.frames);
      for (let i = 0; i < d.frames; i++) left[i] = d.pcm[2 * i];
      const whole = analyzeTone(left, 440, d.sampleRate), edge = Math.round(d.sampleRate * 0.05);
      const core = whole.last - whole.first > 4 * edge ? analyzeTone(left, 440, d.sampleRate, whole.first + edge, whole.last - edge) : whole;
      const sounding = (whole.last - whole.first) / d.sampleRate;
      eq(t.rt.stdout().split("\n")[0], OPEN, "the guest's first line");
      ok(states.includes("Live"), "the output's states: " + states.join(" "));
      ok(sounding > 2.5 && sounding < 3.1, `the device played ${sounding.toFixed(2)} s of sound for 3 s of buffers; output states ${states.join(" ")}; red: ${t.rt.red.join(" | ")}; device callbacks ${d.callbacks}, underrun ${d.underrun}`);
      ok(Math.abs(core.freq - 440) < 0.5, `frequency ${core.freq.toFixed(2)} Hz`);
      ok(Math.abs(core.amp - 0.5) < 0.01, `amplitude ${core.amp.toFixed(4)}`);
      // a run loop that came back more than the ring's lead late (29 ms at its lowest) leaves a gap: the machine's, not the port's
      const late = worstTick > 25;
      ok(late || (core.snr > 60 && core.gaps === 0 && d.underrun === 0), `the tone: ${core.snr.toFixed(1)} dB against a fitted sine, ${core.gaps} gaps, the device ran dry for ${d.underrun} frames; longest time between two ticks ${worstTick.toFixed(1)} ms`);
      eq(t.rt.red.filter(notForce), [], "red lines");
      return [`transport ${dev.transport}, context at ${d.sampleRate} Hz (${d.context}); output states ${states.join(" -> ")}`,
        `${sounding.toFixed(2)} s of ${core.freq.toFixed(2)} Hz, amplitude ${core.amp.toFixed(4)}, ${core.snr.toFixed(1)} dB against a fitted sine, ${core.gaps} gaps, device underrun ${d.underrun} frames in ${d.callbacks} callbacks` + (late ? ` [the run loop came back ${worstTick.toFixed(0)} ms late once: gap checks waived]` : ""),
        `${t.signals.length} buffers came back, ${t.audio.stats.ticks} ticks, the longest time between two ${worstTick.toFixed(1)} ms; ${t.rt.stdout().split("\n")[3]}`];
    } finally { page.onMessage(null); if (!t.rt.disposed) { t.rt.kill(); if (!t.rt.disposed) t.rt.dispose(); } }
  });
  if (env.audioPage && env.mods.hle && env.mods.audio) test("audio renderer (browser: AudioContext and AudioWorklet): the renderer guest on the wall clock with the device attached through the page, six open / play / close rounds; what the worklet put out holds the two voices' mix as the expected signal, sample for sample", async () => {
    const page = env.audioPage!, ROUNDS = 6;
    const t = renBoot({ clock: "wall" }, ROUNDS, 40, () => ({ send: page.send, openDeviceAtStart: true }));
    const dev = t.audio.device!;
    // the longest time between two ticks while a renderer's output is open (between two rounds nothing needs feeding)
    let worstTick = 0, lastTick = 0;
    t.rt.onTick(() => { if (!t.audio.host.outs().length) { lastTick = 0; return; } const n = performance.now(); if (lastTick && n - lastTick > worstTick) worstTick = n - lastTick; lastTick = n; });
    page.onMessage(m => { t.audio.handle(m); t.rt.requestWake(); });
    try {
      const t0 = performance.now();
      while (!dev.rate && !dev.error) { if (performance.now() - t0 > 10000) fail("the page did not open an AudioContext within 10 s"); await new Promise(r => setTimeout(r, 5)); }
      ok(!dev.error, "no device: " + dev.error);
      eq(dev.rate, 48000, "the context's rate (the comparison is sample for sample)");
      await page.record(dev.rate * 4);
      lastTick = 0;
      const r = await t.rt.runAsync();
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + t.rt.red.join(" | ") + t.rt.stdout());
      await new Promise(r => setTimeout(r, 200));   // what is still in the ring is played
      const d = await page.dump(), want = renExpected(), N = want.length / 2;
      // the stretches of sound in the recording: each must be the expected signal (PCM16 / 32768 as the mixer writes it)
      const quiet = (i: number) => d.pcm[2 * i] === 0 && d.pcm[2 * i + 1] === 0;
      const bursts: { at: number; frames: number; wrong: number }[] = [];
      for (let i = 0; i < d.frames; i++) {
        if (quiet(i)) continue;
        let end = i, gap = 0;
        for (let k = i; k < d.frames && gap < 240; k++) { if (quiet(k)) gap++; else { gap = 0; end = k; } }
        const at = i - 1;   // both voices' first sample is 0
        let wrong = 0;
        for (let k = 0; k < N; k++) for (let c = 0; c < 2; c++) if (Math.abs((d.pcm[2 * (at + k) + c] ?? 9) - want[2 * k + c] / 32768) > 1e-6) wrong++;
        bursts.push({ at, frames: end - at + 1, wrong });
        i = end + 240;
      }
      const exact = bursts.filter(b => b.wrong === 0).length;
      const sinks = t.rt.logs.filter(l => l.startsWith("audren: render sink")).length;
      eq(sinks, ROUNDS, "render sinks opened");
      // a round whose sound began before its output was taken over by the device, or a run loop that came back later
      // than the ring's lead, loses frames: the machine's, not the port's. Four of six must be whole
      const late = worstTick > 25;
      ok(exact >= (late ? 1 : ROUNDS - 2), `${exact} of ${bursts.length} stretches of sound equal the expected signal (${bursts.map(b => `${b.frames} frames, ${b.wrong} samples off`).join("; ")}); device underrun ${d.underrun}; longest time between two ticks ${worstTick.toFixed(1)} ms`);
      eq(t.rt.red.filter(notForce), [], "red lines");
      eq([t.audio.host.outs().length, t.audio.x.audio_ren_frames()], [0, 0], "outputs left open, renderer calls in progress");
      return [`transport ${dev.transport}, context at ${d.sampleRate} Hz (${d.context}); ${ROUNDS} rounds, ${t.blocks.length} blocks from the render sinks`,
        `${bursts.length} stretches of sound at the worklet, ${exact} equal to the expected mix of the two voices sample for sample (${N} frames each${exact < bursts.length ? "; the others: " + bursts.filter(b => b.wrong).map(b => `stretch ${bursts.indexOf(b) + 1}, ${b.frames} frames, ${b.wrong} samples off`).join(", ") : ""}); device underrun ${d.underrun} frames in ${d.callbacks} callbacks, longest time between two ticks ${worstTick.toFixed(1)} ms` + (late ? " [the run loop came back late: only one whole stretch is asked for]" : ""),
        t.rt.stdout().split("\n")[2], t.rt.stdout().split("\n").at(-2)!];
    } finally { page.onMessage(null); if (!t.rt.disposed) { t.rt.kill(); if (!t.rt.disposed) t.rt.dispose(); } }
  });

  // ---- graphics: the waits ----
  if (env.haveGfxGuests && env.mods.gfx && env.mods.hle) test("gfx waits (null replayer the test holds back, wall clock): nvnSyncWait with timeout 0, a finite timeout that runs out on the thread's own timer, a finite and an infinite one met by the fence; nvnQueueFinish waits for its fence; float arguments and results by nvn_abi", async () => {
    let held = false, p!: GfxProcess;
    p = await bootGfx(env, [{ name: "syncg", bytes: env.nso("syncg") }], { frames: 0, clock: "wall", nullReplayer: true, holdFences: () => held, setup: q => {
      q.rt.register({ name: "sync_hold", fn: cpu => { held = cpu.w(0) !== 0; if (!held) q.gfx.releaseFences(); } });
      q.rt.register({ name: "sync_release_in", fn: cpu => { const ms = cpu.w(0); setTimeout(() => { held = false; q.gfx.releaseFences(); }, ms); } });
    } });
    const r = await p.rt.runAsync();
    eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + p.rt.red.join(" | ") + p.rt.stdout());
    eq(p.rt.stdout().split("\n"), [
      "sampler builder: lod bias x1000 = 1250, max anisotropy x1000 = 8000",
      "SyncWait on a sync that was never fenced: 2",
      "fence pending, timeout 0: 2",
      "fence pending, timeout 30 ms: 2, after about 30 ms",
      "fence completes 15 ms into a wait of 5 s: 1, when it completed",
      "the same sync again, timeout 0: 0",
      "a new fence, infinite timeout: 1, when it completed",
      "QueueFinish returned when the GPU had finished, the fence before it: 0", ""], "the guest's results (0 ALREADY_SIGNALED, 1 CONDITION_SATISFIED, 2 TIMEOUT_EXPIRED)");
    const s = p.gfx.stats;
    eq([s.syncWaits, s.syncParked, s.syncTimeouts, s.finishes, s.finishParked], [7, 3, 1, 1, 1], "SyncWait calls, parked, timed out; QueueFinish calls, parked");
    eq([s.floatArgCalls, s.floatResults], [2, 2], "calls with float arguments marshalled, float results written to d0");
    eq(p.rt.red.filter(notForce), [], "red lines");
    return [`${s.syncWaits} SyncWait calls: ${s.syncParked} parked the thread, ${s.syncTimeouts} ended by its timeout; QueueFinish parked on fence ${p.gfx.x.gfx_finish_fence() >>> 0}`,
      `${s.nvnCalls} NVN calls, of which ${s.floatArgCalls} marshalled d0..d7 and ${s.floatResults} returned a float through d0`];
  });
  // On a device the GPU finishes on its own: the same guest, nothing held; the waits end and nothing is red
  if (gpu && env.haveGfxGuests && env.mods.gfx && env.mods.hle) test("gfx waits (WebGPU, wall clock): the same guest on the device: every wait ends, QueueFinish returns after its fence", async () => {
    const p = await bootGfx(env, [{ name: "syncg", bytes: env.nso("syncg") }], { frames: 0, clock: "wall", gpu, setup: q => {
      q.rt.register({ name: "sync_hold", fn: () => { } }); q.rt.register({ name: "sync_release_in", fn: () => { } });
    } });
    const r = await p.rt.runAsync();
    eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + p.rt.red.join(" | ") + p.rt.stdout());
    const out = p.rt.stdout().split("\n");
    eq(out[0], "sampler builder: lod bias x1000 = 1250, max anisotropy x1000 = 8000", "floats");
    ok(/^a new fence, infinite timeout: [01],/.test(out[6]), "the infinite wait: " + out[6]);
    ok(/the fence before it: 0$/.test(out[7]), "after QueueFinish: " + out[7]);
    eq(p.rt.red.filter(notForce), [], "red lines");
    return out.slice(2, 8).map(l => l) .concat([`SyncWait parked ${p.gfx.stats.syncParked} times, QueueFinish parked ${p.gfx.stats.finishParked} times`]);
  });

  // ---- graphics: the device goes away in the middle ----
  if (gpu?.requestDevice && env.haveGfxGuests && env.mods.gfx && env.mods.hle) test("gfx device loss: the GPU device is destroyed while the cube demo runs; the replayer gets a new one through requestDevice, textures are uploaded again from guest memory, and the last frame's pixels are those of a run without a loss", async () => {
    const hash = (d: Uint8Array) => { let h = 0x811c9dc5; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };
    const pixels = async (p: GfxProcess) => { await p.gfx.host.device.queue.onSubmittedWorkDone(); return (await p.gfx.host.readTexture(p.gfx.host.lastPresented)).data as Uint8Array; };
    const run = async (loseAt: number) => {
      const device = await gpu.requestDevice!();
      let lost = 0;
      const p = await bootGfx(env, [{ name: "cube", bytes: env.nso("cube") }], { frames: 30, gpu: { ...gpu, device }, onPresent: f => { if (f === loseAt) { lost++; device.destroy(); } } });
      const r = await p.rt.runAsync();
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + p.rt.red.join(" | "));
      return { p, lost, px: await pixels(p) };
    };
    const plain = await run(0), hit = await run(12);
    eq(plain.p.rt.red.filter(notForce), [], "red lines of the run without a loss");
    eq([hit.lost, hit.p.gfx.stats.deviceLosses, hit.p.gfx.stats.deviceRestores, hit.p.gfx.x.gfx_device_state()], [1, 1, 1, 0], "devices destroyed, losses seen, restores, the device machine at the end (0 Live)");
    eq(hit.p.rt.stdout(), plain.p.rt.stdout(), "stdout");
    eq(hash(hit.px), hash(plain.px), "the last frame's pixels");
    const red = hit.p.rt.red.filter(notForce);
    ok(red.length >= 1 && /^\[RED\] WebGPU device lost \(destroyed\)/.test(red[0]), "the loss is one red line: " + red.join(" | "));
    ok(red.every(l => /device lost|the GPU device was lost/.test(l)), "no other red line: " + red.join(" | "));
    plain.p.rt.dispose(); hit.p.rt.dispose();
    return [`30 frames, the device destroyed at frame 12: ${hit.p.gfx.stats.deviceLosses} loss, ${hit.p.gfx.stats.deviceRestores} restore, last frame's pixel hash ${hash(hit.px)} = ${hash(plain.px)} without a loss`, ...red];
  });
  // ---- robustness: long runs, the same seed twice, nothing growing ----
  interface Mark { round: number; memory: number; handles: number; events: number; maps: number; threadRecords: number; table: number; units: number; pcmap: number; loaderArena: number; modules: number; gpu: number }
  const mark = (rt: Runtime, round: number, gfx?: GfxProcess["gfx"]): Mark => ({ round, memory: rt.memory.buffer.byteLength, handles: Number(rt.k.kernel_count(0)), events: Number(rt.k.kernel_count(3)), maps: Number(rt.k.kernel_count(4)),
    threadRecords: Number(rt.k.kernel_count(2)), table: rt.a64.table.length, units: rt.a64.units.length, pcmap: rt.a64.pcMapBytes, loaderArena: rt.ld.x.ld_arena_used() >>> 0, modules: rt.modules.length, gpu: gfx?.live ? gfx.host.liveObjects : 0 });
  const grown = (a: Mark, b: Mark, allow: (keyof Mark)[] = []) => (Object.keys(a) as (keyof Mark)[]).filter(k => k !== "round" && !allow.includes(k) && b[k] > a[k]).map(k => `${k} ${a[k]} -> ${b[k]}`);
  const stress = async (file: string, o: RuntimeOptions, hooks: Record<string, number>, extra?: (rt: Runtime) => void) => {
    const rt = new Runtime(env.mods, o), marks: Mark[] = [];
    attachHle(rt, env.mods.hle!, { config: { opmode: 1 } });
    for (const [name, v] of Object.entries(hooks)) rt.register({ name, fn: () => v });
    rt.register({ name: "stress_mark", fn: cpu => { marks.push(mark(rt, cpu.w(0))); } });
    extra?.(rt);
    ok(rt.loadNso([{ name: file, bytes: env.nso(file) }]), "load failed: " + rt.red.join(" | "));
    const t0 = performance.now(), r = await rt.runAsync();
    eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], `${file}: how it ended: ` + rt.red.slice(-3).join(" | ") + rt.stdout());
    return { rt, marks, ms: performance.now() - t0, end: mark(rt, -1), fingerprint: `${rt.stats.slices}/${rt.stats.svcs}/${rt.units}/${rt.guestNs()}` };
  };
  if (env.mods.hle) test("robust threads: 64 threads contend on four mutexes and two condition variables with timeouts, sleep and exit, wave after wave for 30 s of guest time; the same seed gives the same output, another seed another; no handle or thread record is left", async () => {
    const run = (seed: number) => stress("stress_threads", {}, { stress_seed: seed, stress_ms: 30000 });
    const a = await run(12345), b = await run(12345), c = await run(777);
    eq(b.rt.stdout(), a.rt.stdout(), "the same seed again: output");
    eq(b.fingerprint, a.fingerprint, "the same seed again: slices/SVCs/units/guest ns");
    ok(c.rt.stdout() !== a.rt.stdout(), "another seed gives another run");
    ok(/lock words 0x0 0x0 0x0 0x0 ; guest ms 30\d\d\d$/.test(a.rt.stdout().split("\n")[1]), "every lock free at the end, 30 s passed: " + a.rt.stdout().split("\n")[1]);
    eq([a.end.threadRecords, a.end.maps], [1, 1], "thread records and mappings at the end (the main thread and its stack)");
    ok(a.end.handles <= 2, `handles in use at the end: ${a.end.handles}`);
    eq(a.rt.red.filter(notForce), [], "red lines");
    return [...a.rt.stdout().trim().split("\n"), `${a.rt.stats.slices} slices, ${a.rt.stats.svcs} SVCs in ${a.ms.toFixed(0)} ms; identical on a second run (${a.fingerprint}); seed 777: ${c.rt.stdout().split("\n")[0].slice(0, 60)}...`,
      `at the end: ${a.end.handles} handle(s), ${a.end.threadRecords} thread record, memory ${(a.end.memory / 2 ** 20).toFixed(0)} MiB of address space`];
  });
  if (env.mods.hle) test("robust memory: 3000 rounds of SetHeapSize (4 to 32 MB) and MapMemory / UnmapMemory of heap pages into the stack region while another thread reads and writes the heap; deterministic; no mapping, handle or memory growth", async () => {
    const run = (seed: number) => stress("stress_mem", {}, { stress_seed: seed, stress_rounds: 3000 });
    const a = await run(99), b = await run(99), c = await run(100);
    eq(b.rt.stdout(), a.rt.stdout(), "the same seed again"); eq(b.fingerprint, a.fingerprint, "the same seed again: fingerprint");
    ok(c.rt.stdout() !== a.rt.stdout(), "another seed gives another run");
    ok(/^rounds 3000, mapped and unmapped 3000, failures 0, checksum 0x[0-9a-f]+; the other thread: \d+ touches, 0 wrong$/.test(a.rt.stdout().trim()), a.rt.stdout());
    eq(grown(a.marks[0], a.marks[1]), [], "between round 300 and the last: nothing grew");
    eq([a.end.maps, Number(a.rt.k.kernel_count(5))], [1, 0x800000], "mappings left (the main stack), heap size at the end");
    eq(a.rt.red.filter(notForce), [], "red lines");
    return [a.rt.stdout().trim(), `${a.rt.stats.svcs} SVCs in ${a.ms.toFixed(0)} ms; memory ${(a.end.memory / 2 ** 20).toFixed(0)} MiB of address space at round 300 and at the end, ${a.end.handles} handles, 1 mapping (the main stack); identical on a second run`];
  });
  if (env.mods.hle) test("robust modules: an NRO loaded through nn::ro, called and unloaded 500 times; deterministic; the function table, the pc map, the loader's arena and the memory do not grow from round 50 on", async () => {
    const nro = (rt: Runtime) => rt.register({ name: "test_nro", fn: cpu => { const b = env.file("plug.nro"); cpu.write(cpu.x(0), b); return b.length; } });
    const a = await stress("stress_ro", {}, { stress_rounds: 500 }, nro), b = await stress("stress_ro", {}, { stress_rounds: 500 }, nro);
    eq(b.rt.stdout(), a.rt.stdout(), "a second run"); eq(b.fingerprint, a.fingerprint, "a second run: fingerprint");
    ok(/^(  plug: (init function|fini function, counter \d+)\n)*loaded and unloaded 500 times, 0 failures, checksum 0x[0-9a-f]+\n$/.test(a.rt.stdout()), a.rt.stdout().slice(-200));
    eq(grown(a.marks[0], a.marks[1]), [], "between round 50 and the last: nothing grew");
    eq([a.rt.stats.moduleLoads, a.rt.stats.moduleUnloads, a.end.modules, a.rt.a64.codeRanges().length], [500, 500, 1, 1], "loads, unloads, modules and code ranges left");
    eq(a.rt.red.filter(notForce), [], "red lines");
    const m = a.marks[1];
    return [a.rt.stdout().trim().split("\n").at(-1)!, `${a.ms.toFixed(0)} ms; at round 50 and at the end: function table ${m.table} slots, ${m.units} units, pc map ${m.pcmap} bytes, loader arena ${m.loaderArena} bytes, memory ${(m.memory / 2 ** 20).toFixed(0)} MiB; ${a.rt.a64.translatedFuncs} functions translated in all`];
  });
  if (env.haveGfxGuests && env.mods.gfx && env.mods.hle) test(`robust frames (${gpu ? "WebGPU" : "null replayer"}): 2000 frames with the texture rewritten in pool memory every fourth frame and the present interval changing every 100; deterministic guest clock and (on a device) pixels; no growth in GPU objects, handles or memory`, async () => {
    const run = async () => {
      const marks: Mark[] = [];
      const p = await bootGfx(env, [{ name: "stress_gfx", bytes: env.nso("stress_gfx") }], { frames: 2000, gpu, setup: q => q.rt.register({ name: "stress_mark", fn: cpu => { marks.push(mark(q.rt, cpu.w(0), q.gfx)); } }) });
      const t0 = performance.now(), r = await p.rt.runAsync();
      eq([r.state, r.stop?.kind, r.stop?.code], ["Stopped", "exit", 0], "how it ended: " + p.rt.red.slice(-3).join(" | ") + p.rt.stdout());
      let px = "";
      if (gpu) { await gpu.device.queue.onSubmittedWorkDone(); const img = await p.gfx.host.readTexture(p.gfx.host.lastPresented); let h = 0x811c9dc5; for (const v of img.data as Uint8Array) { h ^= v; h = Math.imul(h, 0x01000193); } px = (h >>> 0).toString(16); }
      const out = { p, marks, ms: performance.now() - t0, px, fp: `${p.rt.stats.slices}/${p.rt.stats.svcs}/${p.rt.units}/${p.rt.guestNs()}/${p.gfx.stats.nvnCalls}`, uploads: p.gfx.x.gfx_stat(8) >>> 0 };
      if (gpu) p.rt.dispose();
      return out;
    };
    const a = await run(), b = await run();
    // intervals 1, 2, 3 in turn for 100 frames each: 2000 frames are 3900 refreshes of 16.67 ms less the first, 64.98 s of guest time
    ok(/^frames 2000, texture updates 500, present interval changes 20, guest ms 6498\d$/.test(a.p.rt.stdout().trim()), a.p.rt.stdout());
    eq(b.p.rt.stdout(), a.p.rt.stdout(), "a second run: output");
    if (gpu) eq(b.px, a.px, "a second run: the last frame's pixels"); else eq(b.fp, a.fp, "a second run: slices/SVCs/units/guest ns/NVN calls");
    ok(a.uploads >= 500, `texture uploads from pool memory: ${a.uploads} for 500 rewrites`);
    eq(grown(a.marks[0], a.marks[1]), [], "between frame 200 and the last: nothing grew");
    eq(a.p.rt.red.filter(notForce), [], "red lines");
    const m = a.marks[1];
    return [a.p.rt.stdout().trim(), `${a.ms.toFixed(0)} ms (${(2000000 / a.ms).toFixed(0)} frames/s unpaced by real time); ${a.uploads} texture uploads; at frame 200 and at the end: ${m.gpu} GPU textures and buffers alive, ${m.handles} handles, memory ${(m.memory / 2 ** 20).toFixed(0)} MiB; ` +
      (gpu ? `last frame's pixel hash ${a.px} twice` : `identical on a second run (${a.fp})`)];
  });
  return list;
}

export async function runIntCases(env: IntEnv, gpu: Gpu | undefined, only: string | undefined, report: (r: CaseResult) => void): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of intCases(env, gpu)) {
    if (only && !c.name.includes(only)) continue;
    const t0 = performance.now();
    let r: CaseResult;
    try { const info = await c.fn(); r = { name: c.name, ok: true, why: "", info, ms: performance.now() - t0 }; }
    catch (e) { r = { name: c.name, ok: false, why: e instanceof Error ? (e.stack ?? e.message) : String(e), info: [], ms: performance.now() - t0 }; }
    out.push(r); report(r);
  }
  return out;
}
export type { GfxProcess };
