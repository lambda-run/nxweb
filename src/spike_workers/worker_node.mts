// EXPERIMENTAL (spike). A guest-core Worker under Node (worker_threads).
import { parentPort } from "node:worker_threads";
import { serve } from "./coord.ts";
serve({ post: m => parentPort!.postMessage(m), onmsg: fn => { parentPort!.on("message", fn); } });
