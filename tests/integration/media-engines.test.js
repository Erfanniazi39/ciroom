// Integration: Node server ↔ ffmpeg/ffprobe/mpv as real external programs. What happens at the process boundary when a
// program is missing, dies mid-stream, or is started and stopped many times in a row; and that none of it ever changes a
// media file. Real tools; a missing tool is simulated with a PATH that only holds the others. Linux only (/proc).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan, until, sleep, scratch } from "../functional/env.js";
import { HAS_FFMPEG, HAS_MPV } from "../fixtures/media.js";
import { LINUX, streamsOf, fingerprint, openStream } from "./procs.js";

const which = (/** @type {string} */ t) => ["/usr/bin/", "/usr/local/bin/"].map((d) => d + t).find((p) => fs.existsSync(p));
/** A PATH folder that holds only the named tools (symlinks to the real ones). */
function pathWith(/** @type {string} */ dir, /** @type {string[]} */ tools) {
  const bin = path.join(dir, "only-bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const t of tools) { const real = which(t); if (real) fs.symlinkSync(real, path.join(bin, t)); }
  return bin;
}
const q = (/** @type {string} */ f, extra = "") => `?path=${encodeURIComponent(f)}${extra}`;

describe("server ↔ ffmpeg: streams that break, storms of seeks, media never touched", { skip: !LINUX || !HAS_FFMPEG }, () => {
  /** @type {any} */ let s, lib, before0;
  const file = (/** @type {string} */ title) => lib.movies.find((/** @type {any} */ m) => m.title === title).file.path;
  before(async () => {
    s = await startCiRoom({ layout: { "Movies/Alpha 2001/a.mkv": "long.mkv", "Movies/Hevc 2003/h.mkv": "hevc10.mkv", "Movies/Alpha 2001/a.fa.srt": "fa-cp1256.srt" } });
    lib = await scan(s);
    before0 = fingerprint(s.media);
    // Warm-up, like a real session's first video: the server's one-time ffmpeg checks (pacing, GPU encoder) run on the first
    // copy and the first transcode stream. Dropping a stream DURING those checks is D-29 (its own test below).
    for (const f of [file("Alpha"), file("Hevc")]) { const w = openStream(s.port, "/api/stream" + q(f)); await until(() => w.st.bytes > 0, 15000); w.close(); }
    await until(() => streamsOf(s.child.pid).length === 0, 5000);
  });
  after(() => s?.stop());

  test("D-29: the very first stream, dropped within milliseconds (during the one-time ffmpeg checks), leaves no ffmpeg behind", { todo: "D-29" }, async () => {
    const fresh = await startCiRoom({ layout: { "Movies/Alpha 2001/a.mkv": "long.mkv" } });
    try {
      const l = await scan(fresh);
      const f = l.movies[0].file.path;
      await fresh.get("/api/probe" + q(f)); // the player always probes first
      const st = openStream(fresh.port, "/api/stream" + q(f, "&t=100"));
      await sleep(3);
      st.close();
      await sleep(1500);
      const left = streamsOf(fresh.child.pid);
      assert.equal(left.length, 0, `ffmpeg ${left.map((p) => p.pid).join(", ")} still runs (asleep, the video file open) until CiRoom closes`);
    } finally { await fresh.stop(); }
  });

  test("ffmpeg dies in the middle of a stream: the response ends at once (no hanging player) and nothing is left running", async () => {
    const st = openStream(s.port, "/api/stream" + q(file("Alpha")));
    const [ff] = await until(() => { const c = streamsOf(s.child.pid); return c.length ? c : null; }, 8000);
    await until(() => st.st.bytes > 0, 5000);
    const t0 = Date.now();
    process.kill(ff.pid, "SIGKILL");
    const r = await Promise.race([st.done, sleep(3000).then(() => null)]);
    assert.ok(r, "the response ended");
    assert.ok(r.endedAt - t0 < 1500, `ended ${r.endedAt - t0} ms after ffmpeg died`);
    assert.equal(r.status, 200, "documented: headers were already sent, so the break shows only as an early end (the player detects that)");
    await until(() => streamsOf(s.child.pid).length === 0, 1000);
    assert.equal((await s.get("/api/ping")).status, 200);
  });

  test("30 seeks in a row, each stream dropped after 40 ms (copy and transcode): no ffmpeg left behind, server fine", async () => {
    for (let i = 0; i < 30; i++) {
      const f = i % 3 === 0 ? file("Hevc") : file("Alpha");
      const st = openStream(s.port, "/api/stream" + q(f, `&t=${(i * 17) % (f === file("Hevc") ? 9 : 590)}`));
      await sleep(40);
      st.close();
    }
    await until(() => streamsOf(s.child.pid).length === 0, 5000);
    assert.equal((await s.get("/api/ping")).status, 200);
    const p = await s.get("/api/probe" + q(file("Alpha")));
    assert.equal(p.status, 200);
  });

  test("source file deleted while it streams: the open stream carries on (Linux keeps the open file), the next request says it's gone", async () => {
    const dir = path.join(s.media, "Movies/Temp Copy 2009");
    fs.mkdirSync(dir, { recursive: true });
    const victim = path.join(dir, "copy.mkv");
    fs.copyFileSync(file("Alpha"), victim);
    const st = openStream(s.port, "/api/stream" + q(victim, "&t=100"));
    await until(() => st.st.bytes > 0, 8000);
    fs.rmSync(victim);
    const at = st.st.bytes;
    await until(() => st.st.bytes > at, 5000); // still delivering after the delete
    st.close();
    await until(() => streamsOf(s.child.pid).length === 0, 5000);
    // A new request (the player's next seek) must fail with a readable message, not hang or play something else.
    const again = openStream(s.port, "/api/stream" + q(victim));
    const r = await Promise.race([again.done, sleep(5000).then(() => null)]);
    again.close();
    assert.ok(r, "answered");
    assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("everything above, plus thumbnails and subtitle conversion, left every media file byte-for-byte as it was", async () => {
    await s.get("/api/thumb" + q(file("Alpha"), "&t=30"));
    await s.get("/api/subtitle.vtt" + q(file("Alpha"), "&i=0"));
    await s.get("/api/seekpoint" + q(file("Alpha"), "&t=123"));
    const now = fingerprint(s.media);
    assert.deepEqual(now, before0);
  });
});

describe("server ↔ missing or failing programs", { skip: !LINUX || !HAS_FFMPEG }, () => {
  test("D-21: ffmpeg can't be started (missing; the same path as EMFILE/EAGAIN): the request fails, the server keeps running", { todo: "D-21" }, async () => {
    const dir = scratch("it-noff");
    const s = await startCiRoom({ dir, layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" }, env: { PATH: pathWith(dir, ["ffprobe"]) } });
    try {
      const lib = await scan(s);
      const f = lib.movies[0].file.path;
      for (const p of ["/api/seekpoint" + q(f, "&t=3"), "/api/stream" + q(f, "&t=3")]) {
        let status = 0;
        try { status = (await s.get(p)).status; } catch { status = -1; }
        let up = false;
        try { up = (await s.get("/api/ping")).status === 200; } catch { up = false; }
        assert.ok(up, `the whole server died on ${p.split("?")[0]} (answer: ${status})`);
      }
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("D-28: mpv can't be started: /api/play must say so (the window otherwise waits for mpv forever)", { todo: "D-28" }, async () => {
    const dir = scratch("it-nompv");
    const s = await startCiRoom({ dir, layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" }, env: { PATH: pathWith(dir, ["ffprobe", "ffmpeg"]) } });
    try {
      const lib = await scan(s);
      const r = await s.post("/api/play", { path: lib.movies[0].file.path, itemId: lib.movies[0].id });
      await sleep(500);
      const snap = (await s.get("/api/player")).json;
      assert.equal(snap.running, false);
      assert.notEqual(r.status, 200, `answer was ${r.status} ${r.text}: the window then shows "starting" and never an error`);
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("tools missing: Settings is told which ones (the check runs the tools, it doesn't trust PATH)", async () => {
    const dir = scratch("it-tools");
    const s = await startCiRoom({ dir, layout: {}, env: { PATH: pathWith(dir, ["ffprobe"]) } });
    try {
      const r = await s.get("/api/system/tools");
      assert.equal(r.status, 200);
      const missing = JSON.stringify(r.json);
      assert.match(missing, /ffmpeg/);
      assert.match(missing, /mpv/);
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("server ↔ mpv: commands while it starts and right after it dies", { skip: !LINUX || !HAS_FFMPEG || !HAS_MPV }, () => {
  test("pause + seek + volume sent in one burst while mpv is still starting all land, in order", async () => {
    const s = await startCiRoom({ layout: { "Movies/Alpha 2001/a.mkv": "long.mkv" }, mpv: true });
    try {
      const lib = await scan(s);
      await s.post("/api/play", { path: lib.movies[0].file.path, startAt: 10, itemId: lib.movies[0].id, volume: 0 });
      const rs = await Promise.all([
        s.post("/api/player/cmd", { cmd: "seek", value: 400 }),
        s.post("/api/player/cmd", { cmd: "set", name: "volume", value: 33 }),
        s.post("/api/player/cmd", { cmd: "set", name: "speed", value: 1.5 }),
        s.post("/api/player/cmd", { cmd: "pause" }),
      ]);
      assert.ok(rs.every((r) => r.status === 200));
      const p = await until(async () => { const x = (await s.get("/api/player")).json; return x.running && x.duration > 0 && x.paused && x.position >= 399 && x; }, 20000);
      assert.ok(p.position < 410, `position ${p.position}`);
      await until(async () => { const x = (await s.get("/api/player")).json; return x.volume === 33 && x.speed === 1.5; }, 5000);
    } finally { await s.post("/api/player/cmd", { cmd: "stop" }).catch(() => {}); await s.stop(); }
  });

  test("a command sent just after mpv crashed is refused or ignored, never sent to the next mpv", async () => {
    const s = await startCiRoom({ layout: { "Movies/Alpha 2001/a.mkv": "long.mkv", "Movies/Beta 2002/b.mkv": "long.mp4" }, mpv: true });
    try {
      const lib = await scan(s);
      const [a, b] = lib.movies;
      await s.post("/api/play", { path: a.file.path, startAt: 10, itemId: a.id, volume: 0 });
      await until(async () => { const x = (await s.get("/api/player")).json; return x.running && x.position > 11; }, 20000);
      const { mpvOf } = await import("./procs.js");
      process.kill(mpvOf(s)[0].pid, "SIGKILL");
      await until(async () => !(await s.get("/api/player")).json.running, 5000);
      await s.post("/api/player/cmd", { cmd: "seek", value: 500 });
      await s.post("/api/play", { path: b.file.path, startAt: 20, itemId: b.id, volume: 0 });
      const p = await until(async () => { const x = (await s.get("/api/player")).json; return x.running && x.duration > 0 && x.position > 20.5 && x; }, 20000);
      assert.ok(p.position < 40, `the new mpv started at ${p.position}: an old command reached it`);
    } finally { await s.post("/api/player/cmd", { cmd: "stop" }).catch(() => {}); await s.stop(); }
  });
});
