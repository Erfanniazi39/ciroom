// Seek accuracy (task 08): a stream-copied seek starts at the keyframe BEFORE t; if the lookup of that keyframe fails or
// times out, /api/seekpoint answers mode "transcode" and /api/stream?mode=transcode starts exactly at t.
// The clip's luma encodes time (Y = 16 + 8·T) with keyframes every 10 s, so the first decoded frame tells where a stream starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

function makeClip(file) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=320x240:r=25:d=25,format=yuv420p,geq=lum='16+8*T':cb=128:cr=128",
    "-f", "lavfi", "-i", "sine=f=440:d=25", "-c:v", "libx264", "-g", "250", "-keyint_min", "250", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
}
/** Downloads a whole stream: { mode: X-Stream-Mode, file } */
const download = (port, url, out) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: url }, (res) => {
    const ws = fs.createWriteStream(out);
    res.pipe(ws);
    ws.on("finish", () => resolve({ status: res.statusCode, mode: String(res.headers["x-stream-mode"] ?? ""), file: out }));
  }).on("error", reject);
});
/** Where the stream's first frame comes from, in source seconds (from its brightness). */
function firstFrameTime(file) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf8" });
  const y = Number(/YAVG=([\d.]+)/.exec(out)?.[1]);
  return (y - 16) / 8;
}
const qs = (file, t) => `path=${encodeURIComponent(file)}&t=${t}`;

test("normal seek: copy mode, starts at the keyframe before t; timed-out lookup: exact transcode, starts at t", async () => {
  // A. normal server
  const a = await startServer();
  let normalStart, normalErr;
  try {
    const file = path.join(a.media, "Movies", "gop.mp4"); makeClip(file);
    const sp = await request({ port: a.port, path: `/api/seekpoint?${qs(file, 15)}` });
    assert.equal(sp.json.mode, "copy");
    assert.ok(Math.abs(sp.json.start - 10) < 0.3, `keyframe start ${sp.json.start}`);
    const d = await download(a.port, `/api/stream?${qs(file, 15)}`, path.join(a.dir, "copy.mp4"));
    assert.match(d.mode, /^copy\//, "normal seeks still stream-copy");
    normalStart = firstFrameTime(d.file); normalErr = Math.abs(normalStart - 15);
    assert.ok(Math.abs(normalStart - sp.json.start) < 0.4, `copy stream starts at its keyframe (${normalStart}) = what seekpoint said (${sp.json.start})`);
    assert.equal((await request({ port: a.port, path: `/api/seekpoint?${qs(file, 0)}` })).json.mode, "copy");
  } finally { a.stop(); }

  // B. the keyframe lookup always times out
  const b = await startServer({ env: { CIROOM_TEST_SEEKPOINT_TIMEOUT_MS: "1" } });
  try {
    const file = path.join(b.media, "Movies", "gop.mp4"); makeClip(file);
    const sp = await request({ port: b.port, path: `/api/seekpoint?${qs(file, 15)}` });
    assert.deepEqual(sp.json, { start: 15, mode: "transcode" });
    const d = await download(b.port, `/api/stream?${qs(file, 15)}&mode=transcode`, path.join(b.dir, "exact.mp4"));
    assert.match(d.mode, /^transcode\//);
    const exactStart = firstFrameTime(d.file);
    console.log(`# stream starts at: copy (before fix) ${normalStart.toFixed(2)} s (off by ${normalErr.toFixed(2)} s), exact mode ${exactStart.toFixed(2)} s, asked 15`);
    assert.ok(Math.abs(exactStart - 15) < 0.3, `exact stream starts at ${exactStart}`);
    // a bad mode value changes nothing
    const e = await download(b.port, `/api/stream?${qs(file, 15)}&mode=weird`, path.join(b.dir, "weird.mp4"));
    assert.match(e.mode, /^copy\//);
  } finally { b.stop(); }
});
