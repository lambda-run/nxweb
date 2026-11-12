// A helper Worker of the runtime under Node (worker_threads): src/glue/rt_helper_worker.ts for the tests.
import { parentPort } from "node:worker_threads";
import { helperBody } from "../../src/glue/rt_helpers.ts";
parentPort!.on("message", helperBody(text => parentPort!.postMessage({ t: "fail", text })));
