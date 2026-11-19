import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
