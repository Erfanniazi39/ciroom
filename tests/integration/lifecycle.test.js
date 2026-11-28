// Integration: process lifecycle between the desktop shell (Rust), the Node server, mpv and ffmpeg.
// Real server, real mpv (no window, no sound), real ffmpeg. What the shell does is reproduced at its boundary: the raw
// bytes it sends to /api/ping, the stdin pipe it closes, the signal it sends. Linux only (/proc).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startCiRoom, scan, until, sleep, scratch } from "../functional/env.js";
import { HAS_FFMPEG, HAS_MPV } from "../fixtures/media.js";
import { LINUX, alive, streamsOf, mpvOf, mediaToolsOn, killAll, openStream, sse } from "./procs.js";

const LAYOUT = { "Movies/Alpha 2001/a.mkv": "long.mkv", "Movies/Beta 2002/b.mkv": "long.mp4" };
const leftovers = /** @type {{ pid: number }[]} */ ([]);
after(() => killAll(leftovers.filter((p) => alive(p.pid))));

/** Raw HTTP over TCP, exactly like the Rust shell's is_ciroom() and the Android app's pc_check (no Node http client in between). */
function raw(/** @type {number} */ port, /** @type {string} */ text, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let out = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(text));
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => s.destroy(), 3000);
  });
}

describe("desktop shell ↔ server: start-up contract", { skip: !LINUX }, () => {
  test("the identity check the shell sends (raw HTTP/1.0 + nonce) gets the exact proof text it looks for", async () => {
    const secret = crypto.randomBytes(16).toString("hex");
    const s = await startCiRoom({ layout: {}, env: { CIROOM_SHELL_SECRET: secret } });
    try {
      const nonce = crypto.randomBytes(16).toString("hex");
      const text = /** @type {string} */ (await raw(s.port, `GET /api/ping?nonce=${nonce} HTTP/1.0\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`));
      assert.ok(text.startsWith("HTTP/1."), text.slice(0, 40));
      assert.ok(text.includes(`"app":"ciroom"`), "the shell looks for this exact text");
      const want = crypto.createHash("sha256").update(secret + nonce).digest("hex");
      assert.ok(text.includes(`"proof":"${want}"`), "proof = sha256(secret + nonce), written without spaces");
      assert.ok(!text.includes(secret), "the secret itself is never sent");
      // A program that is not ours can't produce it: without the secret there is no proof at all.
      const other = await startCiRoom({ layout: {} });
      try {
        const t2 = /** @type {string} */ (await raw(other.port, `GET /api/ping?nonce=${nonce} HTTP/1.0\r\nHost: 127.0.0.1:${other.port}\r\nConnection: close\r\n\r\n`));
        assert.ok(t2.includes(`"app":"ciroom"`) && !t2.includes(`"proof"`), "a CiRoom started by someone else is not taken for ours");
      } finally { await other.stop(); }
    } finally { await s.stop(); }
  });

  test("port already taken by another program: the server exits with a clear message (the shell then picks another port)", async () => {
    const blocker = net.createServer((c) => c.destroy()).listen(0, "127.0.0.1"); // answers nothing (the readiness ping must not hang on it)
    await new Promise((r) => blocker.once("listening", r));
    const port = /** @type {any} */ (blocker.address()).port;
    try {
      await assert.rejects(startCiRoom({ layout: {}, port }), /already in use/);
    } finally { blocker.close(); }
  });

  test("the app's end of stdin closes (window closed or app killed): the server stops within the shell's 4 s, mpv with it", { skip: !HAS_MPV || !HAS_FFMPEG }, async () => {
    const s = await startCiRoom({ layout: LAYOUT, mpv: true, env: { CIROOM_EXIT_WITH_STDIN: "1" } });
    const lib = await scan(s);
    const a = lib.movies.find((/** @type {any} */ m) => m.title === "Alpha");
    await s.post("/api/play", { path: a.file.path, startAt: 50, itemId: a.id, volume: 0 });
    await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.position > 51; }, 20000);
    const players = mpvOf(s);
    leftovers.push(...players);
    assert.equal(players.length, 1);
    const t0 = Date.now();
    s.child.stdin.end();
    await until(() => s.child.exitCode !== null || s.child.signalCode !== null, 4000);
    assert.ok(Date.now() - t0 < 4000);
    await until(() => players.every((p) => !alive(p.pid)), 3000);
    assert.match(s.log(), /shutting down \(app closed\)/);
    await s.stop();
  });
});

describe("server ↔ mpv ↔ ffmpeg: shutdown and crash", { skip: !LINUX || !HAS_MPV || !HAS_FFMPEG }, () => {
  test("clean stop while mpv plays and a page stream runs: both end, mpv's spot is kept and reaches the next window once", async () => {
    const dir = scratch("it-stop");
    let s = await startCiRoom({ dir, layout: LAYOUT, mpv: true });
    const lib = await scan(s);
    const a = lib.movies.find((/** @type {any} */ m) => m.title === "Alpha");
    const b = lib.movies.find((/** @type {any} */ m) => m.title === "Beta");
    await s.post("/api/play", { path: b.file.path, startAt: 200, itemId: b.id, volume: 0 });
    await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.position > 202; }, 20000);
    const stream = openStream(s.port, `/api/stream?path=${encodeURIComponent(a.file.path)}&t=30`);
    const ff = await until(() => { const c = streamsOf(s.child.pid); return c.length ? c : null; }, 8000);
    const players = mpvOf(s);
    leftovers.push(...ff, ...players);
    await s.stop({ keep: true }); // SIGTERM, the clean path
    await until(() => [...ff, ...players].every((p) => !alive(p.pid)), 3000);
    await stream.done;
    // No window was open: the server kept mpv's last position for the next window (never written to the DB by itself).
    const pending = JSON.parse(fs.readFileSync(path.join(s.data, "phone-pending.json"), "utf8"));
    assert.ok(pending[b.id], "position kept");
    assert.ok(pending[b.id].position > 201 && pending[b.id].position < 260, `position ${pending[b.id].position}`);
    s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, mpv: true });
    try {
      const w1 = sse(s.port, "/api/remote/commands");
      await w1.opened;
      const got = await until(() => w1.messages.find((m) => m.cmd === "progress" && m.id === b.id), 3000);
      assert.ok(Math.abs(got.position - pending[b.id].position) < 0.01);
      w1.close();
      const w2 = sse(s.port, "/api/remote/commands");
      await w2.opened;
      await sleep(500);
      assert.ok(!w2.messages.some((m) => m.cmd === "progress"), "handed over once, not again to the next window");
      w2.close();
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("background ffmpeg jobs (volume measuring, skip-intro detection) end with a clean stop", async () => {
    const layout = { ...LAYOUT };
    for (let e = 1; e <= 4; e++) layout[`Series/Show/S01/Show.S01E0${e}.mkv`] = `ep6${e}.mkv`;
    const s = await startCiRoom({ layout, env: { CIROOM_BACKGROUND: "1" } });
    const lib = await scan(s);
    const stream = openStream(s.port, `/api/stream?path=${encodeURIComponent(lib.movies[0].file.path)}`); // first stream: measures loudness
    const running = await until(() => { const l = mediaToolsOn(s.media); return l.length >= 2 ? l : null; }, 15000);
    leftovers.push(...running);
    await s.stop({ keep: true });
    await stream.done;
    await until(() => mediaToolsOn(s.media).length === 0, 3000);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  test("D-23: server crash while mpv plays: mpv must not live on unseen, and the next play must not open a second mpv", { todo: "D-23" }, async () => {
    const dir = scratch("it-crash");
    let s = await startCiRoom({ dir, layout: LAYOUT, mpv: true });
    try {
      const lib = await scan(s);
      const a = lib.movies.find((/** @type {any} */ m) => m.title === "Alpha");
      const b = lib.movies.find((/** @type {any} */ m) => m.title === "Beta");
      await s.post("/api/play", { path: a.file.path, startAt: 100, itemId: a.id, volume: 0 });
      await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.position > 101; }, 20000);
      const first = mpvOf(s);
      leftovers.push(...first);
      await s.stop({ keep: true, signal: "SIGKILL" });
      await sleep(1500);
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache, port: s.port, mpv: true });
      await s.post("/api/play", { path: b.file.path, startAt: 10, itemId: b.id, volume: 0 });
      await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.position > 11; }, 20000);
      const now = mpvOf(s);
      leftovers.push(...now);
      assert.equal(now.length, 1, `mpv processes now: ${now.map((p) => p.pid).join(", ")} (the first one, ${first[0]?.pid}, survived the crash)`);
    } finally {
      await s.post("/api/player/cmd", { cmd: "stop" }).catch(() => {});
      await s.stop(); killAll(leftovers.filter((p) => alive(p.pid))); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Android app ↔ PC: the Connect screen's check (pc_check.rs) against the real server", { skip: !LINUX }, () => {
  test("remote on: the raw request gets a 200 JSON with enabled/paired that pc_check classifies as reachable", async () => {
    const { lanIp, postJson } = await import("../helpers.js");
    const ip = lanIp();
    if (!ip) return; // no private LAN address on this machine (documented environment limit)
    const s = await startCiRoom({ layout: {}, env: { CIROOM_FAKE_NETWORK: "wifi:Home|Home" } });
    try {
      await postJson(s.port, "/api/remote/enable", { on: true });
      await postJson(s.port, "/api/remote/trust");
      await sleep(500);
      const text = /** @type {string} */ (await raw(s.port, `GET /api/remote/me HTTP/1.1\r\nHost: ${ip}:${s.port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`, ip));
      const [head, body] = text.split("\r\n\r\n");
      assert.match(head.split("\r\n")[0], /^HTTP\/1\.1 200/);
      const j = JSON.parse(body.trim());
      assert.equal(j.enabled, true);
      assert.equal(typeof j.paired, "boolean");
      // Remote switched off: the phone gets no answer at all, which pc_check reports as "can't reach the PC" (not "remote is off").
      await postJson(s.port, "/api/remote/enable", { on: false });
      await sleep(500);
      const off = /** @type {string} */ (await raw(s.port, `GET /api/remote/me HTTP/1.1\r\nHost: ${ip}:${s.port}\r\nConnection: close\r\n\r\n`, ip));
      assert.ok(!off.includes('"enabled":false'), "documented: the Off state is never seen by the phone; the server stops listening for other devices");
    } finally { await s.stop(); }
  });
});
