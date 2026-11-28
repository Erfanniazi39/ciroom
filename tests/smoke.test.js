import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postJson, request, startServer } from "./helpers.js";

test("/api/smoke does not exist without CIROOM_SMOKE", async () => {
  const s = await startServer();
  try {
    assert.equal((await request({ port: s.port, path: "/api/smoke" })).status, 404);
    assert.equal((await postJson(s.port, "/api/smoke", { ok: true, t: 9 })).status, 404);
    assert.equal(fs.existsSync(path.join(s.data, "smoke-result.json")), false);
    assert.equal((await request({ port: s.port, path: "/api/ping" })).status, 200); // still running
  } finally { await s.stop(); }
});

test("with CIROOM_SMOKE=1 the page's report is saved and the server exits", async () => {
  const s = await startServer({ env: { CIROOM_SMOKE: "1" } });
  try {
    assert.equal((await request({ port: s.port, path: "/api/smoke" })).status, 200);
    assert.equal((await postJson(s.port, "/api/smoke", { ok: true, t: 8.2 })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.data, "smoke-result.json"), "utf8")), { ok: true, t: 8.2, why: "" });
    await new Promise((r) => setTimeout(r, 500));
    await assert.rejects(request({ port: s.port, path: "/api/ping" })); // exited
  } finally { await s.stop(); }
});

test("the built page is marked as smoke mode only with CIROOM_SMOKE=1", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-smoke-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  try {
    for (const on of [false, true]) {
      const s = await startServer({ env: { CIROOM_DIST: dist, ...(on ? { CIROOM_SMOKE: "1" } : {}) } });
      try {
        for (const p of ["/", "/index.html"]) {
          const r = await fetch(`http://127.0.0.1:${s.port}${p}`);
          assert.equal(r.status, 200);
          const text = await r.text();
          assert.equal(text.includes('<meta name="ciroom-smoke"'), on, `${p} with smoke ${on ? "on" : "off"}`);
          assert.equal(Number(r.headers.get("content-length")), Buffer.byteLength(text));
        }
      } finally { await s.stop(); }
    }
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});
