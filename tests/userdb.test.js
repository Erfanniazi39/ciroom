// User database: round trip, refusal of incomplete state, this-PC-only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, request, postJson, lanIp } from "./helpers.js";

let s;
before(async () => { s = await startServer(); });
after(() => s.stop());
const put = (p, state) => postJson(s.port, p, { state }, {}, "PUT");

test("before the import: GET says not imported, PUT is refused with 409", async () => {
  const g = await request({ port: s.port, path: "/api/userdata" });
  assert.equal(g.status, 200);
  assert.equal(g.json.imported, false);
  const r = await put("/api/userdata/user", { progress: {}, favorites: [], history: [] });
  assert.equal(r.status, 409);
});

test("import, save, read back", async () => {
  const imp = await postJson(s.port, "/api/userdata/import", { user: { progress: {}, favorites: [], watchlist: [], history: [] }, settings: { theme: "dark" } });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.imported, true);
  const state = {
    progress: { m1: { position: 120, duration: 6000, watched: false, updatedAt: Date.now() } },
    favorites: ["m1"], watchlist: ["m2"], history: [{ id: "m1", at: Date.now() }],
  };
  const w = await put("/api/userdata/user", state);
  assert.equal(w.status, 200, w.text);
  const g = await request({ port: s.port, path: "/api/userdata" });
  assert.equal(g.json.imported, true);
  assert.equal(g.json.user.progress.m1.position, 120);
  assert.deepEqual(g.json.user.favorites, ["m1"]);
  assert.deepEqual(g.json.user.watchlist, ["m2"]);
  assert.equal(g.json.settings.theme, "dark");
});

test("incomplete or empty state is refused and never wipes the data", async () => {
  for (const bad of [null, {}, { progress: {} }, { progress: {}, favorites: [] }, { progress: {}, favorites: "x", history: [] }]) {
    const r = await put("/api/userdata/user", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const s2 = await put("/api/userdata/settings", [1, 2]);
  assert.equal(s2.status, 400);
  const g = await request({ port: s.port, path: "/api/userdata" });
  assert.equal(g.json.user.progress.m1.position, 120);
  assert.deepEqual(g.json.user.favorites, ["m1"]);
});

test("a second import does not overwrite", async () => {
  const imp = await postJson(s.port, "/api/userdata/import", { user: { progress: {}, favorites: [], watchlist: [], history: [] } });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.user.progress.m1.position, 120);
});

test("user data is not reachable from another device", { skip: !lanIp() }, async () => {
  const ip = lanIp();
  const r = await request({ port: s.port, host: ip, path: "/api/userdata", hostHeader: `${ip}:${s.port}` });
  assert.equal(r.status, 403);
});
