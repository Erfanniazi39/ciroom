// Task 16: aborted request bodies, thumbnail queue cap, cover art is not the video.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, request } from "./helpers.js";

test("a request that dies mid-body doesn't hurt the server", async () => {
  const s = await startServer();
  try {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => {
        const c = net.connect(s.port, "127.0.0.1", () => {
          c.write("POST /api/player/cmd HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n0123456789");
          setTimeout(() => { c.destroy(); resolve(undefined); }, 30);
        });
        c.on("error", () => {});
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await request({ port: s.port, path: "/api/ping" })).status, 200);
    assert.ok(!/Unhandled|uncaught/i.test(s.log()), s.log());
  } finally { s.stop(); }
});

test("thumbnail queue is capped: the oldest waiters get 503, the newest are served", async () => {
  const s = await startServer({ env: { CIROOM_TEST_THUMB_QUEUE: "6" } });
  try {
    const f = path.join(s.media, "Movies", "q.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=10:d=120", "-pix_fmt", "yuv420p", f]);
    const q = encodeURIComponent(f);
    const res = [];
    for (let t = 0; t < 100; t++) { if (t % 10 === 0) await new Promise((r) => setTimeout(r, 20)); res.push(request({ port: s.port, path: `/api/thumb?path=${q}&t=${t}`, headers: { Connection: "close" } }).then((r) => r.status)); }
    const st = (await Promise.all(res.map((p, i) => p.catch((e) => `${i}:${e.code}`))));
    const ok = st.filter((x) => x === 200).length, dropped = st.filter((x) => x === 503).length;
    assert.equal(ok + dropped, 100, st.join(","));
    assert.ok(dropped > 0, "some were dropped");
    assert.ok(ok >= 3 && ok <= 3 + 6 + 10, `served ${ok}`);
    // sockets don't connect in strict order, so "newest" is checked loosely: most of the last 8 are served, the first 20 mostly dropped
    assert.ok(st.slice(-8).filter((x) => x === 200).length >= 5, "the newest were served: " + st.join(","));
    assert.ok(st.slice(3, 23).filter((x) => x === 503).length >= 12, "the oldest were dropped: " + st.join(","));
  } finally { s.stop(); }
});

test("cover art first: probe and stream use the real video", async () => {
  const s = await startServer();
  try {
    const dir = s.media + "/Movies";
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.04:r=25", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=4",
      "-f", "lavfi", "-i", "sine=d=4", "-map", "0:v", "-map", "1:v", "-map", "2:a", "-c:v:0", "mjpeg", "-strict", "unofficial", "-pix_fmt:v:0", "yuvj420p", "-c:v:1", "libx264", "-pix_fmt:v:1", "yuv420p", "-c:a", "aac",
      "-disposition:v:0", "attached_pic", "-shortest", path.join(dir, "cover.mp4")]);
    const f = encodeURIComponent(path.join(dir, "cover.mp4"));
    const info = (await request({ port: s.port, path: `/api/probe?path=${f}` })).json;
    assert.equal(info.width, 320, JSON.stringify(info));
    const url = `http://127.0.0.1:${s.port}/api/stream?path=${f}&t=0&mode=transcode`;
    const dims = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", url], { encoding: "utf8" }).trim();
    assert.equal(dims, "320", "stream is the real video, not the 64px cover");
  } finally { s.stop(); }
});
