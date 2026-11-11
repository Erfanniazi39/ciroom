// @ts-check
/**
 * Dev-only library scanner: builds the library from the REAL folders in <media root>/Movies and /Series.
 * READ-ONLY: it lists folders and stats files; it never moves, renames, writes or deletes media.
 * The standalone app ports this to Rust (same rules, same output shape).
 *
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
 *  - Folders without a video (e.g. a download in progress) are reported, not shown.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./artwork-store.js";
import { LIBRARY_FILE } from "./paths.js";

const LIB_FILE = LIBRARY_FILE; // per system (full paths differ between Linux and Windows)
const IDS_FILE = path.join(DATA_DIR, "ids.json");
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts|wmv)$/i;
const SKIP_DIR = /^(\.|@|\$|sample$|samples$|extras?$|featurettes?$|behind the scenes$|trailers?$)/i;

/** Folder abbreviations → real names (used for display before TMDB and for matching). */
const ALIASES = /** @type {Record<string,string>} */ ({ himym: "How I Met Your Mother", hotdg: "House of the Dragon", hotd: "House of the Dragon", got: "Game of Thrones" });

/**
 * Ids the library used before the scanner existed, by folder. Progress, favorites and artwork are keyed
 * by these ids, so they must not change. New titles get a slug of their title.
 */
const LEGACY_IDS = /** @type {Record<string,string>} */ ({
  "Movies/Zombieland/Zombieland 2009": "zombieland",
  "Movies/Zombieland/Zombieland 2019": "zombieland-double-tap",
  "Movies/Harry Potter/Harry Potter 2001": "harry-potter-1",
  "Movies/Home Alone/Home Alone 1990": "home-alone",
  "Movies/Zombieland#collection": "zombieland",
  "Movies/Harry Potter#collection": "harry-potter",
  "Movies/Home Alone#collection": "home-alone",
  "Series/HIMYM": "himym",
  "Series/HOTDG": "house-of-the-dragon",
  "Series/A knight of the seven kingdoms": "knight-seven-kingdoms",
  "Series/11.22.63 2016": "11-22-63",
  "Series/Rick & Morty": "rick-and-morty",
});

const readJson = (/** @type {string} */ f, /** @type {any} */ dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (/** @type {string} */ f, /** @type {any} */ v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const slug = (/** @type {string} */ s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "title";
const hueOf = (/** @type {string} */ id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);
const titleCase = (/** @type {string} */ s) => s.split(" ").map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

/** "Inception 2010" → { title: "Inception", year: 2010 }; "11.22.63 2016" keeps "11.22.63". */
function parseFolder(/** @type {string} */ name) {
  const m = name.match(/^(.*?)[\s._-]*[([]?((?:19|20)\d{2})[)\]]?$/);
  let title = (m && m[1].trim() ? m[1] : name).trim();
  if (!/\s/.test(title) && /[._]/.test(title) && !/^[\d.]+$/.test(title)) title = title.replace(/[._]+/g, " "); // "The.Office" → "The Office"; keep "11.22.63"
  title = title.replace(/\s+/g, " ");
  const year = m && m[1].trim() ? Number(m[2]) : undefined;
  const alias = ALIASES[title.toLowerCase()];
  if (alias) title = alias;
  else if (title.split(" ").slice(1).every((w) => w === w.toLowerCase())) title = titleCase(title.charAt(0).toLowerCase() + title.slice(1)); // "A knight of the…"
  return { title, year };
}

const SEASON_DIR = /^(?:s|season[\s._-]*)0*(\d{1,3})(?:\b|[\s._-]*e)/i;
const EPISODE_DIR = /^(?:ep?|episode[\s._-]*)0*(\d{1,3})$/i;
const SE_DIR = /^s0*(\d{1,3})[\s._-]*e0*(\d{1,3})$/i;
const SE_FILE = /(?:^|[^a-z0-9])s0*(\d{1,3})[\s._-]*e0*(\d{1,3})(?!\d)/i;
const X_FILE = /(?:^|[^0-9])(\d{1,2})x(\d{2,3})(?!\d)/i;

/** Season/episode from the folder path first (folder beats file name), then the file name. */
function parseEpisode(/** @type {string[]} */ dirs, /** @type {string} */ file) {
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
  if (episode === undefined && fromFile) { season ??= fromFile.season; episode = fromFile.episode; }
  if (episode !== undefined) season ??= 1; // e.g. Series/<Name>/EP01 with no season folder
  return { season, episode, fromFile };
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

/** @param {string} mediaRoot */
export function scannerRoutes(mediaRoot) {
  const root = path.resolve(mediaRoot);

  function scan() {
    const ids = readJson(IDS_FILE, {});
    const used = new Set(Object.values(ids));
    /** Stable id per folder: saved → legacy → slug(title) → slug(title-year) → numbered. */
    const idFor = (/** @type {string} */ rel, /** @type {string} */ base, /** @type {string=} */ alt) => {
      if (ids[rel]) return ids[rel];
      let id = LEGACY_IDS[rel] ?? slug(base);
      if (!LEGACY_IDS[rel] && used.has(id) && alt) id = slug(alt);
      for (let n = 2; used.has(id) && !LEGACY_IDS[rel]; n++) id = `${slug(alt ?? base)}-${n}`;
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
      const main = vids[0];
      for (const d of vids.slice(1)) if (d.size > main.size * 0.5) note("duplicate", `${rel}/${d.name}`, `Another copy of this movie. CiRoom plays “${main.name}”.`);
      const { title, year } = parseFolder(folder);
      const id = idFor(rel, title, year ? `${title} ${year}` : undefined);
      return {
        kind: "movie", id, title, year, genres: [], ratings: {}, cast: [], addedAt: new Date(main.mtime).toISOString(), collectionId,
        art: { hue: hueOf(id) }, file: { path: main.abs, sizeBytes: main.size, subtitles: [], status: "present" },
      };
    };
    for (const name of subdirs(moviesDir)) {
      const abs = path.join(moviesDir, name), rel = `Movies/${name}`;
      zips(abs, rel);
      const direct = listVideos(abs, 0);
      if (direct.length) { const m = makeMovie(abs, rel, name); if (m) movies.push(m); continue; }
      const subs = subdirs(abs);
      if (!subs.length) { note("empty", rel, "No video file in this folder yet."); continue; }
      const collectionId = idFor(`${rel}#collection`, `${name} collection`);
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
      const id = idFor(rel, title);
      /** @type {Map<number, Map<number, any>>} */ const seasons = new Map();
      for (const v of vids.sort(bestFirst)) {
        const { season, episode, fromFile } = parseEpisode(v.dirs, v.name);
        const vrel = `${rel}/${[...v.dirs, v.name].join("/")}`;
        if (season === undefined || episode === undefined) { note("unidentified", vrel, "Can't tell which episode this is. Put it in an S01/EP01 folder or name it S01E01."); continue; }
        if (!seasons.has(season)) seasons.set(season, new Map());
        const eps = /** @type {Map<number, any>} */ (seasons.get(season));
        if (eps.has(episode)) { note("duplicate", vrel, `Another video for S${season}E${episode}. CiRoom plays the larger file.`); continue; }
        if (fromFile && (fromFile.season !== season || fromFile.episode !== episode)) {
          note("misplaced", vrel, `The file is named S${String(fromFile.season).padStart(2, "0")}E${String(fromFile.episode).padStart(2, "0")} but sits in the S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} folder. CiRoom follows the folder; check it's the right episode.`);
        }
        eps.set(episode, v);
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
        const max = Math.max(0, ...eps.keys(), ...emptyEpisodeDirs.filter((x) => x.sn === sn).map((x) => x.en));
        const firstOnDisk = Math.min(...eps.keys());
        const hasEmptyDirs = emptyEpisodeDirs.some((x) => x.sn === sn && x.en < firstOnDisk);
        if (eps.size && firstOnDisk > 1 && !hasEmptyDirs) note("missing", `${rel} · season ${sn}`, firstOnDisk === 2 ? "Episode 1 is not on disk." : `Episodes 1–${firstOnDisk - 1} are not on disk.`);
        return {
          number: sn,
          episodes: Array.from({ length: max }, (_, i) => {
            const en = i + 1, v = eps.get(en);
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

    writeJson(IDS_FILE, ids);
    const now = new Date().toISOString();
    const roots = [
      { id: "movies", path: moviesDir, kindHint: "movies", online: fs.existsSync(moviesDir), itemCount: movies.length, lastScanAt: now },
      { id: "series", path: seriesDir, kindHint: "series", online: fs.existsSync(seriesDir), itemCount: series.length, lastScanAt: now },
    ];
    return { movies, series, collections, roots, review, scannedAt: now };
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

  return {
    /** @returns {Promise<boolean>} true if handled */
    async handle(/** @type {any} */ req, /** @type {any} */ res, /** @type {(c:number,d:unknown)=>void} */ json) {
      const url = String(req.url);
      if (url === "/api/library" && req.method === "GET") {
        let lib = readJson(LIB_FILE, null);
        if (!lib) { lib = scan(); writeJson(LIB_FILE, lib); }
        json(200, lib);
        return true;
      }
      if (url === "/api/library/scan" && req.method === "POST") {
        const prev = readJson(LIB_FILE, null);
        const t0 = Date.now();
        const lib = scan();
        writeJson(LIB_FILE, lib);
        json(200, { ...lib, changes: { ...diff(prev, lib), ms: Date.now() - t0 } });
        return true;
      }
      return false;
    },
  };
}
