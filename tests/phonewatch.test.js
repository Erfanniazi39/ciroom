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
  assert.equal(m.json.title, "Tiny");
  assert.equal(m.json.nextId, null);
  assert.ok(m.json.duration > 5 && m.json.duration < 7);
  assert.ok(m.json.subtitles.length >= 1);
  assert.ok(!m.text.includes(s.media) && !/"path"|"file"/.test(m.text), "no paths: " + m.text);
  const e = await phone.get(`${W}/probe?id=show-s1e1`);
  assert.equal(e.json.title, "Show");
  assert.equal(e.json.subtitle, "S1E1");
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
