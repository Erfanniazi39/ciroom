// Desktop journeys with other devices and with failures: the phone (an emulated Android phone browser on the PC's LAN
// address, paired by decoding the QR code the desktop app shows), watching on the phone, a watch party guest, and
// recovery from missing media, an unplugged library, a killed ffmpeg/mpv/server and a phone losing its network.
// The real Android app is NOT driven here (no phone connected to the PC during this run): see the manual checklist.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MISSING } from "./app.js";
import { setup, journey, scratch, playingAt, seekBarTo, showControls, progressOf, sleep, until, EVIDENCE } from "./common.js";
import { LAYOUT_FULL, HAS_MPV } from "../fixtures/media.js";
import { launch as chrome, CHROME } from "../e2e/browser.js";

const skip = MISSING.length ? `missing: ${MISSING.join(", ")}` : !CHROME ? "no Chrome (the phone/guest browser)" : false;
const T = { timeout: 300000 };
// The PC's LAN address as the server picks it: a private IPv4 on a real interface (not VPN/Docker/Tailscale/bridges).
const LAN = Object.entries(os.networkInterfaces()).filter(([n]) => !/^(lo|docker|br-|veth|virbr|tun|tap|wg|outline|tailscale|zt)/.test(n)).flatMap(([, a]) => a ?? [])
  .find((a) => a.family === "IPv4" && !a.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))?.address;
const NET = { CIROOM_FAKE_NETWORK: "e2e-home|Home Wi-Fi (test)" };

/** Decodes the QR code visible on the private display (OpenCV's WeChat decoder). */
function decodeQr(/** @type {string} */ png) {
  const py = `import cv2,sys\nd=cv2.wechat_qrcode_WeChatQRCode()\nr,_=d.detectAndDecode(cv2.imread(sys.argv[1]))\nprint(r[0] if r else "")`;
  return execFileSync("python3", ["-c", py, png], { encoding: "utf8" }).trim();
}
/** A phone: headless Chrome with an Android phone's screen and user agent. */
async function phone(/** @type {string} */ dir) {
  const p = await chrome({ dir, width: 412, height: 915 });
  await p.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  await p.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 12; SM-N975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" });
  await p.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  return p;
}

/** Closes the mini player if one is open (after a playback error the failed player lingers there: D-35). */
async function closeMini(/** @type {any} */ app) {
  await app.page.goto("#/"); await sleep(500);
  if (!(await app.page.eval(`!!document.querySelector("[aria-label='Close mini player']")`))) return false;
  const b = await app.page.box("sel:[data-player-host]");
  await app.hover(b.x + b.w / 2, b.y + b.h / 2);
  await app.click("Close mini player");
  await app.page.waitFor(`!document.querySelector("[aria-label='Close mini player']")`, 5000);
  return true;
}

describe("desktop journeys: phone, watch party, recovery", { skip }, () => {
  /** @type {any} */ let ctx;
  /** @type {any[]} */ const browsers = [];
  before(async () => { ctx = await setup(); });
  after(async () => { for (const b of browsers) await b.close().catch(() => {}); await ctx?.teardown(); });

  test("J11 phone remote: Settings → Phone remote on → trust the network → Pair a phone → the phone opens the QR code's address → paired → PC plays a movie → phone pause/play/seek/volume change the PC's player → phone reloads (reconnect) and sees the PC's state", T, () => journey(ctx, "J11-remote", async () => {
    assert.ok(LAN, "a LAN address on this PC");
    const dir = scratch("j11");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL), env: NET });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.click("Settings", "a");
    await app.click("Phone remote", "[role=switch], button");
    await app.page.waitFor(`/Trust this network|Trusted/.test(document.body.innerText)`, 10000);
    if (await app.page.eval(`/Trust this network/.test(document.body.innerText)`)) await app.click("Trust this network");
    await app.click("Pair a phone");
    await app.page.waitFor(`!!document.querySelector("[aria-label='QR code to pair your phone']")`, 10000);
    await app.page.box("sel:[aria-label='QR code to pair your phone']"); // scrolls it into view
    await app.page.eval(`document.querySelector("[aria-label='QR code to pair your phone']").scrollIntoView({ block: "center", behavior: "instant" }), 1`);
    await sleep(600);
    const png = ctx.disp.shot(path.join(EVIDENCE, "J11-pair-qr.png"));
    const url = decodeQr(png);
    const pin = await app.page.eval(`(document.body.innerText.match(/PIN\\s*(\\d{4,8})/) || [])[1]`);
    fs.writeFileSync(path.join(EVIDENCE, "J11-qr.txt"), `${url}\nPIN ${pin}`);
    assert.match(url, new RegExp(`^http://${LAN.replace(/\./g, "\\.")}:${app.port}/\\?pair=${pin}$`), `QR code holds the pairing address: ${url} (PIN ${pin})`);
    const pdir = scratch("j11-phone");
    const ph = await phone(pdir); browsers.push(ph);
    await ph.goto(url);
    await ph.waitFor(`/Alpha Movie|Nothing playing|Library|Browse/i.test(document.body.innerText)`, 20000);
    await ph.screenshot(path.join(EVIDENCE, "J11-phone-paired.png"));
    await app.page.waitFor(`/1 phone|paired|Remove/i.test(document.body.innerText)`, 10000);
    // The PC plays a movie; the phone sees it
    await app.page.goto("#/watch/alpha-movie?t=60");
    await playingAt(app.page, 60.3);
    await ph.waitFor(`document.body.innerText.includes("Alpha Movie")`, 15000);
    const tap = async (/** @type {string} */ label) => ph.click(label, "button");
    await tap("Pause");
    await app.page.waitFor(`document.querySelector("video").paused`, 8000);
    await ph.waitFor(`!![...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Play")`, 8000);
    await tap("Play");
    await playingAt(app.page, 60.5, 1e9, 8000);
    const t0 = (await app.page.video()).t;
    await tap("Forward 10 seconds");
    await app.page.waitFor(`document.querySelector("video").currentTime > ${t0 + 7}`, 8000);
    const v0 = await app.page.eval(`document.querySelector("video").volume`);
    await ph.eval(`(() => { const r = [...document.querySelectorAll("input[type=range]")].find((x) => x.getAttribute("aria-label") === "Volume"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(r, String(Math.round(r.max * 0.3))); r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
    await app.page.waitFor(`Math.abs(document.querySelector("video").volume - ${v0}) > 0.2`, 8000);
    // Reconnect: the phone reloads and still controls the PC
    await ph.goto(`http://${LAN}:${app.port}/`);
    await ph.waitFor(`document.body.innerText.includes("Alpha Movie")`, 15000);
    await tap("Pause");
    await app.page.waitFor(`document.querySelector("video").paused`, 8000);
    // Network drop on the phone: offline, then back
    await ph.send("Network.enable");
    await ph.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(6000);
    const offText = await ph.text();
    await ph.screenshot(path.join(EVIDENCE, "J11-phone-offline.png"));
    await ph.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await app.key("space"); // the PC plays again while the phone was away
    await ph.waitFor(`!![...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Pause")`, 20000);
    fs.writeFileSync(path.join(EVIDENCE, "J11-phone-offline.txt"), offText);
    await app.close();
  }));

  test("J12 watch on the phone: the phone opens a movie → Watch on phone → it plays on the phone (video advances) → pause → the PC has that position", T, () => journey(ctx, "J12-phone-watch", async () => {
    const dir = scratch("j12");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL), env: NET });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.post("/api/remote/enable", { on: true }); // (the Settings clicks are J11)
    await app.post("/api/remote/trust", {});
    const pin = (await app.post("/api/remote/pair/start", {})).json.pin;
    const ph = await phone(scratch("j12-phone")); browsers.push(ph);
    await until(async () => { try { await ph.goto(`http://${LAN}:${app.port}/?pair=${pin}`); return true; } catch { return false; } }, 15000, 500, "the server on the LAN");
    await ph.waitFor(`/Library|Browse|Nothing playing|Alpha/i.test(document.body.innerText)`, 20000);
    await ph.click("Library", "button");
    await ph.click("Alpha Movie", "button");
    await ph.waitFor(`document.body.innerText.includes("Watch on phone")`, 10000);
    fs.writeFileSync(path.join(EVIDENCE, "J12-phone-title.txt"), await ph.text());
    await ph.click("Watch on phone", "button");
    const g = await ph.waitFor(`(() => { const v = document.querySelector("video"); return v && !v.paused && v.readyState >= 3 && v.currentTime > 0.5 && v.currentTime; })()`, 30000);
    await sleep(6000);
    const g2 = await ph.eval(`document.querySelector("video").currentTime`);
    assert.ok(g2 > g + 4, `phone video advances: ${g} → ${g2}`);
    await ph.screenshot(path.join(EVIDENCE, "J12-phone-playing.png"));
    await ph.eval(`document.querySelector("video").pause(), 1`);
    const at = await ph.eval(`document.querySelector("video").currentTime`);
    await sleep(1500);
    await ph.click("Close", "button");
    const p = await until(async () => { const x = await progressOf(app, "alpha-movie"); return x && Math.abs(x.position - at) < 4 && x; }, 15000, 300, "the PC has the phone's position");
    assert.ok(p);
    await app.close();
  }));

  test("J13 watch party: Settings → Watch party on → Create invite link → a guest browser opens it, joins → follows the host's pause, jump and play → chat both ways → host ends the party → guest is told", T, () => journey(ctx, "J13-party", async () => {
    const dir = scratch("j13");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.click("Settings", "a");
    await app.click("Watch party", "[role=switch], button");
    await app.click("Create invite link");
    const links = await app.page.waitFor(`(() => { const m = document.body.innerText.match(/http:\\/\\/[\\d.]+:\\d+\\/party#i=[\\w-]+/g); return m && m; })()`, 10000);
    const link = links.find((/** @type {string} */ l) => LAN && l.includes(LAN)) ?? links[0];
    await app.page.goto("#/watch/alpha-movie?t=100");
    await playingAt(app.page, 100.3);
    const g = await chrome({ dir: scratch("j13-guest") }); browsers.push(g);
    await g.goto(link);
    await g.waitFor(`!!document.querySelector("input[placeholder='Your name']")`, 15000);
    await g.eval(`document.querySelector("input[placeholder='Your name']").focus()`);
    await g.type("Sara");
    await g.click("Join");
    const g0 = await g.waitFor(`(() => { const v = document.querySelector("video"); return v && !v.paused && v.readyState >= 3 && v.currentTime > 99 && v.currentTime; })()`, 30000);
    assert.ok(Math.abs(g0 - (await app.page.video()).t) < 3);
    const hostKey = async (/** @type {string} */ want) => { // a key lost in the test display: press once more
      await app.key("space");
      try { await app.page.waitFor(want, 3000); } catch { await app.key("space"); await app.page.waitFor(want, 4000); }
    };
    await hostKey(`document.querySelector("video").paused`);
    await g.waitFor(`document.querySelector("video").paused`, 8000);
    await app.key("Right"); await app.key("Right"); await app.key("Right");
    const ht = await app.page.waitFor(`(() => { const v = document.querySelector("video"); return v.currentTime > ${g0 + 25} && v.currentTime; })()`, 8000);
    await g.waitFor(`Math.abs(document.querySelector("video").currentTime - ${ht}) < 1.5`, 12000);
    await hostKey(`!document.querySelector("video").paused`);
    await g.waitFor(`!document.querySelector("video").paused`, 8000);
    await sleep(3000);
    const drift = Math.abs((await app.page.video()).t - (await g.eval(`document.querySelector("video").currentTime`)));
    assert.ok(drift < 1.5, `drift ${drift.toFixed(2)} s`);
    await g.eval(`document.querySelector("input[placeholder='Message…']").focus()`);
    await g.type("سلام from Sara");
    await g.click("Send"); // (CDP's Enter key doesn't submit a form in headless Chrome)
    await g.waitFor(`document.body.innerText.includes("سلام from Sara")`, 8000);
    if (!(await app.page.eval(`document.body.innerText.includes("سلام from Sara")`))) await app.click("Show watch party");
    await app.page.waitFor(`document.body.innerText.includes("سلام from Sara")`, 10000);
    await app.click("sel:input[placeholder^='Message']").catch(() => undefined);
    await app.page.eval(`(() => { const i = [...document.querySelectorAll("input")].find((x) => /message/i.test(x.placeholder)); i.focus(); return !!i; })()`);
    await app.type("hello Sara");
    await app.click("Send");
    await g.waitFor(`document.body.innerText.includes("hello Sara")`, 10000);
    ctx.disp.shot(path.join(EVIDENCE, "J13-host-chat.png"));
    await app.page.goto("#/settings");
    await app.click("Watch party", "[role=switch], button");
    await g.waitFor(`/ended|over|closed/i.test(document.body.innerText)`, 10000);
    await app.close();
  }));

  test("R1+R2 missing media and an unplugged library: Play shows a clear message, the app stays usable; Scan now keeps the library; once back, it plays again", T, () => journey(ctx, "R1-R2-missing", async () => {
    const dir = scratch("r1");
    const media = ctx.library(dir, LAYOUT_FULL);
    const app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    const f = path.join(media, "Movies/Gamma Saga/Gamma Two 2012/gamma2.mkv");
    fs.renameSync(f, f + ".away");
    await app.page.goto("#/movies/gamma-two");
    await app.click("Play");
    const msg = await app.page.waitFor(`(() => { const m = document.body.innerText.match(/[^\\n]*(couldn't|can't|could not|not found|missing|isn't there|no video file)[^\\n]*/i); return m && m[0]; })()`, 25000);
    fs.writeFileSync(path.join(EVIDENCE, "R1-missing-file-message.txt"), msg);
    ctx.disp.shot(path.join(EVIDENCE, "R1-missing-file.png"));
    assert.ok(!/ENOENT|\/home\/|stack|undefined/.test(msg), `message is for people: ${msg}`);
    await app.click("Home", "a");
    await app.page.waitFor(`document.body.innerText.includes("Recently Added")`, 8000);
    fs.renameSync(f + ".away", f);
    await closeMini(app); // D-35: else Play reuses the failed player
    await app.page.goto("#/movies/gamma-two");
    await app.click("Play");
    await playingAt(app.page, 0.3);
    // The whole library folder disappears (drive unplugged)
    await app.page.goto("#/");
    fs.renameSync(media, media + ".unplugged");
    try {
      await app.page.goto("#/movies/beta-film");
      await app.click("Play");
      const m2 = await app.page.waitFor(`(() => { const m = document.body.innerText.match(/[^\\n]*(couldn't|can't|could not|not found|missing|unplugged|isn't there|not connected|no video file)[^\\n]*/i); return m && m[0]; })()`, 25000);
      fs.writeFileSync(path.join(EVIDENCE, "R2-unplugged-play-message.txt"), m2);
      await app.click("Library", "a");
      await app.click("Scan now");
      const m3 = await app.page.waitFor(`(() => { const t = document.body.innerText; return !/Scanning…/.test(t) && (t.match(/[^\\n]*(unplugged|not connected|isn't there|can't be read|not found|missing)[^\\n]*/i) || [])[0]; })()`, 30000);
      fs.writeFileSync(path.join(EVIDENCE, "R2-unplugged-scan-message.txt"), m3);
      ctx.disp.shot(path.join(EVIDENCE, "R2-unplugged-scan.png"));
      const lib = (await app.get("/api/library")).json;
      assert.ok(lib.movies.length > 10, `library kept while unplugged (${lib.movies.length} movies)`);
    } finally { fs.renameSync(media + ".unplugged", media); }
    await closeMini(app); // D-35
    await app.page.goto("#/movies/beta-film");
    await app.click("Play");
    await playingAt(app.page, 0.3);
    await app.close();
  }));

  test("D-35: after \"file missing\", the file comes back and Play on the same title plays it (no need to close the mini player first)", { ...T, todo: "D-35" }, () => journey(ctx, "D-35", async () => {
    const dir = scratch("d35");
    const media = ctx.library(dir, LAYOUT_FULL);
    const app = await ctx.launch({ dir, media });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    const f = path.join(media, "Movies/Gamma Saga/Gamma Two 2012/gamma2.mkv");
    fs.renameSync(f, f + ".away");
    await app.page.goto("#/movies/gamma-two");
    await app.click("Play");
    await app.page.waitFor(`document.body.innerText.includes("No video file found")`, 25000);
    fs.renameSync(f + ".away", f);
    await app.page.goto("#/movies/gamma-two");
    await sleep(500);
    ctx.disp.shot(path.join(EVIDENCE, "D-35-failed-mini-player.png"));
    await app.click("Play");
    const ok = await playingAt(app.page, 0.3, 1e9, 15000).then(() => true, () => false);
    const still = await app.page.eval(`document.body.innerText.includes("No video file found")`);
    await app.close();
    assert.ok(ok && !still, `plays after the file is back: playing=${ok}, error still shown=${still}`);
  }));

  test("R3 the page player's ffmpeg is killed mid-film: playback goes on (or a clear message), nothing left running; mpv killed: the window carries on with the page player", T, () => journey(ctx, "R3-engines", async () => {
    const dir = scratch("r3");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.eval(`(() => { const f = window.fetch; window.__s = []; window.fetch = function (u, o) { const url = String(u?.url ?? u); if (/\\/api\\/(stream|seekpoint|probe)/.test(url)) window.__s.push(Math.round(performance.now()) + " " + url.replace(/path=[^&]*/, "path=…")); return f.apply(this, arguments).then((r) => { if (/\\/api\\/stream/.test(url)) window.__s.push(Math.round(performance.now()) + "  -> " + r.status); return r; }, (e) => { window.__s.push(Math.round(performance.now()) + "  -> failed " + e); throw e; }); }; return 1; })()`);
    await app.page.goto("#/watch/alpha-movie?t=200");
    await playingAt(app.page, 200.3);
    /** @type {any[]} */ const trace = [];
    const sample = async (/** @type {string} */ tag) => { try { const v = await app.page.video(); const b = await app.page.eval(`(() => { const v = document.querySelector("video"); const r = v.buffered; return r.length ? r.start(0).toFixed(1) + "-" + r.end(r.length - 1).toFixed(1) : ""; })()`); trace.push({ tag, ms: Date.now(), t: v?.t?.toFixed(1), paused: v?.paused, ready: v?.ready, buf: b, ffmpeg: app.procs(/frag_keyframe/).length }); } catch (e) { trace.push({ tag, err: String(e) }); } };
    const dump = async () => fs.writeFileSync(path.join(EVIDENCE, "R3-trace.json"), JSON.stringify({ trace, requests: await app.page.eval("window.__s").catch(() => null), console: app.page.console.slice(-15) }, null, 1));
    const ff = await until(() => { const x = app.procs(/frag_keyframe/); return x.length && x; }, 10000, 200, "the stream's ffmpeg");
    for (const p of ff) process.kill(p.pid, "SIGKILL");
    const before = (await app.page.video()).t;
    await sample("killed");
    // Up to 2 minutes are already loaded: jump past that so the player must ask for a new stream
    await seekBarTo(app, 0.7);
    await sample("seeked");
    const outcome = await until(async () => {
      await sample("wait");
      const v = await app.page.video();
      if (v && !v.paused && v.ready >= 3 && v.t > 410) return { ok: "plays", t: v.t };
      const err = await app.page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "Open in full player"); return b ? b.parentElement.innerText : ""; })()`);
      if (err) return { ok: "message", text: err.slice(0, 200) };
      return null;
    }, 30000, 1000, "playback resumes after ffmpeg was killed").catch(async (e) => { await dump(); throw e; });
    await dump();
    // ffmpeg dies and the user just keeps watching: past the end of what was loaded, it must go on
    const ff2 = await until(() => { const x = app.procs(/frag_keyframe/); return x.length && x; }, 10000, 200, "the new stream's ffmpeg").catch(() => []);
    await sleep(3000); // let the player load ahead a little
    for (const p of ff2) process.kill(p.pid, "SIGKILL");
    const bufEnd = await app.page.eval(`(() => { const v = document.querySelector("video"); return v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; })()`);
    const past = await until(async () => { const v = await app.page.video(); return v && v.t > bufEnd + 8 && v; }, Math.max(30000, (bufEnd - (await app.page.video()).t + 40) * 1000), 1000, `playing past ${bufEnd.toFixed(0)} s (the loaded end when ffmpeg died)`).catch((e) => ({ stuck: String(e.message).slice(0, 200) }));
    fs.writeFileSync(path.join(EVIDENCE, "R3-ffmpeg-killed.json"), JSON.stringify({ before, outcome, bufEnd, past }));
    assert.equal(outcome.ok, "plays", JSON.stringify(outcome));
    assert.ok(!past.stuck, `keeps playing past the loaded end after ffmpeg died: ${JSON.stringify(past)}`);
    await seekBarTo(app, 0.4); // back to a normal spot for the mpv part
    await playingAt(app.page, 230, 260);
    if (HAS_MPV) {
      await app.key("space");
      await showControls(app);
      await app.click("Open in full player (mpv)");
      await until(async () => (await app.get("/api/player")).json?.running, 30000, 250, "mpv running");
      await sleep(1500);
      const mpvs = app.procs(/(^|\/)mpv( |$)/).filter((/** @type {any} */ m) => !/\bsh\b/.test(m.cmd));
      for (const m of mpvs) process.kill(m.pid, "SIGKILL");
      await until(async () => !(await app.get("/api/player")).json?.running, 15000, 250, "the server notices mpv died");
      const back = await app.page.waitFor(`(() => { const v = document.querySelector("video"); return v && v.readyState >= 1 && v.currentTime > 225 && v.currentTime; })()`, 20000);
      assert.ok(back > 225, `the page player is back at ${back}`);
      // and the full player can be opened again
      await showControls(app);
      await app.click("Open in full player (mpv)");
      await until(async () => (await app.get("/api/player")).json?.running, 30000, 250, "mpv running again");
      await app.post("/api/player/cmd", { cmd: "stop" });
    }
    await app.close();
    assert.deepEqual(app.procs(/frag_keyframe|(^|\/)mpv( |$)/), [], "nothing left after closing");
  }));

  test("R4 the server dies while the window is open: the window says so, the app brings the server back, and saving works again", T, () => journey(ctx, "R4-server", async () => {
    const dir = scratch("r4");
    const app = await ctx.launch({ dir, media: ctx.library(dir, LAYOUT_FULL) });
    await app.page.waitFor(`document.body.innerText.includes("Alpha Movie")`, 30000);
    await app.page.goto("#/watch/alpha-movie?t=50");
    await playingAt(app.page, 50.3);
    await sleep(2000);
    await app.key("space");
    const srv = app.procs(/server\/index\.js/).filter((/** @type {any} */ p) => !/\bsh\b/.test(p.cmd));
    assert.equal(srv.length, 1, JSON.stringify(srv));
    process.kill(srv[0].pid, "SIGKILL");
    const t0 = Date.now();
    let said = "";
    const watchBar = (async () => { while (Date.now() - t0 < 15000) { try { const m = await app.page.eval(`(document.querySelector("[role=alert]") || {}).innerText || ""`); if (m) { said = m; ctx.disp.shot(path.join(EVIDENCE, "R4-server-down.png")); return; } } catch { /* page busy */ } await sleep(200); } })();
    const again = await until(() => { const x = app.procs(/server\/index\.js/).filter((/** @type {any} */ p) => !/\bsh\b/.test(p.cmd) && p.pid !== srv[0].pid); return x.length && x; }, 30000, 100, "a new server process");
    const procMs = Date.now() - t0;
    await until(async () => (await app.get("/api/ping")).status === 200, 30000, 100, "the server answers again");
    const backMs = Date.now() - t0;
    await watchBar;
    await app.page.waitFor(`!/can't reach|cannot reach|not responding/i.test(document.body.innerText)`, 30000);
    // Saving works again
    await app.key("space");
    await playingAt(app.page, 50.5, 1e9, 20000);
    await sleep(2500);
    await app.key("space");
    const at = (await app.page.video()).t;
    const p = await until(async () => { const x = await progressOf(app, "alpha-movie"); return x && Math.abs(x.position - at) < 2 && x; }, 15000, 300, "progress saved after the restart");
    fs.writeFileSync(path.join(EVIDENCE, "R4-server.json"), JSON.stringify({ said, procMs, backMs, newPid: again[0].pid, saved: p }));
    assert.ok(backMs < 10000, `the server was back in ${backMs} ms`);
    await app.close();
  }));
});
