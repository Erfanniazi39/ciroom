// @ts-check
/**
 * Watching on the phone: the media routes a paired phone may use, addressed by LIBRARY ID (never by path).
 * Mounted from server/lib/remote.js, which has already checked that phones are served (remote on, trusted network,
 * valid pairing cookie). The server looks the id up in the saved library and fills in the real file path, then
 * hands the rewritten request to the same stream code the page player and the watch party use.
 *
 *   GET /api/remote/watch/probe?id=
 *   GET /api/remote/watch/seekpoint?id=&t=&q=&a=
 *   GET /api/remote/watch/stream?id=&t=&q=low&level=0&a=
 *   GET /api/remote/watch/subtitle.vtt?id=&i=|e=
 */
import fs from "node:fs";
import { LIBRARY_FILE } from "./paths.js";

const ID = /^[a-z0-9-]{1,200}$/;
export const MAX_STREAMS_PER_DEVICE = 2;
const UNAVAILABLE = "This video isn't available";

/** @typedef {{ id: string, title: string, subtitle: string | null, path: string, nextId: string | null }} Playable */

let libCache = /** @type {{ mtime: number, items: Map<string, Playable> } | null} */ (null);

/** Every playable item of the saved library by exact id; reloaded when library.json changes. */
export function libraryItems() {
  let st;
  try { st = fs.statSync(LIBRARY_FILE); } catch { return new Map(); }
  if (libCache && libCache.mtime === st.mtimeMs) return libCache.items;
  /** @type {Map<string, Playable>} */
  const items = new Map();
  try {
    const lib = JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
    for (const m of lib.movies ?? []) {
      if (m?.file?.status === "present" && typeof m.file.path === "string") items.set(String(m.id), { id: String(m.id), title: String(m.title ?? ""), subtitle: null, path: m.file.path, nextId: null });
    }
    for (const s of lib.series ?? []) {
      /** @type {{ id: string, title: string, subtitle: string, path: string, key: number }[]} */
      const eps = [];
      for (const se of s.seasons ?? []) for (const e of se.episodes ?? []) {
        if (e?.file?.status === "present" && typeof e.file.path === "string") eps.push({ id: String(e.id), title: String(s.title ?? ""), subtitle: `S${e.season}E${e.number}`, path: e.file.path, key: Number(e.season) * 10000 + Number(e.number) });
      }
      eps.sort((a, b) => a.key - b.key);
      eps.forEach((e, i) => items.set(e.id, { id: e.id, title: e.title, subtitle: e.subtitle, path: e.path, nextId: eps[i + 1]?.id ?? null }));
    }
  } catch { /* unreadable library: nothing is available */ }
  libCache = { mtime: st.mtimeMs, items };
  return items;
}

/** The library entry for an id, or null (bad id, unknown id, file not present). Never accepts a path. */
export const itemFor = (/** @type {unknown} */ id) => (typeof id === "string" && ID.test(id) ? libraryItems().get(id) ?? null : null);

/**
 * @param {{ resolveVideo: (p: string) => string, stream: any, streamsOf: (deviceId: string) => { n: number }, onStream: (close: () => void) => () => void }} deps
 */
export function phoneWatchRoutes({ resolveVideo, stream, streamsOf, onStream }) {
  const fail = (/** @type {import("node:http").ServerResponse} */ res, /** @type {number} */ code, /** @type {string} */ error) => {
    if (res.headersSent) return;
    res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error }));
  };
  return {
    /**
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
     * @param {(code: number, data: unknown) => void} json @param {(r: any) => Promise<any>} body @param {string} deviceId
     * @returns {Promise<boolean>}
     */
    async handle(req, res, json, body, deviceId) {
      const u = new URL(req.url ?? "/", "http://x");
      const route = u.pathname;
      if (!route.startsWith("/api/remote/watch/") || req.method !== "GET") return false;
      const what = route.slice("/api/remote/watch/".length);
      if (!["probe", "seekpoint", "stream", "subtitle.vtt"].includes(what)) { fail(res, 404, "Unknown endpoint"); return true; }
      const rawId = u.searchParams.get("id") ?? "";
      if (!ID.test(rawId)) { fail(res, 400, "Bad id"); return true; }
      const item = libraryItems().get(rawId);
      let file = "";
      try { if (item) file = resolveVideo(item.path); } catch { /* not found on disk */ }
      if (!item || !file) { fail(res, 404, UNAVAILABLE); return true; }

      const q = new URLSearchParams({ path: file });
      const num = (/** @type {string} */ k) => Number(u.searchParams.get(k));
      if (what === "stream" || what === "seekpoint") {
        q.set("t", Math.max(0, Math.min(Number.isFinite(num("t")) ? num("t") : 0, 24 * 3600)).toFixed(3));
        if (u.searchParams.get("q") === "low") q.set("q", "low");
        const a = Math.floor(num("a"));
        if (Number.isFinite(a) && a >= 0 && a <= 99) q.set("a", String(a));
      }
      if (what === "stream" && u.searchParams.get("level") === "0") q.set("level", "0");
      if (what === "subtitle.vtt") {
        if (u.searchParams.has("e")) q.set("e", String(Math.max(0, Math.min(99, Math.floor(num("e")) || 0))));
        else q.set("i", String(Math.max(0, Math.min(99, Math.floor(num("i")) || 0))));
      }
      if (what === "stream") {
        const s = streamsOf(deviceId);
        if (s.n >= MAX_STREAMS_PER_DEVICE) { fail(res, 429, "Too many streams open on this phone"); return true; }
        s.n++;
        let done = false;
        const release = () => { if (!done) { done = true; s.n--; off(); } };
        const off = onStream(() => { try { res.destroy(); } catch { /* gone */ } });
        res.on("close", release);
      }
      req.url = `/api/${what}?${q}`;
      if (what === "probe") {
        // Same answer as /api/probe minus anything about the file's location, plus what the phone player needs.
        const filtered = (/** @type {number} */ code, /** @type {any} */ data) => json(code, code === 200 && data
          ? { id: item.id, title: item.title, subtitle: item.subtitle, nextId: item.nextId, duration: data.duration, width: data.width, height: data.height, video: data.video, audio: data.audio, codecs: data.codecs, hasAudio: data.hasAudio, copyVideo: data.copyVideo, levelGainDb: data.levelGainDb, subtitles: (data.subtitles ?? []).map((/** @type {any} */ s) => ({ index: s.index, label: s.label, format: s.format, ...(s.embedded ? { embedded: true, stream: s.stream } : {}) })) }
          : { error: "Could not read the video" });
        await stream.handle(req, res, filtered, body);
      } else {
        await stream.handle(req, res, json, body);
      }
      return true;
    },
  };
}
