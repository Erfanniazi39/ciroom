// Task 11: small security fixes (cross-site reads, phone paths/thumbnails, guest seekpoint limit, shell proof,
// settings.json mode, private addresses in artwork links).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startServer, request, postJson, pairedPhone, lanIp } from "./helpers.js";
import { isPrivateAddress } from "../server/lib/netguard.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (file) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=12", "-f", "lavfi", "-i", "sine=f=440:d=12", "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
function putLibrary(s, file) {
  const lib = { movies: [{ kind: "movie", id: "tiny", title: "Tiny", year: 2020, file: { path: file, sizeBytes: 1, subtitles: [], status: "present", durationSec: 12 } }], series: [], collections: [], roots: [{ path: s.media }], review: [{ path: file }], scannedAt: new Date().toISOString() };
  const f = path.join(s.data, process.platform === "win32" ? "library-windows.json" : "library.json");
  fs.writeFileSync(f, JSON.stringify(lib)); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
}

test("a: cross-site API requests are refused; same-origin, none and no header work; CORP on API answers", async () => {
  const s = await startServer();
  try {
    const get = (h) => request({ port: s.port, path: "/api/ping", headers: h });
    assert.equal((await get({ "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await get({ "Sec-Fetch-Site": "same-site" })).status, 403);
    for (const h of [{ "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }, {}]) assert.equal((await get(h)).status, 200, JSON.stringify(h));
    const r = await new Promise((res, rej) => http.get({ port: s.port, host: "127.0.0.1", path: "/api/ping" }, (x) => { x.resume(); res(x.headers); }).on("error", rej));
    assert.equal(r["cross-origin-resource-policy"], "same-origin");
    const st = await request({ port: s.port, path: "/api/stream?path=/etc/passwd&t=0", headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(st.status, 403, "an embedded stream request never reaches ffmpeg");
  } finally { s.stop(); }
});

test("b: phones get no file paths, no /api/thumb; thumbnails by id work", { skip: !lanIp() }, async () => {
  const s = await startServer();
  try {
    const file = path.join(s.media, "Movies", "tiny.mp4"); clip(file); putLibrary(s, file);
    const phone = await pairedPhone(s);
    const lib = await phone.get("/api/library");
    assert.equal(lib.status, 200);
    assert.ok(!lib.text.includes(s.media), "no folder or file location in the phone's library");
    assert.ok(!/"\/(media|tmp|home|mnt|x)\b/.test(lib.text), "no absolute path");
    assert.equal(lib.json.movies[0].file.status, "present", "the phone still knows the video exists");
    assert.equal(lib.json.movies[0].file.durationSec, 12);
    const pc = await request({ port: s.port, path: "/api/library" });
    assert.ok(pc.text.includes(s.media), "this PC still gets the paths");
    assert.equal((await phone.get(`/api/thumb?path=${encodeURIComponent(file)}&t=1`)).status, 403, "thumbnails by path are closed to phones");
    const t = await phone.open("/api/remote/watch/thumb?id=tiny&t=2", 1000);
    assert.equal(t.status, 200);
    assert.equal(t.buf[0], 0xff); assert.equal(t.buf[1], 0xd8); // a JPEG
    t.res.destroy();
    assert.equal((await phone.get("/api/remote/watch/thumb?id=nope&t=2")).status, 404);
    assert.equal((await phone.get("/api/remote/watch/thumb?id=../x&t=2")).status, 400);
  } finally { s.stop(); }
});

test("c: a guest's 4th seekpoint within 2 s (or two at once) gets 429", async () => {
  const s = await startServer();
  try {
    const file = path.join(s.media, "Movies", "tiny.mp4"); clip(file);
    await postJson(s.port, "/api/party/host/enable", { on: true });
    const invite = (await postJson(s.port, "/api/party/host/invite")).json.token;
    await postJson(s.port, "/api/party/host/state", { media: { path: file, id: "tiny", title: "Tiny", duration: 12 }, position: 0, paused: true });
    const joined = await new Promise((ok, no) => { const q = http.request({ host: "127.0.0.1", port: s.port, path: "/api/party/join", method: "POST", headers: { "Content-Type": "application/json" } }, (r) => { r.resume(); ok(String(r.headers["set-cookie"] ?? "").split(";")[0]); }); q.on("error", no); q.end(JSON.stringify({ invite, name: "g" })); });
    assert.ok(joined, "joined");
    let key = "";
    await new Promise((ok) => { const q = http.get({ host: "127.0.0.1", port: s.port, path: "/api/party/events", headers: { Cookie: joined }, agent: false }, (res) => { let b = ""; res.on("data", (c) => { b += c; const m = /"media":\{"key":"([0-9a-f]+)"/.exec(b); if (m) { key = m[1]; q.destroy(); ok(); } }); }); q.on("error", () => {}); setTimeout(ok, 3000); });
    assert.ok(key, "got the media key");
    const sp = (t) => request({ port: s.port, path: `/api/party/seekpoint?k=${key}&t=${t}`, headers: { Cookie: joined } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await sp(5 + i)).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200], codes.join());
    assert.ok(codes.slice(3).includes(429), "over 3 in 2 s: " + codes.join());
    await wait(2200);
    const both = await Promise.all([sp(6), sp(7)]);
    assert.ok(both.some((r) => r.status === 429) && both.some((r) => r.status === 200), "one in flight at a time: " + both.map((r) => r.status));
    await wait(2200);
    assert.equal((await sp(8)).status, 200, "allowed again after the window");
  } finally { s.stop(); }
});

test("d: /api/ping proves the shell's secret only when asked with a nonce, never reveals it", async () => {
  const secret = "s3cret-" + Math.random();
  const s = await startServer({ env: { CIROOM_SHELL_SECRET: secret } });
  const none = await startServer();
  try {
    const nonce = "0123456789abcdef0123456789abcdef";
    const r = await request({ port: s.port, path: `/api/ping?nonce=${nonce}` });
    assert.equal(r.json.app, "ciroom");
    assert.equal(r.json.proof, createHash("sha256").update(secret + nonce).digest("hex"));
    assert.ok(!r.text.includes(secret));
    const plain = await request({ port: s.port, path: "/api/ping" });
    assert.equal(plain.json.proof, undefined, "no nonce, no proof");
    assert.equal((await request({ port: s.port, path: "/api/ping?nonce=zz" })).json.proof, undefined, "bad nonce");
    assert.equal((await request({ port: none.port, path: `/api/ping?nonce=${nonce}` })).json.proof, undefined, "a server without the secret can't prove anything");
  } finally { s.stop(); none.stop(); }
});

test("e: settings.json is written readable by the owner only", { skip: process.platform === "win32" }, async () => {
  const s = await startServer();
  try {
    const f = path.join(s.data, "settings.json");
    fs.writeFileSync(f, JSON.stringify({ subdlKey: "k" }), { mode: 0o644 });
    // saving the TMDB key rewrites the file (validation against TMDB then fails offline, the file is written first)
    await postJson(s.port, "/api/settings", { tmdbKey: "abc" });
    assert.equal((fs.statSync(f).mode & 0o777).toString(8), "600");
  } finally { s.stop(); }
});

test("f: artwork links to this PC or the home network are refused", async () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.1.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:192.168.1.1", "::ffff:7f00:1", "224.0.0.1", "[::1]"])
    assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])
    assert.equal(isPrivateAddress(a), false, a);
  const s = await startServer();
  try {
    for (const link of ["http://127.0.0.1/x.jpg", "http://192.168.1.1/x.jpg", "http://localhost/x.jpg", "http://[::1]/x.jpg", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3:8080/x.jpg"]) {
      const r = await postJson(s.port, "/api/art/url", { id: "m1", kind: "poster", url: link });
      assert.ok(r.status >= 400, link + " → " + r.status);
      assert.match(JSON.stringify(r.json), /home network|computer/i, link + ": " + r.text);
    }
  } finally { s.stop(); }
});
