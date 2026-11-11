// @ts-check
/**
 * Dev-only metadata store: real titles, years, runtimes, genres, overviews, directors/creators, cast,
 * TMDB ratings and episode titles from TMDB, plus real IMDb ratings from IMDb's free daily dataset.
 * Stage 4 moves this into the Rust `metadata` module with the same API shapes.
 *
 * Stored in the app's data dir (~/.local/share/marquee/metadata/), never next to media:
 *   index.json               item id → MetaEntry (see `fetchOne`)
 *   title.ratings.tsv.gz     IMDb dataset (tconst, averageRating, numVotes), refreshed at most daily
 *
 *   GET  /api/meta                                         → index
 *   POST /api/meta/fetch { id, type, query, year?, seasons?, tmdbId? }  → entry (tmdbId given = manual fix, locked)
 *   POST /api/meta/imdb                                    → { updated, missing, datasetDate }
 *   POST /api/meta/reset { id }                            → {}
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { DATA_DIR, readArtIndex, similarity, tmdb } from "./artwork-store.js";

const META_DIR = path.join(DATA_DIR, "metadata");
const INDEX = path.join(META_DIR, "index.json");
const IMDB_FILE = path.join(META_DIR, "title.ratings.tsv.gz");
const IMDB_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const DAY = 86_400_000;

const readJson = (/** @type {string} */ f, /** @type {any} */ dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (/** @type {string} */ f, /** @type {any} */ v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const yearOf = (/** @type {string|undefined|null} */ d) => (d ? Number(d.slice(0, 4)) || undefined : undefined);

/** Pick the best TMDB result for a folder title (+ year when the folder has one). */
async function searchBest(/** @type {"movie"|"tv"} */ type, /** @type {string} */ query, /** @type {number=} */ year) {
  const q = new URLSearchParams({ query, include_adult: "false" });
  if (year) q.set(type === "movie" ? "year" : "first_air_date_year", String(year));
  let data = await tmdb(`/search/${type}?${q}`);
  if (!data.results?.length && year) { q.delete(type === "movie" ? "year" : "first_air_date_year"); data = await tmdb(`/search/${type}?${q}`); }
  const scored = (data.results || []).slice(0, 10).map((/** @type {any} */ r, /** @type {number} */ i) => {
    const title = r.title ?? r.name, y = yearOf(r.release_date ?? r.first_air_date);
    const yearScore = year && y ? (y === year ? 0.25 : Math.abs(y - year) <= 1 ? 0.12 : 0) : 0.1;
    return { r, title, year: y, score: similarity(query, title) * 0.75 + yearScore - i * 0.01 }; // TMDB order ≈ popularity
  }).sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score);
  return scored[0] ?? null;
}

export function metadataRoutes() {
  fs.mkdirSync(META_DIR, { recursive: true });
  const index = () => readJson(INDEX, {});
  /** IMDb ratings loaded from the dataset for the ids we need: tconst → { value, votes }. */
  let imdbCache = /** @type {Map<string, {value:number, votes:number}>|null} */ (null);

  /**
   * The best trailer from TMDB's video list: YouTube, type Trailer (else Teaser), official first, English
   * first, then the highest resolution and the newest. Returns { key, name, site } or null.
   * @param {any[]} videos
   */
  function pickTrailer(videos) {
    const yt = (videos ?? []).filter((v) => v.site === "YouTube" && /^[\w-]{6,20}$/.test(v.key ?? ""));
    const score = (/** @type {any} */ v) =>
      (v.type === "Trailer" ? 100 : v.type === "Teaser" ? 40 : 0) + (v.official ? 20 : 0) + (v.iso_639_1 === "en" ? 10 : 0) + (v.size ?? 0) / 1000
      + (/official trailer/i.test(v.name ?? "") ? 8 : /trailer/i.test(v.name ?? "") ? 4 : 0)
      - (/\b(4k|ultra hd|blu-?ray|dvd|digital|re-?release|anniversary|remaster|steelbook|reaction|recap)\b/i.test(v.name ?? "") ? 30 : 0);
    const best = yt.filter((v) => v.type === "Trailer" || v.type === "Teaser")
      .sort((a, b) => score(b) - score(a) || String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")))[0];
    return best ? { key: best.key, name: best.name || "Trailer", site: "YouTube" } : null;
  }

  /** Trailer for one title, fetched once and cached in the entry (re-checked after 30 days when none was found). */
  async function trailerFor(/** @type {string} */ id) {
    const idx = index();
    const e = idx[id];
    if (!e?.tmdbId) return null;
    const fresh = e.trailerCheckedAt && Date.now() - Date.parse(e.trailerCheckedAt) < 30 * DAY;
    if (e.trailer || (e.trailer === null && fresh)) return e.trailer;
    const d = await tmdb(`/${e.type}/${e.tmdbId}/videos?include_video_language=en,null`);
    const all = index();
    if (!all[id]) return null;
    all[id].trailer = pickTrailer(d.results);
    all[id].trailerCheckedAt = new Date().toISOString();
    writeJson(INDEX, all);
    return all[id].trailer;
  }

  /**
   * Fetch (or refresh) one title's metadata.
   * @param {{ id: string, type: "movie"|"tv", query: string, year?: number, seasons?: number[], tmdbId?: number }} req
   */
  async function fetchOne(req) {
    const idx = index();
    const prev = idx[req.id];
    /** @type {number|undefined} */ let tmdbId;
    let matchedBy = "", confidence = 1, matchedTitle = "";

    if (req.tmdbId) { tmdbId = req.tmdbId; matchedBy = "manual"; }
    else if (prev?.locked && prev.tmdbId) { tmdbId = prev.tmdbId; matchedBy = prev.matchedBy; }
    else if (readArtIndex()[req.id]?.tmdbId) { tmdbId = readArtIndex()[req.id].tmdbId; matchedBy = "artwork"; }
    else {
      const best = await searchBest(req.type, req.query, req.year);
      if (!best) throw new Error(`TMDB has no results for “${req.query}”`);
      tmdbId = best.r.id; matchedBy = "search"; confidence = Number(best.score.toFixed(2)); matchedTitle = `${best.title}${best.year ? ` (${best.year})` : ""}`;
    }

    const d = await tmdb(`/${req.type}/${tmdbId}?append_to_response=credits,external_ids,videos&include_video_language=en,null`);
    const cast = (d.credits?.cast ?? []).slice(0, 8).map((/** @type {any} */ c) => c.name);
    /** @type {any} */
    const entry = {
      type: req.type, tmdbId, imdbId: d.external_ids?.imdb_id || d.imdb_id || undefined,
      title: d.title ?? d.name, genres: (d.genres ?? []).map((/** @type {any} */ g) => g.name),
      overview: d.overview || undefined, tagline: d.tagline || undefined, cast,
      tmdb: d.vote_count ? { value: Math.round(d.vote_average * 10) / 10, votes: d.vote_count } : undefined,
      imdb: prev?.imdbId && prev.imdbId === (d.external_ids?.imdb_id || d.imdb_id) ? prev.imdb : undefined,
      matchedBy, confidence, matchedTitle: matchedTitle || `${d.title ?? d.name} (${yearOf(d.release_date ?? d.first_air_date) ?? "?"})`,
      locked: matchedBy === "manual" || !!prev?.locked, fetchedAt: new Date().toISOString(),
      trailer: pickTrailer(d.videos?.results), trailerCheckedAt: new Date().toISOString(),
    };
    if (req.type === "movie") {
      entry.year = yearOf(d.release_date);
      entry.runtime = d.runtime || undefined;
      entry.director = (d.credits?.crew ?? []).filter((/** @type {any} */ c) => c.job === "Director").map((/** @type {any} */ c) => c.name).join(", ") || undefined;
    } else {
      entry.year = yearOf(d.first_air_date);
      entry.endYear = ["Ended", "Canceled"].includes(d.status) ? yearOf(d.last_air_date) : undefined;
      entry.status = d.status;
      entry.creator = (d.created_by ?? []).map((/** @type {any} */ c) => c.name).join(", ") || undefined;
      entry.episodeRuntime = d.episode_run_time?.[0] || undefined;
      entry.seasonCount = d.number_of_seasons;
      entry.seasons = {};
      for (const n of req.seasons ?? []) {
        try {
          const s = await tmdb(`/tv/${tmdbId}/season/${n}`);
          entry.seasons[n] = {
            name: s.name, airDate: s.air_date || undefined,
            episodes: Object.fromEntries((s.episodes ?? []).map((/** @type {any} */ e) => [e.episode_number, {
              title: e.name, overview: e.overview || undefined, airDate: e.air_date || undefined, runtime: e.runtime || undefined,
              tmdb: e.vote_count ? { value: Math.round(e.vote_average * 10) / 10, votes: e.vote_count } : undefined,
            }])),
          };
        } catch (e) {
          entry.seasons[n] = { error: e instanceof Error ? e.message : "failed" };
        }
      }
    }
    if (!entry.imdb && entry.imdbId && imdbCache?.has(entry.imdbId)) entry.imdb = imdbCache.get(entry.imdbId);
    const all = index();
    all[req.id] = entry;
    writeJson(INDEX, all);
    return entry;
  }

  /** Download IMDb's ratings dataset (if missing or older than a day) and attach ratings to every entry. */
  async function refreshImdb() {
    const stat = fs.existsSync(IMDB_FILE) ? fs.statSync(IMDB_FILE) : null;
    if (!stat || Date.now() - stat.mtimeMs > DAY) {
      const r = await fetch(IMDB_URL, { signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`IMDb dataset download failed (HTTP ${r.status})`);
      const tmp = `${IMDB_FILE}.part`;
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      fs.renameSync(tmp, IMDB_FILE);
    }
    const idx = index();
    const wanted = new Set(Object.values(idx).map((/** @type {any} */ e) => e.imdbId).filter(Boolean));
    const found = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(IMDB_FILE).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      const tab = line.indexOf("\t");
      const id = line.slice(0, tab);
      if (!wanted.has(id)) continue;
      const [, avg, votes] = line.split("\t");
      found.set(id, { value: Number(avg), votes: Number(votes) });
    }
    imdbCache = found;
    let updated = 0;
    const missing = [];
    for (const [id, e] of Object.entries(idx)) {
      const v = /** @type {any} */ (e).imdbId && found.get(/** @type {any} */ (e).imdbId);
      if (v) { /** @type {any} */ (e).imdb = v; updated++; } else missing.push(id);
    }
    writeJson(INDEX, idx);
    return { updated, missing, datasetDate: fs.statSync(IMDB_FILE).mtime.toISOString() };
  }

  return {
    /** @returns {Promise<boolean>} true if handled */
    async handle(/** @type {any} */ req, /** @type {any} */ res, /** @type {(r:any)=>Promise<any>} */ body, /** @type {(c:number,d:unknown)=>void} */ json) {
      const url = String(req.url);
      if (url === "/api/meta" && req.method === "GET") { json(200, index()); return true; }
      if (url === "/api/meta/fetch" && req.method === "POST") {
        const b = await body(req);
        if (!b.id || !b.query) throw new Error("id and query are required");
        json(200, await fetchOne({
          id: String(b.id), type: b.type === "tv" ? "tv" : "movie", query: String(b.query),
          year: Number(b.year) || undefined, seasons: Array.isArray(b.seasons) ? b.seasons.map(Number) : [], tmdbId: Number(b.tmdbId) || undefined,
        }));
        return true;
      }
      if (url === "/api/meta/trailer" && req.method === "POST") {
        const { id } = await body(req);
        json(200, { trailer: await trailerFor(String(id)) });
        return true;
      }
      if (url === "/api/meta/imdb" && req.method === "POST") { json(200, await refreshImdb()); return true; }
      if (url === "/api/meta/reset" && req.method === "POST") {
        const { id } = await body(req);
        const idx = index();
        delete idx[String(id)];
        writeJson(INDEX, idx);
        json(200, {}); return true;
      }
      return false;
    },
  };
}
