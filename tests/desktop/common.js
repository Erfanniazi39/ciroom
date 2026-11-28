// Shared pieces of the desktop journeys: the private display + silent sink for a test file, scratch folders, evidence on
// failure (screenshot, page console, server log tail), and small player helpers. See app.js for how the app is driven.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDisplay, silentSink, launchApp } from "./app.js";
import { buildClips, makeLibrary } from "../fixtures/media.js";

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
export async function until(/** @type {() => any} */ fn, ms = 10000, step = 150, what = "") {
  const t0 = Date.now(); let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e instanceof Error ? e.message : e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out${what ? ` (${what})` : ""}; last: ${JSON.stringify(last)}`);
    await sleep(step);
  }
}
// Short base folder: mpv's socket path (inside the private XDG_RUNTIME_DIR) must stay under ~100 characters.
const BASE = process.env.CIROOM_E2E_TMP || path.join(os.tmpdir(), "cre2e");
export const EVIDENCE = process.env.CIROOM_E2E_EVIDENCE || path.join(BASE, "evidence");
fs.mkdirSync(EVIDENCE, { recursive: true });
export const scratch = (/** @type {string} */ name) => { fs.mkdirSync(BASE, { recursive: true }); return fs.mkdtempSync(path.join(BASE, `${name}-`)); };

/** One display + sink per test file. */
export async function setup() {
  const disp = await startDisplay();
  const sink = silentSink(`ciroom-e2e-${process.pid}`);
  const clips = await buildClips();
  /** @type {any[]} */ const apps = [];
  return {
    disp, sink, clips, apps,
    library: (/** @type {string} */ dir, /** @type {any} */ layout) => makeLibrary(path.join(dir, "lib"), layout, clips),
    /** @param {Omit<Parameters<typeof launchApp>[0], "disp"|"sink">} o */
    async launch(o) { const a = await launchApp({ ...o, disp, sink }); apps.push(a); return a; },
    async teardown() {
      for (const a of apps) { try { if (a.proc.exitCode === null) await a.kill(); } catch { /* gone */ } }
      disp.stop(); sink.destroy();
    },
  };
}

/** Runs a journey; on failure saves a screenshot, the page console and the server log tail under EVIDENCE/<name>. */
export async function journey(/** @type {any} */ ctx, /** @type {string} */ name, /** @type {() => Promise<void>} */ fn) {
  try { await fn(); }
  catch (e) {
    const slug = name.replace(/[^\w-]+/g, "-").slice(0, 60);
    const app = ctx.apps.at(-1);
    try { ctx.disp.shot(path.join(EVIDENCE, `${slug}.png`)); } catch { /* display gone */ }
    if (app) {
      fs.writeFileSync(path.join(EVIDENCE, `${slug}.console.json`), JSON.stringify(app.page.console, null, 1));
      fs.writeFileSync(path.join(EVIDENCE, `${slug}.server.log`), app.serverLog().split("\n").slice(-80).join("\n"));
      try { fs.writeFileSync(path.join(EVIDENCE, `${slug}.page.txt`), await app.page.text()); } catch { /* page gone */ }
    }
    throw e;
  }
}

/** Waits until the page player plays within [min, max] seconds; returns the time. */
export const playingAt = (/** @type {any} */ page, /** @type {number} */ min, max = 1e9, ms = 30000) =>
  page.waitFor(`(() => { const v = document.querySelector("video"); return v && !v.paused && v.readyState >= 3 && v.currentTime >= ${min} && v.currentTime <= ${max} && v.currentTime; })()`, ms);

/** Shows the player controls (real pointer move over the video) and clicks the seek bar at a fraction of its width. */
export async function seekBarTo(/** @type {any} */ app, /** @type {number} */ frac) {
  await showControls(app);
  const r = await app.page.box("sel:[aria-label='Seek']");
  await app.clickAt(r.x + r.w * frac, r.y + r.h / 2);
}
export async function showControls(/** @type {any} */ app) {
  const v = await app.page.box("sel:video");
  await app.hover(v.x + v.w / 2 + 3, v.y + v.h / 2 + 3);
  await app.hover(v.x + v.w / 2 - 3, v.y + v.h / 2 - 3);
}
export const progressOf = async (/** @type {any} */ app, /** @type {string} */ id) => (await app.get("/api/userdata")).json?.user?.progress?.[id];
/** The subtitle line currently drawn over the page player ("" = none). */
export const subtitleLine = (/** @type {any} */ page) => page.eval(`(() => { const host = document.querySelector("[data-player-host]"); const s = host ? [...host.querySelectorAll("span[dir=auto]")].find((e) => e.getBoundingClientRect().height > 0) : null; return s ? s.innerText : ""; })()`);
