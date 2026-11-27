// Functional test environment: a real CiRoom server (server/index.js) on a random port, with a synthetic library
// (tests/fixtures/media.js), its own data/cache folders, and optional stand-ins for the outside world:
//   - mpv: the real mpv, but forced to --vo=null --ao=null (no window, no sound) through a wrapper first in PATH
//   - TMDB / IMDb: answered in-process by tests/functional/tmdb-mock.js (loaded with --import), never the internet
// Restartable with the same data (stop({ keep: true }) then start again with `data`), to test what survives a restart.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freePort, request, postJson } from "../helpers.js";
import { buildClips, makeLibrary } from "../fixtures/media.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export { request, postJson };

/** A fresh scratch folder for one test file. */
export const scratch = (/** @type {string} */ name) => fs.mkdtempSync(path.join(os.tmpdir(), `ciroom-fn-${name}-`));

/** PATH folder with an `mpv` that runs the real mpv without a window or sound. */
export function mpvWrapperDir(/** @type {string} */ dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = ["/usr/bin/mpv", "/usr/local/bin/mpv"].find((p) => fs.existsSync(p)) ?? "mpv";
  fs.writeFileSync(path.join(bin, "mpv"), `#!/bin/sh\nexec ${real} "$@" --vo=null --ao=null --fullscreen=no\n`, { mode: 0o755 });
  return bin;
}

/**
 * @param {{ layout?: import("../fixtures/media.js").Layout, media?: string, data?: string, cache?: string, env?: Record<string,string>,
 *   tmdb?: boolean, mpv?: boolean, dir?: string, port?: number }} [o]
 */
export async function startCiRoom(o = {}) {
  const dir = o.dir ?? scratch("srv");
  const clips = await buildClips();
  const media = o.media ?? makeLibrary(path.join(dir, "lib"), o.layout ?? {}, clips);
  const data = o.data ?? path.join(dir, "data");
  const cache = o.cache ?? path.join(dir, "cache");
  fs.mkdirSync(data, { recursive: true });
  // mpv's control socket lives in XDG_RUNTIME_DIR under a fixed name: a private one keeps tests from ever talking to the
  // user's mpv (or to another test's).
  const run = path.join(dir, "run");
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const port = o.port ?? (await freePort());
  const env = {
    ...process.env, CIROOM_PORT: String(port), CIROOM_DEV: "1", CIROOM_LISTEN_ALL: "1", CIROOM_MEDIA_ROOT: media,
    CIROOM_DATA_DIR: data, CIROOM_CACHE_DIR: cache, CIROOM_DIST: path.join(root, "dist"), CIROOM_BACKGROUND: "0", TZ: "UTC", XDG_RUNTIME_DIR: run,
    ...(o.mpv ? { PATH: `${mpvWrapperDir(dir)}${path.delimiter}${process.env.PATH}`, CIROOM_MPV_SAVE_MS: "500" } : {}),
    ...o.env,
  };
  const args = [...(o.tmdb ? ["--import", pathToFileURL(path.join(root, "tests/functional/tmdb-mock.js")).href] : []), path.join(root, "server/index.js")];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try { const r = await request({ port, path: "/api/ping" }); if (r.status === 200) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error("server exited: " + log);
    if (Date.now() - t0 > 20000) { child.kill("SIGKILL"); throw new Error("server did not start: " + log); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = {
    port, dir, media, data, cache, child, clips, log: () => log,
    get: (/** @type {string} */ p, /** @type {Record<string,string>} */ headers = {}) => request({ port, path: p, headers }),
    post: (/** @type {string} */ p, /** @type {any} */ b = {}) => postJson(port, p, b),
    put: (/** @type {string} */ p, /** @type {any} */ b = {}) => postJson(port, p, b, {}, "PUT"),
    /** Stops the server (SIGTERM = the clean shutdown path) and deletes the scratch folder unless keep. */
    async stop({ keep = false, signal = /** @type {NodeJS.Signals} */ ("SIGTERM") } = {}) {
      if (child.exitCode === null) {
        const gone = new Promise((r) => child.once("exit", r));
        child.kill(signal);
        await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await gone; }
      }
      if (!keep && !o.dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return s;
}

/** Scan and return the library. */
export async function scan(/** @type {{ post: Function }} */ s) {
  const r = await s.post("/api/library/scan");
  if (r.status !== 200) throw new Error(`scan failed ${r.status} ${r.text}`);
  return r.json;
}

/** The user-state shape the PC window saves (PUT /api/userdata/user replaces it whole). */
export const userState = (/** @type {Record<string, any>} */ over = {}) => ({
  favorites: [], watchlist: [], progress: {}, history: [], watchLog: {}, subPrefs: {}, audioPrefs: {}, subDelays: {}, volume: 100, levelling: true, ...over,
});

/** Imports an empty state once (the database refuses writes before the first import), then saves `state`. */
export async function saveUser(/** @type {any} */ s, /** @type {any} */ state) {
  const cur = await s.get("/api/userdata");
  if (!cur.json?.imported) {
    const r = await s.post("/api/userdata/import", { user: userState(), settings: {} });
    if (r.status !== 200) throw new Error(`import failed ${r.status} ${r.text}`);
  }
  const r = await s.put("/api/userdata/user", { state });
  if (r.status !== 200) throw new Error(`save failed ${r.status} ${r.text}`);
  return r;
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it returns a truthy value (returned) or the time runs out (throws with the last value). */
export async function until(/** @type {() => any} */ fn, ms = 10000, step = 150) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await sleep(step);
  }
}
