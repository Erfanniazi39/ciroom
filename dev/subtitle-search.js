// @ts-check
/**
 * Online subtitle search (dev bridge; the Rust port reproduces these routes).
 *
 *   GET  /api/subsearch/config                     → { hasKey }
 *   POST /api/subsearch/key        { key }         → { hasKey }   (validated with the service right away)
 *   POST /api/subsearch/search     { path, type, imdbId?, tmdbId?, season?, episode?, query, year?, languages[] }
 *                                                  → { results[], videoName }
 *   POST /api/subsearch/download   { path, url, language, release, season?, episode? } → { file }
 *   GET  /api/subsearch/downloaded?path=…          → { files[] }
 *   POST /api/subsearch/remove     { path, file }  → { files[] }
 *
 * Provider: SubDL (free API key). Downloaded subtitles are stored in CiRoom's own data folder
 * (~/.local/share/marquee/found-subs/<video>/), converted to UTF-8 (Persian/Arabic files are often
 * Windows-1256), and picked up by subtitlesFor() like any subtitle next to the video.
 * **Nothing is ever written into the media folders.**
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./paths.js";
import { writeJsonAtomic } from "./fsutil.js";

const run = promisify(execFile);
const DATA = DATA_DIR;
const SETTINGS = path.join(DATA, "settings.json");
export const FOUND_DIR = path.join(DATA, "found-subs");
const API = process.env.SUBDL_API_URL || "https://api.subdl.com/api/v1/subtitles";
const DL = process.env.SUBDL_DL_URL || "https://dl.subdl.com";
const UA = "CiRoom/0.1";
const MAX_ZIP = 8 << 20;

/** SubDL language codes CiRoom offers (display names live in the UI too). */
export const LANGUAGES = {
  FA: "Persian", EN: "English", AR: "Arabic", TR: "Turkish", FR: "French", ES: "Spanish", DE: "German",
  RU: "Russian", IT: "Italian", HI: "Hindi", JA: "Japanese", KO: "Korean", ZH: "Chinese", NL: "Dutch", PL: "Polish",
};
/** Legacy 8-bit encoding per language, for files that aren't valid UTF-8. */
const ENCODING = { FA: "windows-1256", AR: "windows-1256", TR: "windows-1254", RU: "windows-1251", PL: "windows-1250" };

const readJson = (/** @type {string} */ f, /** @type {any} */ d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const key = () => /** @type {string | undefined} */ (readJson(SETTINGS, {}).subdlKey);

/** Folder holding the subtitles found for one video (keyed by the video's real path). */
export const foundDirFor = (/** @type {string} */ videoFile) =>
  path.join(FOUND_DIR, crypto.createHash("sha1").update(videoFile).digest("hex").slice(0, 16));

/** Subtitle files found online for a video (absolute paths). */
export function foundSubtitles(/** @type {string} */ videoFile) {
  const dir = foundDirFor(videoFile);
  try { return fs.readdirSync(dir).filter((n) => /\.(srt|ass|ssa|vtt)$/i.test(n)).sort().map((n) => path.join(dir, n)); } catch { return []; }
}

async function call(/** @type {Record<string,string>} */ params) {
  const u = new URL(API);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== undefined) u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error("Couldn't reach the subtitle service. Check your internet connection or VPN."); }
  const d = await r.json().catch(() => ({}));
  if (d?.error === "not_authorized" || r.status === 401 || r.status === 403) throw Object.assign(new Error("The subtitle service didn't accept your API key."), { code: "key" });
  if (!r.ok && !d?.subtitles) throw new Error(`The subtitle service answered with an error (${r.status}).`);
  return d;
}

const EXT = /\.(srt|ass|ssa|vtt|zip|mkv|mp4|avi)$/i;
const tokens = (/** @type {string} */ s) => s.toLowerCase().replace(EXT, "").split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/** Language code of a SubDL subtitle entry (its fields vary: "EN", "english", "farsi_persian"). */
function codeOf(/** @type {any} */ s) {
  for (const c of [s.language, s.lang]) {
    const v = String(c ?? "");
    if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
    const name = v.toLowerCase();
    if (/persian|farsi/.test(name)) return "FA";
    for (const [code, label] of Object.entries(LANGUAGES)) if (name.includes(label.toLowerCase())) return code;
    if (/^[A-Za-z]{2}[_-]/.test(v)) return v.slice(0, 2).toUpperCase();
  }
  return "";
}

/** Decode a subtitle file to text: BOM → UTF-8 → the language's legacy encoding. */
export function decodeSubtitle(/** @type {Buffer} */ buf, /** @type {string} */ lang) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  return new TextDecoder(/** @type {Record<string,string>} */ (ENCODING)[lang] || "windows-1252").decode(buf);
}

const slug = (/** @type {string} */ s) => s.replace(EXT, "").replace(/[^\w.\-]+/g, " ").trim().replace(/\s+/g, ".").slice(0, 80) || "subtitle";

/** @param {(expected: string) => string} resolveVideo */
export function subtitleSearchRoutes(resolveVideo) {
  return {
    async handle(/** @type {any} */ req, /** @type {any} */ _res, /** @type {(c:number,d:unknown)=>void} */ json, /** @type {(r:any)=>Promise<any>} */ body) {
      const u = new URL(req.url, "http://localhost");
      const p = u.pathname;
      if (!p.startsWith("/api/subsearch/")) return false;
      try {
        if (p === "/api/subsearch/config") { json(200, { hasKey: !!key() }); return true; }

        if (p === "/api/subsearch/key" && req.method === "POST") {
          const { key: k } = await body(req);
          const s = readJson(SETTINGS, {});
          const next = String(k ?? "").trim();
          if (next) {
            // Validate before saving, so a typo is reported immediately.
            const prev = s.subdlKey;
            s.subdlKey = next;
            writeJsonAtomic(SETTINGS, s, { space: 2 });
            try { await call({ api_key: next, film_name: "Inception", type: "movie", languages: "EN", year: "2010" }); }
            catch (e) {
              if (prev) s.subdlKey = prev; else delete s.subdlKey;
              writeJsonAtomic(SETTINGS, s, { space: 2 });
              throw e;
            }
          } else {
            delete s.subdlKey;
            writeJsonAtomic(SETTINGS, s, { space: 2 });
          }
          json(200, { hasKey: !!key() });
          return true;
        }

        if (p === "/api/subsearch/downloaded") {
          const file = resolveVideo(String(u.searchParams.get("path") ?? ""));
          json(200, { files: foundSubtitles(file).map((f) => path.basename(f)) });
          return true;
        }

        if (p === "/api/subsearch/remove" && req.method === "POST") {
          const b = await body(req);
          const file = resolveVideo(String(b.path ?? ""));
          const target = path.join(foundDirFor(file), path.basename(String(b.file ?? "")));
          if (fs.existsSync(target)) fs.rmSync(target, { force: true });
          json(200, { files: foundSubtitles(file).map((f) => path.basename(f)) });
          return true;
        }

        if (p === "/api/subsearch/search" && req.method === "POST") {
          const k = key();
          if (!k) { json(400, { error: "Add your SubDL API key first.", code: "nokey" }); return true; }
          const b = await body(req);
          const file = resolveVideo(String(b.path ?? ""));
          const videoName = path.basename(file);
          const langs = (Array.isArray(b.languages) ? b.languages : []).map((/** @type {any} */ l) => String(l).toUpperCase()).filter((/** @type {string} */ l) => l in LANGUAGES);
          if (!langs.length) { json(400, { error: "Pick at least one language." }); return true; }
          const tv = b.type === "tv";
          const base = { api_key: k, languages: langs.join(","), subs_per_page: "30", type: tv ? "tv" : "movie" };
          const ep = tv && b.season ? { season_number: String(b.season), episode_number: String(b.episode ?? "") } : {};
          let d = b.imdbId ? await call({ ...base, imdb_id: String(b.imdbId), ...ep }) : { subtitles: [] };
          if (!Array.isArray(d.subtitles) || !d.subtitles.length) {
            d = await call({ ...base, film_name: String(b.query ?? ""), year: b.year ? String(b.year) : "", ...ep });
          }
          const mine = new Set(tokens(videoName));
          // The service appends ?api_key=… to every link: it is dropped above, so the key is never kept or logged.
          const list = (Array.isArray(d.subtitles) ? d.subtitles : []).map((/** @type {any} */ s) => {
            const release = String(s.release_name || s.name || "");
            const rt = tokens(release);
            const score = rt.length ? rt.filter((t) => mine.has(t)).length / rt.length : 0;
            return {
              url: String(s.url ?? "").split("?")[0], release, language: codeOf(s), author: String(s.author ?? ""),
              hearingImpaired: !!(s.hi ?? s.hearing_impaired), fullSeason: !!s.full_season,
              season: s.season ?? null, episode: s.episode ?? null, score: Math.round(score * 100) / 100,
            };
          }).filter((/** @type {any} */ s) => /^\/subtitle\/[\w.\-]+\.zip$/.test(s.url) && langs.includes(s.language));
          // Chosen language order first, then the release that looks most like the file, season packs last.
          list.sort((/** @type {any} */ a, /** @type {any} */ c) =>
            langs.indexOf(a.language) - langs.indexOf(c.language) || Number(a.fullSeason) - Number(c.fullSeason) || c.score - a.score);
          json(200, { results: list.slice(0, 40), videoName });
          return true;
        }

        if (p === "/api/subsearch/download" && req.method === "POST") {
          const b = await body(req);
          const file = resolveVideo(String(b.path ?? ""));
          const url = String(b.url ?? "").split("?")[0];
          if (!/^\/subtitle\/[\w.\-]+\.zip$/.test(url)) { json(400, { error: "Unexpected subtitle address." }); return true; }
          const lang = String(b.language ?? "").toUpperCase();
          let r;
          try { r = await fetch(DL + url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) }); }
          catch { throw new Error("Couldn't download the subtitle. Check your internet connection or VPN."); }
          if (!r.ok) throw new Error(`The subtitle download failed (${r.status}).`);
          const zip = Buffer.from(await r.arrayBuffer());
          if (zip.length > MAX_ZIP) throw new Error("That subtitle file is unexpectedly large.");

          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-sub-"));
          try {
            const zf = path.join(tmp, "s.zip");
            fs.writeFileSync(zf, zip);
            const { stdout } = await run("unzip", ["-Z1", zf], { maxBuffer: 1 << 20 });
            const names = stdout.split("\n").map((n) => n.trim()).filter((n) => /\.(srt|ass|ssa|vtt)$/i.test(n) && !n.includes("__MACOSX"));
            if (!names.length) throw new Error("That download had no subtitle file in it.");
            // A season pack has one file per episode: take the one for this episode.
            let pick = names[0];
            if (names.length > 1 && b.season && b.episode) {
              const code = new RegExp(`s0*${Number(b.season)}[ ._-]*e0*${Number(b.episode)}(?!\\d)|\\b0*${Number(b.season)}x0*${Number(b.episode)}(?!\\d)`, "i");
              pick = names.find((n) => code.test(n)) ?? names[0];
            }
            const { stdout: raw } = await run("unzip", ["-p", zf, pick], { encoding: "buffer", maxBuffer: 8 << 20 });
            const text = decodeSubtitle(/** @type {Buffer} */ (/** @type {unknown} */ (raw)), lang).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
            const ext = (path.extname(pick) || ".srt").toLowerCase();
            const dir = foundDirFor(file);
            fs.mkdirSync(dir, { recursive: true });
            // "<release>.<lang>.srt": the language code is what the track label is built from.
            let name = `${slug(String(b.release || pick))}.${(lang || "xx").toLowerCase()}${ext}`;
            for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${slug(String(b.release || pick))}.${(lang || "xx").toLowerCase()}.${i}${ext}`;
            fs.writeFileSync(path.join(dir, name), text);
            json(200, { file: name });
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
          return true;
        }
      } catch (e) {
        json(/** @type {any} */ (e)?.code === "key" ? 401 : 502, { error: e instanceof Error ? e.message : "Subtitle search failed", code: /** @type {any} */ (e)?.code });
        return true;
      }
      return false;
    },
  };
}
