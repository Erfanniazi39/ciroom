// @ts-check
/**
 * Skip intro / skip credits (dev bridge; Stage 3 ports this to Rust).
 *
 * A background queue analyses the library season by season (dev/intro-worker.js, one season at a
 * time in a worker thread, ffmpeg at the lowest CPU/disk priority) and stores the result per video
 * file in CiRoom's database (table media_markers, keyed by path + size + mtime, so a replaced file is
 * analysed again). Order: the season of whatever you open first, then series you've been watching,
 * then everything else. New episodes found by a scan are picked up on the next pass.
 *
 *   GET /api/markers?path=…    → { status: "ready", intro: {start,end} | null, credits: number | null }
 *                                 | { status: "pending" } (its season jumps to the front of the queue)
 *                                 | { status: "none" }    (movies, or a season with a single episode)
 *   GET /api/markers/status    → { done, total, running }  (Settings shows it)
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DATA_DIR } from "./artwork-store.js";
import { openDb } from "./userdb.js";
import { BACKGROUND } from "./paths.js";

const LIB_FILE = path.join(DATA_DIR, "library.json");
const VERSION = 1; // bump when the analysis changes: everything is analysed again
const START_DELAY = 45_000; // let CiRoom start up first
const RECHECK = 10 * 60_000; // look for new episodes again after a pass

const TABLE = `CREATE TABLE IF NOT EXISTS media_markers (
  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, duration REAL,
  intro_start REAL, intro_end REAL, credits_start REAL, version INTEGER NOT NULL, analyzed_at INTEGER NOT NULL)`;

/** @typedef {{ key: string, label: string, seriesId: string, files: string[], ids: string[] }} Season */

export function introRoutes(/** @type {(p: string) => string} */ resolveVideo) {
  let db = /** @type {any} */ (null);
  /** @type {Promise<void> | null} */ let ready = null;
  // Vite reloads this module when dev/*.js changes, in the same process: only the newest queue may run,
  // older ones stop at their next step. (Also: nothing starts during `vite build`; see start().)
  const G = /** @type {any} */ (globalThis);
  const generation = (G.__ciroomIntroGen = (G.__ciroomIntroGen ?? 0) + 1);
  const stale = () => G.__ciroomIntroGen !== generation;
  /** @type {string[]} */ let wanted = []; // season keys asked for (most recent first)
  let running = /** @type {string | null} */ (null);
  let timer = /** @type {NodeJS.Timeout | null} */ (null);

  const stat = (/** @type {string} */ f) => { try { const s = fs.statSync(f); return { size: s.size, mtime: Math.floor(s.mtimeMs) }; } catch { return null; } };
  const row = (/** @type {string} */ f) => db.prepare("SELECT * FROM media_markers WHERE path = ?").get(f);
  const current = (/** @type {string} */ f) => {
    const r = row(f), s = stat(f);
    return r && s && r.size === s.size && r.mtime === s.mtime && r.version === VERSION ? r : null;
  };

  /** Seasons with at least one video, from the saved scan. @returns {Season[]} */
  function seasons() {
    let lib;
    try { lib = JSON.parse(fs.readFileSync(LIB_FILE, "utf8")); } catch { return []; }
    /** @type {Season[]} */ const out = [];
    for (const s of lib.series ?? []) for (const se of s.seasons ?? []) {
      const eps = (se.episodes ?? []).filter((/** @type {any} */ e) => e.file?.path);
      if (eps.length) out.push({ key: `${s.id}:${se.number}`, label: `${s.title} S${se.number}`, seriesId: s.id, files: eps.map((/** @type {any} */ e) => e.file.path), ids: eps.map((/** @type {any} */ e) => e.id) });
    }
    return out;
  }

  /** Next season to analyse: asked-for first, then recently watched series, then the rest. */
  function next() {
    const all = seasons().filter((s) => s.files.some((f) => !current(f)));
    if (!all.length) return null;
    for (const k of wanted) { const s = all.find((x) => x.key === k); if (s) return s; }
    if (!BACKGROUND) return null; // test version: only seasons you open
    const recent = db.prepare("SELECT item_id FROM watch_progress WHERE profile_id = 1 ORDER BY updated_at DESC LIMIT 50").all().map((/** @type {any} */ r) => r.item_id);
    for (const id of recent) { const s = all.find((x) => x.ids.includes(id)); if (s) return s; }
    return all[0];
  }

  function save(/** @type {Season} */ season, /** @type {Record<string, any>} */ results) {
    const ins = db.prepare("INSERT OR REPLACE INTO media_markers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const f of season.files) {
      const s = stat(f);
      if (!s) continue;
      const r = results[f] ?? { duration: null, intro: null, credits: null };
      ins.run(f, s.size, s.mtime, r.duration ?? null, r.intro?.[0] ?? null, r.intro?.[1] ?? null, r.credits ?? null, VERSION, Date.now());
    }
  }

  function work() {
    timer = null;
    if (running || stale()) return;
    const season = next();
    if (!season) { if (BACKGROUND) timer = setTimeout(work, RECHECK); return; }
    wanted = wanted.filter((k) => k !== season.key);
    if (season.files.length < 2) { save(season, {}); setImmediate(work); return; } // nothing to compare with
    running = season.label;
    const t = Date.now();
    const w = new Worker(new URL("./intro-worker.js", import.meta.url), { workerData: { files: season.files } });
    let done = false;
    const finish = (/** @type {Record<string, any> | null} */ results) => {
      if (done) return;
      done = true;
      running = null;
      if (results) {
        save(season, results);
        const found = Object.values(results).filter((r) => r.intro).length;
        console.log(`[ciroom] skip intro: ${season.label}: intro found in ${found}/${season.files.length} episodes (${((Date.now() - t) / 1000).toFixed(0)} s)`);
      }
      if (!stale()) timer = setTimeout(work, results ? 1000 : 60_000);
    };
    w.once("message", (m) => finish(m.results));
    w.once("error", (e) => { console.warn(`[ciroom] skip intro: ${season.label} failed:`, e.message); save(season, {}); finish(null); });
    w.once("exit", () => finish(null));
  }
  const kick = (/** @type {number} */ delay) => {
    if (running || stale()) return;
    if (timer) { if (delay !== 0) return; clearTimeout(timer); }
    timer = setTimeout(work, delay);
  };
  /** Opens the database and starts the background queue (called by the dev server, never by a build). */
  function start() {
    ready ??= (async () => { db = await openDb(); db.exec(TABLE); })();
    ready.then(() => { if (BACKGROUND) kick(START_DELAY); }).catch((e) => console.warn("[ciroom] skip intro disabled:", e.message));
    return ready;
  }

  /** Markers for a file already analysed, or null. Used for mpv and the phone. */
  function markersFor(/** @type {string} */ file) {
    if (!db) return null;
    const r = current(file);
    if (!r) return null;
    return { intro: r.intro_start != null ? { start: r.intro_start, end: r.intro_end } : null, credits: r.credits_start ?? null };
  }

  return {
    start,
    markersFor,
    /** @returns {Promise<boolean>} true if handled */
    async handle(/** @type {any} */ req, /** @type {(c: number, d: unknown) => void} */ json) {
      const url = new URL(String(req.url), "http://x");
      if (!url.pathname.startsWith("/api/markers")) return false;
      await start();
      if (url.pathname === "/api/markers/status") {
        const all = seasons();
        const files = all.flatMap((s) => s.files);
        json(200, { done: files.filter((f) => current(f)).length, total: files.length, running });
        return true;
      }
      if (url.pathname === "/api/markers") {
        const file = resolveVideo(String(url.searchParams.get("path") ?? ""));
        const m = markersFor(file);
        if (m) { json(200, { status: "ready", ...m }); return true; }
        const season = seasons().find((s) => s.files.includes(file));
        if (!season || season.files.length < 2) { json(200, { status: "none" }); return true; }
        wanted = [season.key, ...wanted.filter((k) => k !== season.key)].slice(0, 20);
        kick(0);
        json(200, { status: "pending" });
        return true;
      }
      json(404, { error: "Unknown endpoint" });
      return true;
    },
  };
}
