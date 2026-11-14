// @ts-check
/** Runs one library scan off the main thread (see scanner.js). Input: { root }. Output: { library } or { error }. */
import { parentPort, workerData } from "node:worker_threads";
import { scanLibrary } from "./scanner.js";

try { parentPort?.postMessage({ library: scanLibrary(workerData.root) }); }
catch (e) { parentPort?.postMessage({ error: String(/** @type {Error} */ (e)?.message ?? e) }); }
