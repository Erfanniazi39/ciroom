// Who may call what: this PC, another device on the LAN (remote off), cross-site pages, wrong Host.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, request, postJson, lanIp } from "./helpers.js";

let s;
before(async () => { s = await startServer(); });
after(() => s.stop());

test("ping answers on this PC", async () => {
  const r = await request({ port: s.port, path: "/api/ping" });
  assert.equal(r.status, 200);
  assert.equal(r.json.app, "ciroom");
});

test("cross-site POST (evil Origin, text/plain or JSON) is refused with 403", async () => {
  const a = await request({ port: s.port, path: "/api/remote/enable", method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(a.status, 403);
  const b = await postJson(s.port, "/api/remote/enable", {}, { Origin: "http://evil.example" });
  assert.equal(b.status, 403);
  const c = await postJson(s.port, "/api/remote/enable", {}, { Origin: "null" });
  assert.equal(c.status, 403);
});

test("POST without a JSON content type is refused with 415", async () => {
  const a = await request({ port: s.port, path: "/api/remote/enable", method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(a.status, 415);
  const b = await request({ port: s.port, path: "/api/remote/enable", method: "POST" });
  assert.equal(b.status, 415);
});

test("own origin + JSON passes the gate; GET with a foreign Origin still works", async () => {
  const a = await postJson(s.port, "/api/remote/enable", { on: false }, { Origin: `http://127.0.0.1:${s.port}` });
  assert.notEqual(a.status, 403); assert.notEqual(a.status, 415);
  const b = await request({ port: s.port, path: "/api/ping", headers: { Origin: "http://evil.example" } });
  assert.equal(b.status, 200);
});

test("a domain name in the Host header is refused (DNS rebinding)", async () => {
  const r = await request({ port: s.port, path: "/api/ping", hostHeader: "evil.example" });
  assert.equal(r.status, 403);
});

test("path traversal in the stream routes is refused", async () => {
  const r = await request({ port: s.port, path: "/api/stream?path=" + encodeURIComponent("/etc/passwd") });
  assert.ok(r.status >= 400, "status " + r.status);
  assert.ok(!/root:/.test(r.text));
});

const ip = lanIp();
test("another device on the LAN: everything is 403 while the phone remote is off", { skip: !ip }, async () => {
  for (const p of ["/api/ping", "/api/library", "/api/userdata", "/api/play"]) {
    const r = await request({ port: s.port, host: ip, path: p, hostHeader: `${ip}:${s.port}` });
    assert.equal(r.status, 403, p);
  }
});

test("another device on the LAN cannot reach user data even with the remote on, and cannot pair without a PIN", { skip: !ip }, async () => {
  const en = await postJson(s.port, "/api/remote/enable", { on: true });
  assert.equal(en.status, 200);
  const me = await request({ port: s.port, host: ip, path: "/api/remote/me", hostHeader: `${ip}:${s.port}` });
  assert.equal(me.status, 200);
  assert.equal(me.json.paired, false);
  const data = await request({ port: s.port, host: ip, path: "/api/userdata", hostHeader: `${ip}:${s.port}` });
  assert.equal(data.status, 401);
  // A phone that is not paired cannot send commands or pair with a wrong PIN (no pairing is open → 409).
  const cmd = await request({ port: s.port, host: ip, path: "/api/remote/cmd", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", hostHeader: `${ip}:${s.port}` });
  assert.equal(cmd.status, 401);
  const pair = await request({ port: s.port, host: ip, path: "/api/remote/pair", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "000000", name: "x" }), hostHeader: `${ip}:${s.port}` });
  assert.equal(pair.status, 409);
  const play = await request({ port: s.port, host: ip, path: "/api/play", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", hostHeader: `${ip}:${s.port}` });
  assert.equal(play.status, 401);
  const dis = await postJson(s.port, "/api/remote/enable", { on: false });
  assert.equal(dis.status, 200);
});

test("party routes are closed while the party is off", async () => {
  const r = await request({ port: s.port, path: "/api/party/stream" });
  assert.ok([403, 404, 409].includes(r.status), "status " + r.status);
});
