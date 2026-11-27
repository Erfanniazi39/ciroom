// Functional unit tests of the front-end logic that decides what the user sees and what plays next (areas D, E, G, H,
// M): next-up / next episode / continue watching / recommendations / watched rules / health report / subtitle choice /
// time formats. The real TypeScript modules from src/, bundled for Node by tests/functional/tsload.js.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./tsload.js";

/** @type {any} */ let L, H, U, S, F;
before(async () => {
  [L, H, U, S, F] = await Promise.all(["src/lib/library.ts", "src/lib/health.ts", "src/store/user.ts", "src/store/settings.ts", "src/lib/format.ts"].map(loadTs));
});

const file = (/** @type {string} */ p, extra = {}) => ({ path: p, sizeBytes: 500e6, subtitles: [{ name: "x.srt" }], status: "present", durationSec: 2700, resolution: "720p", ...extra });
const ep = (/** @type {string} */ sid, /** @type {number} */ s, /** @type {number} */ e, f = file(`/lib/${sid}/S${s}E${e}.mkv`), extra = {}) =>
  ({ kind: "episode", id: `${sid}-s${s}e${e}`, seriesId: sid, season: s, number: e, title: `Episode ${e}`, file: f, ...extra });
const series = (/** @type {string} */ id, /** @type {any[][]} */ seasons, extra = {}) => ({
  kind: "series", id, title: id, genres: [], ratings: {}, cast: [], addedAt: "2026-01-01T00:00:00Z", art: { hue: 1 },
  seasons: seasons.map((eps, i) => ({ number: i + 1, episodes: eps })), ...extra,
});
const movie = (/** @type {string} */ id, extra = {}) => ({ kind: "movie", id, title: id, genres: [], ratings: {}, cast: [], addedAt: "2026-01-01T00:00:00Z", art: { hue: 1 }, file: file(`/lib/${id}.mkv`, { durationSec: 6000 }), ...extra });
const prog = (/** @type {number} */ position, /** @type {number} */ duration, watched = false, updatedAt = 1) => ({ position, duration, watched, updatedAt });

describe("next up, next episode, continue watching", () => {
  const show = series("show", [[ep("show", 1, 1), ep("show", 1, 2), ep("show", 1, 3)], [ep("show", 2, 1), { ...ep("show", 2, 2), file: undefined }, ep("show", 2, 3)]]);

  test("nextUp: nothing watched → first episode; one in progress → resume it; finished → the next unwatched", () => {
    assert.deepEqual([L.nextUp(show, {}).episode.id, L.nextUp(show, {}).mode], ["show-s1e1", "start"]);
    assert.deepEqual(Object.values(L.nextUp(show, { "show-s1e2": prog(300, 2700, false, 5) })).map((x) => x.id ?? x), ["show-s1e2", "resume"]);
    const r = L.nextUp(show, { "show-s1e1": prog(2700, 2700, true, 5), "show-s1e2": prog(2700, 2700, true, 6) });
    assert.deepEqual([r.episode.id, r.mode], ["show-s1e3", "next"]);
  });

  test("nextUp: the most recently touched episode decides, across seasons; missing episodes are skipped", () => {
    const r = L.nextUp(show, { "show-s1e1": prog(2700, 2700, true, 10), "show-s2e1": prog(2700, 2700, true, 20) });
    assert.equal(r.episode.id, "show-s2e3", "S2E2 isn't on disk");
    const back = L.nextUp(show, { "show-s2e1": prog(100, 2700, false, 10), "show-s1e1": prog(50, 2700, false, 30) });
    assert.equal(back.episode.id, "show-s1e1", "rewatching an older episode: resume that one");
  });

  test("nextUp: the last episode finished and nothing after it → back to the first, and not in Continue Watching", () => {
    const p = { "show-s2e3": prog(2700, 2700, true, 9) };
    assert.deepEqual([L.nextUp(show, p).episode.id, L.nextUp(show, p).mode], ["show-s1e1", "start"]);
    assert.equal(L.continueWatching({ movies: [], series: [show] }, p).length, 0);
  });

  test("nextEpisode: across a season boundary, over missing episodes, none after the last", () => {
    assert.equal(L.nextEpisode(show, "show-s1e3").id, "show-s2e1");
    assert.equal(L.nextEpisode(show, "show-s2e1").id, "show-s2e3");
    assert.equal(L.nextEpisode(show, "show-s2e3"), null);
    assert.equal(L.nextEpisode(show, "nope"), null);
  });

  test("D-12: after a double episode (one file for E1+E2) Up Next goes to E3, not the same file again", () => {
    const dbl = file("/lib/d/D.S01E01E02.mkv");
    const d = series("d", [[ep("d", 1, 1, dbl), ep("d", 1, 2, dbl), ep("d", 1, 3)]]);
    const next = L.nextEpisode(d, "d-s1e1");
    assert.notEqual(next.file.path, dbl.path, `next after E1 is ${next.id}, the same video file`);
    assert.equal(next.id, "d-s1e3");
    const up = L.nextUp(d, { "d-s1e1": prog(2700, 2700, true, 5) });
    assert.deepEqual([up.episode.id, up.mode], ["d-s1e3", "next"], "Continue Watching doesn't offer the other half");
  });

  test("continueWatching: started movies (> 1 min, not finished) and started series, newest first", () => {
    const lib = { movies: [movie("m1"), movie("m2"), movie("m3"), movie("m4")], series: [show] };
    const items = L.continueWatching(lib, {
      m1: prog(600, 6000, false, 3), m2: prog(30, 6000, false, 9), m3: prog(6000, 6000, true, 8),
      "show-s1e1": prog(2700, 2700, true, 5),
    });
    assert.deepEqual(items.map((i) => i.key), ["show-s1e2", "m1"]);
    assert.equal(items[0].progress.position, 0, "the next episode starts at 0");
  });

  test("D-13: a finished movie watched again and stopped half way shows up in Continue Watching", { todo: "D-13" }, () => {
    U.useUser.setState({ progress: {} });
    U.useUser.getState().savePosition("m1", 5800, 6000); // finished it once (≥ 90 %)
    U.useUser.getState().savePosition("m1", 1200, 6000); // watched again, stopped at 20:00
    const p = U.useUser.getState().progress;
    const items = L.continueWatching({ movies: [movie("m1")], series: [] }, p);
    assert.equal(items.length, 1, `progress is ${JSON.stringify(p.m1)}: still "watched", so it is left out and the watch page starts at 0`);
  });

  test("seriesStatus / seriesProgress count only episodes on disk", () => {
    const all = { "show-s1e1": prog(1, 1, true), "show-s1e2": prog(1, 1, true), "show-s1e3": prog(1, 1, true), "show-s2e1": prog(1, 1, true), "show-s2e3": prog(1, 1, true) };
    assert.deepEqual(L.seriesProgress(show, all), { watched: 5, total: 5, ratio: 1 });
    assert.equal(L.seriesStatus(show, all), "finished");
    assert.equal(L.seriesStatus(show, {}), "not_started");
    assert.equal(L.seriesStatus(show, { "show-s1e1": prog(10, 2700) }), "in_progress");
    assert.equal(L.isWatched(show, all), true);
  });

  test("recommend: genre overlap with favorites/activity, never already watched or the seeds themselves", () => {
    const lib = { movies: [movie("seed", { genres: ["Drama"] }), movie("drama", { genres: ["Drama"] }), movie("action", { genres: ["Action"] }), movie("seen", { genres: ["Drama"] })], series: [] };
    const r = L.recommend(lib, { seen: prog(6000, 6000, true) }, ["seed"]).map((t) => t.id);
    assert.deepEqual(r, ["drama", "action"]);
  });

  test("newEpisodes: aired in the last 30 days and not on disk; the next upcoming one", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const s = series("n", [[ep("n", 1, 1), { ...ep("n", 1, 2), file: undefined, airDate: "2026-11-20" }, { ...ep("n", 1, 3), file: undefined, airDate: "2026-12-03" }, { ...ep("n", 1, 4), file: undefined, airDate: "2025-01-01" }]]);
    const r = L.newEpisodes(s, now);
    assert.deepEqual(r.aired.map((e) => e.number), [2]);
    assert.equal(r.upcoming.number, 3);
    assert.equal(L.daysAgo(r.aired[0], now), 6);
    assert.equal(L.daysUntil(r.upcoming, now), 7);
  });
});

describe("watched rules and saved progress", () => {
  test("isCompleted: ≥ 90 %, or < 3 min left on videos longer than 10 min; never for unknown length", () => {
    assert.equal(U.isCompleted(5400, 6000), true);
    assert.equal(U.isCompleted(5399, 6000), false);
    assert.equal(U.isCompleted(5821, 6000), true, "< 3 min left");
    assert.equal(U.isCompleted(10, 120), false, "a 2-min clip isn't watched at the start");
    assert.equal(U.isCompleted(108, 120), true);
    assert.equal(U.isCompleted(100, 0), false);
  });

  test("savePosition records position, duration, history (newest first, no duplicates, max 200)", () => {
    U.useUser.setState({ progress: {}, history: [] });
    const st = U.useUser.getState();
    st.savePosition("a", 100, 6000); st.savePosition("b", 50, 6000); st.savePosition("a", 200, 6000);
    const s = U.useUser.getState();
    assert.equal(s.progress.a.position, 200);
    assert.deepEqual(s.history.map((h) => h.id), ["a", "b"]);
    for (let i = 0; i < 250; i++) U.useUser.getState().savePosition(`x${i}`, 1, 10);
    assert.equal(U.useUser.getState().history.length, 200);
  });

  test("mark watched / unwatched: watched = position at the end; unwatched = back to 0", () => {
    U.useUser.setState({ progress: {} });
    U.useUser.getState().setWatched(["a", "b"], true, { a: 6000, b: 2700 });
    assert.deepEqual([U.useUser.getState().progress.a.position, U.useUser.getState().progress.a.watched], [6000, true]);
    U.useUser.getState().setWatched(["a"], false);
    assert.deepEqual([U.useUser.getState().progress.a.position, U.useUser.getState().progress.a.watched], [0, false]);
  });

  test("volume is kept between 0 and 130; subtitle delay 0 removes the entry", () => {
    const st = U.useUser.getState();
    st.setVolume(500); assert.equal(U.useUser.getState().volume, 130);
    st.setVolume(-5); assert.equal(U.useUser.getState().volume, 0);
    st.setSubDelay("a", 1.23456); assert.equal(U.useUser.getState().subDelays.a, 1.235);
    st.setSubDelay("a", 0); assert.equal("a" in U.useUser.getState().subDelays, false);
  });

  test("Reset watching data clears progress, history and watch time but keeps favorites and watchlist", () => {
    U.useUser.setState({ favorites: ["f"], watchlist: ["w"], progress: { a: prog(1, 2) }, history: [{ id: "a", at: 1 }], watchLog: { d: { a: 1 } } });
    U.useUser.getState().resetWatching();
    const s = U.useUser.getState();
    assert.deepEqual([s.favorites, s.watchlist, s.progress, s.history, s.watchLog], [["f"], ["w"], {}, [], {}]);
  });

  test("watch time adds up per day and title", () => {
    U.useUser.setState({ watchLog: {} });
    U.useUser.getState().addWatchTime("t", 15); U.useUser.getState().addWatchTime("t", 15.04);
    assert.equal(U.useUser.getState().watchLog[U.dayKey()].t, 30);
  });
});

describe("subtitle choice", () => {
  const subs = [
    { index: 0, label: "English · movie.en", name: "movie.en.srt", language: "English" },
    { index: 1, label: "Persian · movie.fa", name: "movie.fa.srt", language: "Persian" },
    { index: 2, label: "Persian · movie.fa.2", name: "movie.fa.2.srt", language: "Persian" },
  ];
  test("Settings order picks the first matching language; nothing set → the first file; off by default → none", () => {
    assert.equal(S.pickSubtitle(subs, "Persian, English", true), 1);
    assert.equal(S.pickSubtitle(subs, "", true), 0);
    assert.equal(S.pickSubtitle(subs, "Persian", false), -1);
    assert.equal(S.pickSubtitle([], "Persian", true), -1);
  });

  test("remembered choice wins: the same file, else the same language, else Settings; 'off' stays off", () => {
    const prefs = { subtitleLanguages: "English", subtitlesDefault: false };
    assert.equal(S.startSubtitle(subs, { language: "Persian", name: "movie.fa.2.srt" }, prefs), 2);
    assert.equal(S.startSubtitle(subs, { language: "Persian", name: "other.srt" }, prefs), 1);
    assert.equal(S.startSubtitle(subs, { off: true }, prefs), -1);
    assert.equal(S.startSubtitle(subs, { language: "Arabic", name: "x.srt" }, prefs), 0, "a remembered language the episode lacks → Settings order (subtitles on)");
    assert.equal(S.startSubtitle(subs, undefined, prefs), -1, "no memory and 'on by default' off → none");
  });

  test("what is remembered when the user picks a subtitle", () => {
    assert.deepEqual(S.subPrefFor(subs, 1), { language: "Persian", name: "movie.fa.srt" });
    assert.deepEqual(S.subPrefFor(subs, -1), { off: true });
    assert.equal(S.subPrefFor(subs, 9), null);
  });

  test("D-14: a short word in the language order (\"en\") does not pick a French subtitle", { todo: "D-14" }, () => {
    const list = [{ index: 0, label: "French · movie.fr", name: "movie.fr.srt", language: "French" }, { index: 1, label: "English · movie.en", name: "movie.en.srt", language: "English" }];
    assert.equal(S.pickSubtitle(list, "en", true), 1, "\"en\" matched inside \"French\"");
  });
});

describe("library health report", () => {
  test("missing episodes as ranges, duplicates from the scan, low quality, no subtitles (only once facts are read), no details", () => {
    const sd = file("/lib/s/S1E1.mkv", { resolution: "SD" });
    const s = series("s", [[ep("s", 1, 1, sd), { ...ep("s", 1, 2), file: undefined }, { ...ep("s", 1, 3), file: undefined }, ep("s", 1, 4), { ...ep("s", 1, 5), file: undefined }]]);
    const m = movie("m", { file: file("/lib/m.mkv", { subtitles: [], durationSec: 6000, sizeBytes: 100e6 }) });
    const review = [{ id: "d1", kind: "duplicate", path: "Movies/M 2010/m.copy.mkv", detail: "Another copy" }, { id: "e", kind: "empty", path: "Movies/E", detail: "" }];
    const r = H.analyse({ movies: [m], series: [s] }, review, { s: {} }, true);
    assert.deepEqual(r.missingEpisodes.map((x) => x.detail), ["Episodes 2–3, 5 not on disk (3 of 5)"]);
    assert.deepEqual(r.duplicates.map((x) => x.title), ["M 2010 / m.copy.mkv"]);
    assert.deepEqual(r.lowQuality.map((x) => [x.key, x.detail]), [["s-s1e1", "Below 720p"], ["m", "Very low bitrate (0.1 Mbps)"]]);
    assert.deepEqual(r.noSubtitles.map((x) => x.key), ["m"]);
    assert.deepEqual(r.noDetails.map((x) => x.key), ["m"]);
    assert.equal(r.files, 3);
    assert.deepEqual(H.analyse({ movies: [m], series: [] }, [], {}, false).noSubtitles, [], "not judged before the file facts are read");
  });
});

describe("time and size formats", () => {
  test("timecode, remaining, runtime, bytes, plural", () => {
    assert.equal(F.timecode(0), "0:00");
    assert.equal(F.timecode(59.9), "0:59");
    assert.equal(F.timecode(3725), "1:02:05");
    assert.equal(F.runtime(125), "2h 5m");
    assert.equal(F.runtime(undefined), "");
    assert.equal(F.plural(1, "episode"), "1 episode");
    assert.equal(F.plural(2, "episode"), "2 episodes");
    assert.match(F.bytes(1.5e9), /1\.5 GB|1\.4 GB/);
    assert.match(F.remaining(600, 6000), /90 ?min|1h 30m/);
  });
});
