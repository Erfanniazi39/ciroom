// @ts-check
/**
 * Dev-only artwork store + TMDB client. Stage 4 moves this into the Rust `metadata` module.
 *
 * Images live in the app's own data dir (~/.local/share/marquee/artwork), NEVER next to media.
 * index.json maps item id → { poster?, backdrop?, source, tmdbId? }.
 *
 *   GET    /api/art                      → index (with /api/art/file/… URLs)
 *   GET    /api/art/file/<name>          → image
 *   POST   /api/art/url    { id, kind, url }          (manual: from a link)
 *   POST   /api/art/upload { id, kind, dataUrl }      (manual: from a local file)
 *   POST   /api/art/reset  { id, kind? }              (back to generated art)
 *   GET    /api/settings                 → { hasTmdbKey }
 *   POST   /api/settings   { tmdbKey }
 *   POST   /api/tmdb/search { type, query, year? }    → candidates
 *   POST   /api/tmdb/apply  { id, type, tmdbId }      (download poster + backdrop)
 *   POST   /api/tmdb/match  { id, type, title, year } (auto: search, score, apply if confident)
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR as PATHS_DATA_DIR } from "./paths.js";
import { writeJsonAtomic } from "./fsutil.js";

const DATA = PATHS_DATA_DIR;
const ART_DIR = path.join(DATA, "artwork");
const INDEX = path.join(ART_DIR, "index.json");
const SETTINGS = path.join(DATA, "settings.json");
const MAX_BYTES = 15 * 1024 * 1024;
const IMG = "https://image.tmdb.org/t/p";
const EXT = /** @type {Record<string,string>} */ ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" });

const readJson = (/** @type {string} */ f, /** @type {any} */ dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (/** @type {string} */ f, /** @type {any} */ v) => writeJsonAtomic(f, v, { space: 2 });;
const safeId = (/** @type {string} */ id) => String(id).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
const fileUrl = (/** @type {string|undefined} */ name) => (name ? `/api/art/file/${encodeURIComponent(name)}` : undefined);

export const DATA_DIR = DATA;
export const readArtIndex = () => readJson(INDEX, {});
const settings = () => readJson(SETTINGS, {});

/** GET a TMDB v3 endpoint with the user's saved key (v3 key → api_key, v4 token → Bearer). */
export async function tmdb(/** @type {string} */ pathAndQuery) {
  const key = settings().tmdbKey;
  if (!key) throw new Error("Add your TMDB API key in Library → Artwork first");
  const bearer = key.startsWith("eyJ"); // v4 read access token vs v3 api key
  const url = new URL(`https://api.themoviedb.org/3${pathAndQuery}`);
  if (!bearer) url.searchParams.set("api_key", key);
  const r = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(20000) });
  if (r.status === 401) throw new Error("TMDB rejected the API key");
  if (r.status === 404) throw new Error("TMDB doesn't know this title (404)");
  if (!r.ok) throw new Error(`TMDB error (HTTP ${r.status})`);
  return r.json();
}

export function norm(/** @type {string} */ s) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
}
/** Token-overlap similarity, 0–1. Good enough for titles; Stage 4 adds Levenshtein. */
export function similarity(/** @type {string} */ a, /** @type {string} */ b) {
  const A = new Set(norm(a).split(" ")), B = new Set(norm(b).split(" "));
  if (norm(a) === norm(b)) return 1;
  const inter = [...A].filter((x) => B.has(x)).length;
  return (2 * inter) / (A.size + B.size || 1);
}

export function artworkRoutes() {
  fs.mkdirSync(ART_DIR, { recursive: true });

  const index = readArtIndex;

  /** Save image bytes for an item, replacing any previous file of that kind. */
  function store(/** @type {string} */ id, /** @type {"poster"|"backdrop"} */ kind, /** @type {Buffer} */ buf, /** @type {string} */ mime, /** @type {object} */ meta) {
    const ext = EXT[mime];
    if (!ext) throw new Error("Not a supported image type (use JPG, PNG or WebP)");
    if (buf.length > MAX_BYTES) throw new Error("Image is larger than 15 MB");
    const idx = index();
    const prev = idx[id]?.[kind];
    const name = `${safeId(id)}-${kind}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(ART_DIR, name), buf);
    if (prev) fs.rmSync(path.join(ART_DIR, prev), { force: true });
    idx[id] = { ...idx[id], [kind]: name, ...meta };
    writeJson(INDEX, idx);
  }

  async function download(/** @type {string} */ url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links are supported");
    const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
    const mime = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!EXT[mime]) throw new Error("That link is not an image");
    return { buf: Buffer.from(await r.arrayBuffer()), mime };
  }

  async function search(/** @type {"movie"|"tv"} */ type, /** @type {string} */ query, /** @type {number=} */ year) {
    const q = new URLSearchParams({ query, include_adult: "false" });
    if (year) q.set(type === "movie" ? "year" : "first_air_date_year", String(year));
    let data = await tmdb(`/search/${type}?${q}`);
    if (!data.results?.length && year) { q.delete(type === "movie" ? "year" : "first_air_date_year"); data = await tmdb(`/search/${type}?${q}`); }
    return (data.results || []).slice(0, 12).map((/** @type {any} */ r) => ({
      tmdbId: r.id,
      title: r.title ?? r.name,
      year: Number((r.release_date ?? r.first_air_date ?? "").slice(0, 4)) || null,
      overview: r.overview,
      poster: r.poster_path ? `${IMG}/w185${r.poster_path}` : null,
      hasBackdrop: !!r.backdrop_path,
    }));
  }

  async function apply(/** @type {string} */ id, /** @type {"movie"|"tv"} */ type, /** @type {number} */ tmdbId) {
    const d = await tmdb(`/${type}/${tmdbId}`);
    if (!d.poster_path && !d.backdrop_path) throw new Error("TMDB has no images for this title");
    const meta = { source: "tmdb", tmdbId };
    if (d.poster_path) { const { buf, mime } = await download(`${IMG}/w500${d.poster_path}`); store(id, "poster", buf, mime, meta); }
    if (d.backdrop_path) { const { buf, mime } = await download(`${IMG}/w1280${d.backdrop_path}`); store(id, "backdrop", buf, mime, meta); }
  }

  const publicIndex = () => {
    const idx = index();
    return Object.fromEntries(Object.entries(idx).map(([id, v]) => [id, { poster: fileUrl(v.poster), backdrop: fileUrl(v.backdrop), source: v.source, tmdbId: v.tmdbId }]));
  };

  return {
    /** @returns {Promise<boolean>} true if handled */
    async handle(/** @type {any} */ req, /** @type {any} */ res, /** @type {(r:any)=>Promise<any>} */ body, /** @type {(c:number,d:unknown)=>void} */ json) {
      const url = String(req.url);

      if (url.startsWith("/api/art/file/") && req.method === "GET") {
        const name = path.basename(decodeURIComponent(url.slice("/api/art/file/".length).split("?")[0]));
        const f = path.join(ART_DIR, name);
        if (!fs.existsSync(f)) { json(404, { error: "Not found" }); return true; }
        const ext = path.extname(f).slice(1);
        res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // names are unique per version
        fs.createReadStream(f).pipe(res);
        return true;
      }
      if (url === "/api/art" && req.method === "GET") { json(200, publicIndex()); return true; }

      if (url === "/api/art/url" && req.method === "POST") {
        const { id, kind, url: link } = await body(req);
        if (!["poster", "backdrop"].includes(kind)) throw new Error("kind must be poster or backdrop");
        const { buf, mime } = await download(String(link));
        store(String(id), kind, buf, mime, { source: "manual" });
        json(200, publicIndex()[id]); return true;
      }
      if (url === "/api/art/upload" && req.method === "POST") {
        const { id, kind, dataUrl } = await body(req);
        if (!["poster", "backdrop"].includes(kind)) throw new Error("kind must be poster or backdrop");
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
        if (!m) throw new Error("Invalid image data");
        store(String(id), kind, Buffer.from(m[2], "base64"), m[1], { source: "manual" });
        json(200, publicIndex()[id]); return true;
      }
      if (url === "/api/art/reset" && req.method === "POST") {
        const { id, kind } = await body(req);
        const idx = index();
        for (const k of kind ? [kind] : ["poster", "backdrop"]) {
          if (idx[id]?.[k]) { fs.rmSync(path.join(ART_DIR, idx[id][k]), { force: true }); delete idx[id][k]; }
        }
        if (idx[id] && !idx[id].poster && !idx[id].backdrop) delete idx[id];
        writeJson(INDEX, idx);
        json(200, publicIndex()[id] ?? {}); return true;
      }

      if (url === "/api/settings" && req.method === "GET") { json(200, { hasTmdbKey: !!settings().tmdbKey }); return true; }
      if (url === "/api/settings" && req.method === "POST") {
        const { tmdbKey } = await body(req);
        const s = settings();
        if (tmdbKey) s.tmdbKey = String(tmdbKey).trim(); else delete s.tmdbKey;
        writeJson(SETTINGS, s);
        if (s.tmdbKey) await tmdb("/configuration"); // validate now, so the user gets immediate feedback
        json(200, { hasTmdbKey: !!s.tmdbKey }); return true;
      }

      if (url === "/api/tmdb/search" && req.method === "POST") {
        const { type, query, year } = await body(req);
        json(200, await search(type === "tv" ? "tv" : "movie", String(query), year)); return true;
      }
      if (url === "/api/tmdb/apply" && req.method === "POST") {
        const { id, type, tmdbId } = await body(req);
        await apply(String(id), type === "tv" ? "tv" : "movie", Number(tmdbId));
        json(200, publicIndex()[id]); return true;
      }
      if (url === "/api/tmdb/match" && req.method === "POST") {
        const { id, type, title, year } = await body(req);
        const t = type === "tv" ? "tv" : "movie";
        const results = await search(t, String(title), year);
        const scored = results.map((/** @type {any} */ r) => ({
          r, score: similarity(title, r.title) * 0.75 + (year && r.year ? (r.year === year ? 0.25 : Math.abs(r.year - year) <= 1 ? 0.12 : 0) : 0.1),
        })).sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score);
        const best = scored[0];
        if (!best || best.score < 0.6) { json(200, { matched: false, reason: best ? `Best guess “${best.r.title}” was not confident enough` : "No results" }); return true; }
        await apply(String(id), t, best.r.tmdbId);
        json(200, { matched: true, title: best.r.title, year: best.r.year, score: Number(best.score.toFixed(2)), art: publicIndex()[id] }); return true;
      }
      return false;
    },
  };
}
