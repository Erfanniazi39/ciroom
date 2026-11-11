// @ts-check
/**
 * Where CiRoom keeps its own files (never next to the media). One place, so the test version (CiRoom Dev)
 * and the installed app can point at different folders.
 *
 *   CIROOM_DATA_DIR   data: database, library, artwork, metadata, settings  (default ~/.local/share/marquee)
 *   CIROOM_CACHE_DIR  cache: loudness, file facts, converted subtitles      (default ~/.cache/marquee)
 *   CIROOM_DEV=1      the test version: own mpv socket, no background analysis unless CIROOM_BACKGROUND=1
 */
import os from "node:os";
import path from "node:path";

const home = os.homedir();
export const DEV = process.env.CIROOM_DEV === "1";
export const DATA_DIR = process.env.CIROOM_DATA_DIR ? path.resolve(process.env.CIROOM_DATA_DIR) : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "marquee");
export const CACHE_DIR = process.env.CIROOM_CACHE_DIR ? path.resolve(process.env.CIROOM_CACHE_DIR) : path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "marquee");
export const MPV_SOCKET = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), DEV ? "ciroom-dev-mpv.sock" : "marquee-mpv.sock");
/** Background jobs (skip-intro analysis): on in the real app; off in the test version unless asked for. */
export const BACKGROUND = DEV ? process.env.CIROOM_BACKGROUND === "1" : process.env.CIROOM_BACKGROUND !== "0";
