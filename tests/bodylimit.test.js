// M6: request bodies are limited (1 MB, 20 MB for artwork upload); over the limit = 413.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, request } from "./helpers.js";

const J = { "Content-Type": "application/json" };
const MB = 1024 * 1024;
const big = (n) => JSON.stringify({ id: "x", kind: "poster", dataUrl: "a".repeat(n) });

/** Sends the body in chunks with no Content-Length, so only the streaming check can stop it. */
const chunked = (port, path, bytes) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { ...J, "Transfer-Encoding": "chunked" } }, (res) => {
    res.resume(); res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", () => resolve("reset"));
  const chunk = Buffer.alloc(64 * 1024, 97);
  let sent = 0;
  (function pump() { while (sent < bytes) { sent += chunk.length; if (!req.write(chunk)) return void req.once("drain", pump); } req.end(); })();
});

test("bodies over the limit get 413, normal ones still work", async () => {
  const s = await startServer();
  try {
    const post = (p, b) => request({ port: s.port, path: p, method: "POST", headers: J, body: b });
    assert.equal((await post("/api/library/scan", "{}")).status, 200, "a normal request works");
    assert.equal((await post("/api/subtitles/key", big(2 * MB))).status, 413, "2 MB to an ordinary route");
    assert.equal((await post("/api/player/cmd", big(MB + 10))).status, 413);
    assert.notEqual((await post("/api/art/upload", big(2 * MB))).status, 413, "artwork upload may be larger");
    assert.equal((await post("/api/art/upload", big(21 * MB))).status, 413, "but not over 20 MB");
    assert.equal(await chunked(s.port, "/api/player/cmd", 2 * MB), 413, "chunked body without a length");
    assert.equal((await request({ port: s.port, path: "/api/ping" })).status, 200, "server still fine");
  } finally { s.stop(); }
});
