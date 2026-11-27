// @ts-check
/**
 * Library scanner: builds the library from the REAL folders in <media root>/Movies and /Series.
 * READ-ONLY: it lists folders and stats files; it never moves, renames, writes or deletes media.
 *
 * The scan runs in a worker thread (scan-worker.js), so the server stays responsive.
 * Scans only when asked (POST /api/library/scan) or when no saved scan exists yet. The result is saved to
 * ~/.local/share/marquee/library.json; ids.json keeps every title's id stable across scans, so watch
 * progress (stored by id) survives renames of files inside a title folder.
 *
 *   GET  /api/library        → saved scan (scans once if there is none)
 *   POST /api/library/scan   → rescan now → { ...library, changes: { added[], removed[], newEpisodes } }
 *
 * Rules (from the real library, see project-knowledge-archive.md §4):
 *  - Movies/<Title YYYY>/video                      → movie
 *  - Movies/<Name>/<Title YYYY>/video (no direct video) → collection "<Name> Collection" of movies
 *  - Series/<Name>/…/S01/EP02/video, "S01 E01" folders, else SxxEyy / 1x02 in the file name
 *  - Folder beats file name (a file named S01E01 inside EP02 is episode 2; reported as "misplaced").
 *  - Several videos for one title/episode → the largest wins; the rest are reported as duplicates.
 *  - Movies/<Name>/<one folder>/<one video> → a single movie (wrapper folder), not a collection; loose videos in Movies/ → Needs attention.
 *  - Folders without a video (e.g. a download in progress) are reported, not shown.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DATA_DIR } from "./artwork-store.js";
import { LIBRARY_FILE } from "./paths.js";
import { writeJsonAtomic } from "./fsutil.js";
import { defineRoutes } from "./routes.js";

const LIB_FILE = LIBRARY_FILE; // per system (full paths differ between Linux and Windows)
const IDS_FILE = path.join(DATA_DIR, "ids.json");
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts|wmv)$/i;
export const SKIP_DIR = /^(\.|@|\$|sample$|samples$|extras?$|featurettes?$|behind the scenes$|trailers?$)/i;

/**
 * Folder abbreviations (ALIASES) and the ids the library used before the scanner existed (LEGACY_IDS) live in
 * library-ids.json. Progress, favorites and artwork are keyed by those ids, so they must not change.
 */
const ID_DATA = JSON.parse(fs.readFileSync(new URL("./library-ids.json", import.meta.url), "utf8"));
const ALIASES = /** @type {Record<string,string>} */ (ID_DATA.aliases);
const LEGACY_IDS = /** @type {Record<string,string>} */ (ID_DATA.legacyIds);

const readJson = (/** @type {string} */ f, /** @type {any} */ dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (/** @type {string} */ f, /** @type {any} */ v) => writeJsonAtomic(f, v);
const fold = (/** @type {string} */ s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const slug = (/** @type {string} */ s) => fold(s).replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/**
 * The id part for a title. Ids stay ASCII (artwork file names, the phone and mpv checks rely on it), so a title
 * that is mostly non-Latin (Persian, Cyrillic, CJK…) would lose its letters: "درباره الی" → "", "Брат 2" → "2".
 * Those get "t-" + a short hash of the exact title instead, so every such title has its own id.
 */
const titleKey = (/** @type {string} */ s) => {
  const id = slug(s), f = fold(s);
  const latin = (f.match(/[a-z]/g) ?? []).length, other = (f.match(/\p{L}/gu) ?? []).length - latin;
  if (id && other <= latin) return id; // Latin titles (and "1917", "11.22.63") keep the slug they always had
  return `t-${createHash("sha256").update(s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 8)}`;
};
const hueOf = (/** @type {string} */ id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);
const titleCase = (/** @type {string} */ s) => s.split(" ").map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

const RELEASE_WORD = /[\s._([-]+(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|bd-?remux|remux|web-?dl|web-?rip|webrip|hdtv|hdrip|dvdrip|dvdscr|x\.?26[45]|h\.?26[45]|hevc|avc|10bit|hdr10?\+?|dolby\.?vision|yify|yts|rarbg|extended|unrated|imax|proper|repack)(?![a-z0-9])/i;
const KEEP_BRACKET = /^[([](?:US|UK|AU|CA|NZ)[)\]]$/i;

/**
 * Folder name → { title, year }.
 *   "Inception 2010" → Inception, 2010          "Inception (2010) [1080p]" → Inception, 2010
 *   "Movie.Name.2010.1080p.BluRay.x264-GRP" → Movie Name, 2010      "11.22.63 2016" → 11.22.63, 2016
 * The title is cut at the first year (a bracketed year wins), then at the first release word; [..] and (..)
 * groups are dropped (except (US)/(UK)…). "11.22.63" is never a year.
 */
export function parseFolder(/** @type {string} */ name) {
  let title = name, year;
  const YEAR = /(^|[\s._([-])([([]?)((?:19|20)\d{2})([)\]]?)(?=$|[\s._)\]-])/g;
  /** @type {{ at: number, year: number, bracketed: boolean }[]} */ const found = [];
  for (const m of name.matchAll(YEAR)) {
    const at = m.index + m[1].length; // start of the bracket or the digits
    if (!name.slice(0, at).replace(/[\s._([-]+$/, "").trim()) continue; // a name that IS a year ("2012") keeps it
    found.push({ at, year: Number(m[3]), bracketed: !!m[2] && !!m[4] });
  }
  const hit = found.find((f) => f.bracketed) ?? found[0];
  if (hit) { title = name.slice(0, hit.at); year = hit.year; }
  const rw = title.search(RELEASE_WORD);
  if (rw > 0) title = title.slice(0, rw);
  title = title.replace(/\s*[([][^)\]]*[)\]]/g, (g) => (KEEP_BRACKET.test(g.trim()) ? g : ""));
  title = title.replace(/[\s._-]+$/, "").replace(/^[\s._-]+/, "");
  if (!title) { title = name.trim(); year = undefined; }
  if (!/\s/.test(title) && /[._]/.test(title) && !/^[\d.]+$/.test(title)) title = title.replace(/[._]+/g, " "); // "The.Office" → "The Office"; keep "11.22.63"
  title = title.replace(/\s+/g, " ").trim();
  const alias = ALIASES[title.toLowerCase()];
  if (alias) title = alias;
  else if (title.split(" ").slice(1).every((w) => w === w.toLowerCase())) title = titleCase(title.charAt(0).toLowerCase() + title.slice(1)); // "A knight of the…"
  return { title, year };
}

const SEASON_DIR = /^(?:s|season[\s._-]*)0*(\d{1,3})(?:\b|[\s._-]*e)/i;
const EPISODE_DIR = /^(?:ep?|episode[\s._-]*)0*(\d{1,3})$/i;
const SE_DIR = /^s0*(\d{1,3})[\s._-]*e0*(\d{1,3})$/i;
const SE_FILE = /(?:^|[^a-z0-9])s0*(\d{1,3})[\s._-]*e0*(\d{1,3})(?:[\s._-]*e0*(\d{1,3}))?(?!\d)/i; // 3rd group: S01E01E02 / S01E01-E02 double episodes
const X_FILE = /(?:^|[^0-9])(\d{1,2})x(\d{2,3})(?!\d)/i;

/** Season/episode from the folder path first (folder beats file name), then the file name. */
export function parseEpisode(/** @type {string[]} */ dirs, /** @type {string} */ file) {
  let season, episode;
  for (const d of dirs) {
    const se = d.match(SE_DIR);
    if (se) { season ??= Number(se[1]); episode ??= Number(se[2]); continue; }
    const s = d.match(SEASON_DIR);
    if (s && season === undefined) { season = Number(s[1]); continue; }
    const e = d.match(EPISODE_DIR);
    if (e && episode === undefined) episode = Number(e[1]);
  }
  const fm = file.match(SE_FILE) ?? file.match(X_FILE);
  const fromFile = fm ? { season: Number(fm[1]), episode: Number(fm[2]) } : undefined;
  // A double episode (S01E01E02) is one file for two episodes; only trust a short, increasing range.
  const last = fm?.[3] !== undefined ? Number(fm[3]) : undefined;
  const alsoEpisode = last !== undefined && fromFile && last > fromFile.episode && last - fromFile.episode <= 3 ? last : undefined;
  if (episode === undefined && fromFile) { season ??= fromFile.season; episode = fromFile.episode; }
  if (episode !== undefined) season ??= 1; // e.g. Series/<Name>/EP01 with no season folder
  return { season, episode, fromFile, alsoEpisode };
}

/** Videos under a folder (depth-limited), with size and mtime. */
function listVideos(/** @type {string} */ dir, depth = 3, /** @type {string[]} */ rel = []) {
  /** @type {{ abs: string, dirs: string[], name: string, size: number, mtime: number }[]} */
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIR.test(e.name)) out.push(...listVideos(abs, depth - 1, [...rel, e.name])); }
    else if (VIDEO.test(e.name)) {
      try {
        const st = fs.statSync(abs);
        if (/sample/i.test(e.name) && st.size < 300 * 1024 * 1024) continue;
        out.push({ abs, dirs: rel, name: e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* vanished */ }
    }
  }
  return out;
}
const subdirs = (/** @type {string} */ dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIR.test(e.name)).map((e) => e.name).sort(); } catch { return []; } };
/** Largest first; equal size → a "clean" name (no double extension), then the shorter name. */
const bestFirst = (/** @type {any} */ a, /** @type {any} */ b) => b.size - a.size || Number(/\.\w{3}\.\w{3}$/.test(a.name)) - Number(/\.\w{3}\.\w{3}$/.test(b.name)) || a.name.length - b.name.length;

/** "cd1", "part 2", "pt3", "disc1" (any separator, optional brackets) right before the extension. */
export const PART_TOKEN = /[\s._-]*[([]?(?:cd|part|pt|dis[ck])[\s._-]*0*([1-9])[)\]]?(?=\.[a-z0-9]{2,4}$)/i;
/**
 * Files of one movie folder that differ only by cd1/cd2, part1/part2… → one movie in order, else null.
 * @param {{ name: string }[]} vids
 */
export function moviePartsOf(vids) {
  /** @type {Map<string, { v: any, n: number }[]>} */ const groups = new Map();
  for (const v of vids) {
    const m = v.name.match(PART_TOKEN);
    if (!m) continue;
    const key = v.name.replace(PART_TOKEN, "").toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), { v, n: Number(m[1]) }]);
  }
  let best = null;
  for (const g of groups.values()) if (g.length >= 2 && new Set(g.map((x) => x.n)).size === g.length && (!best || g.length > best.length)) best = g;
  return best ? best.sort((a, b) => a.n - b.n).map((x) => x.v) : null;
}

const TAG_WORDS = /[\s._([-]+(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|web-?dl|web-?rip|hdtv|hdrip|dvdrip|x\.?26[45]|h\.?26[45]|hevc|avc|10bit|aac|ac3|dts)(?![a-z0-9])/gi;
/**
 * "One Piece 1071 [1080p].mkv" → 1071. Only a 1–4 digit number at the END of the name (after dropping brackets,
 * resolution/codec words and a year before it) counts. A lone 1900–2099 is read as a year, never an episode.
 * @param {string} file
 */
export function absoluteNumber(file) {
  let n = file.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/\s*[([][^)\]]*[)\]]/g, " ").replace(TAG_WORDS, " ");
  n = n.replace(/[\s._-]+(?:19|20)\d{2}(?=[\s._-]+\d{1,4}\s*$)/, " "); // "Show 2010 - 05": the year isn't the episode
  const m = n.match(/(?:^|[\s._-])0*(\d{1,4})[\s._-]*$/);
  const v = m ? Number(m[1]) : 0;
  return v > 0 && !(v >= 1900 && v <= 2099) ? v : undefined;
}

const NOT_FOUND = "Library folder not found. Is the drive connected?";
const readable = (/** @type {string} */ dir) => { try { fs.readdirSync(dir); return true; } catch { return false; } };
/**
 * Throws when neither Movies nor Series can be read (drive unplugged, folder gone): an empty result from that must
 * never be saved. One of the two missing is a normal library.
 */
function requireLibrary(/** @type {string} */ root) {
  if (!["Movies", "Series"].some((d) => readable(path.join(root, d)))) throw Object.assign(new Error(NOT_FOUND), { code: "NO_LIBRARY" });
}

/** The answer while the library folder can't be read and there is no saved scan of it. Never saved. */
function offlineLibrary(/** @type {string} */ root) {
  const now = new Date().toISOString();
  const entry = (/** @type {string} */ id, /** @type {string} */ name) => ({ id, path: path.join(root, name), kindHint: id, online: false, itemCount: 0, lastScanAt: now });
  return { movies: [], series: [], collections: [], roots: [entry("movies", "Movies"), entry("series", "Series")], review: [], scannedAt: now };
}

/** True when the saved scan was made from this library folder (not from the one chosen before). */
const isScanOf = (/** @type {any} */ lib, /** @type {string} */ root) =>
  (lib.roots ?? []).every((/** @type {any} */ r) => !r.path || path.resolve(r.path) === root || path.dirname(path.resolve(r.path)) === root);

/**
 * One full scan of <mediaRoot>/Movies and /Series (synchronous, so it runs in a worker thread: see scan-worker.js).
 * @param {string} mediaRoot
 */
export function scanLibrary(mediaRoot) {
  const root = path.resolve(mediaRoot);
  requireLibrary(root);
  {
    const ids = readJson(IDS_FILE, {});
    const used = new Set(Object.values(ids));
    // A renamed folder keeps its id (progress, favorites and artwork are keyed by it). An id is handed over only
    // when its old folder no longer exists, and the new folder either holds the same video file (name + size,
    // from the previous scan) or gets the same id from its title.
    const folderGone = (/** @type {string} */ r) => !fs.existsSync(path.join(root, r.replace(/#collection$/, "")));
    /** @type {Map<string, string>} id → saved folder that no longer exists */
    const goneById = new Map();
    for (const [r, id] of Object.entries(ids)) if (folderGone(r)) goneById.set(id, r);
    /** @type {Map<string, string>} "file name|size" → id, from the previous scan */
    const prevByFile = new Map();
    const fileKey = (/** @type {string} */ p, /** @type {number} */ size) => `${path.basename(p)}|${size}`;
    /** @type {Map<string, number>} id → year, from the previous scan */
    const prevYear = new Map();
    if (goneById.size) {
      const prev = readJson(LIB_FILE, null);
      for (const m of prev?.movies ?? []) { if (m.file?.path) prevByFile.set(fileKey(m.file.path, m.file.sizeBytes), m.id); if (m.year) prevYear.set(m.id, m.year); }
      for (const s of prev?.series ?? []) {
        if (s.year) prevYear.set(s.id, s.year);
        for (const se of s.seasons ?? []) for (const e of se.episodes ?? []) if (e.file?.path) prevByFile.set(fileKey(e.file.path, e.file.sizeBytes), s.id);
      }
    }
    /** Year of a vanished folder's title: from the previous scan, else from its folder name. */
    const goneYear = (/** @type {string} */ id) => prevYear.get(id) ?? parseFolder(path.basename(goneById.get(id) ?? "")).year;
    const reclaim = (/** @type {string} */ rel, /** @type {string | undefined} */ id) => {
      const old = id && goneById.get(id);
      if (!id || !old) return null;
      delete ids[old]; goneById.delete(id);
      ids[rel] = id;
      return id;
    };
    /**
     * Stable id per folder: saved → same video as a vanished folder → legacy → title → title-year → numbered.
     * Only folders without a saved id get here, so these rules never change an existing id.
     * A vanished folder's id goes to a new folder by name, unless both have a year and the years differ
     * (deleting "Dune 2021" and adding "Dune 1984" gives the remake its own id).
     * @param {string} rel @param {string} title
     * @param {{ year?: number, withYear?: boolean, suffix?: string, files?: {abs:string,size:number}[] }} [o]
     *   withYear: "title-year" is the next choice when "title" is taken (movies); suffix: e.g. "collection"
     */
    const idFor = (rel, title, { year, withYear, suffix, files } = {}) => {
      if (ids[rel]) return ids[rel];
      for (const f of files ?? []) { const got = reclaim(rel, prevByFile.get(fileKey(f.abs, f.size))); if (got) return got; }
      const legacy = LEGACY_IDS[rel];
      if (legacy) { ids[rel] = legacy; used.add(legacy); return legacy; }
      const key = titleKey(title);
      const base = suffix ? `${key}-${suffix}` : key;
      const alt = withYear && year ? `${key}-${year}` : undefined;
      const yearsDiffer = (/** @type {string} */ id) => { const y = year && goneById.has(id) ? goneYear(id) : undefined; return !!y && y !== year; };
      for (const c of [base, alt]) if (c && !yearsDiffer(c)) { const got = reclaim(rel, c); if (got) return got; }
      let id = base;
      if (used.has(id) && alt) id = alt;
      for (let n = 2; used.has(id); n++) id = `${alt ?? base}-${n}`;
      ids[rel] = id; used.add(id);
      return id;
    };
    /** @type {any[]} */ const movies = [], series = [], collections = [], review = [];
    const note = (/** @type {string} */ kind, /** @type {string} */ rel, /** @type {string} */ detail, /** @type {string=} */ suggestion) =>
      review.push({ id: slug(`${kind}-${rel}`).slice(0, 90), kind, path: rel, detail, suggestion });
    const zips = (/** @type {string} */ dir, /** @type {string} */ rel) => {
      const walk = (/** @type {string} */ d, /** @type {string} */ r, n = 0) => {
        if (n > 4) return;
        for (const e of (() => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
          if (e.isDirectory()) walk(path.join(d, e.name), `${r}/${e.name}`, n + 1);
          else if (/\.(zip|rar|7z)$/i.test(e.name)) note("zipped_subtitle", `${r}/${e.name}`, "Subtitle is inside an archive. Extract it next to the video to use it.");
        }
      };
      walk(dir, rel);
    };

    // ── Movies ────────────────────────────────────────────────────────────
    const moviesDir = path.join(root, "Movies");
    const makeMovie = (/** @type {string} */ abs, /** @type {string} */ rel, /** @type {string} */ folder, /** @type {string=} */ collectionId) => {
      const vids = listVideos(abs, 2).sort(bestFirst);
      if (!vids.length) { note("empty", rel, "No video file in this folder yet (download still running?). Press Scan now when it's done."); return null; }
      const parts = moviePartsOf(vids); // CD1/CD2 → one movie with parts, not a duplicate
      const main = parts ? parts[0] : vids[0];
      const partSize = parts ? parts.reduce((a, p) => a + p.size, 0) : main.size;
      for (const d of vids) if (d !== main && !parts?.includes(d) && d.size > partSize * 0.5) note("duplicate", `${rel}/${d.name}`, `Another copy of this movie. CiRoom plays “${main.name}”.`);
      const { title, year } = parseFolder(folder);
      const id = idFor(rel, title, { year, withYear: true, files: [main] });
      return {
        kind: "movie", id, title, year, genres: [], ratings: {}, cast: [], addedAt: new Date(main.mtime).toISOString(), collectionId,
        art: { hue: hueOf(id) }, file: { path: main.abs, sizeBytes: main.size, subtitles: [], status: "present" },
        ...(parts ? { parts: parts.map((p) => ({ path: p.abs, sizeBytes: p.size })) } : {}),
      };
    };
    // Loose video files directly in Movies/: not added (no folder = no reliable title), but reported.
    try {
      for (const e of fs.readdirSync(moviesDir, { withFileTypes: true }))
        if (e.isFile() && VIDEO.test(e.name) && !/sample/i.test(e.name)) note("loose_video", `Movies/${e.name}`, "Video not in its own folder. Put it in a folder named “Title Year” and press Scan now.");
    } catch { /* no Movies folder */ }
    for (const name of subdirs(moviesDir)) {
      const abs = path.join(moviesDir, name), rel = `Movies/${name}`;
      zips(abs, rel);
      const direct = listVideos(abs, 0);
      if (direct.length) { const m = makeMovie(abs, rel, name); if (m) movies.push(m); continue; }
      const subs = subdirs(abs);
      if (!subs.length) { note("empty", rel, "No video file in this folder yet."); continue; }
      // One sub-folder holding one video is a single movie in a wrapper folder, not a "collection" (unless this
      // folder was already a collection: its ids, and the user's progress, must not change).
      if (subs.length === 1 && !ids[`${rel}#collection`] && !LEGACY_IDS[`${rel}#collection`] && listVideos(path.join(abs, subs[0]), 2).length === 1) {
        const inner = parseFolder(subs[0]), outer = parseFolder(name);
        const m = makeMovie(path.join(abs, subs[0]), rel, !inner.year || outer.year ? name : subs[0]);
        if (m) movies.push(m);
        continue;
      }
      const collectionId = idFor(`${rel}#collection`, name, { suffix: "collection" });
      const members = subs.map((s) => makeMovie(path.join(abs, s), `${rel}/${s}`, s, collectionId)).filter(Boolean);
      if (!members.length) continue;
      movies.push(...members);
      const { title } = parseFolder(name);
      collections.push({ id: collectionId, name: `${title} Collection`, movieIds: members.map((m) => m.id), art: { hue: hueOf(collectionId) } });
    }

    // ── Series ────────────────────────────────────────────────────────────
    const seriesDir = path.join(root, "Series");
    for (const name of subdirs(seriesDir)) {
      const abs = path.join(seriesDir, name), rel = `Series/${name}`;
      zips(abs, rel);
      const vids = listVideos(abs, 4);
      if (!vids.length) { note("empty", rel, "No video files in this series folder yet."); continue; }
      const { title, year } = parseFolder(name);
      const id = idFor(rel, title, { year, files: vids });
      /** @type {Map<number, Map<number, any>>} */ const seasons = new Map();
      // Absolute numbering ("Show - 012.mkv"): only when NO video in the folder parses today and (nearly) all
      // of them end in a number, so a stray file can't create fake episodes.
      /** @type {Map<any, number> | null} */ let absNums = null;
      if (vids.every((v) => parseEpisode(v.dirs, v.name).episode === undefined)) {
        const nums = new Map(vids.map((v) => [v, absoluteNumber(v.name)]));
        const hits = [...nums.values()].filter((n) => n !== undefined);
        if (vids.length >= 2 && hits.length >= Math.ceil(vids.length * 0.9) && new Set(hits).size >= hits.length * 0.9) absNums = /** @type {any} */ (nums);
      }
      for (const v of vids.sort(bestFirst)) {
        const parsed = parseEpisode(v.dirs, v.name);
        const abs = absNums?.get(v);
        const { season, episode, fromFile, alsoEpisode } = abs !== undefined ? { ...parsed, season: 1, episode: abs } : parsed;
        const vrel = `${rel}/${[...v.dirs, v.name].join("/")}`;
        if (season === undefined || episode === undefined) { note("unidentified", vrel, "Can't tell which episode this is. Put it in an S01/EP01 folder or name it S01E01."); continue; }
        if (!seasons.has(season)) seasons.set(season, new Map());
        const eps = /** @type {Map<number, any>} */ (seasons.get(season));
        if (eps.has(episode)) { note("duplicate", vrel, `Another video for S${season}E${episode}. CiRoom plays the larger file.`); continue; }
        if (fromFile && (fromFile.season !== season || fromFile.episode !== episode)) {
          note("misplaced", vrel, `The file is named S${String(fromFile.season).padStart(2, "0")}E${String(fromFile.episode).padStart(2, "0")} but sits in the S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} folder. CiRoom follows the folder; check it's the right episode.`);
        }
        eps.set(episode, v);
        // Double episode: the same file also plays the next episode number (unless that one has its own file).
        if (alsoEpisode !== undefined && !eps.has(alsoEpisode)) eps.set(alsoEpisode, v);
      }
      // Episode folders that exist but hold no video (e.g. Revenge S01/EP01).
      const emptyEpisodeDirs = [];
      for (const s of subdirs(abs)) {
        const sm = s.match(SEASON_DIR), sem = s.match(SE_DIR), em = s.match(EPISODE_DIR);
        const check = (/** @type {number} */ sn, /** @type {number} */ en, /** @type {string} */ r) => {
          if (!seasons.get(sn)?.has(en)) emptyEpisodeDirs.push({ sn, en, r });
        };
        if (sem) { check(Number(sem[1]), Number(sem[2]), `${rel}/${s}`); continue; }
        if (em) { check(1, Number(em[1]), `${rel}/${s}`); continue; }
        if (sm) for (const e of subdirs(path.join(abs, s))) { const m = e.match(EPISODE_DIR); if (m) check(Number(sm[1]), Number(m[1]), `${rel}/${s}/${e}`); }
      }
      for (const x of emptyEpisodeDirs) {
        note("missing", x.r, "Episode folder contains no video file.");
        if (!seasons.has(x.sn)) seasons.set(x.sn, new Map());
      }
      const seasonList = [...seasons.keys()].sort((a, b) => a - b).map((sn) => {
        const eps = /** @type {Map<number, any>} */ (seasons.get(sn));
        const emptyNums = emptyEpisodeDirs.filter((x) => x.sn === sn).map((x) => x.en);
        const have = [...new Set([...eps.keys(), ...emptyNums])].sort((a, b) => a - b);
        const firstOnDisk = Math.min(...eps.keys());
        const hasEmptyDirs = emptyEpisodeDirs.some((x) => x.sn === sn && x.en < firstOnDisk);
        if (eps.size && firstOnDisk > 1 && !hasEmptyDirs) note("missing", `${rel} · season ${sn}`, firstOnDisk === 2 ? "Episode 1 is not on disk." : `Episodes 1–${firstOnDisk - 1} are not on disk.`);
        // Real episodes always get a row (episode 0 included). Gaps get "missing" placeholders only when small,
        // so one stray E999 can't create 900 empty rows.
        const GAP = 30;
        const nums = new Set(have);
        let prev = 0;
        for (const n of have) {
          if (n - prev <= GAP) for (let k = prev + 1; k < n; k++) nums.add(k);
          prev = n;
        }
        return {
          number: sn,
          episodes: [...nums].sort((a, b) => a - b).map((en) => {
            const v = eps.get(en);
            return {
              kind: "episode", id: `${id}-s${sn}e${en}`, seriesId: id, season: sn, number: en, title: `Episode ${en}`,
              file: v ? { path: v.abs, sizeBytes: v.size, subtitles: [], status: "present" } : undefined,
            };
          }),
        };
      }).filter((s) => s.episodes.length);
      const newest = Math.max(...vids.map((v) => v.mtime));
      series.push({ kind: "series", id, title, year, genres: [], ratings: {}, cast: [], addedAt: new Date(newest).toISOString(), art: { hue: hueOf(id) }, seasons: seasonList });
    }

    requireLibrary(root); // the drive may have gone while reading
    writeJson(IDS_FILE, ids);
    const now = new Date().toISOString();
    const roots = [
      { id: "movies", path: moviesDir, kindHint: "movies", online: fs.existsSync(moviesDir), itemCount: movies.length, lastScanAt: now },
      { id: "series", path: seriesDir, kindHint: "series", online: fs.existsSync(seriesDir), itemCount: series.length, lastScanAt: now },
    ];
    return { movies, series, collections, roots, review, scannedAt: now };
  }
}

/** @param {string} mediaRoot */
export function scannerRoutes(mediaRoot) {
  const rootAbs = path.resolve(mediaRoot);
  /** The scan runs in a worker thread so the server keeps answering while a big library is read. One at a time. */
  /** @type {Promise<any> | null} */ let running = null;
  function scan() {
    running ??= new Promise((resolve, reject) => {
      const w = new Worker(new URL("./scan-worker.js", import.meta.url), { workerData: { root: mediaRoot } });
      let done = false;
      const end = (/** @type {Error | null} */ err, /** @type {any=} */ lib) => { if (done) return; done = true; running = null; err ? reject(err) : resolve(lib); };
      w.once("message", (m) => (m.error ? end(Object.assign(new Error(m.error), { status: m.code === "NO_LIBRARY" ? 409 : 500 })) : end(null, m.library)));
      w.once("error", (e) => end(e));
      w.once("exit", (code) => end(new Error(`scan worker exited (${code})`)));
    });
    return running;
  }

  /** What changed compared with the previous scan (for the "Scan complete" message). */
  function diff(/** @type {any} */ prev, /** @type {any} */ next) {
    const titles = (/** @type {any} */ l) => new Map([...(l?.movies ?? []), ...(l?.series ?? [])].map((t) => [t.id, t.year ? `${t.title} (${t.year})` : t.title]));
    const eps = (/** @type {any} */ l) => new Set((l?.series ?? []).flatMap((s) => s.seasons.flatMap((se) => se.episodes.filter((e) => e.file).map((e) => e.id))));
    const a = titles(prev), b = titles(next), ea = eps(prev), eb = eps(next);
    return {
      added: [...b].filter(([id]) => !a.has(id)).map(([, t]) => t),
      removed: [...a].filter(([id]) => !b.has(id)).map(([, t]) => t),
      newEpisodes: prev ? [...eb].filter((id) => !ea.has(id)).length : 0,
    };
  }

  /** The library as a phone may see it: no folder or file locations (it plays by id through /api/remote/watch). */
  const forPhone = (/** @type {any} */ lib) => {
    const bare = (/** @type {any} */ f) => (f ? { ...f, path: "" } : f);
    return {
      ...lib, roots: [], review: [],
      movies: (lib.movies ?? []).map((/** @type {any} */ m) => ({ ...m, file: bare(m.file), ...(m.parts ? { parts: m.parts.map(bare) } : {}) })),
      series: (lib.series ?? []).map((/** @type {any} */ s) => ({ ...s, seasons: (s.seasons ?? []).map((/** @type {any} */ se) => ({ ...se, episodes: (se.episodes ?? []).map((/** @type {any} */ e) => ({ ...e, file: bare(e.file) })) })) })),
    };
  };

  return {
    routes: defineRoutes("scanner", [
      { method: "GET", path: "/api/library", audience: "phone", handler: async ({ json, local }) => {
        let lib = readJson(LIB_FILE, null);
        // No saved scan, or it belongs to the previous library folder: scan now.
        if (!lib || !isScanOf(lib, rootAbs)) {
          try { lib = await scan(); writeJson(LIB_FILE, lib); }
          catch (e) {
            if (/** @type {any} */ (e).status !== 409) { json(500, { error: String(/** @type {Error} */ (e).message) }); return true; }
            lib = offlineLibrary(rootAbs);
          }
        }
        json(200, local ? lib : forPhone(lib)); // other devices never get file locations
        return true;
      } },
      { method: "POST", path: "/api/library/scan", audience: "pc", handler: async ({ json }) => {
        const prev = readJson(LIB_FILE, null);
        const t0 = Date.now();
        let lib;
        try { lib = await scan(); } catch (e) { json(/** @type {any} */ (e).status ?? 500, { error: String(/** @type {Error} */ (e).message) }); return true; }
        writeJson(LIB_FILE, lib);
        json(200, { ...lib, changes: { ...diff(prev, lib), ms: Date.now() - t0 } });
        return true;
      } },
    ]),
  };
}
