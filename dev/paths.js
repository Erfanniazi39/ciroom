// @ts-check
/**
 * Where CiRoom keeps its own files (never next to the media). One place, so the test version (CiRoom Dev)
 * and the installed app can point at different folders.
 *
 *   CIROOM_DATA_DIR   data: database, library, artwork, metadata, settings  (default ~/.local/share/marquee)
 *   CIROOM_CACHE_DIR  cache: loudness, file facts, converted subtitles      (default ~/.cache/marquee)
 *   CIROOM_DEV=1      the test version: own mpv socket, no background analysis unless CIROOM_BACKGROUND=1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
export const DEV = process.env.CIROOM_DEV === "1";
export const DATA_DIR = process.env.CIROOM_DATA_DIR ? path.resolve(process.env.CIROOM_DATA_DIR) : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "marquee");
export const CACHE_DIR = process.env.CIROOM_CACHE_DIR ? path.resolve(process.env.CIROOM_CACHE_DIR) : path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "marquee");
export const MPV_SOCKET = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), DEV ? "ciroom-dev-mpv.sock" : "marquee-mpv.sock");
/** Background jobs (skip-intro analysis): on in the real app; off in the test version unless asked for. */
export const BACKGROUND = DEV ? process.env.CIROOM_BACKGROUND === "1" : process.env.CIROOM_BACKGROUND !== "0";

/** The library folder chosen in Settings (holds Movies/ and Series/), or null. Saved in settings.json. */
export function savedMediaRoot() {
  try { const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8")).mediaRoot; return typeof p === "string" && p ? p : null; } catch { return null; }
}
/** A usable library folder: an existing folder with a Movies or Series folder inside. */
export const isMediaRoot = (/** @type {string} */ p) => !!p && ["Movies", "Series"].some((d) => fs.existsSync(path.join(p, d)));
export function saveMediaRoot(/** @type {string} */ p) {
  const file = path.join(DATA_DIR, "settings.json");
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first save */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...s, mediaRoot: p }, null, 2), { mode: 0o600 });
}
