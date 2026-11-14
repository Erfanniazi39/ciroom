import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

const make = (/** @type {string} */ file, /** @type {number} */ secs) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=64x64:d=${secs}:r=10`, "-pix_fmt", "yuv420p", file]);

test("probe cache: a replaced video file is probed again (key is path+size+mtime)", async () => {
  const srv = await startServer();
  try {
    const file = path.join(srv.media, "Movies", "clip.mp4");
    make(file, 2);
    const q = `/api/probe?path=${encodeURIComponent(file)}`;
    const a = await request({ port: srv.port, path: q });
    assert.equal(a.status, 200);
    assert.ok(Math.abs(a.json.duration - 2) < 0.3, `first duration ${a.json.duration}`);
    make(file, 5); // same path, new content
    const b = await request({ port: srv.port, path: q });
    assert.ok(Math.abs(b.json.duration - 5) < 0.3, `after replace ${b.json.duration}`);
  } finally { srv.stop(); }
});
