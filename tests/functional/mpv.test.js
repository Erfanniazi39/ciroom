// Functional: the full player (area F, mpv) with the REAL mpv, forced to --vo=null --ao=null by a wrapper (no window,
// no sound; see env.js). Start position, pause/seek/volume/speed/tracks through /api/player/cmd, remembered subtitle
// and audio choices, stop, an mpv that dies, restart, broken and missing files.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan, until, sleep } from "./env.js";
import { LAYOUT_FULL, HAS_FFMPEG, HAS_MPV } from "../fixtures/media.js";

const skip = !HAS_FFMPEG || !HAS_MPV || process.platform === "win32";

describe("full player (real mpv, no window)", { skip }, () => {
  /** @type {any} */ let s, lib;
  const file = (/** @type {string} */ title) => lib.movies.find((m) => m.title === title).file.path;
  const snap = async () => (await s.get("/api/player")).json;
  const cmd = (/** @type {any} */ c) => s.post("/api/player/cmd", c);
  const playing = (/** @type {number} */ min = 0) => until(async () => { const p = await snap(); return p.running && p.duration > 0 && p.position >= min && p; }, 20000);
  const mpvPid = () => { for (const pid of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) { try { const c = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); if (c.includes(`--input-ipc-server=${path.join(s.dir, "run")}`)) return Number(pid); } catch { /* gone */ } } return null; };
  before(async () => { s = await startCiRoom({ layout: LAYOUT_FULL, mpv: true }); lib = await scan(s); });
  after(async () => { await cmd({ cmd: "stop" }).catch(() => {}); await s?.stop(); });

  test("dry run resolves the file without starting mpv", async () => {
    const r = await s.post("/api/play", { path: file("Alpha Movie"), dryRun: true });
    assert.deepEqual(r.json, { ok: true, file: file("Alpha Movie") });
    assert.equal((await snap()).running, false);
  });

  test("starts at the requested position, with every audio and subtitle track", async () => {
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 120, itemId: "alpha-movie", volume: 0 });
    const p = await playing(120);
    assert.ok(p.position < 130, `position ${p.position}`);
    assert.equal(Math.round(p.duration), 600);
    assert.equal(p.audio.length, 2);
    assert.deepEqual(p.audio.map((a) => a.lang), ["eng", "fre"]);
    assert.ok(p.subtitles.length >= 6, `${p.subtitles.length} subtitle tracks`);
    const sel = p.subtitles.find((t) => t.selected);
    assert.ok(sel, "a subtitle is on by default (English preferred)");
    assert.equal(sel.language, "English");
  });

  test("pause freezes the position; pause again resumes", async () => {
    await cmd({ cmd: "pause" });
    const a = await until(async () => { const p = await snap(); return p.paused && p; });
    await sleep(800);
    const b = await snap();
    assert.ok(Math.abs(b.position - a.position) < 0.2, `${a.position} → ${b.position}`);
    await cmd({ cmd: "pause" });
    await until(async () => { const p = await snap(); return !p.paused && p.position > b.position + 0.3; });
  });

  test("seek absolute and relative", async () => {
    await cmd({ cmd: "seek", value: 300 });
    await until(async () => { const p = await snap(); return p.position >= 299 && p.position < 305; });
    await cmd({ cmd: "seek-rel", value: -10 });
    await until(async () => { const p = await snap(); return p.position >= 289 && p.position < 295; });
  });

  test("volume, mute and speed are applied by mpv (confirmed back from mpv, not just echoed)", async () => {
    await cmd({ cmd: "set", name: "volume", value: 55 });
    await cmd({ cmd: "set", name: "mute", value: true });
    await cmd({ cmd: "set", name: "speed", value: 1.5 });
    await sleep(400);
    const p = await snap();
    assert.equal(p.volume, 55); assert.equal(p.muted, true); assert.equal(p.speed, 1.5);
    const t0 = p.position; await sleep(2000);
    const moved = (await snap()).position - t0;
    assert.ok(moved > 2.4 && moved < 3.8, `1.5× speed: moved ${moved.toFixed(2)} s in 2 s`);
    await cmd({ cmd: "set", name: "speed", value: 1 });
  });

  test("audio and subtitle tracks can be switched while playing", async () => {
    await cmd({ cmd: "set", name: "aid", value: 2 });
    await until(async () => (await snap()).audio.find((a) => a.selected)?.lang === "fre");
    const fa = (await snap()).subtitles.find((t) => t.language === "Persian" && t.external);
    await cmd({ cmd: "set", name: "sid", value: fa.id });
    await until(async () => (await snap()).subtitles.find((t) => t.selected)?.id === fa.id);
    await cmd({ cmd: "set", name: "sid", value: false });
    await until(async () => !(await snap()).subtitles.some((t) => t.selected));
  });

  test("an unknown command or property is refused", async () => {
    assert.equal((await cmd({ cmd: "explode" })).status, 400);
    assert.equal((await cmd({ cmd: "set", name: "screenshot-directory", value: "/tmp" })).status, 400);
  });

  test("stop closes mpv; with no window open the server keeps mpv's last position for the next start", async () => {
    await cmd({ cmd: "seek", value: 250 });
    await until(async () => { const p = await snap(); return p.position >= 249; });
    await cmd({ cmd: "stop" });
    await until(async () => !(await snap()).running);
    await until(() => !mpvPid(), 5000);
    const pending = JSON.parse(fs.readFileSync(path.join(s.data, "phone-pending.json"), "utf8"));
    const e = pending["alpha-movie"] ?? Object.values(pending)[0];
    assert.ok(e, JSON.stringify(pending));
    assert.ok(e.position >= 249 && e.position < 260, JSON.stringify(e));
  });

  test("D-11: remembered subtitle choice picks the chosen file even when another subtitle file in the folder can't be read", async () => {
    const name = "Alpha.Movie.2001.fa.srt";
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 10, volume: 0, subPref: { language: "Persian", name } });
    await playing(10);
    const sel = await until(async () => (await snap()).subtitles.find((t) => t.selected));
    assert.equal(sel.label, name, `selected: ${sel.label ?? sel.title ?? sel.lang}`);
  });

  test("a remembered built-in subtitle is picked among the built-in tracks, even with a file of the same language", async () => {
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 10, volume: 0, subPref: { language: "Persian", name: "embedded:1:per" } });
    await playing(10);
    const sel = await until(async () => (await snap()).subtitles.find((t) => t.selected));
    assert.deepEqual([sel.external, sel.lang], [false, "per"], JSON.stringify(sel));
  });

  test("remembered 'subtitles off' starts with no subtitle; remembered audio language picks that track", async () => {
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 10, volume: 0, subPref: { off: true }, audioLang: "fre" });
    const p = await playing(10);
    assert.ok(!p.subtitles.some((t) => t.selected));
    assert.equal(p.audio.find((a) => a.selected)?.lang, "fre");
  });

  test("an mpv that dies unexpectedly: the server notices, keeps the position, and the next play works", async () => {
    await s.post("/api/play", { path: file("Beta Film"), startAt: 200, volume: 0, itemId: "beta-film" });
    await playing(203); // a few seconds of play (positions that moved less than 1 s since the last save are not re-saved)
    const pid = await until(() => mpvPid());
    process.kill(pid, "SIGKILL");
    await until(async () => !(await snap()).running, 5000);
    const pending = JSON.parse(fs.readFileSync(path.join(s.data, "phone-pending.json"), "utf8"));
    assert.ok(pending["beta-film"]?.position >= 199, JSON.stringify(pending));
    await s.post("/api/play", { path: file("Beta Film"), startAt: 50, volume: 0 });
    const p = await playing(50);
    assert.ok(p.position < 60);
    await cmd({ cmd: "stop" });
    await until(async () => !(await snap()).running);
  });

  test("a multi-part movie (cd1 + cd2) is one mpv playlist", async () => {
    await s.post("/api/play", { path: file("Epsilon"), volume: 0 });
    await playing(0);
    const pid = await until(() => mpvPid());
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    assert.ok(args.some((a) => a.endsWith("Epsilon.2018.cd1.mkv")) && args.some((a) => a.endsWith("Epsilon.2018.cd2.mkv")));
    assert.ok(args.findIndex((a) => a.endsWith("cd1.mkv")) < args.findIndex((a) => a.endsWith("cd2.mkv")));
    await cmd({ cmd: "stop" });
    await until(async () => !(await snap()).running);
  });

  test("a corrupted file: mpv exits by itself and the player reports not running (no hang)", async () => {
    await s.post("/api/play", { path: file("Broken Download"), volume: 0 });
    await until(async () => !(await snap()).running, 15000);
  });

  test("paths outside the library are refused; commands with mpv closed don't break anything", async () => {
    assert.equal((await s.post("/api/play", { path: "/etc/hosts" })).status, 400);
    assert.equal((await cmd({ cmd: "pause" })).status, 200);
    assert.equal((await snap()).running, false);
  });

  test("D-17: a command sent right after the full player starts is not lost", async () => {
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 30, volume: 0 });
    const r = await cmd({ cmd: "pause" }); // e.g. the phone's pause pressed at once
    assert.equal(r.status, 200);
    const p = await playing(30);
    await sleep(500);
    const now = await snap();
    await cmd({ cmd: "stop" });
    await until(async () => !(await snap()).running);
    assert.equal(now.paused, true, `answered ok but mpv kept playing (position ${p.position.toFixed(1)} → ${now.position.toFixed(1)})`);
  });

  test("D-17: a seek and a volume change sent while mpv is starting are applied in order", async () => {
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 30, volume: 0 });
    for (const c of [{ cmd: "seek", value: 200 }, { cmd: "seek-rel", value: 100 }, { cmd: "set", name: "volume", value: 40 }])
      assert.deepEqual((await cmd(c)).json, { ok: true, queued: true });
    const p = await playing(300);
    assert.ok(p.position < 310, `position ${p.position}`);
    await until(async () => (await snap()).volume === 40);
    assert.deepEqual((await cmd({ cmd: "pause" })).json, { ok: true });
    await cmd({ cmd: "stop" });
    await until(async () => !(await snap()).running);
  });

  test("starting a second title replaces the first (one mpv at a time)", async () => {
    await s.post("/api/play", { path: file("Alpha Movie"), startAt: 5, volume: 0 });
    await playing(5);
    await s.post("/api/play", { path: file("Beta Film"), startAt: 30, volume: 0 });
    await until(async () => { const p = await snap(); return p.running && p.file.includes("beta") && p.position >= 30; });
    const count = () => fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x)).filter((pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(`--input-ipc-server=${path.join(s.dir, "run")}`); } catch { return false; } }).length;
    await until(() => count() === 1, 5000); // the old mpv gets quit + SIGTERM and is gone within moments
    await cmd({ cmd: "stop" });
  });
});

describe("full player: remembered subtitle choice", { skip }, () => {
  test("the chosen subtitle file is selected at start (folder with readable subtitles only)", async () => {
    const s = await startCiRoom({ mpv: true, layout: {
      "Movies/Alpha Movie 2001/Alpha.Movie.2001.mkv": "long.mkv", "Movies/Alpha Movie 2001/Alpha.Movie.2001.en.srt": "en.srt",
      "Movies/Alpha Movie 2001/Alpha.Movie.2001.fa.srt": "fa-cp1256.srt", "Movies/Alpha Movie 2001/Alpha.Movie.2001.zz.ass": "styled.ass" } });
    try {
      const f = (await scan(s)).movies[0].file.path;
      await s.post("/api/play", { path: f, startAt: 10, volume: 0, subPref: { language: "Persian", name: "Alpha.Movie.2001.fa.srt" } });
      const sel = await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.subtitles.find((t) => t.selected); }, 15000);
      assert.equal(sel.label, "Alpha.Movie.2001.fa.srt");
      // A remembered language whose file isn't there any more: a built-in track of that language is used.
      await s.post("/api/play", { path: f, startAt: 10, volume: 0, subPref: { language: "Persian", name: "gone.srt" } });
      const sel2 = await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.subtitles.find((t) => t.selected); }, 15000);
      assert.equal(sel2.language, "Persian");
    } finally { await s.post("/api/player/cmd", { cmd: "stop" }).catch(() => {}); await s.stop(); }
  });
});
