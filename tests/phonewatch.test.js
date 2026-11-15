// Watching on the phone: media routes by library id (W1). Real server, real ffmpeg, a tiny generated video.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request, lanIp, pairedPhone } from "./helpers.js";

const ip = lanIp();
let s, phone;
const netFile = path.join((await import("node:os")).tmpdir(), `ciroom-pw-net-${process.pid}.txt`);
fs.writeFileSync(netFile, "wifi:HomeWifi|HomeWifi");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ffmpegOk = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !ip || !ffmpegOk;

before(async () => {
  if (skip) return;
  s = await startServer({ env: { CIROOM_FAKE_NETWORK_FILE: netFile } });
  const dir = path.join(s.media, "Movies", "Tiny", "Tiny 2020");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tiny.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  fs.writeFileSync(path.join(dir, "tiny.srt"), "1\n00:00:00,500 --> 00:00:02,000\nHello\n");
  const ep = (n) => ({ kind: "episode", id: `show-s1e${n}`, seriesId: "show", season: 1, number: n, title: `Episode ${n}`, file: { path: file, sizeBytes: 1, subtitles: [], status: "present" } });
  const lib = {
    movies: [
      { kind: "movie", id: "tiny", title: "Tiny", year: 2020, file: { path: file, sizeBytes: 1, subtitles: [], status: "present" } },
      { kind: "movie", id: "gone", title: "Gone", year: 2020, file: { path: path.join(s.media, "Movies", "Gone", "gone.mp4"), sizeBytes: 1, subtitles: [], status: "missing" } },
      { kind: "movie", id: "lost", title: "Lost", year: 2020, file: { path: path.join(s.media, "Movies", "Lost", "lost.mp4"), sizeBytes: 1, subtitles: [], status: "present" } },
    ],
    series: [{ kind: "series", id: "show", title: "Show", year: 2020, seasons: [{ number: 1, episodes: [ep(1), ep(2)] }] }],
    collections: [], roots: [], review: [], scannedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(s.data, "library.json"), JSON.stringify(lib));
  // TMDB titles: the PC shows these, so the phone must too (scan titles are "Tiny" / "Show").
  fs.mkdirSync(path.join(s.data, "metadata"), { recursive: true });
  fs.writeFileSync(path.join(s.data, "metadata", "index.json"), JSON.stringify({ tiny: { title: "Tiny II" }, show: { title: "Show Meta", seasons: { 1: { episodes: { 1: { title: "Pilot" } } } } } }));
  phone = await pairedPhone(s);
});
after(() => { if (s) s.stop(); fs.rmSync(netFile, { force: true }); });

const W = "/api/remote/watch";

test("ids: bad / path-like / unknown / missing file / unreadable file are refused", { skip }, async () => {
  for (const id of ["", "../etc/passwd", "a/b", "TINY", "x".repeat(201), "/etc/passwd"]) {
    const r = await phone.get(`${W}/probe?id=${encodeURIComponent(id)}`);
    assert.equal(r.status, 400, `id ${JSON.stringify(id)}`);
  }
  for (const id of ["nope", "gone", "lost"]) {
    const r = await phone.get(`${W}/probe?id=${id}`);
    assert.equal(r.status, 404, id);
    assert.equal(r.json.error, "This video isn't available");
  }
  // A path is never accepted, whatever the parameter.
  const p = await phone.get(`${W}/probe?id=tiny&path=${encodeURIComponent("/etc/passwd")}`);
  assert.equal(p.status, 200);
  assert.ok(!/passwd/.test(p.text));
});

test("no cookie = 401; not on the phone allow-list = 403", { skip }, async () => {
  const r = await request({ port: s.port, host: ip, path: `${W}/probe?id=tiny`, hostHeader: phone.host });
  assert.equal(r.status, 401);
  // Plain /api/probe by path stays closed for phones.
  assert.equal((await phone.get(`/api/probe?path=${encodeURIComponent("/etc/passwd")}`)).status, 403);
  assert.equal((await phone.get("/api/stream?path=x")).status, 403);
});

test("probe answers without any file path, with title, episode code and nextId", { skip }, async () => {
  const m = await phone.get(`${W}/probe?id=tiny`);
  assert.equal(m.status, 200);
  assert.equal(m.json.title, "Tiny II");
  assert.equal(m.json.nextId, null);
  assert.ok(m.json.duration > 5 && m.json.duration < 7);
  assert.ok(m.json.subtitles.length >= 1);
  assert.ok(!m.text.includes(s.media) && !/"path"|"file"/.test(m.text), "no paths: " + m.text);
  const e = await phone.get(`${W}/probe?id=show-s1e1`);
  assert.equal(e.json.title, "Show Meta");
  assert.equal(e.json.subtitle, "S1:E1 · Pilot");
  assert.equal(e.json.nextId, "show-s1e2");
  assert.equal((await phone.get(`${W}/probe?id=show-s1e2`)).json.nextId, null);
});

test("stream starts as fragmented MP4 (ftyp) and q=low is 480p", { skip }, async () => {
  const a = await phone.open(`${W}/stream?id=tiny&t=0`, 20000);
  assert.equal(a.status, 200);
  assert.equal(a.buf.slice(4, 8).toString(), "ftyp");
  a.res.destroy();
  const low = await phone.open(`${W}/stream?id=tiny&t=0&q=low`, 60000);
  assert.equal(low.status, 200);
  const tmp = path.join(s.dir, "low.mp4");
  fs.writeFileSync(tmp, low.buf);
  low.res.destroy();
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", tmp]).toString().trim();
  assert.equal(out, "480");
  const sp = await phone.get(`${W}/seekpoint?id=tiny&t=3`);
  assert.equal(sp.status, 200);
  assert.ok(Number.isFinite(sp.json.start));
});

test("subtitle.vtt serves the file next to the video", { skip }, async () => {
  const r = await phone.get(`${W}/subtitle.vtt?id=tiny&i=0`);
  assert.equal(r.status, 200);
  assert.match(r.text, /WEBVTT/);
  assert.match(r.text, /Hello/);
});

test("a 3rd parallel stream gets 429; closing one frees a slot", { skip }, async () => {
  const one = await phone.open(`${W}/stream?id=tiny&t=0`, 2000);
  const two = await phone.open(`${W}/stream?id=tiny&t=1`, 2000);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  const three = await phone.get(`${W}/stream?id=tiny&t=2`);
  assert.equal(three.status, 429);
  one.res.destroy();
  await wait(500);
  const four = await phone.open(`${W}/stream?id=tiny&t=2`, 2000);
  assert.equal(four.status, 200);
  two.res.destroy(); four.res.destroy();
});

test("switching to another network closes open phone streams", { skip }, async () => {
  const live = await phone.open(`${W}/stream?id=tiny&t=0`, 2000);
  assert.equal(live.status, 200);
  let closed = false;
  live.res.on("close", () => (closed = true));
  live.res.on("error", () => (closed = true));
  fs.writeFileSync(netFile, "wifi:OtherWifi|OtherWifi");
  await request({ port: s.port, path: "/api/remote/info" }); // refreshes the network at once
  await wait(600);
  assert.equal(closed, true);
  fs.writeFileSync(netFile, "wifi:HomeWifi|HomeWifi");
  await request({ port: s.port, path: "/api/remote/info" });
});

// ── W2: progress and subtitle choice go through the PC window ────────────────────────────────────────────
import http from "node:http";

/** The PC window's command stream (loopback). Collects the data lines. */
function windowStream(port) {
  const msgs = [];
  let res;
  const ready = new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/api/remote/commands", agent: false }, (r) => {
      res = r;
      r.setEncoding("utf8");
      let buf = "";
      r.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const m = chunk.match(/^data: (.*)$/m); if (m) msgs.push(JSON.parse(m[1])); } });
      resolve();
    });
  });
  return { msgs, ready, close: () => res?.destroy() };
}
const prog = (body) => phone.post("/api/remote/progress", body);
const fastWait = () => wait(3100);

test("progress: bad ids and bad numbers are 400", { skip }, async () => {
  await fastWait();
  for (const b of [
    { id: "nope", position: 1, duration: 10 }, { id: "../x", position: 1, duration: 10 }, { id: "tiny", position: -1, duration: 10 },
    { id: "tiny", position: 11, duration: 10 }, { id: "tiny", position: 1, duration: 90000 }, { id: "tiny", position: 1, duration: 10, watched: 500 },
    { id: "tiny", position: 1, duration: 10, watched: -2 }, { id: "tiny", position: "x", duration: 10 }, { id: "tiny", duration: 10 }, { id: "tiny", position: 1, duration: 0 },
  ]) {
    const r = await prog({ ...b, final: true });
    assert.equal(r.status, 400, JSON.stringify(b));
    await wait(600);
  }
});

test("progress: a connected PC window gets it on the command stream; the rate limit is 1 per 3 s", { skip }, async () => {
  await fastWait();
  const w = windowStream(s.port);
  await w.ready; await wait(200);
  const a = await prog({ id: "show-s1e1", position: 2.5, duration: 6, watched: 10 });
  assert.equal(a.status, 200);
  assert.equal(a.json.delivered, true);
  const b = await prog({ id: "show-s1e1", position: 3, duration: 6 });
  assert.equal(b.status, 429);
  await wait(600);
  const c = await prog({ id: "show-s1e1", position: 3, duration: 6, final: true }); // a final save only waits 0.5 s
  assert.equal(c.status, 200);
  await wait(300);
  const got = w.msgs.filter((m) => m.cmd === "progress");
  assert.equal(got.length, 2);
  assert.deepEqual({ id: got[0].id, position: got[0].position, duration: got[0].duration, watched: got[0].watched }, { id: "show-s1e1", position: 2.5, duration: 6, watched: 10 });
  assert.ok(got[0].at > 0);
  w.close();
});

test("progress without a window is kept (0600) and handed over first when a window connects", { skip }, async () => {
  await fastWait();
  await wait(300); // the previous window's stream has closed
  const a = await prog({ id: "tiny", position: 1, duration: 6, watched: 4 });
  assert.equal(a.status, 200);
  assert.equal(a.json.delivered, false);
  await wait(600);
  const b = await prog({ id: "tiny", position: 2, duration: 6, watched: 3, final: true }); // newest per id wins, watch time adds up
  assert.equal(b.status, 200);
  const file = path.join(s.data, "phone-pending.json");
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.tiny.position, 2);
  assert.equal(saved.tiny.watched, 7);
  const w = windowStream(s.port);
  await w.ready; await wait(300);
  assert.equal(w.msgs[0].cmd, "progress");
  assert.equal(w.msgs[0].id, "tiny");
  assert.equal(w.msgs[0].position, 2);
  assert.equal(fs.existsSync(file), false);
  w.close();
});

test("subtitle choice: validated, then sent to the window as subPref", { skip }, async () => {
  const w = windowStream(s.port);
  await w.ready; await wait(300);
  // The window counts as online once it reports (or is connected).
  for (const bad of [{ cmd: "subPref", id: "nope", pref: { off: true } }, { cmd: "subPref", id: "tiny" }, { cmd: "subPref", id: "tiny", pref: { language: 5, name: "x" } }, { cmd: "subPref", id: "tiny", pref: { language: "fa" } }]) {
    assert.equal((await phone.post("/api/remote/cmd", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await phone.post("/api/remote/cmd", { cmd: "subPref", id: "tiny", pref: { off: true } })).status, 200);
  assert.equal((await phone.post("/api/remote/cmd", { cmd: "subPref", id: "show-s1e1", pref: { language: "fa", name: "x".repeat(500) } })).status, 200);
  await wait(300);
  const got = w.msgs.filter((m) => m.cmd === "subPref");
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].pref, { off: true });
  assert.equal(got[1].pref.language, "fa");
  assert.equal(got[1].pref.name.length, 200);
  w.close();
});

test("titles: the phone gets the metadata title, like the PC (movie, episode with its own title, episode without)", { skip }, async () => {
  const movie = await phone.get(`${W}/probe?id=tiny`);
  assert.equal(movie.json.title, "Tiny II");
  const e1 = await phone.get(`${W}/probe?id=show-s1e1`);
  assert.equal(e1.json.title, "Show Meta");
  assert.equal(e1.json.subtitle, "S1:E1 · Pilot");
  const e2 = await phone.get(`${W}/probe?id=show-s1e2`);
  assert.equal(e2.json.subtitle, "S1:E2", "no title known yet: just the code");
});
