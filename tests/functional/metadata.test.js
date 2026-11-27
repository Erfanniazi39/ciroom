// Functional: movie/series metadata and artwork (area C) through the real server. TMDB, TMDB images and the IMDb
// dataset are MOCKED in-process (tests/functional/tmdb-mock.js): same code paths, canned catalogue, no internet.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan, scratch } from "./env.js";
import { HAS_FFMPEG } from "../fixtures/media.js";

const LAYOUT = {
  "Movies/Alpha Movie 2001/alpha.mkv": "short.mkv",
  "Movies/Beta Film 2005/beta.mkv": "short20.mkv",
  "Movies/درباره الی 2009/elly.mkv": "short30.mkv",
  "Series/Show One/S01/EP01/a.mkv": "ep60.mkv",
  "Series/Show One/S02/EP01/b.mkv": "ep61.mkv",
};
const mockLog = (/** @type {any} */ s) => { try { return fs.readFileSync(path.join(s.dir, "mock.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).url); } catch { return []; } };

describe("metadata and artwork with a mocked TMDB", { skip: !HAS_FFMPEG }, () => {
  /** @type {any} */ let s;
  before(async () => {
    const dir = scratch("meta");
    s = await startCiRoom({ dir, layout: LAYOUT, tmdb: true, env: { CIROOM_MOCK_LOG: path.join(dir, "mock.log") } });
    await scan(s);
  });
  after(async () => { await s?.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); });

  test("without a TMDB key: a clear message, nothing saved", async () => {
    assert.deepEqual((await s.get("/api/settings")).json, { hasTmdbKey: false });
    const r = await s.post("/api/meta/fetch", { id: "alpha-movie", type: "movie", query: "Alpha Movie", year: 2001 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /TMDB API key/);
    assert.deepEqual((await s.get("/api/meta")).json, {});
  });

  test("a rejected key is reported at once; a good key is saved (and never sent back)", async () => {
    const bad = await s.post("/api/settings", { tmdbKey: "bad" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /rejected/i);
    const ok = await s.post("/api/settings", { tmdbKey: "  good-key  " });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { hasTmdbKey: true });
    assert.ok(!JSON.stringify((await s.get("/api/settings")).json).includes("good-key"));
    const file = JSON.parse(fs.readFileSync(path.join(s.data, "settings.json"), "utf8"));
    assert.equal(file.tmdbKey, "good-key", "trimmed");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(s.data, "settings.json")).mode & 0o777, 0o600);
  });

  test("D-08: a key TMDB rejected is not kept (Settings must not say a key is saved)", { todo: "D-08" }, async () => {
    const bad = await s.post("/api/settings", { tmdbKey: "bad" });
    assert.equal(bad.status, 400);
    const after = (await s.get("/api/settings")).json;
    await s.post("/api/settings", { tmdbKey: "good-key" }); // leave a good key for the next tests
    assert.deepEqual(after, { hasTmdbKey: false }, "the rejected key was saved anyway");
  });

  test("movie: title + year picks the right one of two films with the same name", async () => {
    const r = await s.post("/api/meta/fetch", { id: "alpha-movie", type: "movie", query: "Alpha Movie", year: 2001 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tmdbId, 1001);
    assert.equal(r.json.year, 2001);
    assert.equal(r.json.director, "Ada Director");
    assert.deepEqual(r.json.cast, ["Anna Actor", "Ben Actor"]);
    assert.deepEqual(r.json.genres, ["Drama"]);
    assert.equal(r.json.imdbId, "tt9000001");
    assert.deepEqual(r.json.tmdb, { value: 7.3, votes: 1200 });
    assert.equal(r.json.matchedBy, "search");
    assert.equal(r.json.locked, false);
    assert.deepEqual(r.json.trailer, { key: "alphaTrail1", name: "Official Trailer", site: "YouTube" });
    assert.equal((await s.get("/api/meta")).json["alpha-movie"].tmdbId, 1001, "saved under the library id");
  });

  test("the same name with a different year matches the other film", async () => {
    const r = await s.post("/api/meta/fetch", { id: "probe-1985", type: "movie", query: "Alpha Movie", year: 1985 });
    assert.equal(r.json.tmdbId, 1002);
    await s.post("/api/meta/reset", { id: "probe-1985" });
  });

  test("no year and two equally good candidates: listed for a manual choice (nothing saved) — or the first is taken", async () => {
    const r = await s.post("/api/meta/fetch", { id: "probe-noyear", type: "movie", query: "Alpha Movie" });
    assert.equal(r.status, 200);
    // Both candidates score the same (title 1.0, unknown year): the matcher takes TMDB's first. Record what happens.
    if (r.json.matched === false) assert.ok((await s.get("/api/meta/unmatched")).json["probe-noyear"]);
    else assert.ok([1001, 1002].includes(r.json.tmdbId));
    await s.post("/api/meta/reset", { id: "probe-noyear" });
  });

  test("a title TMDB doesn't know: not matched, listed under unmatched, nothing saved", async () => {
    const r = await s.post("/api/meta/fetch", { id: "nope", type: "movie", query: "Completely Unknown Thing", year: 1999 });
    assert.equal(r.json.matched, false);
    assert.match(r.json.reason, /no results/i);
    assert.ok((await s.get("/api/meta/unmatched")).json.nope);
    assert.equal((await s.get("/api/meta")).json.nope, undefined);
  });

  test("manual match (Fix match) is locked: a later refresh keeps it; the unmatched entry is cleared", async () => {
    const m = await s.post("/api/meta/fetch", { id: "nope", type: "movie", query: "Completely Unknown Thing", tmdbId: 1003 });
    assert.equal(m.json.tmdbId, 1003);
    assert.equal(m.json.matchedBy, "manual");
    assert.equal(m.json.locked, true);
    assert.equal((await s.get("/api/meta/unmatched")).json.nope, undefined);
    const again = await s.post("/api/meta/fetch", { id: "nope", type: "movie", query: "Alpha Movie", year: 2001 });
    assert.equal(again.json.tmdbId, 1003, "refresh keeps the locked choice");
    assert.equal(again.json.locked, true);
  });

  test("a wrong automatic match can be corrected by hand, and the correction survives a rescan", async () => {
    await s.post("/api/meta/fetch", { id: "beta-film", type: "movie", query: "Beta Film", year: 2005 });
    const fixed = await s.post("/api/meta/fetch", { id: "beta-film", type: "movie", query: "Beta Film", tmdbId: 1011 });
    assert.equal(fixed.json.title, "Zeta Twin");
    await scan(s);
    const idx = (await s.get("/api/meta")).json;
    assert.equal(idx["beta-film"].tmdbId, 1011);
    assert.equal(idx["beta-film"].locked, true);
  });

  test("reset forgets a title's metadata (it can be fetched again)", async () => {
    await s.post("/api/meta/reset", { id: "nope" });
    assert.equal((await s.get("/api/meta")).json.nope, undefined);
  });

  test("series: show details plus the episode titles and air dates of the seasons on disk", async () => {
    const r = await s.post("/api/meta/fetch", { id: "show-one", type: "tv", query: "Show One", seasons: [1, 2] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tmdbId, 2001);
    assert.equal(r.json.creator, "Show Creator");
    assert.equal(r.json.year, 2015);
    assert.equal(r.json.endYear, 2016, "ended show: end year");
    assert.equal(r.json.seasons[1].episodes[1].title, "Show One S1E1 title");
    assert.equal(r.json.seasons[2].episodes[3].title, "Show One S2E3 title");
    assert.equal(r.json.seasons[1].episodes[2].airDate, "2015-02-01");
  });

  test("a season TMDB doesn't have is recorded as an error, the rest is saved", async () => {
    const r = await s.post("/api/meta/fetch", { id: "show-one", type: "tv", query: "Show One", seasons: [1, 9] });
    assert.ok(r.json.seasons[1].episodes);
    assert.ok(r.json.seasons[9].error);
  });

  test("D-07: a Persian folder name is matched automatically (TMDB knows the film by its original title)", { todo: "D-07" }, async () => {
    const r = await s.post("/api/meta/fetch", { id: "title", type: "movie", query: "درباره الی", year: 2009 });
    assert.notEqual(r.json.matched, false, `not matched: ${r.json.reason}`);
    assert.equal(r.json.tmdbId, 1010);
  });

  test("IMDb ratings: the dataset is downloaded once and attached by IMDb id", async () => {
    const r = await s.post("/api/meta/imdb");
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.updated >= 2);
    const idx = (await s.get("/api/meta")).json;
    assert.deepEqual(idx["alpha-movie"].imdb, { value: 6, votes: 1000 });
    assert.deepEqual(idx["show-one"].imdb, { value: 8, votes: 5000 });
    const before = mockLog(s).filter((u) => u.includes("title.ratings")).length;
    await s.post("/api/meta/imdb");
    assert.equal(mockLog(s).filter((u) => u.includes("title.ratings")).length, before, "not downloaded again the same day");
  });

  test("trailer: the cached one is returned without asking TMDB again", async () => {
    const before = mockLog(s).length;
    const r = await s.post("/api/meta/trailer", { id: "alpha-movie" });
    assert.deepEqual(r.json.trailer, { key: "alphaTrail1", name: "Official Trailer", site: "YouTube" });
    assert.equal(mockLog(s).length, before);
    assert.deepEqual((await s.post("/api/meta/trailer", { id: "not-a-title" })).json, { trailer: null });
  });

  test("open-trailer only accepts a YouTube video id", async () => {
    for (const key of ["", "a", "https://evil.example/x", "../../etc", "x".repeat(40), "a b c d e f"]) assert.equal((await s.post("/api/open-trailer", { key })).status, 400, key);
  });

  test("artwork: TMDB poster and background are downloaded and stored for the title", async () => {
    const r = await s.post("/api/tmdb/apply", { id: "alpha-movie", type: "movie", tmdbId: 1001 });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.poster, /^\/api\/art\/file\/alpha-movie-poster-\d+\.png$/);
    assert.match(r.json.backdrop, /^\/api\/art\/file\/alpha-movie-backdrop-\d+\.png$/);
    const img = await s.get(r.json.poster);
    assert.equal(img.status, 200);
    assert.equal((await s.get("/api/art")).json["alpha-movie"].tmdbId, 1001);
  });

  test("artwork: automatic match by title (artwork matcher) and its confidence rule", async () => {
    const ok = await s.post("/api/tmdb/match", { id: "beta-film", type: "movie", title: "Beta Film", year: 2005 });
    assert.equal(ok.json.matched, true);
    assert.ok(ok.json.art.poster);
    const no = await s.post("/api/tmdb/match", { id: "zzz", type: "movie", title: "Nothing Like It", year: 2005 });
    assert.equal(no.json.matched, false);
    assert.equal((await s.get("/api/art")).json.zzz, undefined);
  });

  test("artwork: upload replaces the previous file (old file deleted), reset goes back to generated art", async () => {
    const png = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fccf00000301010018dd8db00000000049454e44ae426082", "hex").toString("base64");
    const before = (await s.get("/api/art")).json["alpha-movie"].poster;
    const up = await s.post("/api/art/upload", { id: "alpha-movie", kind: "poster", dataUrl: png });
    assert.equal(up.status, 200, up.text);
    assert.notEqual(up.json.poster, before);
    assert.equal((await s.get(before)).status, 404, "the replaced file is gone");
    assert.equal((await s.get(up.json.poster)).status, 200);
    const reset = await s.post("/api/art/reset", { id: "alpha-movie" });
    assert.deepEqual(reset.json, {});
    assert.equal((await s.get(up.json.poster)).status, 404);
    assert.equal((await s.get("/api/art")).json["alpha-movie"], undefined);
  });

  test("artwork: bad input is refused with a message (wrong kind, not an image, private address)", async () => {
    assert.equal((await s.post("/api/art/upload", { id: "a", kind: "logo", dataUrl: "data:image/png;base64,AA==" })).status, 400);
    const txt = await s.post("/api/art/upload", { id: "a", kind: "poster", dataUrl: "data:text/plain;base64,aGVsbG8=" });
    assert.equal(txt.status, 400);
    assert.match(txt.json.error, /supported image/i);
    assert.equal((await s.post("/api/art/upload", { id: "a", kind: "poster", dataUrl: "not a data url" })).status, 400);
    const lan = await s.post("/api/art/url", { id: "a", kind: "poster", url: `http://127.0.0.1:${s.port}/api/ping` });
    assert.equal(lan.status, 400);
    assert.equal((await s.post("/api/art/url", { id: "a", kind: "poster", url: "file:///etc/passwd" })).status, 400);
    const okUrl = await s.post("/api/art/url", { id: "beta-film", kind: "backdrop", url: "https://image.tmdb.org/t/p/w1280/x.png" });
    assert.equal(okUrl.status, 200, okUrl.text);
    assert.ok(okUrl.json.backdrop);
  });

  test("artwork id with path characters can't write outside the artwork folder", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await s.post("/api/art/upload", { id: "../../escape", kind: "poster", dataUrl: png });
    assert.equal(r.status, 200);
    assert.ok(!fs.readdirSync(s.data).some((f) => f.includes("escape")));
    assert.ok(!fs.readdirSync(path.dirname(s.data)).some((f) => f.includes("escape")));
  });

  test("metadata stays attached to the right title after a rescan with renamed folders", async () => {
    fs.renameSync(path.join(s.media, "Movies/Alpha Movie 2001"), path.join(s.media, "Movies/Alpha Movie (2001)"));
    const lib = await scan(s);
    assert.ok(lib.movies.some((m) => m.id === "alpha-movie"));
    assert.equal((await s.get("/api/meta")).json["alpha-movie"].tmdbId, 1001);
  });
});

describe("TMDB unreachable", { skip: !HAS_FFMPEG }, () => {
  test("fetch fails with a message and the existing metadata is kept", async () => {
    const s = await startCiRoom({ layout: LAYOUT, tmdb: true });
    try {
      await scan(s);
      await s.post("/api/settings", { tmdbKey: "good" });
      await s.post("/api/meta/fetch", { id: "alpha-movie", type: "movie", query: "Alpha Movie", year: 2001 });
      await s.stop({ keep: true });
      const s2 = await startCiRoom({ dir: s.dir, media: s.media, data: s.data, cache: s.cache, tmdb: true, env: { CIROOM_MOCK_OFFLINE: "1" } });
      try {
        const r = await s2.post("/api/meta/fetch", { id: "alpha-movie", type: "movie", query: "Alpha Movie", year: 2001 });
        assert.equal(r.status, 400);
        assert.ok(r.json.error);
        assert.equal((await s2.get("/api/meta")).json["alpha-movie"].tmdbId, 1001);
        assert.equal((await s2.get("/api/library")).status, 200, "the library still loads offline");
      } finally { await s2.stop(); }
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
});
