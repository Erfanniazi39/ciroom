// @ts-check
/**
 * Where CiRoom keeps its own files (never inside Movies/ or Series/). One place, so the test version
 * (CiRoom Dev), the installed Linux app and the Windows app each find the right folders.
 *
 * Shared between Linux and Windows (dual boot): when the library folder has a "CiRoom-data" folder next to
 * Movies/ and Series/, that is the data folder, so both systems see the same progress, lists and settings.
 * Otherwise data stays in this system's own folder (Linux ~/.local/share/marquee, Windows %APPDATA%\CiRoom).
 *
 *   CIROOM_DATA_DIR   data folder (the test version uses its own copy); also this system's own folder then
 *   CIROOM_CACHE_DIR  cache: loudness, file facts, converted subtitles (always this system's own)
 *   CIROOM_DEV=1      the test version: own mpv connection, no background analysis unless CIROOM_BACKGROUND=1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WIN = process.platform === "win32";
const home = os.homedir();
export const DEV = process.env.CIROOM_DEV === "1";
export const SHARED_NAME = "CiRoom-data";

const readJson = (/** @type {string} */ f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

/** This system's own folder (never shared): which library folder to use, and the data when not shared. */
export const LOCAL_DIR = process.env.CIROOM_DATA_DIR ? path.resolve(process.env.CIROOM_DATA_DIR)
  : WIN ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "CiRoom")
  : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "marquee");
const LOCAL_FILE = path.join(LOCAL_DIR, "local.json");

/** A usable library folder: an existing folder with a Movies or Series folder inside. */
export const isMediaRoot = (/** @type {string | null | undefined} */ p) => !!p && ["Movies", "Series"].some((d) => fs.existsSync(path.join(p, d)));

/** Windows, first start: look for the shared data folder on every drive (X:\<folder>\CiRoom-data). */
function findSharedLibrary() {
  for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZC") {
    const drive = `${letter}:\\`;
    let names;
    try { names = fs.readdirSync(drive); } catch { continue; }
    for (const n of names) {
      const root = path.join(drive, n);
      if (fs.existsSync(path.join(root, SHARED_NAME, "ciroom.db")) && isMediaRoot(root)) return root;
    }
  }
  return null;
}

function chooseMediaRoot() {
  const saved = readJson(LOCAL_FILE)?.mediaRoot ?? readJson(path.join(LOCAL_DIR, "settings.json"))?.mediaRoot; // settings.json: before 0.1.2
  if (typeof saved === "string" && saved) return saved;
  if (WIN && !process.env.CIROOM_DATA_DIR) {
    const found = findSharedLibrary();
    if (found) { try { saveMediaRoot(found); } catch { /* read-only: find it again next time */ } }
    return found;
  }
  return null;
}

/** The library folder chosen in Settings (or found), or null. */
const MEDIA_ROOT = chooseMediaRoot();
export const savedMediaRoot = () => MEDIA_ROOT;
export function saveMediaRoot(/** @type {string} */ p) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify({ ...(readJson(LOCAL_FILE) ?? {}), mediaRoot: p }, null, 2), { mode: 0o600 });
}

const sharedDir = MEDIA_ROOT && !process.env.CIROOM_DATA_DIR ? path.join(MEDIA_ROOT, SHARED_NAME) : null;

/**
 * Linux, once: move the data into the shared folder next to Movies/ and Series/, so the Windows app (dual boot)
 * finds it. A copy: the old folder stays as it was (a backup). The database is copied with SQLite's own
 * consistent snapshot. If anything fails, CiRoom keeps using the old folder.
 */
function shareData(/** @type {string} */ dir) {
  const tmp = `${dir}.partial`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const name of fs.readdirSync(LOCAL_DIR)) {
      if (/^ciroom\.db(-wal|-shm|-journal)?$/.test(name) || name === "local.json") continue;
      fs.cpSync(path.join(LOCAL_DIR, name), path.join(tmp, name), { recursive: true });
    }
    const db = new DatabaseSync(path.join(LOCAL_DIR, "ciroom.db"));
    db.exec(`VACUUM INTO '${path.join(tmp, "ciroom.db").replaceAll("'", "''")}'`);
    db.close();
    fs.renameSync(tmp, dir); // only a complete copy becomes the shared folder
    fs.writeFileSync(path.join(LOCAL_DIR, "MOVED.txt"), `CiRoom's data now lives in ${dir} (shared with Windows).\nThis folder is the copy from before the move; CiRoom no longer uses it.\n`);
    console.log(`[ciroom] your data now lives in ${dir} (shared with Windows)`);
    return true;
  } catch (e) {
    console.warn(`[ciroom] couldn't move the data to ${dir}: ${e instanceof Error ? e.message : e}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return false;
  }
}
// Only the installed app moves data (CIROOM_SHARE_DATA=1, set by src-tauri), never a script or the test version.
if (process.env.CIROOM_SHARE_DATA === "1" && sharedDir && !WIN && !DEV && !fs.existsSync(sharedDir) && isMediaRoot(MEDIA_ROOT) && fs.existsSync(path.join(LOCAL_DIR, "ciroom.db"))) shareData(sharedDir);
/** True when the data folder is the one shared with the other system. */
export const SHARED = !!sharedDir && fs.existsSync(sharedDir);
export const DATA_DIR = SHARED && sharedDir ? sharedDir : LOCAL_DIR;
export const CACHE_DIR = process.env.CIROOM_CACHE_DIR ? path.resolve(process.env.CIROOM_CACHE_DIR)
  : WIN ? path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "CiRoom", "cache")
  : path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "marquee");
/** The saved scan holds full file paths, which differ between Linux and Windows: one file per system. */
export const LIBRARY_FILE = path.join(DATA_DIR, WIN ? "library-windows.json" : "library.json");
/** mpv's control connection: a named pipe on Windows, a socket file elsewhere. */
export const MPV_SOCKET = WIN ? `\\\\.\\pipe\\ciroom-mpv${DEV ? "-dev" : ""}`
  : path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), DEV ? "ciroom-dev-mpv.sock" : "marquee-mpv.sock");
/** Background jobs (skip-intro analysis): on in the real app; off in the test version unless asked for. */
export const BACKGROUND = DEV ? process.env.CIROOM_BACKGROUND === "1" : process.env.CIROOM_BACKGROUND !== "0";

/** Opens a web address in the system browser. */
export const openUrlCommand = (/** @type {string} */ url) =>
  WIN ? /** @type {const} */ (["rundll32", ["url.dll,FileProtocolHandler", url]])
  : process.platform === "darwin" ? /** @type {const} */ (["open", [url]]) : /** @type {const} */ (["xdg-open", [url]]);
