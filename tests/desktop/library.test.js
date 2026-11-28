// Desktop journeys, library side: details and artwork from TMDB, My List, collections, odd titles, series with Up Next,
// search, and a rescan after the folders changed. Real packaged app, real input (see app.js). TMDB/IMDb are the
// in-process mock of the functional tests (loaded into the app's own bundled Node with NODE_OPTIONS), never the internet.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MISSING, assertPlaying } from "./app.js";
import { setup, journey, scratch, playingAt, seekBarTo, progressOf, sleep, until, EVIDENCE } from "./common.js";
import { LAYOUT_FULL, addEntry } from "../fixtures/media.js";

const skip = MISSING.length ? `missing: ${MISSING.join(", ")}` : false;
const T = { timeout: 300000 };
const MOCK = { NODE_OPTIONS: `--import ${pathToFileURL(path.resolve(import.meta.dirname, "../functional/tmdb-mock.js")).href}` };
const cardHref = (/** @type {string} */ h) => `sel:a[href='${h}']`;

describe("desktop journeys: library, series, search, rescan", { skip }, () => {
  /** @type {any} */ let ctx;
  before(async () => { ctx = await setup(); });
  after(async () => { await ctx?.teardown(); });

  test("J2 browse: TMDB key in Library → details + artwork fetched → poster/backdrop/director on the detail page → My List → collection → a title TMDB doesn't know → an odd folder name plays", T, () => journey(ctx, "J2-browse", async () => {
    const dir = scratch("j2");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL), env: MOCK });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.click("Library", "a");
    const key = await app.page.box("sel:input[placeholder^='Paste API key']");
    await app.clickAt(key.x + key.w / 2, key.y + key.h / 2); // the middle: the sidebar widens over the left edge while the pointer is near it
    assert.ok(await app.page.waitFor(`document.activeElement?.placeholder?.startsWith("Paste API key")`, 5000), "the key field has the focus after a click");
    await app.type("good-key");
    const typed = await app.page.eval(`document.activeElement.value`);
    assert.equal(typed, "good-key");
    await app.key("Return");
    await app.page.waitFor(`document.body.innerText.includes("TMDB connected") || /rejected|invalid|couldn't|not valid/i.test(document.body.innerText)`, 20000);
    assert.match(await app.page.text(), /TMDB connected/);
    // Details for every title (button text "Fetch details for N titles"), then artwork
    const details = await app.page.eval(`[...document.querySelectorAll("button")].map((b) => b.innerText).find((t) => /Fetch details for/.test(t)) || ""`);
    if (details) { await app.click("Fetch details for"); await app.page.waitFor(`![...document.querySelectorAll("button")].some((b) => /Stop/.test(b.innerText)) && !/Fetch details for \\d+ titles/.test(document.body.innerText.replace("${details}", ""))`, 90000).catch(() => undefined); }
    await until(async () => { const m = (await app.get("/api/meta")).json; return m && m["alpha-movie"]?.director && m; }, 90000, 500, "Alpha Movie's details");
    const art = await app.page.eval(`[...document.querySelectorAll("button")].map((b) => b.innerText).find((t) => /Fetch artwork for/.test(t)) || ""`);
    if (art) { await app.click("Fetch artwork for"); }
    await until(async () => { const a = (await app.get("/api/art")).json; return a && JSON.stringify(a).includes("alpha-movie") && a; }, 90000, 500, "Alpha Movie's artwork");
    fs.writeFileSync(path.join(EVIDENCE, "J2-library-page.txt"), await app.page.text());
    // Detail page
    await app.click("Home", "a");
    await app.click(cardHref("#/movies/alpha-movie"));
    await app.page.waitFor(`location.hash === "#/movies/alpha-movie"`);
    await app.page.waitFor(`document.body.innerText.includes("Ada Director")`, 15000);
    const imgs = await app.page.waitFor(`(() => { const i = [...document.querySelectorAll("img")].filter((x) => /\\/api\\/art\\/file\\//.test(x.src) && x.complete && x.naturalWidth > 0); return i.length ? i.map((x) => x.src.split("/").pop()) : null; })()`, 15000);
    ctx.disp.shot(path.join(EVIDENCE, "J2-detail.png"));
    assert.ok(imgs.length >= 1, `artwork shown on the detail page: ${imgs}`);
    // My List
    await app.click("Add to watchlist");
    await until(async () => (await app.get("/api/userdata")).json?.user?.watchlist?.includes?.("alpha-movie"), 8000, 200, "watchlist saved");
    await app.click("My List", "a");
    await app.page.waitFor(`location.hash === "#/my-list"`);
    await sleep(400);
    const first = await app.page.text();
    fs.writeFileSync(path.join(EVIDENCE, "D-33-my-list-first-view.txt"), first);
    ctx.disp.shot(path.join(EVIDENCE, "D-33-my-list-first-view.png"));
    await app.click("Watchlist");
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`);
    await app.click("Home", "a");
    const homeText = await app.page.waitFor(`document.body.innerText.includes("Recently Added") && document.body.innerText`);
    fs.writeFileSync(path.join(EVIDENCE, "J2-home.txt"), homeText);
    // Collection
    await app.page.goto("#/movies");
    await app.page.waitFor(`document.body.innerText.includes("Gamma Saga")`, 10000);
    await app.click("Gamma Saga", "a");
    await app.page.waitFor(`document.body.innerText.includes("Gamma One") && document.body.innerText.includes("Gamma Two")`);
    // A title TMDB doesn't know: still a usable page
    await app.page.goto("#/movies/silent-film");
    const silent = await app.page.waitFor(`document.body.innerText.includes("Silent Film") && document.body.innerText`);
    assert.ok(/Play/.test(silent), "a title without details can still be played");
    // An odd folder name opens and plays
    await app.page.goto("#/movies");
    await app.click("Name With 'quotes'", "a");
    await app.page.waitFor(`/#\\/movies\\//.test(location.hash) && document.body.innerText.includes("quotes")`);
    await app.click("Play");
    await playingAt(app.page, 0.3);
    assert.ok((await assertPlaying(app.page)).ok);
    await app.close();
  }));

  test("D-33: My List opens on what the user saved (only a watchlist entry → not an empty Favorites tab)", { ...T, todo: "D-33" }, () => journey(ctx, "D-33", async () => {
    const dir = scratch("d33");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/movies/alpha-movie");
    await app.click("Add to watchlist");
    await app.click("My List", "a");
    await app.page.waitFor(`location.hash === "#/my-list"`);
    await sleep(400);
    const t = await app.page.text();
    await app.close();
    assert.ok(t.includes("Alpha Movie") && !/No favorites yet/.test(t), t.slice(0, 300));
  }));

  test("J5 series: seasons → episode → ←/→ and Space → near the end Up Next → Play now opens the next episode on disk → back on the series page E1 is watched, E3 started; the last episode has no Up Next", T, () => journey(ctx, "J5-series", async () => {
    const dir = scratch("j5");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Show One")`, 30000);
    await app.page.goto("#/series");
    await app.click(cardHref("#/series/show-one"));
    await app.page.waitFor(`!!document.querySelector("[aria-label='Seasons']")`);
    const s1 = await app.page.text();
    assert.ok(/Missing|not on disk/i.test(s1), "season 1's missing episode 3 is shown as missing");
    await app.click("2", "[aria-label='Seasons'] [role=tab]");
    await app.click("Play episode 1");
    await app.page.waitFor(`location.hash.startsWith("#/watch/show-one-s2e1")`);
    await playingAt(app.page, 0.3);
    await app.key("Right");
    const f = await playingAt(app.page, 10, 30);
    await app.key("Left");
    await playingAt(app.page, 0, f - 5);
    await app.key("space");
    await app.page.waitFor(`document.querySelector("video").paused`);
    await app.key("space");
    await playingAt(app.page, 0.1);
    await seekBarTo(app, 0.92); // 62 s episode: the Up Next card shows in the last 15 s; past 90 % counts as watched
    await app.page.waitFor(`/up next/i.test(document.body.innerText)`, 20000);
    ctx.disp.shot(path.join(EVIDENCE, "J5-upnext.png"));
    await app.click("Play now");
    await app.page.waitFor(`location.hash.startsWith("#/watch/show-one-s2e3")`, 15000); // E2 isn't on disk
    await playingAt(app.page, 0.1);
    assert.match(await app.page.text(), /E3|Episode 3/);
    await sleep(3000);
    await app.key("space");
    await sleep(1000);
    await app.page.goto("#/series/show-one");
    await app.page.waitFor(`!!document.querySelector("[aria-label='Seasons']")`);
    await app.click("2", "[aria-label='Seasons'] [role=tab]");
    const marks = await app.page.waitFor(`(() => { const b = [...document.querySelectorAll("button[aria-label^='Mark as']")]; return b.length >= 2 && b.map((x) => x.getAttribute("aria-label")); })()`);
    assert.equal(marks[0], "Mark as unwatched", `S2E1 shows as watched: ${marks}`);
    const p3 = await progressOf(app, "show-one-s2e3");
    assert.ok(p3 && p3.position > 1 && !p3.watched, `S2E3 partly watched: ${JSON.stringify(p3)}`);
    const resumeShown = await app.page.eval(`document.body.innerText`);
    fs.writeFileSync(path.join(EVIDENCE, "J5-series-page.txt"), resumeShown);
    // The last episode on disk: no Up Next, an end screen instead
    await app.page.goto("#/watch/show-one-s2e3");
    await app.key("space"); // it is still open (paused) in the player: play on
    await playingAt(app.page, 0.1);
    await seekBarTo(app, 0.85);
    await playingAt(app.page, 50);
    await app.page.waitFor(`document.querySelector("video").ended || /replay|watch again|start over/i.test(document.body.innerText)`, 30000);
    assert.ok(!/up next/i.test(await app.page.text()), "no Up Next after the last episode");
    ctx.disp.shot(path.join(EVIDENCE, "J5-last-episode-end.png"));
    await app.close();
  }));

  test("J9 search: Ctrl+K → a title → open it; a Persian title; a name with quotes and brackets; nothing found; Back returns", T, () => journey(ctx, "J9-search", async () => {
    const dir = scratch("j9");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    const search = async (/** @type {string} */ q) => {
      await app.key("k", "ctrl");
      await app.page.waitFor(`document.activeElement && document.activeElement.tagName === "INPUT"`);
      await app.page.eval(`document.activeElement.select(), 1`);
      await app.type(q);
      await sleep(400);
    };
    await search("gamma");
    await app.page.waitFor(`document.body.innerText.includes("Gamma One") && document.body.innerText.includes("Gamma Two")`);
    await app.click("Gamma Two", "[role=dialog] a, [role=dialog] button, [role=dialog] [role=option]");
    await app.page.waitFor(`location.hash.includes("gamma-two")`);
    await search("درباره");
    await app.page.waitFor(`[...document.querySelectorAll("[role=dialog] *")].some((e) => e.children.length === 0 && e.textContent.includes("درباره الی"))`);
    await app.key("Escape");
    await search("'quotes' & [");
    await app.page.waitFor(`[...document.querySelectorAll("[role=dialog] *")].some((e) => e.children.length === 0 && /quotes/i.test(e.textContent))`);
    await app.key("Escape");
    await search("zzqx no such title");
    await app.page.waitFor(`/no (results|matches)|nothing/i.test(document.body.innerText)`);
    await app.key("Escape");
    await app.page.waitFor(`!document.querySelector("[role=dialog]")`);
    await app.page.goto("#/movies/beta-film");
    await app.click("Back");
    await app.page.waitFor(`location.hash.includes("gamma-two")`, 5000);
    await app.close();
  }));

  test("J10 rescan: progress on two titles → a new film, a new episode, a renamed folder, a removed film → Library → Scan now → all changes shown, progress kept for the renamed one", T, () => journey(ctx, "J10-rescan", async () => {
    const dir = scratch("j10");
    const media = ctx.library(dir, LAYOUT_FULL);
    const app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    // Watch a bit of Epsilon (will be renamed) and Show Two E1
    for (const id of ["epsilon", "show-two-s1e1"]) {
      await app.page.goto(`#/watch/${id}?t=5`);
      await playingAt(app.page, 5.3);
      await sleep(3000);
      await app.key("space");
      await until(async () => (await progressOf(app, id))?.position > 5, 8000, 200, `${id} progress`);
    }
    const before = { eps: await progressOf(app, "epsilon"), two: await progressOf(app, "show-two-s1e1") };
    addEntry(media, "Movies/Fresh Arrival 2026/fresh.mkv", "short20.mkv", ctx.clips);
    addEntry(media, "Series/Show Two 2016/S01 E03/c.mkv", "ep66.mkv", ctx.clips);
    fs.renameSync(path.join(media, "Movies/Epsilon 2018"), path.join(media, "Movies/Epsilon (2018) Remastered"));
    fs.rmSync(path.join(media, "Movies/Silent Film 1927"), { recursive: true });
    await app.click("Library", "a");
    await app.click("Scan now");
    const summary = await app.page.waitFor(`(() => { const t = document.body.innerText; return /Fresh Arrival/.test(t) && !/Scanning…/.test(t) && t; })()`, 60000);
    fs.writeFileSync(path.join(EVIDENCE, "J10-scan-summary.txt"), summary);
    const lib = (await app.get("/api/library")).json;
    const ids = [...lib.movies, ...lib.series].map((/** @type {any} */ x) => x.id);
    assert.ok(ids.includes("fresh-arrival"), "new film");
    assert.ok(!ids.includes("silent-film"), "removed film gone");
    assert.ok(ids.includes("epsilon"), `renamed folder keeps its id: ${ids.filter((/** @type {string} */ i) => /eps/.test(i))}`);
    const two = lib.series.find((/** @type {any} */ s) => s.id === "show-two");
    assert.ok(two.seasons[0].episodes.some((/** @type {any} */ e) => e.number === 3 && e.file), "new episode E3");
    assert.deepEqual(await progressOf(app, "epsilon"), before.eps, "progress of the renamed film kept");
    assert.deepEqual(await progressOf(app, "show-two-s1e1"), before.two);
    await app.page.goto("#/movies/fresh-arrival");
    await app.click("Play");
    await playingAt(app.page, 0.3);
    await app.close();
  }));
});
