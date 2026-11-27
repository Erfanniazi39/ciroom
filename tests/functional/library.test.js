// Functional: media library management (area B) and series/episode detection (area D) through the real server and a
// real synthetic library on disk. Rescans, renames, removals, stable ids, preserved user data, unavailable drive,
// changing the library folder. Tests marked { todo: "D-xx" } assert the expected behaviour of a confirmed defect
// (docs: the round-1 defect report); they report but don't fail the run.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan, saveUser, userState, scratch } from "./env.js";
import { LAYOUT_FULL, addEntry, makeLibrary, buildClips, HAS_FFMPEG } from "../fixtures/media.js";

const byId = (/** @type {any} */ lib) => new Map([...lib.movies, ...lib.series].map((t) => [t.id, t]));
const review = (/** @type {any} */ lib, /** @type {string} */ kind) => lib.review.filter((r) => r.kind === kind).map((r) => r.path);
const episodes = (/** @type {any} */ s) => s.seasons.map((x) => `S${x.number}:` + x.episodes.map((e) => e.number + (e.file ? "" : "?")).join(","));

describe("first scan of the full test library", { skip: !HAS_FFMPEG }, () => {
  /** @type {any} */ let s, lib;
  before(async () => { s = await startCiRoom({ layout: LAYOUT_FULL }); lib = await scan(s); });
  after(() => s?.stop());

  test("every movie folder with a video becomes exactly one movie, with the right title and year", () => {
    const got = Object.fromEntries(lib.movies.map((m) => [m.title, m.year]));
    assert.deepEqual(got, {
      "Alpha Movie": 2001, "Beta Film": 2005, "Broken Download": 2023, Epsilon: 2018, "Gamma One": 2010, "Gamma Two": 2012, "HEVC Ten": 2021,
      "Name With 'quotes' &": 2020, "Silent Film": 1927, Surround: 2022, "Delta Movie": 2015, "Zeta Twin": 2019, "درباره الی": 2009,
    });
  });

  test("release-style folder names: brackets, resolution and codec words are dropped", () => {
    const beta = lib.movies.find((m) => m.title === "Beta Film");
    assert.equal(beta.year, 2005);
    assert.match(beta.file.path, /beta\.film\.mp4$/);
  });

  test("a folder of movie folders is a collection; a wrapper with one movie is just that movie", () => {
    assert.equal(lib.collections.length, 1);
    const c = lib.collections[0];
    assert.equal(c.name, "Gamma Saga Collection");
    assert.deepEqual(c.movieIds, ["gamma-one", "gamma-two"]);
    for (const id of c.movieIds) assert.equal(lib.movies.find((m) => m.id === id).collectionId, c.id);
    const delta = lib.movies.find((m) => m.title === "Delta Movie");
    assert.equal(delta.collectionId, undefined);
    assert.ok(!lib.collections.some((x) => /Wrapper/.test(x.name)));
  });

  test("cd1/cd2 files are one movie with two parts in order, not a duplicate", () => {
    const e = lib.movies.find((m) => m.title === "Epsilon");
    assert.deepEqual(e.parts.map((p) => path.basename(p.path)), ["Epsilon.2018.cd1.mkv", "Epsilon.2018.cd2.mkv"]);
    assert.ok(!review(lib, "duplicate").some((p) => p.includes("Epsilon")));
  });

  test("two copies of one movie: one movie, the other copy is listed under Needs attention", () => {
    assert.equal(lib.movies.filter((m) => m.title === "Zeta Twin").length, 1);
    assert.deepEqual(review(lib, "duplicate").filter((p) => p.startsWith("Movies/")), ["Movies/Zeta Twin 2019/zeta.copy.mkv"]);
  });

  test("empty folders, loose videos and files without an extension are reported, never shown as titles", () => {
    assert.deepEqual(review(lib, "loose_video"), ["Movies/loose.video.2020.mkv"]);
    assert.ok(review(lib, "empty").includes("Movies/Still Downloading 2024"));
    assert.ok(review(lib, "empty").includes("Series/Empty Series"));
    assert.ok(review(lib, "empty").includes("Movies/Extensionless 2024"), "a video without an extension is not recognised (reported as empty)");
    assert.ok(!lib.movies.some((m) => /Still Downloading|Extensionless|loose/i.test(m.title)));
  });

  test("every movie points at a file that exists inside the library", () => {
    for (const m of lib.movies) {
      assert.ok(m.file.path.startsWith(s.media + path.sep), m.file.path);
      assert.ok(fs.existsSync(m.file.path), m.file.path);
      assert.equal(m.file.sizeBytes, fs.statSync(m.file.path).size);
    }
  });

  test("series: seasons and episodes from folders first, then file names", () => {
    const all = Object.fromEntries(lib.series.map((x) => [x.title, episodes(x)]));
    assert.deepEqual(all, {
      "Abs Show": ["S1:1,2,3"],          // "Abs Show - 001" absolute numbering
      "Double Show": ["S1:1,2,3"],       // S01E01E02 plays as E1 and E2
      "Flat Show": ["S1:1,2,3"],         // SxxEyy and 1x03 in one folder
      "Show One": ["S1:1,2,3?", "S2:1,2?,3"], // EP03 folder empty; S02E02 never on disk
      "Show Two": ["S1:1,2"],            // "S01 E01" folders
      "Zip Show": ["S1:1"],
    });
  });

  test("a file named S01E01 inside the EP02 folder plays as episode 2 and is reported as misplaced", () => {
    const one = lib.series.find((x) => x.title === "Show One");
    const e2 = one.seasons[0].episodes.find((e) => e.number === 2);
    assert.match(e2.file.path, /EP02\/Show\.One\.S01E01\.mkv$/);
    assert.deepEqual(review(lib, "misplaced"), ["Series/Show One/S01/EP02/Show.One.S01E01.mkv"]);
  });

  test("a double episode file is the same file for both episode numbers", () => {
    const d = lib.series.find((x) => x.title === "Double Show").seasons[0].episodes;
    assert.equal(d[0].file.path, d[1].file.path);
    assert.notEqual(d[0].id, d[1].id, "but two ids, so each has its own progress");
  });

  test("a second, smaller video for one episode: the larger plays, the other is listed", () => {
    const e2 = lib.series.find((x) => x.title === "Flat Show").seasons[0].episodes[1];
    assert.match(e2.file.path, /Flat\.Show\.S01E02\.mkv$/);
    assert.ok(review(lib, "duplicate").includes("Series/Flat Show/Flat.Show.S01E02.REPACK.small.mkv"));
  });

  test("episode ids are <series>-s<season>e<episode> and episodes are in order", () => {
    for (const sr of lib.series) for (const se of sr.seasons) {
      const nums = se.episodes.map((e) => e.number);
      assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
      for (const e of se.episodes) { assert.equal(e.id, `${sr.id}-s${se.number}e${e.number}`); assert.equal(e.seriesId, sr.id); assert.equal(e.season, se.number); }
    }
  });

  test("subtitle archives are reported (never extracted)", () => {
    assert.deepEqual(review(lib, "zipped_subtitle"), ["Series/Zip Show/S01/EP01/subs.zip"]);
  });

  test("ids are unique across movies, series and collections", () => {
    const ids = [...lib.movies, ...lib.series, ...lib.collections].map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("a phone gets the library without any file or folder location", async () => {
    // Asked as this PC we get paths; the phone view is checked in tests/security6.test.js. Here: the saved scan is served.
    const r = await s.get("/api/library");
    assert.equal(r.status, 200);
    assert.equal(r.json.movies.length, lib.movies.length);
  });

  test("the scan never changes the library on disk", () => {
    const list = (/** @type {string} */ d) => fs.readdirSync(d, { recursive: true, withFileTypes: false }).map(String).sort();
    const before = list(s.media);
    return scan(s).then(() => assert.deepEqual(list(s.media), before));
  });
});

describe("rescan: add, remove, rename, new episode (scenario 6)", { skip: !HAS_FFMPEG }, () => {
  test("ids stay stable, changes are reported right, user data is untouched", async () => {
    const s = await startCiRoom({ layout: LAYOUT_FULL });
    try {
      const first = await scan(s);
      const ids1 = byId(first);
      // The user watched things, saved favorites, a subtitle delay and a series subtitle choice.
      const state = userState({
        favorites: ["alpha-movie", "show-one"], watchlist: ["beta-film"],
        progress: { "alpha-movie": { position: 120, duration: 600, watched: false, updatedAt: Date.now() }, "show-one-s1e1": { position: 60, duration: 60, watched: true, updatedAt: Date.now() } },
        history: [{ id: "alpha-movie", at: Date.now() }], subDelays: { "show-one-s1e2": 1.5 }, subPrefs: { "show-one": { language: "Persian", name: "x.srt" } },
      });
      await saveUser(s, state);

      // Rename a movie folder and a series folder, remove one movie, add one movie and one episode.
      fs.renameSync(path.join(s.media, "Movies/Alpha Movie 2001"), path.join(s.media, "Movies/Alpha Movie (2001) [720p]"));
      fs.renameSync(path.join(s.media, "Series/Show One"), path.join(s.media, "Series/Show One (2015)"));
      fs.rmSync(path.join(s.media, "Movies/Beta Film (2005) [1080p] BluRay x264"), { recursive: true });
      addEntry(s.media, "Movies/New Arrival 2025/new.arrival.2025.mkv", "short.mkv", s.clips);
      addEntry(s.media, "Series/Show One (2015)/S02/Show.One.S02E02.mkv", "short30.mkv", s.clips);

      const second = await scan(s);
      const ids2 = byId(second);
      assert.ok(ids2.has("alpha-movie"), "renamed movie folder keeps its id");
      assert.equal(ids2.get("alpha-movie").year, 2001);
      assert.ok(ids2.has("show-one"), "renamed series folder keeps its id");
      assert.ok(!ids2.has("beta-film"), "removed movie is gone");
      assert.ok(ids2.has("new-arrival"));
      assert.deepEqual(second.changes.added, ["New Arrival (2025)"]);
      assert.deepEqual(second.changes.removed, ["Beta Film (2005)"]);
      assert.equal(second.changes.newEpisodes, 1);
      assert.deepEqual(episodes(ids2.get("show-one")), ["S1:1,2,3?", "S2:1,2,3"]);
      // Every other id is unchanged.
      for (const id of ids1.keys()) if (id !== "beta-film") assert.ok(ids2.has(id), `id ${id} survived`);

      const u = (await s.get("/api/userdata")).json.user;
      assert.deepEqual(u.favorites, ["alpha-movie", "show-one"]);
      assert.equal(u.progress["alpha-movie"].position, 120);
      assert.equal(u.progress["show-one-s1e1"].watched, true);
      assert.equal(u.subDelays["show-one-s1e2"], 1.5);
      assert.deepEqual(u.subPrefs["show-one"], { language: "Persian", name: "x.srt" });
      assert.deepEqual(u.watchlist, ["beta-film"], "a removed title stays on the list (it comes back with the file)");

      // The removed movie comes back: same id as before (the user's watchlist entry applies again).
      addEntry(s.media, "Movies/Beta Film (2005) [1080p] BluRay x264/beta.film.mp4", "long.mp4", s.clips);
      const third = await scan(s);
      assert.ok(byId(third).has("beta-film"));
      assert.deepEqual(third.changes.added, ["Beta Film (2005)"]);
    } finally { await s.stop(); }
  });

  test("a movie whose folder AND file were renamed keeps its id when the file size matches", async () => {
    const s = await startCiRoom({ layout: { "Movies/Old Name 2010/old.mkv": "short20.mkv" } });
    try {
      assert.ok(byId(await scan(s)).has("old-name"));
      fs.renameSync(path.join(s.media, "Movies/Old Name 2010"), path.join(s.media, "Movies/Completely Different 2010"));
      const lib = await scan(s);
      assert.deepEqual([...byId(lib).keys()], ["old-name"], "same video file (name + size) → same id");
      assert.equal(lib.movies[0].title, "Completely Different");
    } finally { await s.stop(); }
  });

  test("an episode file replaced by a bigger one keeps the episode id and progress key", async () => {
    const s = await startCiRoom({ layout: { "Series/Rep/S01/EP01/a.mkv": "ep60.mkv" } });
    try {
      await scan(s);
      fs.rmSync(path.join(s.media, "Series/Rep/S01/EP01/a.mkv"));
      addEntry(s.media, "Series/Rep/S01/EP01/a.1080p.mkv", "ep67.mkv", s.clips);
      const lib = await scan(s);
      assert.equal(lib.series[0].seasons[0].episodes[0].id, "rep-s1e1");
      assert.match(lib.series[0].seasons[0].episodes[0].file.path, /a\.1080p\.mkv$/);
    } finally { await s.stop(); }
  });

  test("D-01: a non-Latin title that vanished must not hand its id to a different non-Latin title", async () => {
    const s = await startCiRoom({ layout: { "Movies/درباره الی 2009/a.mkv": "short.mkv" } });
    try {
      const a = (await scan(s)).movies[0];
      await saveUser(s, userState({ progress: { [a.id]: { position: 300, duration: 600, watched: true, updatedAt: Date.now() } }, favorites: [a.id] }));
      // The user deletes that film and downloads a different Persian film before the next scan.
      fs.rmSync(path.join(s.media, "Movies/درباره الی 2009"), { recursive: true });
      addEntry(s.media, "Movies/جدایی نادر از سیمین 2011/b.mkv", "short20.mkv", s.clips);
      const b = (await scan(s)).movies[0];
      assert.equal(b.title, "جدایی نادر از سیمین");
      assert.notEqual(b.id, a.id, `the new film got the deleted film's id "${a.id}" (and with it its progress, favorite, artwork and metadata)`);
    } finally { await s.stop(); }
  });

  test("D-01: Persian titles get readable, distinct ids (not 'title', 'title-2', a bare year)", async () => {
    const s = await startCiRoom({ layout: { "Movies/درباره الی 2009/a.mkv": "short.mkv", "Movies/جدایی 2011/b.mkv": "short20.mkv", "Movies/گذشته 2011/c.mkv": "short30.mkv" } });
    try {
      const ids = (await scan(s)).movies.map((m) => m.id).sort();
      assert.equal(new Set(ids).size, 3);
      for (const id of ids) assert.ok(id !== "title" && !/^title-\d+$/.test(id) && !/^\d{4}(-\d+)?$/.test(id), `id "${id}"`);
    } finally { await s.stop(); }
  });

  test("D-02: a remake with the same name must not inherit the old film's id when both have different years", async () => {
    const s = await startCiRoom({ layout: { "Movies/Dune 2021/dune.mkv": "short.mkv" } });
    try {
      const a = (await scan(s)).movies[0];
      fs.rmSync(path.join(s.media, "Movies/Dune 2021"), { recursive: true });
      addEntry(s.media, "Movies/Dune 1984/dune.1984.mkv", "short30.mkv", s.clips);
      const b = (await scan(s)).movies[0];
      assert.equal(b.year, 1984);
      assert.notEqual(b.id, a.id, "Dune (1984) took over Dune (2021)'s id, progress and metadata match");
    } finally { await s.stop(); }
  });
});

describe("unusual names and structures", { skip: !HAS_FFMPEG }, () => {
  test("very long names, Unicode, emoji, spaces and shell characters are scanned and kept exactly", async () => {
    const long = "A".repeat(180) + " 2010";
    const layout = {
      [`Movies/${long}/${"b".repeat(200)}.mkv`]: "short.mkv",
      "Movies/Émilie & Co – l'été 2012/É.mkv": "short20.mkv",
      "Movies/Film 🎬 Night 2013/f.mkv": "short30.mkv",
      "Movies/Shell `touch pwned` $(touch pwned2) 2014/v.mkv": "short.mkv",
      "Series/Série Ü/S01/EP01/ü.mkv": "ep60.mkv",
    };
    const s = await startCiRoom({ layout });
    try {
      const lib = await scan(s);
      const titles = lib.movies.map((m) => m.title).sort();
      assert.equal(titles.length, 4, JSON.stringify(titles));
      assert.ok(titles.includes("Émilie & Co – l'été"));
      assert.ok(titles.includes("Film 🎬 Night"));
      assert.ok(titles.some((t) => t.startsWith("A".repeat(50))));
      assert.ok(titles.some((t) => t.startsWith("Shell")), JSON.stringify(titles));
      assert.ok(!["pwned", "pwned2"].some((f) => fs.existsSync(f) || fs.existsSync(path.join(s.media, f))), "names are never run as commands");
      for (const m of lib.movies) assert.ok(fs.existsSync(m.file.path));
      assert.equal(lib.series[0].title, "Série Ü");
      assert.ok(lib.series[0].seasons[0].episodes[0].file);
    } finally { await s.stop(); }
  });

  test("D-06: a movie folder whose name starts with $ (\"$9.99 2008\") is shown, or at least reported", async () => {
    const s = await startCiRoom({ layout: { "Movies/$9.99 2008/nine.mkv": "short.mkv", "Movies/$RECYCLE.BIN/x.mkv": "short20.mkv" } });
    try {
      const lib = await scan(s);
      const seen = lib.movies.some((m) => m.title.includes("9.99")) || lib.review.some((r) => r.path.includes("9.99"));
      assert.ok(seen, `movies: ${JSON.stringify(lib.movies.map((m) => m.title))}, review: ${JSON.stringify(lib.review.map((r) => r.path))}`);
    } finally { await s.stop(); }
  });

  test("hidden folders, samples and extras are skipped", async () => {
    const s = await startCiRoom({ layout: {
      "Movies/Real 2010/real.mkv": "short30.mkv", "Movies/Real 2010/sample/real-sample.mkv": "short.mkv", "Movies/Real 2010/Extras/making.mkv": "short20.mkv",
      "Movies/.hidden 2010/h.mkv": "short.mkv", "Series/S/S01/EP01/e.mkv": "ep60.mkv", "Series/S/Featurettes/f.mkv": "short.mkv",
    } });
    try {
      const lib = await scan(s);
      assert.deepEqual(lib.movies.map((m) => m.title), ["Real"]);
      assert.deepEqual(review(lib, "duplicate"), [], "a sample/extra is not a duplicate");
      assert.deepEqual(episodes(lib.series[0]), ["S1:1"]);
    } finally { await s.stop(); }
  });

  test("an unreadable folder is skipped without breaking the rest of the scan", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async () => {
    const s = await startCiRoom({ layout: { "Movies/Open 2010/o.mkv": "short.mkv", "Movies/Locked 2011/l.mkv": "short20.mkv" } });
    const locked = path.join(s.media, "Movies/Locked 2011");
    try {
      fs.chmodSync(locked, 0o000);
      const r = await s.post("/api/library/scan");
      assert.equal(r.status, 200);
      assert.ok(r.json.movies.some((m) => m.title === "Open"));
    } finally { fs.chmodSync(locked, 0o755); await s.stop(); }
  });

  test("a library with no Movies/Series content scans to an empty library (no crash)", async () => {
    const s = await startCiRoom({ layout: {} });
    try {
      const lib = await scan(s);
      assert.deepEqual([lib.movies.length, lib.series.length, lib.collections.length], [0, 0, 0]);
      assert.equal(lib.roots.length, 2);
    } finally { await s.stop(); }
  });

  test("a big episode number gap does not create hundreds of empty rows", async () => {
    const s = await startCiRoom({ layout: { "Series/Gap/Gap.S01E01.mkv": "ep60.mkv", "Series/Gap/Gap.S01E500.mkv": "ep61.mkv" } });
    try {
      const eps = (await scan(s)).series[0].seasons[0].episodes.map((e) => e.number);
      assert.deepEqual(eps, [1, 500]);
    } finally { await s.stop(); }
  });
});

describe("library folder unavailable or changed", { skip: !HAS_FFMPEG }, () => {
  test("D-03: a scan while the drive is unplugged must not replace the library with an empty one", async () => {
    const dir = scratch("unplug");
    const s = await startCiRoom({ dir, layout: { "Movies/Keep 2010/k.mkv": "short.mkv", "Series/Keep S/S01/EP01/e.mkv": "ep60.mkv" } });
    try {
      assert.equal((await scan(s)).movies.length, 1);
      const moved = s.media + "-unplugged";
      fs.renameSync(s.media, moved); // the drive is gone
      const r = await s.post("/api/library/scan");
      fs.renameSync(moved, s.media);
      const lib = (await s.get("/api/library")).json;
      assert.ok(r.status !== 200 || r.json.roots.every((x) => x.online === false), "the answer says the folders are offline");
      assert.equal(lib.movies.length, 1, `after a scan with the drive missing the saved library has ${lib.movies.length} movies and ${lib.series.length} series`);
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("after the drive comes back, a scan restores every title with the same id", async () => {
    const dir = scratch("unplug2");
    const s = await startCiRoom({ dir, layout: { "Movies/Keep 2010/k.mkv": "short.mkv", "Series/Keep S/S01/EP01/e.mkv": "ep60.mkv" } });
    try {
      const before = [...byId(await scan(s)).keys()].sort();
      const moved = s.media + "-unplugged";
      fs.renameSync(s.media, moved);
      await s.post("/api/library/scan");
      fs.renameSync(moved, s.media);
      const after = [...byId(await scan(s)).keys()].sort();
      assert.deepEqual(after, before);
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("with no saved scan and the drive unplugged: nothing is saved, and the library appears once it is back", async () => {
    const dir = scratch("unplug3");
    const s = await startCiRoom({ dir, layout: { "Movies/Keep 2010/k.mkv": "short.mkv" } });
    const moved = s.media + "-unplugged";
    try {
      fs.renameSync(s.media, moved);
      const offline = await s.get("/api/library");
      assert.equal(offline.status, 200);
      assert.deepEqual([offline.json.movies.length, offline.json.roots.map((x) => x.online)], [0, [false, false]]);
      const r = await s.post("/api/library/scan");
      assert.equal(r.status, 409);
      assert.match(r.json.error, /Library folder not found/);
      assert.ok(!fs.readdirSync(s.data).some((f) => /^(library(-windows)?|ids)\.json$/.test(f)), "nothing saved from a missing folder");
      fs.renameSync(moved, s.media);
      assert.deepEqual((await s.get("/api/library")).json.movies.map((m) => m.title), ["Keep"]);
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("a library with only one of Movies/Series still scans", async () => {
    const s = await startCiRoom({ layout: { "Movies/Keep 2010/k.mkv": "short.mkv" } });
    try {
      fs.rmSync(path.join(s.media, "Series"), { recursive: true, force: true });
      const r = await s.post("/api/library/scan");
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.movies.length, r.json.roots.map((x) => x.online)], [1, [true, false]]);
    } finally { await s.stop(); }
  });

  test("Settings → Library folder: a folder without Movies/Series is refused; a good one is saved for the next start", async () => {
    const dir = scratch("root");
    const s = await startCiRoom({ dir, layout: { "Movies/A 2010/a.mkv": "short.mkv" } });
    try {
      const bad = path.join(dir, "nothing-here"); fs.mkdirSync(bad);
      assert.equal((await s.post("/api/media-root", { path: bad })).status, 400);
      assert.equal((await s.post("/api/media-root", { path: "" })).status, 400);
      assert.equal((await s.post("/api/media-root", { path: path.join(dir, "missing") })).status, 400);
      const other = makeLibrary(path.join(dir, "lib2"), { "Movies/B 2011/b.mkv": "short20.mkv" }, await buildClips());
      const r = await s.post("/api/media-root", { path: other });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { saved: other, restart: true });
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.data, "local.json"), "utf8")).mediaRoot, other, "written to local.json for the next start");
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("D-05: Settings shows the newly saved library folder when reopened (before the restart)", async () => {
    const dir = scratch("root2");
    const s = await startCiRoom({ dir, layout: { "Movies/A 2010/a.mkv": "short.mkv" } });
    try {
      const other = makeLibrary(path.join(dir, "lib2"), { "Movies/B 2011/b.mkv": "short20.mkv" }, await buildClips());
      assert.equal((await s.post("/api/media-root", { path: other })).status, 200);
      assert.equal((await s.get("/api/media-root")).json.saved, other, "GET /api/media-root still reports the folder saved at start-up");
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("D-04: after switching the library folder and restarting, the library shows the NEW folder's titles", async () => {
    const dir = scratch("switch");
    const clips = await buildClips();
    const a = makeLibrary(path.join(dir, "libA"), { "Movies/Only In A 2010/a.mkv": "short.mkv" }, clips);
    const b = makeLibrary(path.join(dir, "libB"), { "Movies/Only In B 2011/b.mkv": "short20.mkv" }, clips);
    const data = path.join(dir, "data");
    let s = await startCiRoom({ dir, media: a, data });
    try {
      await scan(s);
      assert.equal((await s.post("/api/media-root", { path: b })).status, 200);
      await s.stop({ keep: true });
      // Restart as the app does: the saved folder is used (no CIROOM_MEDIA_ROOT).
      s = await startCiRoom({ dir, media: b, data, env: { CIROOM_MEDIA_ROOT: "" } });
      assert.equal((await s.get("/api/media-root")).json.current, b);
      const titles = (await s.get("/api/library")).json.movies.map((m) => m.title);
      assert.deepEqual(titles, ["Only In B"], `library after the switch: ${JSON.stringify(titles)}`);
    } finally { await s.stop({ keep: true }); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
