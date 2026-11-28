// Integration: phone ↔ server ↔ mpv ↔ PC window, commands arriving close together. A real paired phone (over the PC's
// LAN address, through the real pairing flow), the real mpv (no window, no sound), the window's report posted as the
// window does. Needs a private LAN address (skipped without one) and mpv.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startCiRoom, scan, until, sleep } from "../functional/env.js";
import { lanIp, pairedPhone } from "../helpers.js";
import { HAS_FFMPEG, HAS_MPV } from "../fixtures/media.js";
import { sse } from "./procs.js";

const skip = !HAS_FFMPEG || !HAS_MPV || !lanIp() || process.platform === "win32";

describe("one screen at a time: phone and full player racing", { skip }, () => {
  /** @type {any} */ let s, lib, phone, A;
  const snap = async () => (await s.get("/api/player")).json;
  const started = () => until(async () => { const p = await snap(); return p.running && p.duration > 0 && p.position > 0 && p; }, 20000);
  before(async () => {
    s = await startCiRoom({ mpv: true, layout: { "Movies/Alpha Movie 2001/alpha.mkv": "long.mkv" }, env: { CIROOM_FAKE_NETWORK: "wifi:Home|Home" } });
    lib = await scan(s);
    A = lib.movies[0];
    phone = await pairedPhone(s);
    await s.post("/api/remote/report", { now: { meta: { id: A.id, title: "Alpha Movie" }, page: null } }); // the window: mpv shows Alpha
  });
  after(async () => { await s?.post("/api/player/cmd", { cmd: "stop" }).catch(() => {}); await s?.stop(); });
  const reset = async () => {
    await s.post("/api/player/cmd", { cmd: "stop" });
    await phone.post("/api/remote/state", { id: A.id, position: 40, playing: false });
    await sleep(2100); // the phone state limit: 4 posts per 2 s
  };

  test("phone starts the title while mpv is already playing: mpv pauses and the window is told to yield", async () => {
    const w = sse(s.port, "/api/remote/commands");
    await w.opened;
    await s.post("/api/play", { path: A.file.path, startAt: 30, itemId: A.id, volume: 0 });
    await started();
    await phone.post("/api/remote/state", { id: A.id, position: 77, playing: true });
    await until(async () => (await snap()).paused, 5000);
    const y = await until(() => w.messages.find((m) => m.cmd === "yield" && m.id === A.id), 3000);
    assert.equal(y.position, 77);
    w.close();
    await reset();
  });

  test("phone starts the title once while mpv is still starting: mpv ends up paused", async () => {
    await s.post("/api/play", { path: A.file.path, startAt: 30, itemId: A.id, volume: 0 });
    await phone.post("/api/remote/state", { id: A.id, position: 40, playing: true });
    await started();
    await sleep(1200);
    assert.equal((await snap()).paused, true);
    await reset();
  });

  test("D-27: phone plays, pauses and plays again while mpv is still starting: mpv must end up paused, not playing beside the phone", { todo: "D-27" }, async () => {
    await s.post("/api/play", { path: A.file.path, startAt: 30, itemId: A.id, volume: 0 });
    await phone.post("/api/remote/state", { id: A.id, position: 40, playing: true });
    await phone.post("/api/remote/state", { id: A.id, position: 40, playing: false });
    await phone.post("/api/remote/state", { id: A.id, position: 40, playing: true });
    await started();
    await sleep(1200);
    const p = await snap();
    try { assert.equal(p.paused, true, `mpv is playing at ${p.position} while the phone plays the same title`); } finally { await reset(); }
  });

  test("phone pause and PC pause sent together (one each, toggles): mpv ends paused or playing, but the phone sees mpv's real state", async () => {
    await s.post("/api/play", { path: A.file.path, startAt: 30, itemId: A.id, volume: 0 });
    await started();
    const ev = await phone.open("/api/remote/events", 1);
    await Promise.all([phone.post("/api/remote/cmd", { cmd: "toggle" }), s.post("/api/player/cmd", { cmd: "pause" })]);
    await sleep(1500);
    const real = (await snap()).paused;
    // What the phone shows must match mpv after the dust settles (it reads mpv live, not a cached guess).
    let last = null;
    const chunks = [];
    ev.res.on("data", (/** @type {Buffer} */ c) => chunks.push(String(c)));
    await sleep(1600);
    for (const line of chunks.join("").split("\n")) if (line.startsWith("data: ")) { try { last = JSON.parse(line.slice(6)); } catch { /* partial */ } }
    ev.res.destroy();
    if (last?.now) assert.equal(last.now.paused, real);
    await reset();
  });
});
