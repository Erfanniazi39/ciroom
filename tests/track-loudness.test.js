// Volume levelling measures the audio track that plays (task 10): a clip with a quiet first track and a normal second track.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

const headers = (port, url) => new Promise((resolve, reject) => {
  const r = http.get({ host: "127.0.0.1", port, path: url }, (res) => { res.destroy(); resolve(res.headers); });
  r.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
});

test("each audio track gets its own gain; the stream uses the playing track's gain", async () => {
  const s = await startServer();
  try {
    const f = path.join(s.media, "Movies", "two.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=20:r=10", "-f", "lavfi", "-i", "sine=f=300:d=20,volume=0.12", "-f", "lavfi", "-i", "sine=f=600:d=20,volume=1.3",
      "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]);
    const q = encodeURIComponent(f);
    const gain = async (audio) => {
      for (let i = 0; i < 60; i++) {
        const g = (await request({ port: s.port, path: `/api/probe?path=${q}&audio=${audio}` })).json.levelGainDb;
        if (typeof g === "number") return g;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("no gain for track " + audio);
    };
    const g0 = await gain(0), g1 = await gain(1);
    console.log(`# gains: track 0 ${g0} dB, track 1 ${g1} dB, difference ${(g0 - g1).toFixed(1)} dB`);
    assert.ok(g0 - g1 > 20 && g0 - g1 < 27, `the quiet track needs ~24 dB more: ${g0} vs ${g1}`);
    assert.equal((await request({ port: s.port, path: `/api/probe?path=${q}` })).json.levelGainDb, g0, "no ?audio= means track 0");
    // the stream applies the gain of the track it plays
    assert.equal(Number((await headers(s.port, `/api/stream?path=${q}&t=0`))["x-level-gain"]), g0);
    assert.equal(Number((await headers(s.port, `/api/stream?path=${q}&t=0&a=1`))["x-level-gain"]), g1);
  } finally { s.stop(); }
});
