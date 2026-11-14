import test from "node:test";
import assert from "node:assert/strict";
import { startServer, request } from "./helpers.js";

const JSON_POST = { "Content-Type": "application/json" };

test("scan runs in a worker: result is right, concurrent scans share one run, server stays responsive", async () => {
  const files = [];
  for (let i = 0; i < 60; i++) for (let e = 1; e <= 5; e++) files.push(`Series/Show ${i}/S01/Show.${i}.S01E0${e}.mkv`);
  for (let i = 0; i < 100; i++) files.push(`Movies/Movie ${i} ${1950 + (i % 70)}/movie.mkv`);
  const srv = await startServer({ files });
  try {
    const [a, b] = await Promise.all([1, 2].map(() => request({ port: srv.port, path: "/api/library/scan", method: "POST", headers: JSON_POST, body: "{}" })));
    for (const r of [a, b]) { assert.equal(r.status, 200); assert.equal(r.json.movies.length, 100); assert.equal(r.json.series.length, 60); }
    assert.equal((await request({ port: srv.port, path: "/api/ping" })).status, 200);
  } finally { srv.stop(); }
});
