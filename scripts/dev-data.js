// @ts-check
/**
 * Gives the test version (CiRoom Dev) a fresh copy of your real CiRoom data, in .dev-data/ (project folder,
 * never published). Testing then can't change your real progress, lists or settings.
 *
 *   npm run dev-data              replace the copy with your current data
 *   node scripts/dev-data.js --if-missing   (used by npm run dev-app) only if there is no copy yet
 *
 * Not copied: phone pairings and the watch party (they stay off in the test version), and the backups.
 * Read-only on your real data: the database is copied with SQLite's own consistent snapshot (VACUUM INTO).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const home = os.homedir();
const REAL_DATA = path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "marquee");
const REAL_CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "marquee");
const ROOT = path.resolve(here, "../.dev-data");
const DATA = path.join(ROOT, "data"), CACHE = path.join(ROOT, "cache");
const SKIP = new Set(["remote.json", "party.json", "backups", "ciroom.db", "ciroom.db-wal", "ciroom.db-shm", "ciroom.db-journal"]);

if (process.argv.includes("--if-missing") && fs.existsSync(path.join(DATA, "ciroom.db"))) process.exit(0);
if (!fs.existsSync(REAL_DATA)) { console.log("[dev-data] no CiRoom data yet: the test version starts empty"); process.exit(0); }

if (path.basename(ROOT) !== ".dev-data") throw new Error("refusing to clear an unexpected folder"); // safety for the line below
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

for (const name of fs.readdirSync(REAL_DATA)) {
  if (SKIP.has(name)) continue;
  fs.cpSync(path.join(REAL_DATA, name), path.join(DATA, name), { recursive: true });
}
const dbFile = path.join(REAL_DATA, "ciroom.db");
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec(`VACUUM INTO '${path.join(DATA, "ciroom.db").replaceAll("'", "''")}'`);
  db.close();
}
if (fs.existsSync(REAL_CACHE)) {
  fs.cpSync(REAL_CACHE, CACHE, { recursive: true, filter: (src) => !/desktop\.log$/.test(src) && !src.includes(`${path.sep}target`) });
}
console.log(`[dev-data] test version now has a fresh copy of your data (${DATA})`);
