// M13: /api/stream?q=low re-encodes to 480p ~1 Mbps (the party guest's "low data" choice); the normal stream is untouched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "./helpers.js";

const have = spawnSync("ffmpeg", ["-version"]).status === 0;
/** @type {Awaited<ReturnType<typeof startServer>>} */ let s;
let file = "";

before(async () => {
  if (!have) return;
  s = await startServer();
  file = path.join(s.media, "Movies", "Clip", "clip.mp4");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 1080p H.264 with noisy detail so a copy is clearly bigger than a 1 Mbps encode.
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=10", "-f", "lavfi", "-i", "sine=duration=10", "-vf", "noise=alls=30:allf=t", "-c:v", "libx264", "-b:v", "6M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  assert.equal(r.status, 0, String(r.stderr));
});
after(() => s?.stop());

const get = (/** @type {string} */ p) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port: s.port, path: p, agent: false }, (res) => {
    const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, mode: res.headers["x-stream-mode"], buf: Buffer.concat(c) }));
  }).on("error", (e) => reject(new Error(e.message + " @" + p)));
});
const probeOut = (/** @type {Buffer} */ buf) => {
  const f = path.join(s.dir, "out.mp4"); fs.writeFileSync(f, buf);
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height,codec_name,profile,level", "-of", "json", f]);
  return JSON.parse(String(r.stdout)).streams[0];
};

test("q=low gives 480p at about 1 Mbps; the default stream is still a copy", { skip: !have }, async () => {
  const q = encodeURIComponent(file);
  const low = /** @type {any} */ (await get(`/api/stream?path=${q}&t=0&q=low&level=0`));
  assert.equal(low.status, 200, s.log());
  assert.equal(low.mode, "low/aac");
  const v = probeOut(low.buf);
  assert.equal(v.height, 480);
  assert.equal(v.codec_name, "h264");
  assert.equal(v.level, 31); // matches the guest's avc1.64001f
  assert.ok((low.buf.length * 8) / 10 < 1.4e6, `bitrate ${(low.buf.length * 8) / 10}`);
  const full = /** @type {any} */ (await get(`/api/stream?path=${q}&t=0&level=0`));
  assert.equal(full.mode, "copy/aac");
  assert.equal(probeOut(full.buf).height, 1080);
  assert.ok(full.buf.length > 2 * low.buf.length);
});

test("seekpoint for q=low is the exact time (no keyframe origin)", { skip: !have }, async () => {
  const r = /** @type {any} */ (await get(`/api/seekpoint?path=${encodeURIComponent(file)}&t=4.5&q=low`));
  assert.equal(JSON.parse(r.buf.toString()).start, 4.5);
});
