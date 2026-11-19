import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

test("probe and stream answer at once on a cold loudness cache; the gain is measured in the background", async () => {
  const srv = await startServer();
  try {
    const file = path.join(srv.media, "Movies", "quiet.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=60:r=10", "-f", "lavfi", "-i", "sine=f=440:d=60,volume=0.02",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    const q = encodeURIComponent(file);
    let t0 = Date.now();
    const a = await request({ port: srv.port, path: `/api/probe?path=${q}` });
    assert.equal(a.status, 200);
    assert.ok(Date.now() - t0 < 1500, `first probe took ${Date.now() - t0} ms`);
    assert.equal(a.json.levelGainDb, undefined);

    // First stream bytes arrive quickly, unlevelled.
    t0 = Date.now();
    const mode = await new Promise((resolve, reject) => {
      const r = http.get({ port: srv.port, host: "127.0.0.1", path: `/api/stream?path=${q}` }, (res) => {
        res.once("data", () => { const ms = Date.now() - t0; r.destroy(); resolve({ ms, mode: res.headers["x-stream-mode"] }); });
      });
      r.on("error", reject);
    });
    assert.ok(/** @type {any} */ (mode).ms < 2000, `first stream byte took ${/** @type {any} */ (mode).ms} ms`);
    assert.match(String(/** @type {any} */ (mode).mode), /unlevelled-pending/);

    // Later probe has the number.
    let gain;
    for (let i = 0; i < 60 && gain === undefined; i++) {
      await new Promise((r) => setTimeout(r, 500));
      gain = (await request({ port: srv.port, path: `/api/probe?path=${q}` })).json.levelGainDb;
    }
    assert.equal(typeof gain, "number");
    assert.ok(gain > 5, `quiet clip should get a boost, got ${gain}`);
  } finally { srv.stop(); }
});
