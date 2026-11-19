// Thumbnail cache cap (task 12e): over the cap, the oldest files are deleted first, down to 75 %.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

test("thumbnails over the cap are pruned, oldest first", async () => {
  const s = await startServer({ env: { CIROOM_THUMB_MAX_MB: "0.03", CIROOM_THUMB_PRUNE_MS: "0" } }); // 30 KB cap
  try {
    const f = path.join(s.media, "Movies", "c.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=10:d=30", "-pix_fmt", "yuv420p", f]);
    const dir = path.join(s.dir, "cache", "thumbs");
    const q = encodeURIComponent(f);
    // make an old file first: a 5-year-old fake thumbnail that must go before any new one
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, "old.jpg"); fs.writeFileSync(old, Buffer.alloc(8000, 1)); const past = new Date(Date.now() - 5 * 365 * 86400_000); fs.utimesSync(old, past, past);
    const sizes = [];
    for (let t = 1; t <= 14; t++) {
      const r = await request({ port: s.port, path: `/api/thumb?path=${q}&t=${t}` });
      assert.equal(r.status, 200);
      await new Promise((r2) => setTimeout(r2, 60)); // the prune runs in the background
      sizes.push(fs.readdirSync(dir).reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0));
    }
    const total = sizes.at(-1);
    assert.ok(total <= 0.03 * 1048576 + 8000, `folder stays near the cap: ${sizes.join(",")}`);
    assert.ok(!fs.existsSync(old), "the oldest file went first");
    assert.ok(fs.readdirSync(dir).length >= 2, "newest thumbnails are kept");
  } finally { s.stop(); }
});
