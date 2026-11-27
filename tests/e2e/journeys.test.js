// End-to-end user journeys: the real built app (dist/) served by the real server, driven in headless Chrome like a user
// (clicks, keys, the seek bar), on the synthetic library; the full player is the real mpv without a window or sound.
// Needs: npm run build, ffmpeg, Chrome/Chromium (mpv for the full-player journey). Run: npm run test:e2e
// The installed app's own engine (WebKitGTK) is covered by the playback-engine test round, not here.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, until, sleep, scratch } from "../functional/env.js";
import { LAYOUT_FULL, HAS_FFMPEG, HAS_MPV, addEntry } from "../fixtures/media.js";
import { launch, CHROME } from "./browser.js";

const root = path.resolve(import.meta.dirname, "../..");
const skip = !HAS_FFMPEG || !CHROME || !fs.existsSync(path.join(root, "dist/index.html"));
const progressOf = async (/** @type {any} */ s, /** @type {string} */ id) => (await s.get("/api/userdata")).json.user?.progress?.[id];
/** Click the seek bar at a fraction of its width (a real mouse click). */
async function seekBarTo(/** @type {any} */ b, /** @type {number} */ frac) {
  await b.eval(`document.querySelector("video")?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`);
  const r = await b.waitFor(`(() => { const e = document.querySelector('[aria-label="Seek"]'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 ? { x: r.left, y: r.top + r.height / 2, w: r.width } : null; })()`);
  await b.mouse(r.x + r.w * frac, r.y);
}
const playingAt = (/** @type {any} */ b, /** @type {number} */ min, /** @type {number} */ max = 1e9) =>
  b.waitFor(`(() => { const v = document.querySelector("video"); return v && !v.paused && v.readyState >= 3 && v.currentTime >= ${min} && v.currentTime <= ${max} && v.currentTime; })()`, 20000);

describe("end-to-end journeys (real app in Chrome)", { skip }, () => {
  /** @type {any} */ let s, b, base;
  const dir = scratch("e2e");
  /** @type {string[]} */ const profiles = [];
  const restart = async () => {
    await b?.close(); await s.stop({ keep: true });
    s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, mpv: HAS_MPV });
    base = `http://127.0.0.1:${s.port}`;
    profiles.push(scratch("e2e-profile"));
    b = await launch({ dir: profiles.at(-1) }); // a new window (fresh browser storage: only the server's data counts)
  };
  before(async () => {
    s = await startCiRoom({ dir, layout: LAYOUT_FULL, mpv: HAS_MPV });
    base = `http://127.0.0.1:${s.port}`;
    b = await launch({ dir });
  });
  after(async () => {
    await b?.close(); await s?.post("/api/player/cmd", { cmd: "stop" }).catch(() => {}); await s?.stop({ keep: true });
    for (const d of [dir, ...profiles]) fs.rmSync(d, { recursive: true, force: true });
  });

  test("journey 1: a new user finds a movie, plays, jumps ahead, pauses, closes CiRoom; after a restart Resume continues there", async () => {
    await b.goto(base + "/");
    await b.waitFor(`document.body.innerText.includes("Recently Added")`, 20000); // first start: the library is scanned by itself
    assert.ok((await b.text()).includes("Alpha Movie"));
    await b.goto(base + "/#/movies/alpha-movie");
    await b.click("Play");
    await b.waitFor(`location.hash === "#/watch/alpha-movie"`);
    await playingAt(b, 0.5);
    await seekBarTo(b, 1 / 3); // ≈ 3:20
    const t = await playingAt(b, 190, 215);
    await sleep(1500);
    await b.key(" ", "Space", 32);
    await b.waitFor(`document.querySelector("video").paused`);
    const at = (await b.video()).t;
    const saved = await until(async () => { const p = await progressOf(s, "alpha-movie"); return p && Math.abs(p.position - at) < 2 && p; }, 8000);
    assert.ok(saved.position > t - 1, `saved ${saved.position}, paused at ${at}`);
    await restart();
    await b.goto(base + "/#/movies/alpha-movie");
    const label = await b.waitFor(`[...document.querySelectorAll("button")].map((x) => x.innerText).find((x) => /Resume/.test(x))`);
    const [, m, sec] = label.match(/(\d+):(\d\d)/);
    assert.ok(Math.abs(Number(m) * 60 + Number(sec) - saved.position) <= 1, `button "${label}" vs saved ${saved.position}`);
    await b.click("Resume");
    const resumed = await playingAt(b, saved.position - 3, saved.position + 6);
    assert.ok(resumed > 0);
  });

  test("journey 2: a series — subtitles on by default, C turns them off and on (remembered for the series), near the end Up Next plays the next episode by itself; the first is watched", async () => {
    await b.goto(base + "/#/series/show-one");
    await b.waitFor(`document.body.innerText.includes("Show One")`);
    await b.goto(base + "/#/watch/show-one-s2e1"); // the season-2 episode that has an English subtitle file
    await playingAt(b, 0.2);
    await b.waitFor(`document.body.innerText.includes("Hello, how are you? #") || /#\\d+/.test(document.body.innerText)`, 10000); // on by default (Settings)
    await b.key("c", "KeyC", 67);
    await until(async () => (await s.get("/api/userdata")).json.user.subPrefs["show-one"]?.off === true);
    await sleep(500);
    assert.ok(!(await b.eval(`/(you\\?|want\\.|place\\.|it\\?|then\\.) #\\d+/.test(document.body.innerText)`)), "no subtitle text after C");
    await b.key("c", "KeyC", 67);
    const pref = await until(async () => { const p = (await s.get("/api/userdata")).json.user.subPrefs["show-one"]; return p && !p.off && p; });
    assert.equal(pref.language, "English", "the choice is remembered for the series");
    await seekBarTo(b, 0.9); // the episode is 62 s: the Up Next card shows in the last 15 s
    await b.waitFor(`/up next/i.test(document.body.innerText)`, 15000);
    await b.waitFor(`location.hash.startsWith("#/watch/show-one-s2e3")`, 30000); // E2 isn't on disk: the next one on disk is E3
    const p1 = await until(() => progressOf(s, "show-one-s2e1"));
    assert.equal(p1.watched, true);
    await playingAt(b, 0.1);
  });

  test("journey 3: page player → full player (mpv) at the same spot → a jump in mpv → close mpv → the page continues there", { skip: !HAS_MPV }, async () => {
    await b.goto(base + "/#/watch/alpha-movie?t=120");
    await playingAt(b, 118, 130);
    await b.key(" ", "Space", 32);
    await b.waitFor(`document.querySelector("video").paused`);
    const at = (await b.video()).t;
    await b.click("Open in full player (mpv)"); // the player's own button (the page's "Full player" button: see D-18)
    const p = await until(async () => { const x = (await s.get("/api/player")).json; return x.running && x.duration > 0 && x; }, 20000);
    assert.ok(Math.abs(p.position - at) < 3, `mpv started at ${p.position}, the page was at ${at}`);
    await s.post("/api/player/cmd", { cmd: "seek", value: 400 });
    await until(async () => (await s.get("/api/player")).json.position >= 400);
    await sleep(1500); // the window polls mpv every 0.5 s and saves every 10 s and on close
    await s.post("/api/player/cmd", { cmd: "stop" });
    await until(async () => !(await s.get("/api/player")).json.running);
    const back = await b.waitFor(`(() => { const v = document.querySelector("video"); return v && v.readyState >= 1 && v.currentTime > 395 && v.currentTime; })()`, 20000);
    assert.ok(back < 410, `page continued at ${back}`);
    const saved = await until(async () => { const x = await progressOf(s, "alpha-movie"); return x && x.position >= 399 && x; }, 10000);
    assert.ok(saved.position < 412);
  });

  test("D-13 (in the app): a movie marked watched, watched again to 1:40 and left — the detail page offers Resume", { todo: "D-13" }, async () => {
    await b.goto(base + "/#/movies/beta-film");
    await b.click("Mark as watched");
    await until(async () => (await progressOf(s, "beta-film"))?.watched === true);
    await b.click("Play");
    await playingAt(b, 0, 5); // a finished movie starts from the beginning: expected
    await seekBarTo(b, 1 / 6);
    await playingAt(b, 95, 110);
    await b.key(" ", "Space", 32);
    await sleep(1500);
    await b.goto(base + "/#/movies/beta-film");
    await sleep(1000);
    const buttons = await b.eval(`[...document.querySelectorAll("button")].map((x) => x.innerText.trim()).filter(Boolean).join(" | ")`);
    assert.match(buttons, /Resume/, `buttons: ${buttons}`);
  });

  test("D-18: the watch page's Full player button starts mpv where the page player is (after Start over: near 0:00, not the old spot)", { skip: !HAS_MPV, todo: "D-18" }, async () => {
    const old = (await progressOf(s, "alpha-movie"))?.position ?? 0;
    assert.ok(old > 60, `alpha has saved progress (${old})`);
    await b.goto(base + "/#/movies/alpha-movie");
    await b.click("Start over");
    await playingAt(b, 0, 5);
    await b.click("Full player", "button:not([aria-label])");
    const p = await until(async () => { const x = (await s.get("/api/player")).json; return x.running && x.duration > 0 && x; }, 20000);
    await s.post("/api/player/cmd", { cmd: "stop" });
    await until(async () => !(await s.get("/api/player")).json.running);
    assert.ok(p.position < 15, `mpv started at ${p.position.toFixed(0)} s (the saved spot was ${old.toFixed(0)} s, the page was at ~0)`);
  });

  test("D-18: on a movie marked watched, the page's Full player button doesn't open mpv at the very end (it would close at once)", { skip: !HAS_MPV, todo: "D-18" }, async () => {
    await b.goto(base + "/#/movies/zeta-twin");
    await b.click("Mark as watched");
    await until(async () => (await progressOf(s, "zeta-twin"))?.watched === true);
    await b.goto(base + "/#/watch/zeta-twin");
    await playingAt(b, 0, 5);
    await b.click("Full player", "button:not([aria-label])");
    const p = await until(async () => { const x = (await s.get("/api/player")).json; return x.running && x.duration > 0 && x; }, 15000).catch(() => ({ position: "mpv ended at once" }));
    await s.post("/api/player/cmd", { cmd: "stop" });
    assert.ok(typeof p.position === "number" && p.position < 10, `mpv started at ${p.position} (page was at ~0)`);
  });

  test("journey 4: search by title, by a Persian title, and a search with no results", async () => {
    await b.goto(base + "/");
    await b.waitFor(`document.body.innerText.includes("Recently Added")`);
    await b.key("k", "KeyK", 75, 2); // Ctrl+K
    await b.waitFor(`document.activeElement && document.activeElement.tagName === "INPUT"`);
    await b.type("gamma");
    await b.waitFor(`document.body.innerText.includes("Gamma One") && document.body.innerText.includes("Gamma Two")`);
    await b.eval(`(() => { const i = document.activeElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await b.type("درباره");
    await b.waitFor(`[...document.querySelectorAll("[role=dialog] *, body *")].some((e) => e.children.length === 0 && e.textContent.includes("درباره الی"))`);
    await b.eval(`(() => { const i = document.activeElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await b.type("zzqx no such title");
    await b.waitFor(`/no (results|matches)|nothing/i.test(document.body.innerText)`);
    await b.key("Escape", "Escape", 27);
  });

  test("journey 5: the mini player keeps playing while browsing; Close stops it", async () => {
    await b.goto(base + "/#/watch/alpha-movie?t=60");
    await playingAt(b, 59, 70);
    await b.click("Home", "a");
    await b.waitFor(`location.hash === "#/" || location.hash === ""`);
    const t1 = (await b.video()).t;
    await sleep(1500);
    const v = await b.video();
    assert.ok(v && !v.paused && v.t > t1 + 0.8, `still playing in the corner: ${JSON.stringify(v)}`);
    await b.click("Close mini player");
    await b.waitFor(`!document.querySelector("video")`);
  });

  test("journey 6: a new film on disk shows up after Library → Scan now; nothing else changes", async () => {
    addEntry(s.media, "Movies/Fresh Arrival 2026/fresh.mkv", "short20.mkv", s.clips);
    await b.goto(base + "/#/library");
    await b.click("Scan now");
    await b.waitFor(`document.body.innerText.includes("Fresh Arrival")`, 20000);
    await b.goto(base + "/");
    await b.waitFor(`document.body.innerText.includes("Fresh Arrival")`);
    assert.ok((await progressOf(s, "alpha-movie"))?.position > 0, "earlier progress untouched");
  });

  test("journey 7: settings survive a restart (auto-play next off, subtitle size L)", async () => {
    await b.goto(base + "/#/settings");
    await b.click("Auto-play next episode", "button, [role=switch]");
    await b.click("L", "[aria-label='Subtitle size'] button, [aria-label='Subtitle size'] [role=radio]").catch(async () => b.eval(`[...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "L")?.click()`));
    await until(async () => { const st = (await s.get("/api/userdata")).json.settings; return st && st.autoplayNext === false && st.subtitleStyle?.size === "L"; }, 8000);
    await restart();
    await b.goto(base + "/#/settings");
    await b.waitFor(`document.body.innerText.includes("Play the next episode automatically")`);
    const st = (await s.get("/api/userdata")).json.settings;
    assert.equal(st.autoplayNext, false);
    assert.equal(st.subtitleStyle.size, "L");
    const sw = await b.eval(`(() => { const e = [...document.querySelectorAll("[role=switch], button")].find((x) => (x.getAttribute("aria-label") || "").includes("Auto-play next episode")); return e ? e.getAttribute("aria-checked") ?? e.getAttribute("aria-pressed") : "not found"; })()`);
    assert.equal(sw, "false", "the window shows it off too");
  });

  test("journey 8: a video that can't be played shows a message and the full-player button, not an endless spinner", async () => {
    await b.goto(base + "/#/watch/broken-download");
    await b.waitFor(`[...document.querySelectorAll("button")].some((x) => x.innerText.trim() === "Open in full player")`, 25000);
  });

  test("D-19: that message is written for people (no raw ffprobe command line or file path)", { todo: "D-19" }, async () => {
    await b.goto(base + "/#/watch/broken-download");
    await b.waitFor(`[...document.querySelectorAll("button")].some((x) => x.innerText.trim() === "Open in full player")`, 25000);
    const text = await b.text();
    assert.ok(!/ffprobe|Command failed|EBML|\/tmp\//.test(text), text.slice(0, 300));
  });

  test("journey 9: a title whose files vanished since the last scan: Play shows an error, nothing else plays", async () => {
    const lib = (await s.get("/api/library")).json;
    const dlt = lib.movies.find((m) => m.id === "delta-movie");
    fs.renameSync(path.dirname(path.dirname(dlt.file.path)), path.dirname(path.dirname(dlt.file.path)) + ".away");
    try {
      await b.goto(base + "/#/watch/delta-movie");
      await b.waitFor(`/couldn't|can't|could not|not found/i.test(document.body.innerText)`, 25000);
    } finally { fs.renameSync(path.dirname(path.dirname(dlt.file.path)) + ".away", path.dirname(path.dirname(dlt.file.path))); }
  });

  test("no uncaught errors in the page during the journeys", () => {
    const errors = b.console.filter((l) => l.startsWith("exception") || l.startsWith("error"));
    assert.deepEqual(errors, []);
  });
});
