// @ts-check
/**
 * CiRoom's user database.
 *
 * Progress, favorites, watchlist, history, watch time, subtitle/audio choices and app settings live in
 * SQLite at ~/.local/share/marquee/ciroom.db instead of the window's browser storage, so they are safe
 * (WAL, daily backups) and don't depend on the window's address (the standalone app will use a new port).
 * Every row has a profile_id, ready for profiles (#17); today everything is profile 1.
 *
 * The UI keeps its zustand stores; their persistence goes through these routes (src/lib/serverStorage.ts):
 *   GET  /api/userdata                   → { imported, user: {...} | null, settings: {...} | null }
 *   PUT  /api/userdata/user     {state}  → replaces profile 1's user data (one transaction)
 *   PUT  /api/userdata/settings {state}  → replaces profile 1's settings
 *   POST /api/userdata/import   {user, settings} → one-time move from browser storage (cleans the
 *        session-1 sample data: progress/history saved before CiRoom existed)
 * This PC only: phones and watch-party guests get 403.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./artwork-store.js";

const DB_FILE = path.join(DATA_DIR, "ciroom.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PROFILE = 1;
/** Progress/history saved before this moment is the session-1 sample data (CiRoom first ran on 2026-11-10). */
const SAMPLE_CUTOFF = new Date(2026, 10, 9).getTime();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS watch_progress (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL, position REAL NOT NULL, duration REAL NOT NULL, watched INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id));
CREATE TABLE IF NOT EXISTS watch_history (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (profile_id, item_id));
CREATE TABLE IF NOT EXISTS user_list_items (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  list TEXT NOT NULL CHECK (list IN ('favorites','watchlist')), item_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (profile_id, list, item_id));
CREATE TABLE IF NOT EXISTS watch_time (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day TEXT NOT NULL, title_id TEXT NOT NULL, seconds REAL NOT NULL, PRIMARY KEY (profile_id, day, title_id));
CREATE TABLE IF NOT EXISTS sub_delays (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL, seconds REAL NOT NULL, PRIMARY KEY (profile_id, item_id));
CREATE TABLE IF NOT EXISTS sub_prefs (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL, off INTEGER NOT NULL, language TEXT, name TEXT, PRIMARY KEY (profile_id, title_id));
CREATE TABLE IF NOT EXISTS audio_prefs (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL, lang TEXT NOT NULL, PRIMARY KEY (profile_id, title_id));
CREATE TABLE IF NOT EXISTS settings (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (profile_id, scope, key));
`;

/** Plain user-store fields kept in the settings table (scope "user"); everything else has its own table. */
const USER_SCALARS = ["volume", "levelling"];

/** Opens the database lazily (node:sqlite is built into Node 22; no native module to install). */
let db = /** @type {any} */ (null);
async function open() {
  if (db) return db;
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (?, ?, ?)").run(PROFILE, "Me", Date.now());
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  try { fs.chmodSync(DB_FILE, 0o600); } catch { /* not fatal */ }
  backup();
  return db;
}

/** One backup a day (VACUUM INTO: a consistent copy), keeping the last 7. */
function backup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const name = `ciroom-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.db`;
    const file = path.join(BACKUP_DIR, name);
    if (fs.existsSync(file) || !imported()) return;
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^ciroom-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
    for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) {
    console.warn("[ciroom] database backup failed:", e instanceof Error ? e.message : e);
  }
}

const imported = () => !!db.prepare("SELECT value FROM meta WHERE key = 'imported_at'").get();

/** Profile 1's user data in the shape of the UI's user store (src/store/user.ts). */
function readUser() {
  const all = (/** @type {string} */ sql) => db.prepare(sql).all(PROFILE);
  /** @type {Record<string, any>} */ const progress = {};
  for (const r of all("SELECT * FROM watch_progress WHERE profile_id = ?"))
    progress[r.item_id] = { position: r.position, duration: r.duration, watched: !!r.watched, updatedAt: r.updated_at };
  const history = all("SELECT item_id, at FROM watch_history WHERE profile_id = ? ORDER BY at DESC").map((r) => ({ id: r.item_id, at: r.at }));
  const list = (/** @type {string} */ name) =>
    db.prepare("SELECT item_id FROM user_list_items WHERE profile_id = ? AND list = ? ORDER BY position").all(PROFILE, name).map((r) => r.item_id);
  /** @type {Record<string, Record<string, number>>} */ const watchLog = {};
  for (const r of all("SELECT * FROM watch_time WHERE profile_id = ?")) (watchLog[r.day] ??= {})[r.title_id] = r.seconds;
  const subDelays = Object.fromEntries(all("SELECT item_id, seconds FROM sub_delays WHERE profile_id = ?").map((r) => [r.item_id, r.seconds]));
  const subPrefs = Object.fromEntries(all("SELECT * FROM sub_prefs WHERE profile_id = ?").map((r) =>
    [r.title_id, r.off ? { off: true } : { language: r.language ?? null, name: r.name ?? "" }]));
  const audioPrefs = Object.fromEntries(all("SELECT title_id, lang FROM audio_prefs WHERE profile_id = ?").map((r) => [r.title_id, r.lang]));
  /** @type {Record<string, any>} */ const state = { favorites: list("favorites"), watchlist: list("watchlist"), progress, history, watchLog, subDelays, subPrefs, audioPrefs };
  Object.assign(state, readScope("user"));
  return state;
}

function readScope(/** @type {string} */ scope) {
  /** @type {Record<string, any>} */ const out = {};
  for (const r of db.prepare("SELECT key, value FROM settings WHERE profile_id = ? AND scope = ?").all(PROFILE, scope)) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* skip a broken value */ }
  }
  return out;
}

function writeScope(/** @type {string} */ scope, /** @type {Record<string, any>} */ values) {
  db.prepare("DELETE FROM settings WHERE profile_id = ? AND scope = ?").run(PROFILE, scope);
  const ins = db.prepare("INSERT INTO settings (profile_id, scope, key, value) VALUES (?, ?, ?, ?)");
  for (const [k, v] of Object.entries(values)) if (v !== undefined && typeof v !== "function") ins.run(PROFILE, scope, k, JSON.stringify(v));
}

const num = (/** @type {any} */ v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (/** @type {any} */ v) => String(v).slice(0, 300);
const obj = (/** @type {any} */ v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);

/** Replaces profile 1's user data with `s` (the user store's persisted state), in one transaction. */
function writeUser(/** @type {any} */ s) {
  s = obj(s);
  db.exec("BEGIN");
  try {
    for (const t of ["watch_progress", "watch_history", "user_list_items", "watch_time", "sub_delays", "sub_prefs", "audio_prefs"])
      db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(PROFILE);
    const p = db.prepare("INSERT INTO watch_progress VALUES (?, ?, ?, ?, ?, ?)");
    for (const [id, v] of Object.entries(obj(s.progress))) p.run(PROFILE, str(id), num(v?.position), num(v?.duration), v?.watched ? 1 : 0, num(v?.updatedAt, Date.now()));
    const h = db.prepare("INSERT OR REPLACE INTO watch_history VALUES (?, ?, ?)");
    for (const v of arr(s.history).slice(0, 500)) if (v?.id) h.run(PROFILE, str(v.id), num(v.at, Date.now()));
    const l = db.prepare("INSERT OR IGNORE INTO user_list_items VALUES (?, ?, ?, ?)");
    for (const name of ["favorites", "watchlist"]) arr(s[name]).forEach((id, i) => l.run(PROFILE, name, str(id), i));
    const w = db.prepare("INSERT INTO watch_time VALUES (?, ?, ?, ?)");
    for (const [day, titles] of Object.entries(obj(s.watchLog))) for (const [id, sec] of Object.entries(obj(titles))) w.run(PROFILE, str(day), str(id), num(sec));
    const d = db.prepare("INSERT INTO sub_delays VALUES (?, ?, ?)");
    for (const [id, sec] of Object.entries(obj(s.subDelays))) d.run(PROFILE, str(id), num(sec));
    const sp = db.prepare("INSERT INTO sub_prefs VALUES (?, ?, ?, ?, ?)");
    for (const [id, v] of Object.entries(obj(s.subPrefs))) sp.run(PROFILE, str(id), v?.off ? 1 : 0, v?.language ?? null, v?.name ?? null);
    const a = db.prepare("INSERT INTO audio_prefs VALUES (?, ?, ?)");
    for (const [id, lang] of Object.entries(obj(s.audioPrefs))) if (lang) a.run(PROFILE, str(id), str(lang));
    writeScope("user", Object.fromEntries(USER_SCALARS.filter((k) => k in s).map((k) => [k, s[k]])));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function writeSettings(/** @type {any} */ s) {
  db.exec("BEGIN");
  try { writeScope("app", obj(s)); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Drops the session-1 sample data: progress and history saved before CiRoom existed. Returns what was removed. */
function cleanSample(/** @type {any} */ user) {
  const u = obj(user);
  const removed = Object.entries(obj(u.progress)).filter(([, v]) => num(v?.updatedAt) < SAMPLE_CUTOFF).map(([id]) => id);
  for (const id of removed) delete u.progress[id];
  u.history = arr(u.history).filter((h) => num(h?.at) >= SAMPLE_CUTOFF);
  return { user: u, removed };
}

/** The open database (for other bridge modules, e.g. skip-intro markers). */
export const openDb = () => open();

export function userdbRoutes() {
  return {
    /** @returns {Promise<boolean>} true if handled */
    async handle(/** @type {any} */ req, /** @type {(c: number, d: unknown) => void} */ json, /** @type {(r: any) => Promise<any>} */ body, /** @type {boolean} */ local) {
      const url = String(req.url);
      if (!url.startsWith("/api/userdata")) return false;
      if (!local) { json(403, { error: "Not allowed from this device" }); return true; }
      await open();
      if (url === "/api/userdata" && req.method === "GET") {
        const ok = imported();
        const settings = readScope("app");
        json(200, { imported: ok, user: ok ? readUser() : null, settings: ok && Object.keys(settings).length ? settings : null });
        return true;
      }
      if (url === "/api/userdata/user" && req.method === "PUT") {
        if (!imported()) { json(409, { error: "Import first" }); return true; }
        const { state } = await body(req);
        // A broken or empty request must never wipe the data: the real store always sends these fields.
        if (!state || typeof state !== "object" || typeof state.progress !== "object" || !Array.isArray(state.favorites) || !Array.isArray(state.history)) {
          json(400, { error: "Incomplete user data" }); return true;
        }
        writeUser(state);
        json(200, { ok: true });
        return true;
      }
      if (url === "/api/userdata/settings" && req.method === "PUT") {
        if (!imported()) { json(409, { error: "Import first" }); return true; }
        const { state } = await body(req);
        if (!state || typeof state !== "object" || Array.isArray(state)) { json(400, { error: "Incomplete settings" }); return true; }
        writeSettings(state);
        json(200, { ok: true });
        return true;
      }
      if (url === "/api/userdata/import" && req.method === "POST") {
        if (imported()) { json(200, { imported: true, user: readUser(), settings: readScope("app"), removed: [] }); return true; }
        const b = await body(req);
        if (b.user != null && (typeof b.user !== "object" || Array.isArray(b.user))) { json(400, { error: "Bad import" }); return true; }
        const { user, removed } = cleanSample(b.user ?? { progress: {}, favorites: [], watchlist: [], history: [] });
        writeUser(user);
        if (b.settings) writeSettings(b.settings);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_at', ?)").run(new Date().toISOString());
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('import_removed', ?)").run(JSON.stringify(removed));
        backup();
        console.log(`[ciroom] user data moved to ${DB_FILE} (${Object.keys(obj(user.progress)).length} progress entries; removed sample data: ${removed.join(", ") || "none"})`);
        json(200, { imported: true, user: readUser(), settings: readScope("app"), removed });
        return true;
      }
      json(404, { error: "Unknown endpoint" });
      return true;
    },
  };
}
