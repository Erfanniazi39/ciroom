// Loads a front-end TypeScript module (src/…) in Node for unit tests: esbuild bundles it with the "@/" alias the app
// uses, into the test's scratch folder, then it is imported. Dependencies (React, zustand) are bundled in; only pure logic is called.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-ts-"));
process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));

// Browser things the stores touch at import time (persist storage): an in-memory localStorage, and a fetch that fails,
// so the stores fall back to their defaults like the window does when the server can't be reached.
globalThis.localStorage ??= /** @type {any} */ ({ _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } });
globalThis.window ??= /** @type {any} */ (globalThis);
const listeners = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
for (const [k, v] of Object.entries(listeners)) if (typeof (/** @type {any} */ (globalThis))[k] !== "function") (/** @type {any} */ (globalThis))[k] = v;
globalThis.document ??= /** @type {any} */ ({ ...listeners, visibilityState: "visible", createElement: () => ({}) });
globalThis.navigator ??= /** @type {any} */ ({ userAgent: "node" });

/** @param {string} rel path under the repo, e.g. "src/lib/library.ts" */
export async function loadTs(rel) {
  const file = path.join(out, rel.replace(/[\\/]/g, "_") + ".mjs");
  await build({
    entryPoints: [path.join(root, rel)], bundle: true, format: "esm", platform: "node", target: "node22", outfile: file, logLevel: "error",
    alias: { "@": path.join(root, "src") }, nodePaths: [path.join(root, "node_modules")],
  });
  return import(pathToFileURL(file).href);
}
