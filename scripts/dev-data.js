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
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CACHE_DIR, DATA_DIR } from "../dev/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.env.CIROOM_DATA_DIR) throw new Error("run without CIROOM_DATA_DIR (this copies the real data)");
const REAL_DATA = DATA_DIR, REAL_CACHE = CACHE_DIR; // the real app's folders (shared with Windows when set up)
const ROOT = path.resolve(here, "../.dev-data");
const DATA = path.join(ROOT, "data"), CACHE = path.join(ROOT, "cache");
const SKIP = new Set(["remote.json", "party.json", "local.json", "backups", "ciroom.db", "ciroom.db-wal", "ciroom.db-shm", "ciroom.db-journal"]);

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
