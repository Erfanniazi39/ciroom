// Preloaded into the test server with `node --import` (tests/functional/env.js, option tmdb: true). It replaces the
// server's global fetch for TMDB, TMDB images and the IMDb dataset with canned answers, so metadata tests never use the
// internet and always see the same catalogue. Every other request goes to the real fetch. MOCKED, on purpose:
// the real services need keys and a network, and their data changes.
//   CIROOM_MOCK_LOG=<file>   each mocked request is appended as one JSON line { url } (tests check what was asked)
import dns from "node:dns/promises";
import fs from "node:fs";
import zlib from "node:zlib";

const realFetch = globalThis.fetch;
const realLookup = dns.lookup.bind(dns);
const MOCKED = new Set(["api.themoviedb.org", "image.tmdb.org", "datasets.imdbws.com"]);

// Public-looking address for the mocked hosts (the picture download checks that the host is public; RFC 5737 doc
// ranges count as private there, so use a real public range that is never contacted: the fetch is mocked).
dns.lookup = /** @type {any} */ (async (host, opts) => (MOCKED.has(host) ? (opts?.all ? [{ address: "151.101.1.1", family: 4 }] : { address: "151.101.1.1", family: 4 }) : realLookup(host, opts)));

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** The catalogue. ids are TMDB-like numbers; imdb ids are fake (tt9000xxx). */
const MOVIES = [
  { id: 1001, title: "Alpha Movie", release_date: "2001-05-01", imdb: "tt9000001", runtime: 10, genres: ["Drama"], director: "Ada Director", cast: ["Anna Actor", "Ben Actor"], videos: [{ key: "alphaTrail1", site: "YouTube", type: "Trailer", official: true, iso_639_1: "en", name: "Official Trailer" }] },
  { id: 1002, title: "Alpha Movie", release_date: "1985-03-01", imdb: "tt9000002", runtime: 95, genres: ["Horror"], director: "Old Director", cast: ["Old Actor"], videos: [] },
  { id: 1003, title: "Beta Film", release_date: "2005-01-01", imdb: "tt9000003", runtime: 10, genres: ["Comedy"], director: "B Director", cast: ["Beta Star"], videos: [] },
  { id: 1004, title: "Gamma One", release_date: "2010-01-01", imdb: "tt9000004", genres: ["Action"], cast: [], videos: [] },
  { id: 1005, title: "Gamma Two", release_date: "2012-01-01", imdb: "tt9000005", genres: ["Action"], cast: [], videos: [] },
  { id: 1006, title: "Delta Movie", release_date: "2015-01-01", imdb: "tt9000006", genres: ["Drama"], cast: [], videos: [] },
  { id: 1007, title: "Epsilon", release_date: "2018-01-01", imdb: "tt9000007", genres: ["Sci-Fi"], cast: [], videos: [] },
  { id: 1010, title: "About Elly", original_title: "درباره الی", release_date: "2009-02-07", imdb: "tt9000010", genres: ["Drama"], cast: ["Golshifteh"], videos: [] },
  { id: 1011, title: "Zeta Twin", release_date: "2019-01-01", imdb: "tt9000011", genres: ["Thriller"], cast: [], videos: [] },
];
const TV = [
  { id: 2001, name: "Show One", first_air_date: "2015-01-01", imdb: "tt9000101", genres: ["Drama"], status: "Ended", last_air_date: "2016-12-01", seasons: { 1: 3, 2: 3 } },
  { id: 2002, name: "Show Two", first_air_date: "2016-02-01", imdb: "tt9000102", genres: ["Mystery"], status: "Returning Series", seasons: { 1: 2 } },
  { id: 2003, name: "Flat Show", first_air_date: "2018-01-01", imdb: "tt9000103", genres: ["Comedy"], status: "Ended", seasons: { 1: 3 } },
];
const norm = (/** @type {string} */ s) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function json(/** @type {any} */ body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tmdb(/** @type {URL} */ u) {
  if (!u.searchParams.get("api_key") || u.searchParams.get("api_key") === "bad") return json({ status_message: "Invalid API key" }, 401);
  const p = u.pathname.replace(/^\/3/, "");
  let m;
  if (p === "/configuration") return json({ images: { secure_base_url: "https://image.tmdb.org/t/p/" } });
  if ((m = p.match(/^\/search\/(movie|tv)$/))) {
    const q = norm(u.searchParams.get("query") ?? "");
    const year = u.searchParams.get(m[1] === "movie" ? "year" : "first_air_date_year");
    const list = m[1] === "movie" ? MOVIES : TV;
    const hits = list.filter((x) => {
      const names = [x.title ?? x.name, x.original_title].filter(Boolean).map((n) => norm(String(n)));
      return names.some((n) => n.includes(q) || q.includes(n)) && (!year || String(x.release_date ?? x.first_air_date).startsWith(year));
    });
    return json({ results: hits.map((x) => ({ id: x.id, title: x.title, name: x.name, original_title: x.original_title, release_date: x.release_date, first_air_date: x.first_air_date, overview: `${x.title ?? x.name} overview`, poster_path: `/p${x.id}.png`, backdrop_path: `/b${x.id}.png`, popularity: 10 })) });
  }
  if ((m = p.match(/^\/movie\/(\d+)(\/videos)?$/))) {
    const x = MOVIES.find((y) => y.id === Number(m[1]));
    if (!x) return json({ status_message: "not found" }, 404);
    if (m[2]) return json({ results: x.videos });
    return json({ id: x.id, title: x.title, release_date: x.release_date, runtime: x.runtime, genres: x.genres.map((n) => ({ name: n })), overview: `${x.title} overview`, tagline: "A tagline",
      vote_average: 7.25, vote_count: 1200, poster_path: `/p${x.id}.png`, backdrop_path: `/b${x.id}.png`, external_ids: { imdb_id: x.imdb },
      credits: { cast: x.cast.map((n) => ({ name: n })), crew: x.director ? [{ job: "Director", name: x.director }] : [] }, videos: { results: x.videos } });
  }
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) {
    const x = TV.find((y) => y.id === Number(m[1]));
    const n = x?.seasons[Number(m[2])];
    if (!x || !n) return json({ status_message: "not found" }, 404);
    // Episodes air on the 1st of consecutive months of the show's first year; the last one of season 1 of Show Two airs "tomorrow".
    const eps = Array.from({ length: n }, (_, k) => ({ episode_number: k + 1, name: `${x.name} S${m[2]}E${k + 1} title`, overview: "Episode overview", air_date: `${x.first_air_date.slice(0, 4)}-${String(k + 1).padStart(2, "0")}-01`, runtime: 1, vote_average: 8, vote_count: 10 }));
    return json({ name: `Season ${m[2]}`, air_date: eps[0]?.air_date, episodes: eps });
  }
  if ((m = p.match(/^\/tv\/(\d+)(\/videos)?$/))) {
    const x = TV.find((y) => y.id === Number(m[1]));
    if (!x) return json({ status_message: "not found" }, 404);
    if (m[2]) return json({ results: [] });
    return json({ id: x.id, name: x.name, first_air_date: x.first_air_date, last_air_date: x.last_air_date, status: x.status, genres: x.genres.map((n) => ({ name: n })), overview: `${x.name} overview`,
      vote_average: 8.1, vote_count: 900, poster_path: `/p${x.id}.png`, backdrop_path: `/b${x.id}.png`, external_ids: { imdb_id: x.imdb }, created_by: [{ name: "Show Creator" }],
      episode_run_time: [1], number_of_seasons: Object.keys(x.seasons).length, credits: { cast: [{ name: "Series Star" }] }, videos: { results: [] } });
  }
  return json({ status_message: "unknown endpoint" }, 404);
}

function imdbDataset() {
  const rows = ["tconst\taverageRating\tnumVotes", ...MOVIES.map((x, i) => `${x.imdb}\t${(6 + i / 10).toFixed(1)}\t${1000 + i}`), ...TV.map((x, i) => `${x.imdb}\t${(8 + i / 10).toFixed(1)}\t${5000 + i}`)];
  return new Response(zlib.gzipSync(rows.join("\n") + "\n"), { status: 200, headers: { "content-type": "application/octet-stream" } });
}

globalThis.fetch = /** @type {any} */ (async (input, init) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (!MOCKED.has(u.hostname)) return realFetch(input, init);
  if (process.env.CIROOM_MOCK_LOG) fs.appendFileSync(process.env.CIROOM_MOCK_LOG, JSON.stringify({ url: u.pathname + u.search.replace(/api_key=[^&]+/, "api_key=*") }) + "\n");
  if (process.env.CIROOM_MOCK_OFFLINE === "1") throw new TypeError("fetch failed");
  if (u.hostname === "api.themoviedb.org") return tmdb(u);
  if (u.hostname === "image.tmdb.org") return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  return imdbDataset();
});
