// @ts-check
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";

/**
 * Write a JSON file so a crash or a full disk can never leave it half-written: the data goes to a temporary
 * file next to it, then replaces the real file in one step (rename).
 * `mode` (e.g. 0o600) applies to the new file. `space` is the JSON indent. Throws if the write fails; the
 * old file is then still intact and no temporary file is left behind.
 */
export function writeJsonAtomic(/** @type {string} */ file, /** @type {any} */ value, /** @type {{ mode?: number, space?: number }} */ opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${threadId}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, opts.space), opts.mode === undefined ? undefined : { mode: opts.mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}
