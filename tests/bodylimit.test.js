// M6: request bodies are limited (1 MB, 20 MB for artwork upload); over the limit = 413.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, request } from "./helpers.js";

const J = { "Content-Type": "application/json" };
const MB = 1024 * 1024;
const big = (n) => JSON.stringify({ id: "x", kind: "poster", dataUrl: "a".repeat(n) });

// The server answers 413 and closes the connection while a big body is still being sent. Depending on timing the client
// then sees the 413, or only EPIPE/ECONNRESET from its own write (CI hit EPIPE twice in a row). Both mean "refused";
// the last check proves the server is still fine.
const REFUSED = [413, "reset"];
/** POSTs a body; gives the status, or "reset" if the server cut the upload off before the client read the answer. */
const post = (port, path, body) => new Promise((resolve, reject) => {
  let status = null;
  const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: J }, (res) => {
    status = res.statusCode; res.resume(); res.on("end", () => resolve(status)); res.on("error", () => resolve(status));
  });
  req.on("error", (e) => (["EPIPE", "ECONNRESET"].includes(/** @type {any} */ (e).code) ? resolve(status ?? "reset") : reject(e)));
  req.end(body);
});

/** Sends the body in chunks with no Content-Length, so only the streaming check can stop it. */
const chunked = (port, path, bytes) => new Promise((resolve) => {
  let status = null;
  const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { ...J, "Transfer-Encoding": "chunked" } }, (res) => {
    status = res.statusCode; res.resume(); res.on("end", () => resolve(status));
  });
  req.on("error", () => resolve(status ?? "reset"));
  const chunk = Buffer.alloc(64 * 1024, 97);
  let sent = 0;
  (function pump() { while (sent < bytes) { sent += chunk.length; if (!req.write(chunk)) return void req.once("drain", pump); } req.end(); })();
});

test("bodies over the limit get 413, normal ones still work", async () => {
  const s = await startServer();
  try {
    const p = (path, b) => post(s.port, path, b);
    assert.equal(await p("/api/library/scan", "{}"), 200, "a normal request works");
    assert.ok(REFUSED.includes(await p("/api/subtitles/key", big(2 * MB))), "2 MB to an ordinary route");
    assert.ok(REFUSED.includes(await p("/api/player/cmd", big(MB + 10))), "just over 1 MB");
    assert.ok(!REFUSED.includes(await p("/api/art/upload", big(2 * MB))), "artwork upload may be larger");
    assert.ok(REFUSED.includes(await p("/api/art/upload", big(21 * MB))), "but not over 20 MB");
    assert.ok(REFUSED.includes(await chunked(s.port, "/api/player/cmd", 2 * MB)), "chunked body without a length");
    assert.equal((await request({ port: s.port, path: "/api/ping" })).status, 200, "server still fine");
  } finally { s.stop(); }
});
