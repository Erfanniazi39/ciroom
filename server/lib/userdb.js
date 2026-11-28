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
 *   GET  /api/userdata                   → { imported, user: {...} | null, settings: {...} | null, revision, readOnly }
 *   PUT  /api/userdata/user     {state}  → replaces profile 1's user data (one transaction)
 *   PUT  /api/userdata/settings {state}  → replaces profile 1's settings
 *   POST /api/userdata/import   {user, settings} → one-time move from browser storage (cleans the
 *        session-1 sample data: progress/history saved before CiRoom existed)
 * This PC only: phones and watch-party guests get 403.
 *
 * Read-only data folder (the shared NTFS drive after Windows hibernated or shut down with Fast Startup): the database
 * is opened from a private temporary copy, GET answers the saved data with `readOnly: true`, and the PUT routes answer
 * 503 `{ readOnly: true }`. Writability is checked again at most once a minute when a request comes in. Every save
 * bumps meta.revision, so a window that kept changes while the folder was read-only can tell whether the database
 * changed meanwhile (src/lib/serverStorage.ts) and a PUT may carry `ifRevision` (409 `{ conflict: true }` if it changed).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./artwork-store.js";
import { checkWritable } from "./diskcheck.js";
import { LOCAL_DIR } from "./paths.js";
import { defineRoutes } from "./routes.js";

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
/** True while the data folder can't be written: `db` is then a private temporary copy (or an empty in-memory database). */
let readOnly = false;
/** The temporary folder holding that copy, removed when the real database is opened again. */
let roCopy = /** @type {string | null} */ (null);
let lastCheck = 0;
const RECHECK_MS = 60_000;
/** @type {Promise<any> | null} */ let sqlite = null;
/** Told when `db` is replaced (read-only ↔ writable), e.g. the skip-intro queue. @type {Set<(db: any, readOnly: boolean) => void>} */
const listeners = new Set();

/** True for errors that mean "this folder or file can't be written": read-only mount, permissions. */
function isReadOnlyError(/** @type {any} */ e) {
  if (["EROFS", "EACCES", "EPERM"].includes(e?.code)) return true;
  const base = Number(e?.errcode) & 0xff;
  return base === 8 /* SQLITE_READONLY */ || (base === 14 /* SQLITE_CANTOPEN */ && checkWritable(DATA_DIR).readOnly);
}

/** The real database, read-write (throws if the folder or file can't be written). */
function openWritable(/** @type {any} */ DatabaseSync) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = new DatabaseSync(DB_FILE);
  try {
    d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    d.exec(SCHEMA);
    d.prepare("INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (?, ?, ?)").run(PROFILE, "Me", Date.now());
    d.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  } catch (e) {
    try { d.close(); } catch { /* not open */ }
    throw e;
  }
  try { fs.chmodSync(DB_FILE, 0o600); } catch { /* not fatal */ }
  return d;
}

/**
 * The saved data, for reading only. SQLite can't even read a WAL database in a folder where it can't create its -shm
 * file, so this opens a private copy (database + write-ahead log) in the system's temporary folder. Nothing written to
 * the copy is kept. No database yet: an empty one in memory.
 */
function openReadOnly(/** @type {any} */ DatabaseSync) {
  dropCopy();
  if (!fs.existsSync(DB_FILE)) {
    const d = new DatabaseSync(":memory:");
    d.exec(SCHEMA);
    return d;
  }
  roCopy = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-readonly-"));
  const copy = path.join(roCopy, "ciroom.db");
  fs.copyFileSync(DB_FILE, copy);
  if (fs.existsSync(`${DB_FILE}-wal`)) fs.copyFileSync(`${DB_FILE}-wal`, `${copy}-wal`); // not the -shm: SQLite rebuilds it from the log
  for (const f of fs.readdirSync(roCopy)) fs.chmodSync(path.join(roCopy, f), 0o600); // copies keep the original's read-only mode
  const d = new DatabaseSync(copy);
  d.exec("PRAGMA busy_timeout = 3000;");
  d.exec(SCHEMA); // only the copy: tables a very old database lacks
  return d;
}

function dropCopy() {
  if (!roCopy) return;
  try { fs.rmSync(roCopy, { recursive: true, force: true }); } catch { /* the system cleans its temporary folder */ }
  roCopy = null;
}

function replaceDb(/** @type {any} */ next, /** @type {boolean} */ ro) {
  const old = db;
  db = next;
  readOnly = ro;
  for (const fn of listeners) { try { fn(db, ro); } catch (e) { console.warn("[ciroom] database listener failed:", e instanceof Error ? e.message : e); } }
  try { old?.close(); } catch { /* already closed */ }
}

const READ_ONLY_NOTE = (/** @type {string} */ dir) =>
  `[ciroom] the data folder ${dir} is read-only (on the shared drive: Windows was hibernated or shut down with Fast Startup). ` +
  "Showing the saved progress; the window keeps what you watch and saves it when the folder is writable again.";

async function open() {
  if (db && !(readOnly && Date.now() - lastCheck >= RECHECK_MS)) return db;
  if (closed) throw new Error("CiRoom is shutting down");
  const { DatabaseSync } = await (sqlite ??= import("node:sqlite"));
  if (closed) throw new Error("CiRoom is shutting down");
  if (db && !readOnly) return db; // opened by a request that arrived at the same time
  if (db) {
    // Read-only: try the real database again (the drive may have been remounted read-write).
    if (Date.now() - lastCheck < RECHECK_MS) return db;
    lastCheck = Date.now();
    if (checkWritable(DATA_DIR).readOnly) return db;
    let d;
    try { d = openWritable(DatabaseSync); } catch (e) { if (!isReadOnlyError(e)) console.warn("[ciroom] database still read-only:", e instanceof Error ? e.message : e); return db; }
    replaceDb(d, false);
    dropCopy();
    console.log(`[ciroom] the data folder ${DATA_DIR} is writable again: saving to the database`);
    backup();
    return db;
  }
  try {
    db = openWritable(DatabaseSync);
    readOnly = false;
  } catch (e) {
    if (!isReadOnlyError(e)) throw e;
    db = openReadOnly(DatabaseSync);
    readOnly = true;
    lastCheck = Date.now();
    console.warn(READ_ONLY_NOTE(DATA_DIR));
    return db;
  }
  backup();
  return db;
}

/** A write failed because the folder became read-only while CiRoom was running: switch to the read-only copy. */
async function becomeReadOnly() {
  const { DatabaseSync } = await (sqlite ??= import("node:sqlite"));
  replaceDb(openReadOnly(DatabaseSync), true);
  lastCheck = Date.now();
  console.warn(READ_ONLY_NOTE(DATA_DIR));
}

/** Backups on this system's own disk (LOCAL_DIR): the data folder may sit on the shared NTFS drive, which has been damaged before. */
const LOCAL_BACKUP_DIR = path.join(LOCAL_DIR, "backups");
const BACKUP_NAME = /^ciroom-\d{4}-\d{2}-\d{2}\.db$/;

/** One consistent copy (VACUUM INTO) per day into `dir`, keeping the newest `keep`. */
function backupInto(/** @type {string} */ dir, /** @type {number} */ keep) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const name = `ciroom-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.db`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch { /* not fatal */ }
  for (const f of fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort().slice(0, -keep)) fs.unlinkSync(path.join(dir, f));
}

/** One backup a day, keeping the last 7 next to the data, plus the last 3 on this system's own disk when that is a different folder. */
function backup() {
  if (!imported()) return;
  try { backupInto(BACKUP_DIR, 7); } catch (e) { console.warn("[ciroom] database backup failed:", e instanceof Error ? e.message : e); }
  if (path.resolve(LOCAL_DIR) === path.resolve(DATA_DIR)) return;
  try { backupInto(LOCAL_BACKUP_DIR, 3); } catch (e) { console.warn("[ciroom] second database backup failed:", e instanceof Error ? e.message : e); }
}

let closed = false;
/** Shutdown: fold the write-ahead log into the database file and close it, so no .db-wal is left on the shared drive. Never reopens. */
export function closeDb() {
  closed = true;
  if (!db) return;
  if (!readOnly) try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* busy or already closed */ }
  try { db.close(); } catch { /* already closed */ }
  db = null;
  dropCopy();
}

const imported = () => !!db.prepare("SELECT value FROM meta WHERE key = 'imported_at'").get();
/** Counts every save of user data or settings (0 for a database saved before 0.2.10, which had no counter). */
const revision = () => Number(/** @type {any} */ (db.prepare("SELECT value FROM meta WHERE key = 'revision'").get())?.value ?? 0) || 0;
/** Inside a save's transaction: one more revision. Adds the row on the first save; never touches any other data. */
const bumpRevision = () =>
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)").run();

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
    bumpRevision();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function writeSettings(/** @type {any} */ s) {
  db.exec("BEGIN");
  try { writeScope("app", obj(s)); bumpRevision(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Drops the session-1 sample data: progress and history saved before CiRoom existed. Returns what was removed. */
function cleanSample(/** @type {any} */ user) {
  const u = obj(user);
  const removed = Object.entries(obj(u.progress)).filter(([, v]) => num(v?.updatedAt) < SAMPLE_CUTOFF).map(([id]) => id);
  for (const id of removed) delete u.progress[id];
  u.history = arr(u.history).filter((h) => num(h?.at) >= SAMPLE_CUTOFF);
  return { user: u, removed };
}

/** The open database (for other bridge modules, e.g. skip-intro markers). While the data folder is read-only it is a temporary copy: check isDbReadOnly(). */
export const openDb = () => open();
/** True while the data folder can't be written (nothing written to the database is kept). */
export const isDbReadOnly = () => readOnly;
/** Calls `fn(db, readOnly)` whenever the open database is replaced (read-only ↔ writable). Returns the unsubscribe. */
export function onDbChange(/** @type {(db: any, readOnly: boolean) => void} */ fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const READ_ONLY_ERROR = "The drive with CiRoom's data is read-only, so nothing can be saved there right now. " +
  "The window keeps your changes and saves them when the drive is writable again.";
const refuseReadOnly = (/** @type {(status: number, body: any) => void} */ json) => { json(503, { error: READ_ONLY_ERROR, readOnly: true }); return true; };

/** Runs a save; if the folder turned read-only meanwhile, switches to the read-only copy and answers 503. */
async function save(/** @type {(status: number, body: any) => void} */ json, /** @type {() => void} */ write) {
  try { write(); } catch (e) {
    if (!isReadOnlyError(e)) throw e;
    await becomeReadOnly();
    return refuseReadOnly(json);
  }
  json(200, { ok: true, revision: revision() });
  return true;
}

/** A window that kept changes while the folder was read-only sends the revision it loaded: refuse if the database changed since. */
function changedSince(/** @type {any} */ ifRevision, /** @type {(status: number, body: any) => void} */ json) {
  if (ifRevision == null || Number(ifRevision) === revision()) return false;
  json(409, { error: "The saved data changed meanwhile", conflict: true, revision: revision() });
  return true;
}

export function userdbRoutes() {
  return {
    routes: defineRoutes("userdata", [
      { method: "GET", path: "/api/userdata", audience: "pc", handler: async ({ json }) => {
        await open();
        const ok = imported();
        const settings = readScope("app");
        json(200, { imported: ok, user: ok ? readUser() : null, settings: ok && Object.keys(settings).length ? settings : null, revision: revision(), readOnly });
        return true;
      } },
      { method: "PUT", path: "/api/userdata/user", audience: "pc", handler: async ({ req, json, body }) => {
        await open();
        const { state, ifRevision } = await body(req);
        // A broken or empty request must never wipe the data: the real store always sends these fields.
        if (!state || typeof state !== "object" || typeof state.progress !== "object" || !Array.isArray(state.favorites) || !Array.isArray(state.history)) {
          json(400, { error: "Incomplete user data" }); return true;
        }
        if (readOnly) return refuseReadOnly(json);
        if (!imported()) { json(409, { error: "Import first" }); return true; }
        if (changedSince(ifRevision, json)) return true;
        return save(json, () => writeUser(state));
      } },
      { method: "PUT", path: "/api/userdata/settings", audience: "pc", handler: async ({ req, json, body }) => {
        await open();
        const { state, ifRevision } = await body(req);
        if (!state || typeof state !== "object" || Array.isArray(state)) { json(400, { error: "Incomplete settings" }); return true; }
        if (readOnly) return refuseReadOnly(json);
        if (!imported()) { json(409, { error: "Import first" }); return true; }
        if (changedSince(ifRevision, json)) return true;
        return save(json, () => writeSettings(state));
      } },
      { method: "POST", path: "/api/userdata/import", audience: "pc", handler: async ({ req, json, body }) => {
        await open();
        if (readOnly) return refuseReadOnly(json);
        if (imported()) { json(200, { imported: true, user: readUser(), settings: readScope("app"), removed: [], revision: revision(), readOnly: false }); return true; }
        const b = await body(req);
        if (b.user != null && (typeof b.user !== "object" || Array.isArray(b.user))) { json(400, { error: "Bad import" }); return true; }
        const { user, removed } = cleanSample(b.user ?? { progress: {}, favorites: [], watchlist: [], history: [] });
        try {
          writeUser(user);
          if (b.settings) writeSettings(b.settings);
          db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_at', ?)").run(new Date().toISOString());
          db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('import_removed', ?)").run(JSON.stringify(removed));
        } catch (e) {
          if (!isReadOnlyError(e)) throw e;
          await becomeReadOnly();
          return refuseReadOnly(json);
        }
        backup();
        console.log(`[ciroom] user data moved to ${DB_FILE} (${Object.keys(obj(user.progress)).length} progress entries; removed sample data: ${removed.join(", ") || "none"})`);
        json(200, { imported: true, user: readUser(), settings: readScope("app"), removed, revision: revision(), readOnly: false });
        return true;
      } },
    ]),
  };
}
