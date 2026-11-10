// The page of `npm run rt:browser`: starts the Worker that runs the cases, keeps what it reports for the Node script,
// and hosts the page side of the audio device (AudioDeviceMain: an AudioContext exists only on the main thread),
// passing { audio } messages both ways and handing the worklet's recording to the Worker's audio case.
import { AudioDeviceMain } from "../../../src/glue/audio_device_main.ts";

const w = window as any;
w.results = []; w.finished = null; w.shots = []; w.notes = [];
w.start = (only: string | undefined) => {
  const worker = new Worker("/worker.js");
  const main = new AudioDeviceMain((m, t) => worker.postMessage(m, t ?? []), { watchVisibility: false });
  w.audioMain = main;
  worker.onmessage = async ev => {
    const d = ev.data;
    if (main.handle(d)) return;
    if (d.audioTest === "record") { await main.opened; main.record(d.frames); worker.postMessage({ audioTestDone: d.id, result: true }); }
    else if (d.audioTest === "dump") {
      const r = await main.dump();
      worker.postMessage({ audioTestDone: d.id, result: { pcm: r.dump, frames: r.frames, sampleRate: r.sampleRate, underrun: r.underrun, callbacks: r.callbacks, context: main.ctx?.state ?? "none" } }, [r.dump.buffer]);
    }
    else if (d.result) w.results.push(d.result);
    else if (d.shot) w.shots.push({ ...d.shot, rgba: Array.from(d.shot.rgba) });
    else if (d.note) w.notes.push(d.note);
    else w.finished = d;
  };
  worker.onerror = e => { w.finished = { done: true, fatal: String(e.message) }; };
  worker.postMessage({ only });
};
