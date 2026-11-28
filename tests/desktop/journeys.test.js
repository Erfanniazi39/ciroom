// Desktop end-to-end journeys in the REAL packaged CiRoom (AppImage or extracted package), driven with real mouse and
// keyboard input in a private X display, sound into a silent sink, on the synthetic library (tests/fixtures).
// Run: npm run test:desktop   (CIROOM_APP=<AppImage or squashfs-root> to pick the build; default the installed one)
// Not for CI: needs a desktop session (PipeWire, Xephyr). Evidence of failures: $CIROOM_E2E_EVIDENCE (see common.js).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MISSING, assertPlaying } from "./app.js";
import { setup, journey, scratch, playingAt, seekBarTo, showControls, progressOf, sleep, until, EVIDENCE } from "./common.js";
import { LAYOUT_FULL } from "../fixtures/media.js";

const skip = MISSING.length ? `missing: ${MISSING.join(", ")}` : false;
const T = { timeout: 240000 };

describe("desktop journeys (real packaged app)", { skip }, () => {
  /** @type {any} */ let ctx;
  before(async () => { ctx = await setup(); });
  after(async () => { await ctx?.teardown(); });

  test("J1 first install: empty library → user types the library folder in Settings → reopens → library scanned → plays a movie", T, () => journey(ctx, "J1-first-install", async () => {
    const dir = scratch("j1");
    const media = ctx.library(dir, LAYOUT_FULL);
    let app = await ctx.launch({ dir, fresh: true }); // nothing set: a brand-new user with an empty HOME
    await app.page.waitFor(`document.body.innerText.includes("Your library is empty")`, 20000);
    // The empty home screen's own button.
    await app.click("Add a folder");
    await sleep(800);
    ctx.disp.shot(path.join(EVIDENCE, "D-32-after-add-a-folder.png"));
    fs.writeFileSync(path.join(EVIDENCE, "D-32-after-add-a-folder.txt"), await app.page.text());
    const afterAdd = { hash: await app.page.hash(), hasField: await app.page.eval(`!!document.querySelector("input[aria-label='Library folder']")`) };
    fs.writeFileSync(path.join(EVIDENCE, "J1-add-a-folder.json"), JSON.stringify(afterAdd));
    // Where the folder can actually be set: Settings → Library folder.
    if (!afterAdd.hasField) { await app.click("Settings", "a"); await app.page.waitFor(`!!document.querySelector("input[aria-label='Library folder']")`); }
    const box = await app.page.box("sel:input[aria-label='Library folder']");
    await app.clickAt(box.x + box.w / 2, box.y + box.h / 2);
    await app.page.eval(`(() => { const i = document.activeElement; i.select(); return i === document.querySelector("input[aria-label='Library folder']"); })()`);
    await app.type(media);
    await app.click("Save");
    const msg = await app.page.waitFor(`(() => { const m = document.body.innerText.match(/Saved[^\\n]*|No Movies or Series[^\\n]*/); return m && m[0]; })()`);
    assert.match(msg, /Saved/);
    const closeMs = await app.close();
    assert.ok(closeMs < 8000, `closing took ${closeMs} ms`);
    app = await ctx.launch({ dir, fresh: true }); // reopen: same HOME
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 60000);
    const home = await app.page.text();
    for (const title of ["Alpha Movie", "Show One"]) assert.ok(home.includes(title), `Home shows ${title}`);
    await app.click("sel:a[href='#/movies/alpha-movie']");
    await app.page.waitFor(`location.hash === "#/movies/alpha-movie"`);
    await app.click("Play");
    await playingAt(app.page, 0.3);
    const p = await assertPlaying(app.page);
    assert.ok(p.ok, JSON.stringify(p));
    const lvl = await ctx.sink.level(2);
    assert.ok(lvl > -60, `sound is produced (${lvl} dB)`);
    const where = await app.get("/api/media-root");
    fs.writeFileSync(path.join(EVIDENCE, "J1-media-root.json"), where.text);
    await app.close();
  }));

  test("J3 watch a movie: play, pause (Space), resume (click), seek (seek bar), volume, speed 1.5×, fullscreen in/out, browse away and back (mini player), stop → progress saved", T, () => journey(ctx, "J3-watch-movie", async () => {
    const dir = scratch("j3");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/movies/alpha-movie");
    await app.click("Play");
    await playingAt(app.page, 0.3);
    assert.equal(await app.page.eval(`document.title + "|" + document.body.innerText.includes("Alpha Movie")`).then((x) => x.split("|")[1]), "true", "the watch page names the movie");
    // Pause with the keyboard
    await app.key("space");
    await app.page.waitFor(`document.querySelector("video").paused`);
    const t1 = (await app.page.video()).t; await sleep(1200);
    assert.ok(Math.abs((await app.page.video()).t - t1) < 0.05, "paused: time stands still");
    // Resume with the big Play button / control
    await showControls(app);
    await app.click("Play (K)");
    await playingAt(app.page, t1 + 0.2);
    // Seek: a third of the bar ≈ 3:20
    await seekBarTo(app, 1 / 3);
    const ts = await playingAt(app.page, 190, 215);
    assert.ok(ts);
    // Volume: click low on the volume slider
    const loud = await ctx.sink.level(1.5);
    await showControls(app);
    const grp = await app.page.eval(`(() => { const r = document.querySelector("[aria-label='Volume']").parentElement.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    await app.hover(grp.x + 12, grp.y + grp.h / 2); // the slider opens while the pointer is over the speaker button
    await app.page.waitFor(`document.querySelector("[aria-label='Volume']").getBoundingClientRect().width > 60`);
    await sleep(300);
    const vol = await app.page.box("sel:[aria-label='Volume']");
    await app.clickAt(vol.x + vol.w * 0.15, vol.y + vol.h / 2);
    const v2 = await app.page.waitFor(`(() => { const v = document.querySelector("video"); return v.volume < 0.4 && v.volume; })()`);
    const quiet = await ctx.sink.level(1.5);
    assert.ok(quiet < loud - 6, `volume ${v2.toFixed(2)}: sound ${loud} dB → ${quiet} dB`);
    // Speed 1.5× from the settings menu
    await showControls(app);
    await app.click("Settings (right-click)");
    await app.click("Playback speed");
    await app.click("1.5×");
    await app.page.waitFor(`document.querySelector("video").playbackRate === 1.5`);
    const a = (await app.page.video()).t; await sleep(2000); const b = (await app.page.video()).t;
    assert.ok(b - a > 2.4, `1.5× really plays faster: ${(b - a).toFixed(2)} s in 2 s`);
    await app.key("Escape");
    // Fullscreen with F, out with F. The test display has no window manager to resize the window, so what is checked is
    // the app's side: the Tauri window is put in fullscreen (its own state) and the player fills the whole window.
    const isFull = () => app.page.eval(`window.__TAURI_INTERNALS__.invoke("plugin:window|is_fullscreen", { label: "main" })`);
    const fills = () => app.page.eval(`(() => { const r = document.querySelector("[data-player-host]").getBoundingClientRect(); return r.width >= innerWidth - 1 && r.height >= innerHeight - 1; })()`);
    assert.equal(await isFull(), false);
    await app.key("f");
    await until(async () => (await isFull()) && (await fills()), 8000, 150, "window fullscreen + player filling it");
    ctx.disp.shot(path.join(EVIDENCE, "J3-fullscreen.png"));
    assert.ok(await app.page.eval(`!document.querySelector("video").paused`), "still playing in fullscreen");
    await app.key("f");
    await until(async () => !(await isFull()) && !(await fills()), 8000, 150, "back from fullscreen");
    // Browse away: the mini player keeps playing
    await app.click("Home", "a");
    await app.page.waitFor(`location.hash === "#/" || location.hash === ""`);
    const m1 = await app.page.video(); await sleep(1500); const m2 = await app.page.video();
    assert.ok(m2 && !m2.paused && m2.t > m1.t + 1, `mini player keeps playing: ${JSON.stringify([m1?.t, m2?.t])}`);
    await app.page.goto("#/movies/beta-film"); await sleep(500);
    const mini = await app.page.box("sel:[data-player-host]");
    await app.hover(mini.x + mini.w / 2, mini.y + mini.h / 2); // the mini player shows its buttons on hover
    await app.click("Back to the watch page");
    await app.page.waitFor(`location.hash.startsWith("#/watch/alpha-movie")`);
    const back = await app.page.video();
    assert.ok(back && Math.abs(back.t - m2.t) < 15, `same video, same place after coming back (${back?.t} vs ${m2.t})`);
    // Stop: pause and leave; the saved spot is where it stopped
    await app.key("space");
    await app.page.waitFor(`document.querySelector("video").paused`);
    const stopAt = (await app.page.video()).t;
    const saved = await until(async () => { const p = await progressOf(app, "alpha-movie"); return p && Math.abs(p.position - stopAt) < 2 && p; }, 10000, 200, "progress saved at the pause");
    assert.ok(saved.position > 200);
    assert.deepEqual(app.page.errors().filter((/** @type {any} */ e) => !/api\/smoke/.test(e.url ?? "")), [], "no page errors");
    await app.close();
  }));

  test("D-31: closing the window keeps where the movie was: a jump made just before closing, and a pause right before closing", { ...T, todo: "D-31" }, () => journey(ctx, "D-31", async () => {
    const dir = scratch("d31");
    const media = ctx.library(dir, LAYOUT_FULL);
    let app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/watch/alpha-movie?t=100");
    await playingAt(app.page, 100.3);
    await sleep(12000); // a periodic save happens (~110 s)
    await seekBarTo(app, 0.75); // jump to ~7:30
    await playingAt(app.page, 440, 470);
    await sleep(3000);
    const at = (await app.page.video()).t;
    await app.close();
    app = await ctx.launch({ dir, media });
    const p = await progressOf(app, "alpha-movie");
    const r1 = `jumped to ~450 and closed at ${at.toFixed(1)}: saved ${p?.position?.toFixed(1)}`;
    await app.page.goto("#/watch/alpha-movie?t=200");
    await playingAt(app.page, 200.3);
    await sleep(4000);
    await app.key("space"); // pause, then close at once
    const at2 = (await app.page.video()).t;
    await app.close();
    app = await ctx.launch({ dir, media });
    const p2 = await progressOf(app, "alpha-movie");
    const r2 = `paused at ${at2.toFixed(1)} and closed at once: saved ${p2?.position?.toFixed(1)}`;
    fs.writeFileSync(path.join(EVIDENCE, "D-31.json"), JSON.stringify({ r1, r2 }));
    await app.close();
    assert.ok(p && Math.abs(at - p.position) < 5, r1);
    assert.ok(p2 && Math.abs(p2.position - at2) < 2, r2);
  }));

  test("J4 resume after restarting: paused → closed (X) → reopened → Continue Watching → Resume at the same spot; closed while playing; app killed while playing; Start over", T, () => journey(ctx, "J4-resume", async () => {
    const dir = scratch("j4");
    const media = ctx.library(dir, LAYOUT_FULL);
    let app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/movies/alpha-movie");
    await app.click("Play");
    await playingAt(app.page, 0.3);
    await seekBarTo(app, 0.25);
    await playingAt(app.page, 140, 165);
    await sleep(1000);
    await app.key("space");
    await app.page.waitFor(`document.querySelector("video").paused`);
    const pausedAt = (await app.page.video()).t;
    await sleep(1000); // the time it takes to move to the window's X
    await app.close();
    // (a) reopen: Continue Watching on Home, Resume at the paused spot
    app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Continue Watching")`, 30000);
    const row = await app.page.eval(`(() => { const h = [...document.querySelectorAll("h2, h3")].find((e) => /Continue Watching/.test(e.innerText)); return h ? h.closest("section")?.innerText ?? h.parentElement.parentElement.innerText : ""; })()`);
    assert.match(row, /Alpha Movie/, "Alpha Movie is in Continue Watching");
    await app.page.goto("#/movies/alpha-movie");
    const label = await app.page.waitFor(`[...document.querySelectorAll("button")].map((x) => x.innerText).find((x) => /Resume/.test(x))`);
    await app.click("Resume");
    const resumed = await playingAt(app.page, pausedAt - 3, pausedAt + 6);
    assert.ok(Math.abs(resumed - pausedAt) < 6, `resumed at ${resumed}, paused at ${pausedAt} (button "${label}")`);
    // (b) closed while PLAYING right after a seek (no pause)
    await seekBarTo(app, 0.5);
    const playingTo = await playingAt(app.page, 290, 315);
    await sleep(12000); // watches a little after the jump (an immediate close after a jump is D-31)
    const closedAt = (await app.page.video()).t;
    await app.close();
    app = await ctx.launch({ dir, media });
    const p1 = await progressOf(app, "alpha-movie");
    assert.ok(p1 && closedAt - p1.position < 11 && p1.position <= closedAt + 1, `closed while playing at ${closedAt.toFixed(1)} (seeked to ${playingTo.toFixed(1)}): saved ${p1?.position}`);
    // (c) the app is killed while playing (crash): at most ~a save interval is lost, never the earlier progress
    await app.page.goto("#/watch/alpha-movie");
    await playingAt(app.page, p1.position - 3);
    await seekBarTo(app, 0.6); // ~6:00 (later than 7:00 counts as watched on this 10-minute film)
    await playingAt(app.page, 350, 380);
    await sleep(12000); // past one periodic save
    const killedAt = (await app.page.video()).t;
    await app.kill("SIGKILL");
    app = await ctx.launch({ dir, media });
    const p2 = await progressOf(app, "alpha-movie");
    fs.writeFileSync(path.join(EVIDENCE, "J4-kill.json"), JSON.stringify({ killedAt, saved: p2 }));
    assert.ok(p2 && p2.position > 350 && !p2.watched && killedAt - p2.position < 15, `killed at ${killedAt.toFixed(1)}: saved ${p2?.position}`);
    // (d) Start over plays from the beginning
    await app.page.goto("#/movies/alpha-movie");
    await app.click("Start over");
    await playingAt(app.page, 0, 6);
    await app.close();
  }));
});
