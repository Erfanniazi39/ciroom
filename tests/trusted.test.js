// Trusted networks: the phone remote works only on a network the user approved (fake network, real server).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { startServer, request, postJson, lanIp } from "./helpers.js";

const ip = lanIp();
let s, netFile;
const setNet = (/** @type {string} */ v) => fs.writeFileSync(netFile, v);
// A refused connection (server not listening for other devices) counts as status 0.
const phoneReq = (/** @type {string} */ p, extra = {}) => request({ port: s.port, host: ip, path: p, hostHeader: `${ip}:${s.port}`, ...extra }).catch((e) => ({ status: 0, json: null, text: String(e.code) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listensOn = (host) => new Promise((res) => { const c = net.connect(s.port, host); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false)); });

before(async () => {
  const dir = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "ciroom-net-"));
  netFile = path.join(dir, "net.txt");
  setNet("wifi:HomeWifi|HomeWifi");
  s = await startServer({ loopbackOnly: true, env: { CIROOM_FAKE_NETWORK_FILE: netFile } });
});
after(() => s.stop());

test("remote on + untrusted network: phones get the server only listens on loopback (nothing reaches phones)", { skip: !ip }, async () => {
  assert.equal((await postJson(s.port, "/api/remote/enable", { on: true })).status, 200);
  const info = await request({ port: s.port, path: "/api/remote/info" });
  assert.equal(info.json.enabled, true);
  assert.equal(info.json.active, false);
  assert.equal(info.json.network.trusted, false);
  assert.equal(info.json.network.label, "HomeWifi");
  await wait(300);
  assert.equal((await phoneReq("/api/remote/me")).status, 0);
  assert.equal(await listensOn(ip), false);
  assert.equal((await postJson(s.port, "/api/remote/pair/start")).status, 409);
});

test("trust: phones are served and the server listens on all addresses", { skip: !ip }, async () => {
  assert.equal((await postJson(s.port, "/api/remote/trust")).status, 200);
  await wait(400);
  assert.equal(await listensOn(ip), true);
  const me = await phoneReq("/api/remote/me");
  assert.equal(me.status, 200);
  const info = await request({ port: s.port, path: "/api/remote/info" });
  assert.equal(info.json.active, true);
  assert.equal(info.json.trusted.length, 1);
  assert.equal(info.json.trusted[0].label, "HomeWifi");
});

test("trust is refused from another device, and the id can't come from the page", { skip: !ip }, async () => {
  const r = await phoneReq("/api/remote/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "wifi:Evil" }) });
  assert.equal(r.status, 401); // not paired: refused before it gets anywhere
  const u = await phoneReq("/api/remote/untrust", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.ok([401, 403].includes(u.status));
});

test("switching to another network: not served again and the phone's event stream is closed", { skip: !ip }, async () => {
  // A paired phone with an open event stream.
  // Pair for real to get a cookie.
  const start2 = await postJson(s.port, "/api/remote/pair/start");
  const ck = await new Promise((res, rej) => {
    const q = http.request({ host: ip, port: s.port, path: "/api/remote/pair", method: "POST", headers: { Host: `${ip}:${s.port}`, "Content-Type": "application/json" } }, (r) => { r.resume(); res(String(r.headers["set-cookie"]).split(";")[0]); });
    q.on("error", rej); q.end(JSON.stringify({ pin: start2.json.pin, name: "t2" }));
  });
  let closed = false;
  const stream = http.get({ host: ip, port: s.port, path: "/api/remote/events", headers: { Host: `${ip}:${s.port}`, Cookie: ck } }, (r) => { assert.equal(r.statusCode, 200); r.on("close", () => (closed = true)); r.on("error", () => (closed = true)); r.resume(); });
  stream.on("error", () => (closed = true));
  await wait(300);
  assert.equal(closed, false);
  setNet("wifi:OtherWifi|OtherWifi");
  // The server notices within 15 s; asking for the info refreshes it at once.
  await request({ port: s.port, path: "/api/remote/info" });
  await wait(500);
  assert.equal(closed, true);
  assert.equal((await phoneReq("/api/remote/me")).status, 0);
  assert.equal(await listensOn(ip), false);
  const info = await request({ port: s.port, path: "/api/remote/info" });
  assert.equal(info.json.active, false);
  assert.equal(info.json.network.trusted, false);
  // Back on the trusted network: served again (the pairing survives).
  setNet("wifi:HomeWifi|HomeWifi");
  await request({ port: s.port, path: "/api/remote/info" });
  await wait(400);
  const me = await phoneReq("/api/remote/me", { headers: { Cookie: ck } });
  assert.equal(me.json.paired, true);
});

test("an unknown network can't be trusted; untrust removes one", { skip: !ip }, async () => {
  setNet("");
  assert.equal((await postJson(s.port, "/api/remote/trust")).status, 409);
  setNet("wifi:HomeWifi|HomeWifi");
  const info = await request({ port: s.port, path: "/api/remote/info" });
  const id = info.json.trusted[0].id;
  assert.equal((await postJson(s.port, "/api/remote/untrust", { id })).status, 200);
  const after = await request({ port: s.port, path: "/api/remote/info" });
  assert.equal(after.json.trusted.length, 0);
  assert.equal(after.json.active, false);
});
