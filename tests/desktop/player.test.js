// Desktop journeys, player side: subtitles (every encoding/format, timing, look, built-in, off) and audio tracks as they
// are drawn/heard; page player ↔ full player (the real mpv, its own window in the private display); settings that must
// change what the player does after a restart. Real packaged app, real input (see app.js).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MISSING } from "./app.js";
import { setup, journey, scratch, playingAt, seekBarTo, showControls, progressOf, subtitleLine, sleep, until, EVIDENCE } from "./common.js";
import { LAYOUT_FULL, HAS_MPV } from "../fixtures/media.js";

const skip = MISSING.length ? `missing: ${MISSING.join(", ")}` : false;
const T = { timeout: 300000 };

/** The player's settings panel (its buttons; the control bar has a "Subtitles on (C)" button too). */
const PANEL = "div[class*='bottom-[86px]'] button";
/** Opens the player's Settings menu at a page ("Subtitles", "Audio", "Subtitle timing", "Playback speed"), checking each
 * step (the panel is open, then shows that page) and retrying, so a click lost to the controls fading doesn't derail a test. */
async function menu(/** @type {any} */ app, /** @type {string} */ page) {
  const panelOpen = () => app.page.eval(`!!document.querySelector("div[class*='bottom-[86px]']")`);
  const onPage = () => app.page.eval(`(() => { const p = document.querySelector("div[class*='bottom-[86px]']"); const h = p && p.querySelector("span.flex-1"); return !!h && h.innerText.trim() === ${JSON.stringify(page)}; })()`);
  for (let i = 0; i < 3; i++) {
    if (await panelOpen()) { if (await onPage()) return; await app.key("Escape"); await sleep(300); } // Escape only with a panel open (else it leaves fullscreen)
    await showControls(app);
    await app.click("Settings (right-click)");
    try { await app.page.waitFor(`!!document.querySelector("div[class*='bottom-[86px]']")`, 3000); } catch { continue; }
    await sleep(400); // the panel slides in
    await app.click(page, PANEL);
    try { await until(onPage, 3000, 100); await sleep(250); return; } catch { /* retry */ }
  }
  throw new Error(`couldn't open the player's "${page}" menu`);
}
/** Clicks a panel button and waits for `ok()` (read from the saved data); clicks once more if the first click was lost. */
async function choose(/** @type {any} */ app, /** @type {string} */ text, /** @type {() => Promise<any>} */ ok) {
  await app.click(text, PANEL);
  try { await until(ok, 3000, 200); } catch { await app.click(text, PANEL); await until(ok, 4000, 200, `choice "${text}" applied`); }
}
const user = async (/** @type {any} */ app) => (await app.get("/api/userdata")).json?.user ?? {};
/** Options listed on the open menu page (text of each option button). */
const options = (/** @type {any} */ app) => app.page.eval(`[...document.querySelectorAll(${JSON.stringify(PANEL)})].filter((b) => b.offsetParent && !b.getAttribute("aria-label") && !b.hasAttribute("aria-pressed")).map((b) => b.innerText.trim()).filter(Boolean)`);

describe("desktop journeys: subtitles, audio, full player, settings", { skip }, () => {
  /** @type {any} */ let ctx;
  before(async () => { ctx = await setup(); });
  after(async () => { await ctx?.teardown(); });

  test("J6 subtitles and audio: English file shows its lines → timing +0.5 → size L is bigger → Persian Windows-1256 and UTF-16 read right → ASS → built-in → Off shows nothing; Audio → French really changes the sound", T, () => journey(ctx, "J6-tracks", async () => {
    const dir = scratch("j6");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/watch/alpha-movie?t=20");
    await playingAt(app.page, 20.3);
    await menu(app, "Subtitles");
    const opts = await options(app);
    fs.writeFileSync(path.join(EVIDENCE, "J6-subtitle-options.json"), JSON.stringify(opts, null, 1));
    const pick = async (/** @type {RegExp} */ re) => {
      const o = opts.find((/** @type {string} */ x) => re.test(x));
      assert.ok(o, `an option matching ${re} in ${JSON.stringify(opts)}`);
      await menu(app, "Subtitles");
      const label = o.split("\n")[0];
      const stem = label.includes("built-in") ? "embedded:" : label.split(" · ").pop();
      await choose(app, label, async () => JSON.stringify((await user(app)).subPrefs?.["alpha-movie"] ?? {}).includes(stem));
      return o;
    };
    /** Waits for a drawn line matching re (the cue changes every 4 s). */
    const line = (/** @type {RegExp} */ re, ms = 12000) => until(async () => { const l = await subtitleLine(app.page); return re.test(l) && l; }, ms, 200, `subtitle line ${re}`);
    await pick(/\.en\b|English.*Alpha/i);
    const en = await line(/(Hello|want|place|it\?|then)\S* #\d+|#\d+/);
    assert.match(en, /[A-Za-z]/);
    ctx.disp.shot(path.join(EVIDENCE, "J6-english.png"));
    // Timing +0.5 s
    await menu(app, "Subtitle timing");
    await choose(app, "=+0.5", async () => (await user(app)).subDelays?.["alpha-movie"] === 0.5);
    // Look: size L draws bigger than M
    const sizeOf = () => app.page.eval(`(() => { const s = [...document.querySelectorAll("[data-player-host] span[dir=auto]")].find((e) => e.getBoundingClientRect().height > 0); return s ? parseFloat(getComputedStyle(s).fontSize) : 0; })()`);
    await line(/#\d+/);
    const m = await sizeOf();
    await menu(app, "Subtitles");
    await choose(app, "=L", async () => (await app.get("/api/userdata")).json?.settings?.subtitleStyle?.size === "L");
    await line(/#\d+/);
    const l = await sizeOf();
    assert.ok(l > m, `size L ${l}px > before ${m}px`);
    // Persian (Windows-1256), Persian (UTF-16), ASS, built-in
    await pick(/\.fa\b/i);
    const fa = await line(/[؀-ۿ]/);
    assert.match(fa, /سلام|پارسي|گوشي|زيرنويس|مي/, `Persian text decoded: ${fa}`);
    ctx.disp.shot(path.join(EVIDENCE, "J6-persian-cp1256.png"));
    await pick(/utf16/i);
    await line(/[؀-ۿ]/);
    await pick(/styled/i);
    await line(/Styled line #\d+/);
    await pick(/built-in/i);
    await line(/#\d+/);
    // Off
    await menu(app, "Subtitles");
    await choose(app, "=Off", async () => (await user(app)).subPrefs?.["alpha-movie"]?.off === true);
    await sleep(4500);
    assert.equal(await subtitleLine(app.page), "", "no subtitle drawn when Off");
    await app.key("Escape");
    // Audio: English 440 Hz → French 1200 Hz
    const before = await ctx.sink.tone(2);
    await menu(app, "Audio");
    const aopts = await options(app);
    fs.writeFileSync(path.join(EVIDENCE, "J6-audio-options.json"), JSON.stringify(aopts));
    await choose(app, (aopts.find((/** @type {string} */ x) => /fr/i.test(x)) ?? aopts[1]).split("\n")[0], async () => (await user(app)).audioPrefs?.["alpha-movie"] === "fre");
    await sleep(2500);
    await playingAt(app.page, 1);
    const afterT = await ctx.sink.tone(2);
    fs.writeFileSync(path.join(EVIDENCE, "J6-audio-tones.json"), JSON.stringify({ before, after: afterT }));
    assert.ok(Math.abs(before.hz - 440) < 60, `English track sounds at ~440 Hz: ${JSON.stringify(before)}`);
    assert.ok(Math.abs(afterT.hz - 1200) < 120, `French track sounds at ~1200 Hz: ${JSON.stringify(afterT)}`);
    assert.equal((await app.get("/api/userdata")).json?.user?.audioPrefs?.["alpha-movie"], "fre", "audio choice remembered");
    await app.close();
  }));

  test("D-34: every subtitle choice can be reached in the player's menu on the watch page (7 tracks, 1440×900 window)", T, () => journey(ctx, "D-34", async () => {
    const dir = scratch("d34");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/watch/alpha-movie?t=20");
    await playingAt(app.page, 20.3);
    await menu(app, "Subtitles");
    ctx.disp.shot(path.join(EVIDENCE, "D-34-subtitle-menu-cut-off.png"));
    const panel = await app.page.eval(`(() => { const host = document.querySelector("[data-player-host]").getBoundingClientRect(); const r = document.querySelector("div[class*='bottom-[86px]']").getBoundingClientRect(); return { top: Math.round(r.top), playerTop: Math.round(host.top) }; })()`);
    // The list may scroll: each row must be reachable by scrolling it into view inside the panel.
    const geo = await app.page.eval(`(() => { const host = document.querySelector("[data-player-host]").getBoundingClientRect();
      return [...document.querySelectorAll(${JSON.stringify(PANEL)})].filter((b) => !b.getAttribute("aria-label") && !b.hasAttribute("aria-pressed")).map((b) => { b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); return { label: b.innerText.trim(), top: Math.round(r.top), visible: r.top >= Math.max(0, host.top) && r.bottom <= host.bottom }; }); })()`);
    fs.writeFileSync(path.join(EVIDENCE, "D-34-options.json"), JSON.stringify({ window: await app.page.eval("[innerWidth, innerHeight]"), panel, options: geo }, null, 1));
    await app.close();
    const hidden = geo.filter((/** @type {any} */ o) => !o.visible).map((/** @type {any} */ o) => o.label);
    assert.ok(panel.top >= panel.playerTop, `the panel starts above the player: ${JSON.stringify(panel)}`);
    assert.ok(geo.length >= 8, `Off + 7 tracks listed: ${geo.length}`);
    assert.deepEqual(hidden, [], `options cut off by the player: ${hidden.join(" | ")}`);
  }));

  test("J7 page player → full player (mpv, its own window) at the same spot → a key in mpv seeks → subtitle track changed → closing mpv's window → the page continues there; one mpv at a time; progress follows", { ...T, skip: !HAS_MPV && "no mpv" }, () => journey(ctx, "J7-engines", async () => {
    const dir = scratch("j7");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/watch/alpha-movie?t=120");
    await playingAt(app.page, 120.3);
    await app.key("space");
    await app.page.waitFor(`document.querySelector("video").paused`);
    const at = (await app.page.video()).t;
    await showControls(app);
    await app.click("Open in full player (mpv)");
    const p = await until(async () => { const x = (await app.get("/api/player")).json; return x?.running && x.duration > 0 && x; }, 30000, 250, "mpv running");
    assert.ok(Math.abs(p.position - at) < 3, `mpv opened at ${p.position}, the page was at ${at}`);
    assert.match(p.subtitles?.length ? "ok" : "none", /ok/, "mpv got the subtitle tracks");
    const mpvWin = await until(() => ctx.disp.windows().find((/** @type {any} */ w) => w.pid !== app.appPid && w.w > 100 && app.procs(/(^|\/)mpv( |$)/).some((/** @type {any} */ m) => m.pid === w.pid)), 15000, 250, "mpv's window");
    ctx.disp.shot(path.join(EVIDENCE, "J7-mpv-window.png"));
    assert.equal(app.procs(/(^|\/)mpv( |$)/).filter((/** @type {any} */ m) => !/\bsh\b/.test(m.cmd)).length >= 1, true);
    // The page shows a placeholder, not a second player
    assert.ok(await app.page.eval(`!document.querySelector("video") || document.querySelector("video").paused`), "the page player isn't playing alongside mpv");
    // Real key in mpv's window: → seeks forward
    ctx.disp.x("focus", mpvWin.id);
    if (p.paused) { ctx.disp.x("key", "space"); await sleep(500); }
    ctx.disp.x("key", "Right"); await sleep(1200);
    const p2 = (await app.get("/api/player")).json;
    assert.ok(p2.position > p.position + 3, `→ in mpv seeks: ${p.position} → ${p2.position}`);
    // Subtitle track change (what mpv's own menu does)
    const sub = p2.subtitles.find((/** @type {any} */ s) => !s.selected) ?? p2.subtitles[0];
    await app.post("/api/player/cmd", { cmd: "set", name: "sid", value: sub.id });
    await until(async () => (await app.get("/api/player")).json.sid === sub.id, 5000, 200, "sid switched");
    await sleep(1500);
    const last = (await app.get("/api/player")).json.position;
    // Close mpv's window like a user
    ctx.disp.x("close", mpvWin.id);
    await until(async () => !(await app.get("/api/player")).json.running, 15000, 200, "mpv closed");
    const back = await app.page.waitFor(`(() => { const v = document.querySelector("video"); return v && v.readyState >= 1 && v.currentTime > ${last - 4} && v.currentTime; })()`, 20000);
    assert.ok(Math.abs(back - last) < 6, `page continued at ${back}, mpv was at ${last}`);
    const saved = await until(async () => { const x = await progressOf(app, "alpha-movie"); return x && Math.abs(x.position - last) < 6 && x; }, 10000, 300, "progress follows mpv");
    assert.ok(saved);
    await sleep(1000);
    assert.equal(app.procs(/(^|\/)mpv( |$)/).filter((/** @type {any} */ m) => !/\bsh\b/.test(m.cmd)).length, 0, "no mpv left");
    await app.close();
  }));

  test("S1 settings take effect after a restart: subtitle languages 'Persian, English' → Alpha starts with Persian; auto-play next off → the episode ends without starting the next", T, () => journey(ctx, "S1-settings", async () => {
    const dir = scratch("s1");
    const media = ctx.library(dir, LAYOUT_FULL);
    let app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.click("Settings", "a");
    const f = await app.page.box("sel:input[aria-label='Subtitle language order']");
    await app.clickAt(f.x + f.w / 2, f.y + f.h / 2);
    await app.page.eval(`document.activeElement.select(), 1`);
    await app.type("Persian, English");
    await app.key("Tab");
    await app.click("Auto-play next episode", "button, [role=switch]");
    await until(async () => { const st = (await app.get("/api/userdata")).json?.settings; return st && st.autoplayNext === false && JSON.stringify(st.subtitleLanguages ?? "").includes("Persian") && st; }, 8000, 200, "settings saved");
    await app.close();
    app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/watch/alpha-movie?t=20");
    await playingAt(app.page, 20.3);
    const l = await until(async () => { const x = await subtitleLine(app.page); return x && x; }, 12000, 200, "a subtitle line");
    assert.match(l, /[؀-ۿ]/, `starts with a Persian subtitle: ${l}`);
    await app.page.goto("#/watch/show-one-s2e1");
    await playingAt(app.page, 0.2);
    await seekBarTo(app, 0.9);
    await app.page.waitFor(`document.querySelector("video").ended || /replay|play next|next episode/i.test(document.body.innerText)`, 30000);
    await sleep(4000);
    assert.ok((await app.page.hash()).startsWith("#/watch/show-one-s2e1"), `stayed on the episode: ${await app.page.hash()}`);
    ctx.disp.shot(path.join(EVIDENCE, "S1-autoplay-off-end.png"));
    await app.close();
  }));
});
