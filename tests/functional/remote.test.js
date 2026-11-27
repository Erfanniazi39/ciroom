// Functional: the phone remote (area K) between a "phone" (requests from this machine's LAN address with the pairing
// cookie) and the PC: pairing rules, commands reaching the PC window, what the phone sees, commands driving the REAL
// mpv (no window, no sound), removing a phone, switching the remote off.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { startCiRoom, scan, until, sleep } from "./env.js";
import { lanIp, pairedPhone, postJson } from "../helpers.js";
import { HAS_FFMPEG, HAS_MPV } from "../fixtures/media.js";

const ip = lanIp();
function sse(/** @type {http.RequestOptions} */ o) {
  /** @type {any[]} */ const msgs = [];
  let res = /** @type {any} */ (null), ended = false;
  const ready = new Promise((resolve, reject) => {
    const q = http.get({ ...o, agent: false }, (r) => {
      res = r; let buf = "";
      r.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); for (const l of b.split("\n")) if (l.startsWith("data: ")) { try { msgs.push(JSON.parse(l.slice(6))); } catch { /* skip */ } } } });
      r.on("end", () => { ended = true; }); r.on("close", () => { ended = true; });
      resolve(r.statusCode);
    });
    q.on("error", (e) => { ended = true; reject(e); });
  });
  return { msgs, ready, close: () => res?.destroy(), ended: () => ended, wait: (/** @type {(m:any)=>boolean} */ f, ms = 6000) => until(() => msgs.find(f), ms, 50) };
}

describe("phone remote", { skip: !HAS_FFMPEG || !ip }, () => {
  /** @type {any} */ let s, lib, phone, pcCmds;
  before(async () => {
    s = await startCiRoom({ mpv: HAS_MPV, layout: { "Movies/Alpha Movie 2001/alpha.mkv": "long.mkv", "Series/Show/S01/EP01/a.mkv": "ep60.mkv" }, env: { CIROOM_FAKE_NETWORK: "wifi:Home|Home" } });
    lib = await scan(s);
  });
  after(async () => { pcCmds?.close(); await s?.post("/api/player/cmd", { cmd: "stop" }).catch(() => {}); await s?.stop(); if (s) fs.rmSync(s.dir, { recursive: true, force: true }); });

  test("pairing: no PIN open → refused; wrong PINs lock pairing after 5 tries; a used PIN can't pair a second phone", async () => {
    await postJson(s.port, "/api/remote/enable", { on: true });
    await postJson(s.port, "/api/remote/trust");
    await sleep(400);
    const pair = (/** @type {string} */ pin) => new Promise((resolve) => { const q = http.request({ host: ip, port: s.port, path: "/api/remote/pair", method: "POST", agent: false, headers: { Host: `${ip}:${s.port}`, "Content-Type": "application/json" } }, (r) => { r.resume(); resolve(r.statusCode); }); q.end(JSON.stringify({ pin, name: "x" })); });
    assert.equal(await pair("123456"), 409, "nothing to pair with");
    const { pin } = (await s.post("/api/remote/pair/start")).json;
    assert.match(pin, /^\d{6}$/);
    const wrong = pin === "000000" ? "111111" : "000000";
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push(await pair(wrong));
    assert.deepEqual(codes, [401, 401, 401, 401, 401]);
    assert.equal(await pair(pin), 429, "locked after 5 wrong tries (even the right PIN)");
  });

  test("pairing with the right PIN works once; the phone is listed on the PC", async () => {
    // The lock from the previous test lasts 60 s: restart the server to clear it (it is in memory, by design).
    await s.stop({ keep: true });
    s = await startCiRoom({ dir: s.dir, media: s.media, data: s.data, cache: s.cache, mpv: HAS_MPV, env: { CIROOM_FAKE_NETWORK: "wifi:Home|Home" } });
    phone = await pairedPhone(s, "Note 10+");
    assert.ok(phone.cookie.startsWith("ciroom_remote="));
    const info = (await s.get("/api/remote/info")).json;
    assert.ok(JSON.stringify(info).includes("Note 10+"), JSON.stringify(info).slice(0, 300));
    assert.equal((await phone.get("/api/remote/me")).json.paired, true);
  });

  test("with no CiRoom window open, commands are refused with a clear message", async () => {
    const r = await phone.post("/api/remote/cmd", { cmd: "toggle" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /isn't open/);
  });

  test("commands reach the PC window as they were sent; unknown commands are refused", async () => {
    pcCmds = sse({ host: "127.0.0.1", port: s.port, path: "/api/remote/commands" });
    await pcCmds.ready;
    for (const c of [{ cmd: "toggle" }, { cmd: "seekBy", value: -10 }, { cmd: "seekTo", value: 1500 }, { cmd: "volume", value: 80 }, { cmd: "next" }, { cmd: "play", id: "alpha-movie", fromStart: true }]) {
      assert.equal((await phone.post("/api/remote/cmd", c)).status, 200, JSON.stringify(c));
      const got = await pcCmds.wait((m) => m.cmd === c.cmd && (c.value === undefined || m.value === c.value));
      if (c.id) { assert.equal(got.id, "alpha-movie"); assert.equal(got.fromStart, true); }
    }
    assert.equal((await phone.post("/api/remote/cmd", { cmd: "rm -rf" })).status, 400);
    assert.equal((await phone.post("/api/remote/cmd", { cmd: "subPref", id: "nope", pref: { off: true } })).status, 400);
    assert.equal((await phone.post("/api/remote/cmd", { cmd: "subPref", id: "alpha-movie", pref: { off: true } })).status, 200);
  });

  test("the phone sees what the PC reports (now playing) and its progress list, without file paths", async () => {
    const ev = sse({ host: ip, port: s.port, path: "/api/remote/events", headers: { Host: phone.host, Cookie: phone.cookie } });
    assert.equal(await ev.ready, 200);
    await s.post("/api/remote/report", { now: { page: { position: 321, duration: 600, paused: false, volume: 90, muted: false, subs: [], subId: -1 }, meta: { id: "alpha-movie", title: "Alpha Movie" } }, user: { progress: { "alpha-movie": { position: 321, duration: 600, watched: false, updatedAt: Date.now() } }, favorites: [] } });
    const m = await ev.wait((x) => x.now?.id === "alpha-movie");
    assert.equal(m.now.position, 321);
    assert.equal(m.online, true);
    const lib2 = await phone.get("/api/library");
    assert.ok(!lib2.text.includes(s.media), "no folder paths for phones");
    ev.close();
  });

  test("while the full player (mpv) runs, phone commands drive mpv itself", { skip: !HAS_MPV }, async () => {
    const f = lib.movies[0].file.path;
    await s.post("/api/play", { path: f, startAt: 100, volume: 0, itemId: "alpha-movie" });
    await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.duration > 0 && p.position >= 100; }, 20000); // duration > 0: mpv is connected (see D-17)
    const t = await phone.post("/api/remote/cmd", { cmd: "toggle" });
    assert.equal(t.status, 200, t.text);
    await until(async () => (await s.get("/api/player")).json.paused);
    await phone.post("/api/remote/cmd", { cmd: "seekTo", value: 400 });
    await until(async () => { const p = (await s.get("/api/player")).json; return p.position >= 399 && p.position < 402; }, 4000).catch(async (e) => { throw new Error(`seek: ${(await s.get("/api/player")).json.position} ${e.message}`); });
    await phone.post("/api/remote/cmd", { cmd: "volume", value: 999 });
    await until(async () => (await s.get("/api/player")).json.volume === 130, 4000).catch(async (e) => { throw new Error(`volume: ${JSON.stringify((await s.get("/api/player")).json.volume)} ${e.message}`); });
    await phone.post("/api/remote/cmd", { cmd: "subDelay", value: 1.25 });
    await until(async () => Math.abs((await s.get("/api/player")).json.subDelay - 1.3) < 0.01);
    const next = await phone.post("/api/remote/cmd", { cmd: "next" });
    assert.equal(next.status, 409, "Next isn't offered while mpv plays");
    await phone.post("/api/remote/cmd", { cmd: "stop" });
    await until(async () => !(await s.get("/api/player")).json.running);
  });

  test("D-15: a phone command with a missing or broken number changes nothing (no NaN reaches mpv)", { skip: !HAS_MPV }, async () => {
    const f = lib.movies[0].file.path;
    await s.post("/api/play", { path: f, startAt: 100, volume: 40, itemId: "alpha-movie" });
    await until(async () => { const p = (await s.get("/api/player")).json; return p.running && p.duration > 0 && p.volume === 40; }, 20000);
    const r = await phone.post("/api/remote/cmd", { cmd: "volume", value: "loud" });
    for (const cmd of ["seekBy", "seekTo", "volume", "subtitle", "subDelay"]) {
      for (const value of [undefined, null, "12"]) assert.equal((await phone.post("/api/remote/cmd", { cmd, value })).status, 400, `${cmd} ${JSON.stringify(value)}`);
    }
    for (const c of [{ cmd: "seek", value: "x" }, { cmd: "seek-rel" }, { cmd: "set", name: "volume", value: "loud" }, { cmd: "set", name: "speed", value: null }]) {
      assert.equal((await s.post("/api/player/cmd", c)).status, 400, `PC ${JSON.stringify(c)}`);
    }
    await sleep(500);
    const p = (await s.get("/api/player")).json;
    await phone.post("/api/remote/cmd", { cmd: "stop" });
    assert.ok(r.status === 400 && p.volume === 40, `answered ${r.status}, mpv volume is now ${JSON.stringify(p.volume)}`);
  });

  test("D-16: removing a phone on the PC cuts it off at once, including its open live connection", async () => {
    const other = await pairedPhone(s, "Kept phone");
    const kept = sse({ host: ip, port: s.port, path: "/api/remote/events", headers: { Host: other.host, Cookie: other.cookie } });
    await kept.ready;
    // A video stream the phone is watching: left unread, so it is still open when the phone is removed.
    const media = await new Promise((resolve, reject) => { http.get({ host: ip, port: s.port, path: "/api/remote/watch/stream?id=alpha-movie&t=0", agent: false, headers: { Host: phone.host, Cookie: phone.cookie } }, (r) => { r.pause(); r.on("error", () => {}); resolve(r); }).on("error", reject); });
    assert.equal(media.statusCode, 200);
    const ev = sse({ host: ip, port: s.port, path: "/api/remote/events", headers: { Host: phone.host, Cookie: phone.cookie } });
    await ev.ready;
    const dev = (await s.get("/api/remote/info")).json.devices.find((d) => d.name === "Note 10+");
    await s.post("/api/remote/revoke", { id: dev.id });
    assert.equal((await phone.post("/api/remote/cmd", { cmd: "toggle" })).status, 401, "new requests are refused");
    await sleep(300);
    const before = ev.msgs.length;
    await s.post("/api/remote/report", { now: { page: { position: 1, duration: 600, paused: false }, meta: { id: "alpha-movie", title: "SECRET after revoke" } } });
    await sleep(500);
    const leaked = ev.msgs.slice(before).some((m) => JSON.stringify(m).includes("SECRET after revoke"));
    media.resume();
    await until(() => media.complete || media.destroyed, 6000, 50);
    const keptGot = kept.msgs.some((m) => JSON.stringify(m).includes("SECRET after revoke"));
    ev.close(); kept.close();
    assert.ok(ev.ended() && !leaked, "the removed phone's open event stream still receives what the PC plays");
    assert.equal(media.complete, false, "the removed phone's video stream was cut, not finished");
    assert.ok(keptGot && !kept.ended(), "another phone stays connected");
  });

  test("switching the remote off: phones get nothing at all", async () => {
    const p2 = await pairedPhone(s, "Second phone");
    await s.post("/api/remote/enable", { on: false });
    await sleep(400);
    const r = await p2.get("/api/remote/me").catch((e) => ({ status: `refused (${e.code})` }));
    assert.ok(r.status === 403 || String(r.status).startsWith("refused"), String(r.status));
  });
});
