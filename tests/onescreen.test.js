// One screen at a time (handoff 4, S1/S5): the phone reports its playing state, the PC pauses on a paused → playing edge
// for the same title only. Part 1: real server through the real phone gate. Part 2: the routes in-process with a fake mpv.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer, request, lanIp, pairedPhone, postJson } from "./helpers.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = lanIp();
const LIB = {
  movies: [
    { kind: "movie", id: "tiny", title: "Tiny", year: 2020, file: { path: "/x/tiny.mp4", sizeBytes: 1, subtitles: [], status: "present" } },
    { kind: "movie", id: "other", title: "Other", year: 2020, file: { path: "/x/other.mp4", sizeBytes: 1, subtitles: [], status: "present" } },
  ],
  series: [], collections: [], roots: [], review: [], scannedAt: new Date().toISOString(),
};
const netFile = path.join(os.tmpdir(), `ciroom-os-net-${process.pid}.txt`);
fs.writeFileSync(netFile, "wifi:HomeWifi|HomeWifi");

/** Collects the JSON messages of an SSE stream. */
function listen(opts, headers = {}) {
  const msgs = [];
  const req = http.get({ ...opts, headers, agent: false }, (res) => {
    let buf = "";
    res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const part = buf.slice(0, i); buf = buf.slice(i + 2); if (part.startsWith("data: ")) try { msgs.push(JSON.parse(part.slice(6))); } catch { /* ignore */ } } });
  });
  req.on("error", () => {});
  return { msgs, close: () => req.destroy() };
}
const yields = (l) => l.msgs.filter((m) => m.cmd === "yield");

// ── Part 1: real server ─────────────────────────────────────────────────────────────────────
let s, phone, win;
before(async () => {
  if (!ip) return;
  s = await startServer({ env: { CIROOM_FAKE_NETWORK_FILE: netFile }, library: LIB });
  phone = await pairedPhone(s);
  win = listen({ host: "127.0.0.1", port: s.port, path: "/api/remote/commands" });
  await wait(200);
});
after(() => { win?.close(); s?.stop(); fs.rmSync(netFile, { force: true }); });
const report = (now) => postJson(s.port, "/api/remote/report", { now, user: null });
const pcPlaying = (id) => ({ meta: { id, title: id, subtitle: null }, page: { paused: false, position: 100, duration: 1000 } });
const pcPaused = (id) => ({ meta: { id, title: id, subtitle: null }, page: { paused: true, position: 100, duration: 1000 } });

test("/api/remote/state: needs the pairing cookie, validates, rate-limits", { skip: !ip }, async () => {
  const un = await request({ port: s.port, host: ip, path: "/api/remote/state", method: "POST", hostHeader: phone.host, headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(un.status, 401);
  for (const b of [{}, { id: "nope", position: 1, playing: true }, { id: "tiny", position: -1, playing: true }, { id: "tiny", position: "x", playing: true }, { id: "tiny", position: 1e9, playing: true }, { id: "tiny", position: 5, playing: "yes" }, { id: "../x", position: 5, playing: true }]) {
    assert.equal((await phone.post("/api/remote/state", b)).status, 400, JSON.stringify(b));
  }
  assert.equal((await phone.post("/api/remote/state", { id: "tiny", position: 5, playing: false })).status, 200);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await phone.post("/api/remote/state", { id: "tiny", position: 5, playing: false })).status);
  assert.ok(codes.includes(429), "more than 4 in 2 s is refused: " + codes);
  await wait(2100);
});

test("yield: only on a paused → playing edge, only for the title the PC plays", { skip: !ip }, async () => {
  const st = (id, playing, position = 100) => phone.post("/api/remote/state", { id, position, playing });
  await st("tiny", false); await wait(2100);
  win.msgs.length = 0;
  await report(pcPlaying("tiny"));
  assert.equal((await st("tiny", true, 100)).status, 200);
  await wait(150);
  assert.equal(yields(win).length, 1, "edge → one yield");
  assert.deepEqual({ id: yields(win)[0].id, by: yields(win)[0].by, position: yields(win)[0].position }, { id: "tiny", by: "phone", position: 100 });
  // heartbeats of a phone that already plays: no new yield
  await wait(600); await st("tiny", true, 105); await wait(600); await st("tiny", true, 110); await wait(150);
  assert.equal(yields(win).length, 1, "heartbeat is not an edge");
  assert.ok(win.msgs.some((m) => m.cmd === "phoneState" && m.id === "tiny" && m.playing === true && m.position === 110), "window sees the phone's live state");
  await wait(1200); await st("tiny", false); await wait(2100);

  // the PC is paused: nothing to yield
  win.msgs.length = 0;
  await report(pcPaused("tiny"));
  await st("tiny", true); await wait(150);
  assert.equal(yields(win).length, 0, "PC paused → no yield");
  await st("tiny", false); await wait(2100);

  // the PC plays a different title: both keep playing
  win.msgs.length = 0;
  await report(pcPlaying("other"));
  await st("tiny", true); await wait(150);
  assert.equal(yields(win).length, 0, "different title → no yield");
  await st("tiny", false); await wait(2100);

  // the PC has no page player report at all
  win.msgs.length = 0;
  await report(null);
  await st("tiny", true); await wait(150);
  assert.equal(yields(win).length, 0);
});

test("/api/remote/info lists the phones that report (PC only)", { skip: !ip }, async () => {
  await wait(2100);
  await phone.post("/api/remote/state", { id: "tiny", position: 42, playing: true });
  const r = await request({ port: s.port, path: "/api/remote/info" });
  const p = r.json.phones.find((x) => x.id === "tiny");
  assert.ok(p && p.position === 42 && p.playing === true && typeof p.name === "string");
  const viaPhone = await phone.get("/api/remote/info");
  assert.equal(viaPhone.status, 403, "phones can't read it");
});

// ── Part 2: in-process with a fake mpv and a moving clock ───────────────────────────────────
test("mpv path + stale phone state (fake mpv, fake clock)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-os-"));
  process.env.CIROOM_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "library-windows.json" : "library.json"), JSON.stringify(LIB));
  const { remoteRoutes } = await import("../server/lib/remote.js");
  const mpv = { isRunning: true, paused: false, cmds: [] };
  const remote = remoteRoutes({ running: () => mpv.isRunning, snapshot: () => ({ paused: mpv.paused, position: 100, duration: 1000, subtitles: [], volume: 100, muted: false }), command: (c) => mpv.cmds.push(c) });
  const srv = http.createServer((req, res) => {
    const json = (c, d) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    const body = (r) => new Promise((ok) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => ok(t ? JSON.parse(t) : {})); });
    remote.handle(req, res, json, body, true).then((h) => { if (!h) json(404, {}); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  process.env.CIROOM_FAKE_NETWORK = "wifi:HomeWifi|HomeWifi";
  await postJson(port, "/api/remote/enable", { on: true });
  await postJson(port, "/api/remote/trust");
  const pin = (await postJson(port, "/api/remote/pair/start")).json.pin;
  const pair = await new Promise((ok) => { const q = http.request({ host: "127.0.0.1", port, path: "/api/remote/pair", method: "POST", headers: { "Content-Type": "application/json" } }, (r) => { r.resume(); ok(String(r.headers["set-cookie"]).split(";")[0]); }); q.end(JSON.stringify({ pin, name: "p" })); });
  const st = (id, playing) => postJson(port, "/api/remote/state", { id, position: 50, playing }, { Cookie: pair });
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  const w = listen({ host: "127.0.0.1", port, path: "/api/remote/commands" });
  try {
    await wait(100);
    await postJson(port, "/api/remote/report", { now: { meta: { id: "tiny" }, page: null }, user: null });
    // mpv plays the same title → mpv is paused directly
    assert.equal((await st("tiny", true)).status, 200);
    assert.deepEqual(mpv.cmds, [{ cmd: "pause" }]);
    await wait(100);
    assert.equal(yields(w).length, 1, "the window is told so it won't save a stale position");
    // heartbeat → no second pause
    assert.equal((await st("tiny", true)).status, 200);
    assert.equal(mpv.cmds.length, 1);
    // stale: after 20 s without news the phone counts as not playing, so its next "playing" is an edge again
    skew += 20_000; mpv.cmds.length = 0;
    assert.equal((await st("tiny", true)).status, 200);
    assert.equal(mpv.cmds.length, 1, "stale entry (>15 s) is not 'already playing'");
    // mpv already paused → untouched
    mpv.paused = true; mpv.cmds.length = 0; skew += 20_000;
    await st("tiny", true);
    assert.equal(mpv.cmds.length, 0);
    // mpv plays a different title → untouched
    mpv.paused = false; skew += 20_000;
    await postJson(port, "/api/remote/report", { now: { meta: { id: "other" }, page: null }, user: null });
    await st("tiny", true);
    assert.equal(mpv.cmds.length, 0);
    // stale entries are not listed in info
    skew += 20_000;
    assert.deepEqual((await request({ port, path: "/api/remote/info" })).json.phones, []);
  } finally { Date.now = realNow; w.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
