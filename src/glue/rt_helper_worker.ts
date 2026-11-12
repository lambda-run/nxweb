// A helper Worker of the runtime (RuntimeOptions.helpers; rt_helpers.ts): runs the translated code of one guest thread
// at a time over the shared memory. Bundled as build/web/helper_worker.js; the runtime's Worker makes them.
import { helperBody } from "./rt_helpers.ts";
const on = helperBody(text => { (self as any).postMessage({ t: "fail", text }); });
(self as any).onmessage = (e: MessageEvent) => on(e.data);
