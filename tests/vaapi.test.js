// Hardware encoding (task 09): transcodes use VA-API when the machine has it, x264 otherwise; a failing GPU encode
// falls back to x264 for that stream. Clip: 10-bit H.264 (not copyable, like the library's 10-bit HEVC).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

const hasGpu = process.platform === "linux" && fs.existsSync("/dev/dri/renderD128");
const makeClip = (file) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6",
  "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-g", "50", "-c:a", "aac", "-shortest", file]);
const download = (port, url, out) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: url }, (res) => {
    const ws = fs.createWriteStream(out); res.pipe(ws);
    ws.on("finish", () => resolve({ status: res.statusCode, mode: String(res.headers["x-stream-mode"] ?? ""), enc: String(res.headers["x-encoder"] ?? ""), file: out }));
  }).on("error", reject);
});
const probeOut = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,level,pix_fmt,height", "-of", "json", file], { encoding: "utf8" })).streams[0];
const q = (f, extra = "") => `/api/stream?path=${encodeURIComponent(f)}&t=0${extra}`;

test("CIROOM_NO_VAAPI=1 and an unusable device: x264, still plays; tools reports the encoder", async () => {
  for (const env of [{ CIROOM_NO_VAAPI: "1" }, { CIROOM_VAAPI_DEVICE: "/dev/dri/does-not-exist" }]) {
    const s = await startServer({ env });
    try {
      const f = path.join(s.media, "Movies", "ten.mp4"); makeClip(f);
      const d = await download(s.port, q(f), path.join(s.dir, "o.mp4"));
      assert.equal(d.status, 200);
      assert.match(d.mode, /^transcode\//);
      assert.equal(d.enc, "x264");
      const v = probeOut(d.file);
      assert.deepEqual([v.codec_name, v.pix_fmt, v.height], ["h264", "yuv420p", 720]);
      assert.equal((await request({ port: s.port, path: "/api/system/tools" })).json.encoder, "cpu");
    } finally { s.stop(); }
  }
});

test("GPU present: transcode and low-data use VA-API (High, level 4.0 / 3.1, 8-bit)", { skip: !hasGpu }, async () => {
  const s = await startServer();
  try {
    const f = path.join(s.media, "Movies", "ten.mp4"); makeClip(f);
    assert.equal((await request({ port: s.port, path: "/api/system/tools" })).json.encoder, "vaapi");
    const d = await download(s.port, q(f), path.join(s.dir, "o.mp4"));
    assert.equal(d.enc, "vaapi");
    const v = probeOut(d.file);
    assert.deepEqual([v.codec_name, v.profile, v.level, v.pix_fmt, v.height], ["h264", "High", 40, "yuv420p", 720]);
    const l = await download(s.port, q(f, "&q=low"), path.join(s.dir, "l.mp4"));
    assert.equal(l.enc, "vaapi");
    const lv = probeOut(l.file);
    assert.deepEqual([lv.profile, lv.level, lv.height], ["High", 31, 480]);
  } finally { s.stop(); }
});

test("a GPU encode that fails before sending anything is redone with x264 (and VA-API stays off)", { skip: !hasGpu }, async () => {
  const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ciroom-fakeff-"));
  const real = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  // fails every real h264_vaapi encode, lets the 1-second lavfi detection pass
  fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in *h264_vaapi*) case "$*" in *lavfi*) ;; *) echo "simulated VA-API failure" >&2; exit 1;; esac;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const s = await startServer({ env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  try {
    const f = path.join(s.media, "Movies", "ten.mp4"); makeClip(f);
    assert.equal((await request({ port: s.port, path: "/api/system/tools" })).json.encoder, "vaapi", "detection passes");
    const d = await download(s.port, q(f), path.join(s.dir, "o.mp4"));
    assert.equal(d.status, 200);
    assert.equal(d.enc, "x264", "fell back");
    assert.equal(probeOut(d.file).codec_name, "h264", "and the stream is complete");
    assert.equal((await request({ port: s.port, path: "/api/system/tools" })).json.encoder, "cpu", "VA-API is off for the session");
  } finally { s.stop(); fs.rmSync(bin, { recursive: true, force: true }); }
});
