/** Worker-thread entry for the walker regex scan (F1): a catastrophic pattern
 * can starve the event loop, so grepContents' timeout race could never fire if
 * the scan ran inline. The parent races this worker against the deadline and
 * terminates it on timeout; this file only walks, scans, and posts the result.
 * Compiled to dist/grep-worker.js — search.ts spawns it via
 * `new URL("./grep-worker.js", import.meta.url)`. */
import { parentPort, workerData } from "node:worker_threads";
import { walkerRegexGrep } from "./search.js";
const data = workerData;
try {
    const matches = await walkerRegexGrep(data.cwd, data.pattern, data.literal, data.ignoreCase, data.follow, Date.now() + data.timeoutMs, data.timeoutMs, data.wholeWord, data.scope);
    parentPort?.postMessage({ matches });
}
catch (err) {
    parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) });
}
