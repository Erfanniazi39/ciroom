// Who may call every route: a snapshot. Every route the server answers is called as
//   (a) another device on the LAN that is NOT paired,
//   (b) a paired phone,
//   (c) a joined watch-party guest,
// and the status code is compared with the table below. A new route must be added to ROUTES and to EXPECT, so
// nobody can add a route without deciding who may call it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, request, postJson, pairedPhone, lanIp } from "./helpers.js";

const ip = lanIp();

/** Every route served today. [method, path (with a query where the phone gate needs one)] */
export const ROUTES = [
  ["GET", "/api/ping"], ["GET", "/api/system/tools"],
  ["GET", "/api/library"], ["POST", "/api/library/scan"],
  ["GET", "/api/meta"], ["GET", "/api/meta?x=1"], ["GET", "/api/meta/unmatched"], ["POST", "/api/meta/fetch"], ["POST", "/api/meta/trailer"], ["POST", "/api/meta/imdb"], ["POST", "/api/meta/reset"],
  ["GET", "/api/art"], ["GET", "/api/art?x=1"], ["GET", "/api/art/file/none.jpg"], ["POST", "/api/art/url"], ["POST", "/api/art/upload"], ["POST", "/api/art/reset"],
  ["GET", "/api/settings"], ["POST", "/api/settings"], ["POST", "/api/tmdb/search"], ["POST", "/api/tmdb/apply"], ["POST", "/api/tmdb/match"],
  ["GET", "/api/userdata"], ["PUT", "/api/userdata/user"], ["PUT", "/api/userdata/settings"], ["POST", "/api/userdata/import"],
  ["GET", "/api/markers/status"], ["GET", "/api/markers?path=x"],
  ["POST", "/api/files/facts"], ["GET", "/api/probe?path=x"], ["GET", "/api/stream?path=x"], ["GET", "/api/seekpoint?path=x"], ["GET", "/api/subtitle.vtt?path=x"], ["GET", "/api/thumb?path=x"],
  ["GET", "/api/subsearch/config"], ["POST", "/api/subsearch/key"], ["GET", "/api/subsearch/downloaded"], ["POST", "/api/subsearch/remove"], ["POST", "/api/subsearch/search"], ["POST", "/api/subsearch/download"],
  ["GET", "/api/player"], ["POST", "/api/player/cmd"], ["POST", "/api/play"], ["POST", "/api/open-trailer"], ["GET", "/api/media-root"], ["POST", "/api/media-root"],
  ["GET", "/api/remote/me"], ["POST", "/api/remote/pair"], ["GET", "/api/remote/events"], ["POST", "/api/remote/progress"], ["POST", "/api/remote/state"], ["POST", "/api/remote/cmd"],
  ["GET", "/api/remote/watch/probe?id=x"], ["GET", "/api/remote/watch/seekpoint?id=x"], ["GET", "/api/remote/watch/stream?id=x"], ["GET", "/api/remote/watch/subtitle.vtt?id=x"], ["GET", "/api/remote/watch/thumb?id=x"], ["GET", "/api/remote/watch/other?id=x"],
  ["GET", "/api/remote/info"], ["POST", "/api/remote/enable"], ["POST", "/api/remote/trust"], ["POST", "/api/remote/untrust"], ["POST", "/api/remote/pair/start"], ["POST", "/api/remote/pair/cancel"], ["POST", "/api/remote/revoke"], ["POST", "/api/remote/report"], ["GET", "/api/remote/commands"],
  ["GET", "/party"], ["GET", "/party/app.js"], ["GET", "/party/app.css"], ["GET", "/party/nope"],
  ["GET", "/api/party/me"], ["POST", "/api/party/join"], ["POST", "/api/party/status"], ["POST", "/api/party/chat"], ["POST", "/api/party/cmd"], ["GET", "/api/party/events"],
  ["GET", "/api/party/probe?k=x"], ["GET", "/api/party/seekpoint?k=x"], ["GET", "/api/party/stream?k=x"], ["GET", "/api/party/subtitle.vtt?k=x"],
  ["GET", "/api/party/host/info"], ["POST", "/api/party/host/enable"], ["POST", "/api/party/host/invite"], ["POST", "/api/party/host/invite/cancel"], ["POST", "/api/party/host/revoke"], ["POST", "/api/party/host/settings"], ["POST", "/api/party/host/state"], ["POST", "/api/party/host/chat"], ["GET", "/api/party/host/events"], ["GET", "/api/party/host/nope"],
  ["GET", "/api/party/nope"],
  ["GET", "/api/nope"], ["POST", "/api/nope"],
  ["POST", "/api/party/leave"], // last: it removes the guest
];

/** The expected status codes today: [unpaired LAN device, paired phone, party guest]. Filled from a real run, then read through. */
export const EXPECT = /** @type {Record<string, [number, number, number]>} */ ({
  "GET /api/ping": [401, 403, 401],
  "GET /api/system/tools": [401, 403, 401],
  "GET /api/library": [401, 200, 401],
  "POST /api/library/scan": [401, 403, 401],
  "GET /api/meta": [401, 200, 401],
  "GET /api/meta?x=1": [401, 200, 401], // deliberate fix (task 19): routes match on the path, a query string no longer turns a phone away from a valid route,
  "GET /api/meta/unmatched": [401, 403, 401],
  "POST /api/meta/fetch": [401, 403, 401],
  "POST /api/meta/trailer": [401, 403, 401],
  "POST /api/meta/imdb": [401, 403, 401],
  "POST /api/meta/reset": [401, 403, 401],
  "GET /api/art": [401, 200, 401],
  "GET /api/art?x=1": [401, 200, 401], // same fix,
  "GET /api/art/file/none.jpg": [401, 404, 401],
  "POST /api/art/url": [401, 403, 401],
  "POST /api/art/upload": [401, 403, 401],
  "POST /api/art/reset": [401, 403, 401],
  "GET /api/settings": [401, 403, 401],
  "POST /api/settings": [401, 403, 401],
  "POST /api/tmdb/search": [401, 403, 401],
  "POST /api/tmdb/apply": [401, 403, 401],
  "POST /api/tmdb/match": [401, 403, 401],
  "GET /api/userdata": [401, 403, 401],
  "PUT /api/userdata/user": [401, 403, 401],
  "PUT /api/userdata/settings": [401, 403, 401],
  "POST /api/userdata/import": [401, 403, 401],
  "GET /api/markers/status": [401, 403, 401],
  "GET /api/markers?path=x": [401, 403, 401],
  "POST /api/files/facts": [401, 403, 401],
  "GET /api/probe?path=x": [401, 403, 401],
  "GET /api/stream?path=x": [401, 403, 401],
  "GET /api/seekpoint?path=x": [401, 403, 401],
  "GET /api/subtitle.vtt?path=x": [401, 403, 401],
  "GET /api/thumb?path=x": [401, 403, 401],
  "GET /api/subsearch/config": [401, 403, 401],
  "POST /api/subsearch/key": [401, 403, 401],
  "GET /api/subsearch/downloaded": [401, 403, 401],
  "POST /api/subsearch/remove": [401, 403, 401],
  "POST /api/subsearch/search": [401, 403, 401],
  "POST /api/subsearch/download": [401, 403, 401],
  "GET /api/player": [401, 403, 401],
  "POST /api/player/cmd": [401, 403, 401],
  "POST /api/play": [401, 403, 401],
  "POST /api/open-trailer": [401, 403, 401],
  "GET /api/media-root": [401, 403, 401],
  "POST /api/media-root": [401, 403, 401],
  "GET /api/remote/me": [200, 200, 200],
  "POST /api/remote/pair": [409, 409, 409],
  "GET /api/remote/events": [401, 200, 401],
  "POST /api/remote/progress": [401, 400, 401],
  "POST /api/remote/state": [401, 400, 401],
  "POST /api/remote/cmd": [401, 409, 401],
  "GET /api/remote/watch/probe?id=x": [401, 404, 401],
  "GET /api/remote/watch/seekpoint?id=x": [401, 404, 401],
  "GET /api/remote/watch/stream?id=x": [401, 404, 401],
  "GET /api/remote/watch/subtitle.vtt?id=x": [401, 404, 401],
  "GET /api/remote/watch/thumb?id=x": [401, 404, 401],
  "GET /api/remote/watch/other?id=x": [401, 403, 401],
  "GET /api/remote/info": [401, 403, 401],
  "POST /api/remote/enable": [401, 403, 401],
  "POST /api/remote/trust": [401, 403, 401],
  "POST /api/remote/untrust": [401, 403, 401],
  "POST /api/remote/pair/start": [401, 403, 401],
  "POST /api/remote/pair/cancel": [401, 403, 401],
  "POST /api/remote/revoke": [401, 403, 401],
  "POST /api/remote/report": [401, 403, 401],
  "GET /api/remote/commands": [401, 403, 401],
  "GET /party": [200, 200, 200],
  "GET /party/app.js": [200, 200, 200],
  "GET /party/app.css": [200, 200, 200],
  "GET /party/nope": [401, 401, 404],
  "GET /api/party/me": [200, 200, 200],
  "POST /api/party/join": [401, 401, 401],
  "POST /api/party/status": [401, 401, 200],
  "POST /api/party/chat": [401, 401, 400],
  "POST /api/party/cmd": [401, 401, 400],
  "GET /api/party/events": [401, 401, 200],
  "GET /api/party/probe?k=x": [401, 401, 409],
  "GET /api/party/seekpoint?k=x": [401, 401, 409],
  "GET /api/party/stream?k=x": [401, 401, 409],
  "GET /api/party/subtitle.vtt?k=x": [401, 401, 409],
  "GET /api/party/host/info": [403, 403, 403],
  "POST /api/party/host/enable": [403, 403, 403],
  "POST /api/party/host/invite": [403, 403, 403],
  "POST /api/party/host/invite/cancel": [403, 403, 403],
  "POST /api/party/host/revoke": [403, 403, 403],
  "POST /api/party/host/settings": [403, 403, 403],
  "POST /api/party/host/state": [403, 403, 403],
  "POST /api/party/host/chat": [403, 403, 403],
  "GET /api/party/host/events": [403, 403, 403],
  "GET /api/party/host/nope": [403, 403, 403],
  "GET /api/party/nope": [401, 401, 404],
  "GET /api/nope": [401, 403, 401],
  "POST /api/nope": [401, 403, 401],
  "POST /api/party/leave": [401, 401, 200],
});

const key = (/** @type {string[]} */ r) => `${r[0]} ${r[1]}`;

/** Sends one request and gives back the status as soon as the headers arrive (event streams never end). */
const call = (/** @type {number} */ port, /** @type {string} */ host, /** @type {string} */ method, /** @type {string} */ p, /** @type {string} */ cookie) => new Promise((resolve) => {
  const hasBody = method !== "GET";
  const q = http.request({ host, port, path: p, method, agent: false, headers: { Host: `${host}:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) } }, (res) => {
    resolve(res.statusCode);
    res.destroy();
  });
  q.on("error", () => resolve(0));
  q.setTimeout(8000, () => { resolve(-1); q.destroy(); });
  q.end(hasBody ? "{}" : undefined);
});

let s; let phone; let guestCookie;
before(async () => {
  if (!ip) return;
  s = await startServer({ env: { CIROOM_FAKE_NETWORK: "wifi:HomeWifi|HomeWifi" } });
  phone = await pairedPhone(s);
  await postJson(s.port, "/api/party/host/enable", { on: true });
  const inv = await postJson(s.port, "/api/party/host/invite");
  const token = inv.json.token;
  guestCookie = await new Promise((resolve, reject) => {
    const q = http.request({ host: ip, port: s.port, path: "/api/party/join", method: "POST", headers: { Host: `${ip}:${s.port}`, "Content-Type": "application/json" } }, (r) => { r.resume(); resolve(String(r.headers["set-cookie"] ?? "").split(";")[0]); });
    q.on("error", reject);
    q.end(JSON.stringify({ invite: token, name: "guest" }));
  });
  assert.ok(guestCookie, "guest joined");
});
after(() => s?.stop());

test("every route gives the same status to an unpaired device, a paired phone and a party guest", { skip: !ip, timeout: 240_000 }, async () => {
  const got = /** @type {Record<string, number[]>} */ ({});
  for (const r of ROUTES) {
    const k = key(r);
    const a = await call(s.port, ip, r[0], r[1], "");
    const b = await call(s.port, ip, r[0], r[1], phone.cookie);
    const c = await call(s.port, ip, r[0], r[1], guestCookie);
    got[k] = [a, b, c];
  }
  if (process.env.AUDIENCE_PRINT) console.log("EXPECT_JSON " + JSON.stringify(got));
  const diff = ROUTES.map(key).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(EXPECT[k])).map((k) => `${k}: got ${got[k]} expected ${EXPECT[k]}`);
  assert.deepEqual(diff, []);
});

test("this PC's own calls to a few safe routes still work", { skip: !ip }, async () => {
  assert.equal((await request({ port: s.port, path: "/api/ping" })).status, 200);
  assert.equal((await request({ port: s.port, path: "/api/library" })).status, 200);
  assert.equal((await request({ port: s.port, path: "/api/nope" })).status, 404);
  assert.equal((await request({ port: s.port, path: "/api/party/host/nope" })).status, 404);
});

// ── The table itself ───────────────────────────────────────────────────────────────────────────
const { createCiRoom } = await import("../server/lib/mpv-bridge.js");
const { defineRoutes, AUDIENCES, matchRoute } = await import("../server/lib/routes.js");

test("every route in the table names an audience, and defineRoutes refuses one without", () => {
  const app = createCiRoom(process.env.TMPDIR || "/tmp");
  assert.ok(app.routes.length > 50);
  for (const r of app.routes) assert.ok(AUDIENCES.includes(r.audience), `${r.method} ${r.path}`);
  const h = () => {};
  assert.throws(() => defineRoutes("x", [{ method: "GET", path: "/api/x", handler: h }]), /no audience/);
  assert.throws(() => defineRoutes("x", [{ method: "GET", path: "/api/x", audience: "everyone", handler: h }]), /no audience/);
  assert.throws(() => defineRoutes("x", [{ method: "GET", path: "/api/x", audience: "pc", open: true, handler: h }]), /only phone and guest/);
});

test("the snapshot above covers every route in the table (a new route needs an entry)", () => {
  const app = createCiRoom(process.env.TMPDIR || "/tmp");
  const uncovered = app.routes.filter((r) => !ROUTES.some(([m, p]) => m === r.method && matchRoute([r], m, p.split("?")[0]) === r));
  assert.deepEqual(uncovered.map((r) => `${r.method} ${r.path}`), []);
});

test("phones and guests reach exactly these routes (everything else is for this PC)", () => {
  const app = createCiRoom(process.env.TMPDIR || "/tmp");
  const of = (/** @type {string} */ a) => app.routes.filter((r) => r.audience === a).map((r) => `${r.method} ${r.path}${r.open ? " (open)" : ""}`).sort();
  assert.deepEqual(of("phone"), [
    "GET /api/art", "GET /api/art/file/*", "GET /api/library", "GET /api/meta", "GET /api/remote/events", "GET /api/remote/me (open)",
    "GET /api/remote/watch/probe", "GET /api/remote/watch/seekpoint", "GET /api/remote/watch/stream", "GET /api/remote/watch/subtitle.vtt", "GET /api/remote/watch/thumb",
    "POST /api/remote/cmd", "POST /api/remote/pair (open)", "POST /api/remote/progress", "POST /api/remote/state",
  ].sort());
  assert.deepEqual(of("guest"), [
    "GET /api/party/events", "GET /api/party/me (open)", "GET /api/party/probe", "GET /api/party/seekpoint", "GET /api/party/stream", "GET /api/party/subtitle.vtt",
    "GET /party (open)", "GET /party/app.css (open)", "GET /party/app.js (open)",
    "POST /api/party/chat", "POST /api/party/cmd", "POST /api/party/join (open)", "POST /api/party/leave", "POST /api/party/status",
  ].sort());
  assert.deepEqual(of("public"), []);
});
