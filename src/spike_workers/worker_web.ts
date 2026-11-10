// EXPERIMENTAL (spike). A guest-core Worker in a browser (bundled to build/spike_workers/web/worker.js).
import { serve } from "./coord.ts";
serve({ post: m => (self as any).postMessage(m), onmsg: fn => { (self as any).onmessage = (ev: MessageEvent) => fn(ev.data); } });
