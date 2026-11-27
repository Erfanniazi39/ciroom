// Functional: the page player's server side (areas F, H, I) on real synthetic media: probe, stream (copy / transcode /
// no audio / 5.1), seek points, audio-track choice (checked by the tone's pitch), volume levelling, every subtitle kind
// (UTF-8, UTF-16, Windows-1256 Persian, ASS, built-in, broken), thumbnails, missing and broken files.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { startCiRoom, scan, until } from "./env.js";
import { LAYOUT_FULL, HAS_FFMPEG } from "../fixtures/media.js";

const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
/** Runs ffmpeg/ffprobe on a URL of the test server (no proxy), returns stdout as a Buffer. */
const ff = (/** @type {string} */ bin, /** @type {string[]} */ args) => new Promise((resolve, reject) =>
  execFile(bin, args, { env: noProxyEnv, encoding: "buffer", maxBuffer: 64 << 20, timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err))) : resolve(out))));
/** Dominant pitch of a stream's audio: zero crossings per 0.25 s window over the first `sec` seconds, median of the
 *  windows (a seek's first window can be partly silent: the audio starts a moment after the video's keyframe). */
async function pitch(/** @type {string} */ url, sec = 3) {
  const pcm = /** @type {Buffer} */ (await ff("ffmpeg", ["-v", "error", "-i", url, "-t", String(sec), "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]));
  const win = 12000, rates = [];
  for (let w = 0; (w + 1) * win * 2 <= pcm.length; w++) {
    let z = 0, prev = pcm.readInt16LE(w * win * 2);
    for (let i = w * win * 2; i < (w + 1) * win * 2; i += 2) { const v = pcm.readInt16LE(i); if ((v >= 0) !== (prev >= 0)) z++; prev = v; }
    rates.push(z / 2 / 0.25);
  }
  rates.sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)] ?? 0;
}
/** ffprobe of a stream URL → streams. */
async function streamsOf(/** @type {string} */ url) {
  const out = await ff("ffprobe", ["-v", "error", "-show_streams", "-of", "json", "-read_intervals", "%+3", url]);
  return JSON.parse(String(out)).streams;
}
/** GET with only the headers and the first bytes, then closes. */
const head = (/** @type {number} */ port, /** @type {string} */ p, bytes = 4096) => new Promise((resolve, reject) => {
  const q = http.get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
    const chunks = []; let n = 0, done = false;
    const finish = () => { if (done) return; done = true; res.destroy(); resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }); };
    res.on("data", (c) => { chunks.push(c); n += c.length; if (n >= bytes) finish(); });
    res.on("end", finish);
  });
  q.on("error", reject);
});
const children = (/** @type {number} */ pid) => {
  try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map((c) => { try { return fs.readFileSync(`/proc/${c}/comm`, "utf8").trim(); } catch { return "?"; } }); } catch { return []; }
};

describe("page player: server side", { skip: !HAS_FFMPEG }, () => {
  /** @type {any} */ let s, lib;
  const file = (/** @type {string} */ title) => lib.movies.find((m) => m.title === title).file.path;
  const q = (/** @type {string} */ f, extra = "") => `?path=${encodeURIComponent(f)}${extra}`;
  const url = (/** @type {string} */ p) => `http://127.0.0.1:${s.port}${p}`;
  before(async () => { s = await startCiRoom({ layout: LAYOUT_FULL }); lib = await scan(s); });
  after(() => s?.stop());

  test("probe tells each kind of file apart (copy vs transcode, audio tracks, no audio, 5.1)", async () => {
    const alpha = (await s.get("/api/probe" + q(file("Alpha Movie")))).json;
    assert.equal(alpha.copyVideo, true);
    assert.equal(Math.round(alpha.duration), 600);
    assert.deepEqual(alpha.audioTracks.map((t) => t.language), ["eng", "fre"]);
    assert.deepEqual(alpha.embedded.map((e) => e.language), ["English", "Persian"]);
    const hevc = (await s.get("/api/probe" + q(file("HEVC Ten")))).json;
    assert.equal(hevc.copyVideo, false);
    assert.match(hevc.video, /hevc 10-bit/);
    const silent = (await s.get("/api/probe" + q(file("Silent Film")))).json;
    assert.equal(silent.hasAudio, false);
    assert.deepEqual(silent.audioTracks, []);
    const sur = (await s.get("/api/probe" + q(file("Surround")))).json;
    assert.equal(sur.audioTracks[0].channels, 6);
  });

  test("a stream-copied movie: the stream is H.264 + AAC stereo fMP4, mode copy", async () => {
    const h = /** @type {any} */ (await head(s.port, "/api/stream" + q(file("Alpha Movie"))));
    assert.equal(h.status, 200);
    assert.equal(h.headers["content-type"], "video/mp4");
    assert.match(h.headers["x-stream-mode"], /^copy\/aac/);
    assert.equal(h.buf.subarray(4, 8).toString(), "ftyp");
    const st = await streamsOf(url("/api/stream" + q(file("Alpha Movie"))));
    assert.deepEqual(st.map((x) => x.codec_name), ["h264", "aac"]);
    assert.equal(st[1].channels, 2);
  });

  test("an HEVC 10-bit file is transcoded to 8-bit H.264 the browser can play", async () => {
    const h = /** @type {any} */ (await head(s.port, "/api/stream" + q(file("HEVC Ten"))));
    assert.match(h.headers["x-stream-mode"], /^transcode\//);
    const st = await streamsOf(url("/api/stream" + q(file("HEVC Ten"))));
    const v = st.find((x) => x.codec_type === "video");
    assert.equal(v.codec_name, "h264");
    assert.equal(v.pix_fmt, "yuv420p");
    assert.ok(v.height <= 720);
  });

  test("a video without sound streams video only (no broken audio track)", async () => {
    const st = await streamsOf(url("/api/stream" + q(file("Silent Film"))));
    assert.deepEqual(st.map((x) => x.codec_type), ["video"]);
  });

  test("5.1 AC-3 sound is turned into AAC stereo", async () => {
    const st = await streamsOf(url("/api/stream" + q(file("Surround"))));
    const a = st.find((x) => x.codec_type === "audio");
    assert.equal(a.codec_name, "aac");
    assert.equal(a.channels, 2);
  });

  test("audio track choice: a=0 is the English tone (440 Hz), a=1 the French one (1200 Hz); a bad number falls back to the first", async () => {
    const f = file("Alpha Movie");
    const p0 = await pitch(url("/api/stream" + q(f, "&a=0&level=0")));
    const p1 = await pitch(url("/api/stream" + q(f, "&a=1&level=0")));
    const bad = await pitch(url("/api/stream" + q(f, "&a=7&level=0")));
    assert.ok(Math.abs(p0 - 440) < 20, `a=0 → ${p0} Hz`);
    assert.ok(Math.abs(p1 - 1200) < 40, `a=1 → ${p1} Hz`);
    assert.ok(Math.abs(bad - 440) < 20, `a=7 → ${bad} Hz`);
  });

  test("audio track choice also holds after a seek (t=300)", async () => {
    const p1 = await pitch(url("/api/stream" + q(file("Alpha Movie"), "&a=1&t=300&level=0")));
    assert.ok(Math.abs(p1 - 1200) < 40, `${p1} Hz`);
  });

  test("seek point: a copy stream starts at the keyframe at or before t (keyframes every 2 s)", async () => {
    const f = file("Alpha Movie");
    let last = -1;
    for (const t of [0, 1, 37.5, 101, 299.9, 598]) {
      const r = (await s.get("/api/seekpoint" + q(f, `&t=${t}`))).json;
      assert.equal(r.mode, "copy");
      assert.ok(r.start <= t + 0.001 && t - r.start < 2.2, `t=${t} → start ${r.start}`);
      assert.ok(r.start >= last, "monotonic");
      last = r.start;
    }
  });

  test("seek point of a transcoded file is exactly t", async () => {
    assert.deepEqual((await s.get("/api/seekpoint" + q(file("HEVC Ten"), "&t=4.5"))).json, { start: 4.5, mode: "transcode" });
  });

  test("a seek past the end gives a stream that ends at once instead of hanging", async () => {
    const t0 = Date.now();
    const r = /** @type {any} */ (await head(s.port, "/api/stream" + q(file("Silent Film"), "&t=9999"), 1 << 30));
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 10000);
  });

  test("volume levelling: the first stream is unlevelled while the gain is measured, the next one carries it; level=0 never levels", async () => {
    const f = file("Gamma Two");
    const first = /** @type {any} */ (await head(s.port, "/api/stream" + q(f)));
    assert.match(first.headers["x-stream-mode"], /unlevelled-pending|levelled|aac$/);
    await until(async () => (await s.get("/api/probe" + q(f))).json.levelGainDb !== undefined, 20000);
    const gain = (await s.get("/api/probe" + q(f))).json.levelGainDb;
    assert.equal(typeof gain, "number");
    const second = /** @type {any} */ (await head(s.port, "/api/stream" + q(f)));
    assert.equal(Number(second.headers["x-level-gain"]), gain);
    const off = /** @type {any} */ (await head(s.port, "/api/stream" + q(f, "&level=0")));
    assert.equal(off.headers["x-level-gain"], undefined);
    assert.doesNotMatch(off.headers["x-stream-mode"], /levelled/);
  });

  test("subtitles: files next to the video are listed with detected languages, plus the built-in ones", async () => {
    const p = (await s.get("/api/probe" + q(file("Alpha Movie")))).json;
    const names = Object.fromEntries(p.subtitles.map((x) => [x.name, x.language]));
    assert.equal(names["Alpha.Movie.2001.en.srt"], "English");
    assert.equal(names["Alpha.Movie.2001.fa.srt"], "Persian");
    assert.equal(names["Alpha.Movie.2001.utf16.srt"], "Persian", "UTF-16 Persian detected by content");
    assert.ok("Alpha.Movie.2001.styled.ass" in names);
    assert.equal(p.embedded.length, 2);
  });

  test("subtitles: every encoding comes out as readable UTF-8 WebVTT", async () => {
    const p = (await s.get("/api/probe" + q(file("Alpha Movie")))).json;
    const idx = (/** @type {string} */ n) => p.subtitles.find((x) => x.name === n).index;
    const vtt = async (/** @type {string} */ n) => { const r = await s.get("/api/subtitle.vtt" + q(file("Alpha Movie"), `&i=${idx(n)}`)); return r; };
    const en = await vtt("Alpha.Movie.2001.en.srt");
    assert.equal(en.status, 200);
    assert.match(en.text, /^WEBVTT/);
    assert.match(en.text, /(00:)?00:01\.000 --> (00:)?00:04\.000\nHello, how are you\? #1/);
    for (const n of ["Alpha.Movie.2001.fa.srt", "Alpha.Movie.2001.utf16.srt"]) {
      const r = await vtt(n);
      assert.equal(r.status, 200, n);
      assert.match(r.text, /سلام/, `${n} decoded`);
      assert.doesNotMatch(r.text, /�/, `${n} has no broken characters`);
    }
    const ass = await vtt("Alpha.Movie.2001.styled.ass");
    assert.equal(ass.status, 200);
    assert.match(ass.text, /Styled line #1/);
    assert.doesNotMatch(ass.text, /\{\\b1\}/, "ASS override tags are not shown as text");
  });

  test("a broken subtitle file gives 422 (the player shows a message), not garbage", async () => {
    const p = (await s.get("/api/probe" + q(file("Alpha Movie")))).json;
    const i = p.subtitles.find((x) => x.name === "Alpha.Movie.2001.broken.srt").index;
    const r = await s.get("/api/subtitle.vtt" + q(file("Alpha Movie"), `&i=${i}`));
    assert.equal(r.status, 422);
  });

  test("D-10: a broken (binary) subtitle file is not labelled with a language", { todo: "D-10" }, async () => {
    const p = (await s.get("/api/probe" + q(file("Alpha Movie")))).json;
    const b = p.subtitles.find((x) => x.name === "Alpha.Movie.2001.broken.srt");
    assert.equal(b.language, null, `labelled "${b.label}"`);
  });

  test("built-in subtitles: each stream extracts on its own; a stream that doesn't exist is 404", async () => {
    const f = file("Alpha Movie");
    const en = await s.get("/api/subtitle.vtt" + q(f, "&e=0"));
    const fa = await s.get("/api/subtitle.vtt" + q(f, "&e=1"));
    assert.match(en.text, /Hello, how are you\? #1/);
    assert.match(fa.text, /سلام/);
    assert.equal((await s.get("/api/subtitle.vtt" + q(f, "&e=5"))).status, 404);
    assert.equal((await s.get("/api/subtitle.vtt" + q(f, "&e=-1"))).status, 404);
  });

  test("an episode only gets subtitles that belong to it (season folder with several videos)", async () => {
    const one = lib.series.find((x) => x.title === "Show One");
    const e1 = one.seasons[1].episodes.find((e) => e.number === 1).file.path;
    const e3 = one.seasons[1].episodes.find((e) => e.number === 3).file.path;
    assert.deepEqual((await s.get("/api/probe" + q(e1))).json.subtitles.map((x) => x.name), ["Show.One.S02E01.en.srt"]);
    assert.deepEqual((await s.get("/api/probe" + q(e3))).json.subtitles.map((x) => x.name), ["Show.One.S02E03.fa.srt"]);
  });

  test("thumbnails: a JPEG for a time in the video", async () => {
    const r = /** @type {any} */ (await head(s.port, "/api/thumb" + q(file("Alpha Movie"), "&t=120"), 1 << 20));
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/jpeg");
    assert.equal(r.buf[0], 0xff); assert.equal(r.buf[1], 0xd8);
  });

  test("a corrupted video: probe and stream answer an error at once (no hang, no endless spinner)", async () => {
    const f = file("Broken Download");
    const t0 = Date.now();
    const p = await s.get("/api/probe" + q(f));
    assert.equal(p.status, 400);
    assert.ok(p.json.error);
    const st = await s.get("/api/stream" + q(f));
    assert.notEqual(st.status, 200);
    assert.ok(Date.now() - t0 < 15000);
  });

  test("paths outside the library are refused", async () => {
    for (const bad of ["/etc/passwd", `${s.media}/../data/ciroom.db`, "relative/x.mkv", ""]) {
      const r = await s.get("/api/probe" + q(bad));
      assert.equal(r.status, 400, bad);
    }
  });

  test("a video renamed inside its folder since the last scan still plays (the folder decides)", async () => {
    const f = file("Gamma One");
    const renamed = path.join(path.dirname(f), "gamma1.renamed.mkv");
    fs.renameSync(f, renamed);
    try {
      const p = await s.get("/api/probe" + q(f));
      assert.equal(p.status, 200);
      assert.equal(Math.round(p.json.duration), 20);
    } finally { fs.renameSync(renamed, f); }
  });

  test("a title folder deleted since the last scan: a clear error, no other video", async () => {
    const f = file("Zeta Twin");
    const dir = path.dirname(f);
    fs.renameSync(dir, dir + ".gone");
    try {
      const p = await s.get("/api/probe" + q(f));
      assert.equal(p.status, 400);
    } finally { fs.renameSync(dir + ".gone", dir); }
  });

  test("D-09: an episode deleted since the last scan must not play a different episode", async () => {
    const one = lib.series.find((x) => x.title === "Show One");
    const e1 = one.seasons[0].episodes.find((e) => e.number === 1).file.path; // .../S01/EP01/show.one.e1.mkv (no SxxEyy in the name)
    const dir = path.dirname(e1);
    fs.renameSync(dir, dir + ".gone");
    try {
      const p = await s.get("/api/probe" + q(e1));
      assert.equal(p.status, 400, `played something else: ${Math.round(p.json?.duration)} s long (episode 1 is 60 s)`);
    } finally { fs.renameSync(dir + ".gone", dir); }
  });

  test("D-09: a collection film deleted since the last scan must not play the other film of the collection", async () => {
    const f = file("Gamma One"); // Movies/Gamma Saga/Gamma One 2010/gamma1.mkv (20 s); Gamma Two is 30 s
    const dir = path.dirname(f);
    fs.renameSync(dir, dir + ".gone");
    try {
      const p = await s.get("/api/probe" + q(f));
      assert.equal(p.status, 400, `played a ${Math.round(p.json?.duration)} s video instead`);
    } finally { fs.renameSync(dir + ".gone", dir); }
  });

  test("D-09: a path directly in Movies/ that doesn't exist must not play some other movie", async () => {
    const p = await s.get("/api/probe" + q(path.join(s.media, "Movies", "does-not-exist.mkv")));
    assert.equal(p.status, 400, `answered ${p.status} with a ${Math.round(p.json?.duration)} s video`);
  });

  test("two streams at once both work; ffmpeg stops when the player goes away", async () => {
    const pid = s.child.pid;
    const a = /** @type {any} */ (await head(s.port, "/api/stream" + q(file("Alpha Movie"), "&t=100"), 2 << 20));
    const b = /** @type {any} */ (await head(s.port, "/api/stream" + q(file("Beta Film"), "&t=50"), 2 << 20));
    assert.equal(a.buf.subarray(4, 8).toString(), "ftyp");
    assert.equal(b.buf.subarray(4, 8).toString(), "ftyp");
    await until(() => !children(pid).includes("ffmpeg"), 5000);
  });
});
