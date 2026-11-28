// End-to-end integration: the real built window (Chrome) ↔ real server ↔ SQLite ↔ ffmpeg, across failures between them:
// a data folder that turns read-only, the server crashing and coming back while the window stays open, and the page
// player switching videos faster than streams can start. Needs: npm run build, ffmpeg, Chrome/Chromium.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan, until, sleep, scratch, userState, saveUser } from "../functional/env.js";
import { HAS_FFMPEG } from "../fixtures/media.js";
import { launch, CHROME } from "./browser.js";
import { setReadOnly, streamsOf } from "../integration/procs.js";

const root = path.resolve(import.meta.dirname, "../..");
const skip = !HAS_FFMPEG || !CHROME || !fs.existsSync(path.join(root, "dist/index.html")) || process.platform !== "linux";
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;
const LAYOUT = { "Movies/Alpha Movie 2001/a.mkv": "long.mkv", "Movies/Beta Film 2005/b.mkv": "long.mp4" };
const page = (/** @type {any} */ b, /** @type {string} */ url, /** @type {string} */ text) => b.goto(url).then(() => b.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, 20000));

describe("window ↔ server ↔ database: a data folder that turns read-only", { skip: skip || ROOT_USER }, () => {
  test("D-22: a window opened while the data folder is read-only still shows the saved progress and lists", async () => {
    const dir = scratch("e2e-ro");
    let s = await startCiRoom({ dir, layout: LAYOUT });
    await scan(s);
    await saveUser(s, userState({ favorites: ["alpha-movie"], progress: { "alpha-movie": { position: 200, duration: 600, watched: false, updatedAt: Date.now() } } }));
    await s.stop({ keep: true });
    setReadOnly(s.data, true);
    let b;
    try {
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache });
      b = await launch({ dir: path.join(dir, "fresh-window") }); // e.g. the installed app's first start, or another port
      await page(b, `http://127.0.0.1:${s.port}/#/movies/alpha-movie`, "Alpha Movie");
      await sleep(1000);
      assert.ok((await b.text()).includes("Resume"), "the 3:20 saved for Alpha Movie is not shown");
    } finally { await b?.close(); setReadOnly(s.data, false); await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("D-22: what is watched while the folder is read-only is not lost once it is writable again", async () => {
    const dir = scratch("e2e-ro2");
    let s = await startCiRoom({ dir, layout: LAYOUT });
    await scan(s);
    await saveUser(s, userState());
    const port = s.port;
    await s.stop({ keep: true });
    setReadOnly(s.data, true);
    const win = path.join(dir, "window");
    let b;
    try {
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, port });
      b = await launch({ dir: win });
      await b.goto(`http://127.0.0.1:${port}/#/watch/beta-film?t=120`);
      await b.waitFor(`(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 123; })()`, 20000);
      await sleep(1500);
      await b.key(" ", "Space", 32);
      await b.waitFor(`document.querySelector("video").paused`);
      await sleep(1500);
      await b.goto(`http://127.0.0.1:${port}/#/`);
      await sleep(800);
      await b.close(); b = null;
      await s.stop({ keep: true });
      setReadOnly(s.data, false);
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, port });
      b = await launch({ dir: win }); // the same window as before
      await page(b, `http://127.0.0.1:${port}/#/movies/beta-film`, "Beta Film");
      await sleep(1500);
      const db = (await s.get("/api/userdata")).json.user.progress["beta-film"];
      assert.ok(db || (await b.text()).includes("Resume"), "the ~2:05 watched on Beta Film is gone from the database and the window");
    } finally { await b?.close(); try { setReadOnly(s.data, false); } catch { /* already */ } await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("window ↔ server: the server crashes and comes back while the window stays open", { skip }, () => {
  test("a change made while it is down reaches the database with the next change after it is back (whole state, nothing lost)", async () => {
    const dir = scratch("e2e-down");
    let s = await startCiRoom({ dir, layout: LAYOUT });
    await scan(s);
    await saveUser(s, userState());
    const b = await launch({ dir: path.join(dir, "w") });
    try {
      await page(b, `http://127.0.0.1:${s.port}/#/movies/alpha-movie`, "Alpha Movie");
      await sleep(800);
      await s.stop({ keep: true, signal: "SIGKILL" });
      await b.click("Add to favorites");
      await sleep(1000);
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, port: s.port });
      await b.click("Add to watchlist");
      const u = await until(async () => { const x = (await s.get("/api/userdata")).json.user; return x.watchlist.length && x; }, 5000);
      assert.deepEqual(u.favorites, ["alpha-movie"]);
      assert.deepEqual(u.watchlist, ["alpha-movie"]);
    } finally { await b.close(); await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("D-25: a change made while it is down reaches the database once it is back, even with no further change", { todo: "D-25" }, async () => {
    const dir = scratch("e2e-down2");
    let s = await startCiRoom({ dir, layout: LAYOUT });
    await scan(s);
    await saveUser(s, userState());
    const b = await launch({ dir: path.join(dir, "w") });
    try {
      await page(b, `http://127.0.0.1:${s.port}/#/movies/alpha-movie`, "Alpha Movie");
      await sleep(800);
      await s.stop({ keep: true, signal: "SIGKILL" });
      await b.click("Add to favorites");
      await sleep(1000);
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, port: s.port });
      await until(async () => (await s.get("/api/userdata")).json.user.favorites.length > 0, 8000);
    } finally { await b.close(); await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("D-24: while the server is down the window says so (instead of silently doing nothing)", { todo: "D-24" }, async () => {
    const dir = scratch("e2e-down3");
    const s = await startCiRoom({ dir, layout: LAYOUT });
    await scan(s);
    await saveUser(s, userState());
    const b = await launch({ dir: path.join(dir, "w") });
    try {
      await page(b, `http://127.0.0.1:${s.port}/#/movies/alpha-movie`, "Alpha Movie");
      await sleep(800);
      await s.stop({ keep: true, signal: "SIGKILL" });
      await b.click("Add to favorites");
      await b.click("Play");
      await b.waitFor(`/can't reach|cannot reach|not running|offline|connection|stopped/i.test(document.body.innerText)`, 15000);
    } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("window ↔ page player ↔ stream ↔ ffmpeg: switching faster than streams start", { skip }, () => {
  test("18 switches between 4 videos in ~5 s: one ffmpeg left, the last video plays from its own start time, progress only for what was really watched", async () => {
    const s = await startCiRoom({ layout: { ...LAYOUT, "Series/Show/S01/Show.S01E01.mkv": "ep60.mkv", "Series/Show/S01/Show.S01E02.mkv": "ep61.mkv" } });
    const lib = await scan(s);
    await saveUser(s, userState());
    const ep = lib.series[0].seasons[0].episodes.map((/** @type {any} */ e) => e.id);
    const b = await launch({ dir: path.join(s.dir, "w") });
    try {
      await page(b, `http://127.0.0.1:${s.port}/#/`, "Alpha Movie");
      const seq = ["alpha-movie?t=100", "beta-film?t=300", `${ep[0]}?t=10`, "alpha-movie?t=100", `${ep[1]}?t=20`, "beta-film?t=300"];
      let most = 0;
      const watch = setInterval(() => { most = Math.max(most, streamsOf(s.child.pid).length); }, 50);
      for (let r = 0; r < 3; r++) for (const w of seq) { await b.eval(`location.hash = "#/watch/${w}"`); await sleep(120 + (r * 37 + w.length * 13) % 200); }
      await b.waitFor(`(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 301 && v.currentTime < 330; })()`, 30000);
      clearInterval(watch);
      await sleep(1500);
      assert.equal(streamsOf(s.child.pid).length, 1, "only the playing video's ffmpeg");
      await b.key(" ", "Space", 32);
      await b.waitFor(`document.querySelector("video").paused`);
      const p = await until(async () => { const x = (await s.get("/api/userdata")).json.user.progress; return x["beta-film"] && x; }, 8000);
      assert.ok(p["beta-film"].position > 300 && p["beta-film"].position < 340, `beta ${p["beta-film"].position}`);
      for (const [id, v] of Object.entries(p)) if (id !== "beta-film") assert.ok(Math.abs(/** @type {any} */ (v).position - 300) > 30, `${id} got Beta's position (${/** @type {any} */ (v).position})`);
      assert.ok(most <= 8, `at most ${most} streams ran at once`);
    } finally { await b.close(); await s.stop(); }
  });

  test("D-30: switching videos doesn't throw uncaught errors in the page", { todo: "D-30" }, async () => {
    const s = await startCiRoom({ layout: LAYOUT });
    await scan(s);
    await saveUser(s, userState());
    const b = await launch({ dir: path.join(s.dir, "w") });
    try {
      await page(b, `http://127.0.0.1:${s.port}/#/`, "Alpha Movie");
      for (let i = 0; i < 8; i++) { await b.eval(`location.hash = "#/watch/${i % 2 ? "beta-film" : "alpha-movie"}?t=${50 + i}"`); await sleep(250); }
      await sleep(1500);
      const thrown = b.console.filter((/** @type {string} */ l) => l.startsWith("exception:"));
      assert.deepEqual(thrown, []);
    } finally { await b.close(); await s.stop(); }
  });
});
