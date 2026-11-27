// Functional: the watch party (area L) end to end at the protocol level. The host is this PC (its window's calls are
// made directly); guests connect through this machine's LAN address, so the server sees them as other devices, exactly
// like a laptop on Tailscale or the home network. Invite → join → state sync → chat → guest controls → episode change
// → disconnect/reconnect → revoke → party off.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startCiRoom, scan, until, sleep } from "./env.js";
import { lanIp } from "../helpers.js";
import { HAS_FFMPEG } from "../fixtures/media.js";

const ip = lanIp();

/** A guest: cookie jar + helpers, all requests from the LAN address. */
function guestClient(/** @type {number} */ port) {
  const host = `${ip}:${port}`;
  let cookie = "";
  const req = (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => new Promise((resolve, reject) => {
    const q = http.request({ host: ip, port, path: p, method, agent: false, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      const sc = res.headers["set-cookie"]; if (sc) cookie = String(sc).split(";")[0];
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, text, json, headers: res.headers }); });
    });
    q.on("error", reject);
    q.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
  return { get: (/** @type {string} */ p) => req("GET", p), post: (/** @type {string} */ p, /** @type {any} */ b = {}) => req("POST", p, b), events: (/** @type {string} */ p) => sse({ host: ip, port, path: p, headers: { Host: host, Cookie: cookie } }), get cookie() { return cookie; } };
}
/** Server-sent events reader: collects every JSON message. */
function sse(/** @type {http.RequestOptions} */ o) {
  /** @type {any[]} */ const msgs = [];
  let res = /** @type {http.IncomingMessage | null} */ (null);
  const ready = new Promise((resolve, reject) => {
    const q = http.get({ ...o, agent: false }, (r) => {
      res = r; let buf = "";
      r.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); for (const line of block.split("\n")) if (line.startsWith("data: ")) { try { msgs.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ } } } });
      resolve(r.statusCode);
    });
    q.on("error", reject);
  });
  return { msgs, ready, status: () => res?.statusCode, close: () => res?.destroy(), last: (/** @type {string} */ type) => [...msgs].reverse().find((m) => m.type === type), wait: (/** @type {(m:any)=>boolean} */ f, ms = 6000) => until(() => msgs.find(f), ms, 50) };
}

describe("watch party", { skip: !HAS_FFMPEG || !ip }, () => {
  /** @type {any} */ let s, lib, host;
  const alpha = () => lib.movies.find((m) => m.id === "alpha-movie");
  before(async () => {
    s = await startCiRoom({ layout: { "Movies/Alpha Movie 2001/alpha.mkv": "long.mkv", "Series/Show/S01/EP01/a.mkv": "ep60.mkv", "Series/Show/S01/EP02/b.mkv": "ep61.mkv" } });
    lib = await scan(s);
    host = sse({ host: "127.0.0.1", port: s.port, path: "/api/party/host/events" });
    await host.ready;
  });
  after(async () => { host?.close(); await s?.stop(); });

  /** @type {any} */ let g1, g1ev;

  test("off by default: a guest gets nothing, not even the page", async () => {
    const g = guestClient(s.port);
    assert.equal((await g.get("/party")).status, 403);
    assert.equal((await s.post("/api/party/host/invite")).status, 409, "no invite while the party is off");
  });

  test("invite → the guest page loads with its strict CSP → a wrong invite is refused → the right one joins (once)", async () => {
    assert.equal((await s.post("/api/party/host/enable", { on: true })).status, 200);
    const inv = (await s.post("/api/party/host/invite")).json;
    assert.match(inv.token, /^[A-Za-z0-9_-]{24}$/);
    assert.ok(inv.links.every((l) => l.url.includes(`/party#i=${inv.token}`)), "token only in the # part");
    g1 = guestClient(s.port);
    const page = await g1.get("/party");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal((await g1.post("/api/party/join", { invite: "x".repeat(24), name: "Sara" })).status, 401);
    const ok = await g1.post("/api/party/join", { invite: inv.token, name: "Sara <b>" });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(g1.cookie.startsWith("ciroom_guest="));
    const again = guestClient(s.port);
    assert.equal((await again.post("/api/party/join", { invite: inv.token, name: "Eve" })).status, 401, "single use");
    assert.equal((await g1.get("/api/party/me")).json.guest.name, "Sara <b>", "names are kept as text");
  });

  test("the guest sees what the host plays: title, position, paused, speed", async () => {
    g1ev = g1.events("/api/party/events");
    assert.equal(await g1ev.ready, 200);
    await g1ev.wait((m) => m.type === "hello");
    await s.post("/api/party/host/state", { media: { id: "alpha-movie", path: alpha().file.path, title: "Alpha Movie (2001)", duration: 600 }, position: 100, paused: false, rate: 1, at: Date.now() });
    const st = await g1ev.wait((m) => m.type === "state" && m.media?.title === "Alpha Movie (2001)");
    assert.equal(st.paused, false);
    assert.ok(Math.abs(st.position - 100) < 1);
    assert.ok(!JSON.stringify(st).includes(s.media), "no file path reaches the guest");
    await s.post("/api/party/host/state", { media: { id: "alpha-movie", path: alpha().file.path, title: "Alpha Movie (2001)", duration: 600 }, position: 101, paused: true, rate: 1, at: Date.now() });
    await g1ev.wait((m) => m.type === "state" && m.paused === true);
    await s.post("/api/party/host/state", { media: { id: "alpha-movie", path: alpha().file.path, title: "Alpha Movie (2001)", duration: 600 }, position: 400, paused: false, rate: 1.5, at: Date.now() });
    const jump = await g1ev.wait((m) => m.type === "state" && m.rate === 1.5);
    assert.ok(Math.abs(jump.position - 400) < 1);
  });

  test("the guest can stream only the host's current video, by its key, and gets no file names", async () => {
    const key = g1ev.last("state").media.key;
    const probe = await g1.get(`/api/party/probe?k=${key}`);
    assert.equal(probe.status, 200);
    assert.ok(Math.round(probe.json.duration) === 600);
    assert.ok(!probe.text.includes("alpha.mkv") && !probe.text.includes(s.media));
    const st = await new Promise((resolve) => { const q = http.get({ host: ip, port: s.port, path: `/api/party/stream?k=${key}&t=100`, headers: { Host: `${ip}:${s.port}`, Cookie: g1.cookie }, agent: false }, (r) => { r.once("data", (c) => { resolve({ status: r.statusCode, head: c.subarray(4, 8).toString() }); r.destroy(); }); }); q.on("error", () => {}); });
    assert.deepEqual(st, { status: 200, head: "ftyp" });
    assert.equal((await g1.get(`/api/party/probe?k=wrongkey`)).status, 409);
    assert.equal((await g1.get(`/api/probe?path=${encodeURIComponent(alpha().file.path)}`)).status, 403, "never the PC's own media routes");
  });

  test("chat both ways; text arrives exactly as typed (HTML is not interpreted), empty is refused", async () => {
    assert.equal((await g1.post("/api/party/chat", { text: "سلام 👋 <img src=x onerror=alert(1)>" })).status, 200);
    const gm = await host.wait((m) => m.type === "chat" && m.msg.from === "Sara <b>");
    assert.equal(gm.msg.text, "سلام 👋 <img src=x onerror=alert(1)>");
    assert.equal((await s.post("/api/party/host/chat", { text: "hi Sara" })).status, 200);
    await g1ev.wait((m) => m.type === "chat" && m.msg.text === "hi Sara" && m.msg.host);
    assert.equal((await g1.post("/api/party/chat", { text: "   " })).status, 400);
  });

  test("guest controls reach the host's player; when the host turns them off they are refused", async () => {
    const key = g1ev.last("state").media.key;
    assert.equal((await g1.post("/api/party/cmd", { cmd: "pause", key })).status, 200);
    const c = await host.wait((m) => m.type === "cmd" && m.cmd === "pause");
    assert.equal(c.from, "Sara <b>");
    assert.equal((await g1.post("/api/party/cmd", { cmd: "seekTo", value: 321, key })).status, 200);
    assert.equal((await host.wait((m) => m.type === "cmd" && m.cmd === "seekTo")).value, 321);
    assert.equal((await g1.post("/api/party/cmd", { cmd: "explode", key })).status, 400);
    assert.equal((await g1.post("/api/party/cmd", { cmd: "pause", key: "old" })).status, 409);
    await s.post("/api/party/host/settings", { guestControl: false });
    await g1ev.wait((m) => m.type === "state" && m.guestControl === false);
    assert.equal((await g1.post("/api/party/cmd", { cmd: "pause", key })).status, 403);
    await s.post("/api/party/host/settings", { guestControl: true });
  });

  test("an episode change: the guest gets the new video (new key); the old key stops working", async () => {
    const oldKey = g1ev.last("state").media.key;
    const e2 = lib.series[0].seasons[0].episodes[1];
    await s.post("/api/party/host/state", { media: { id: e2.id, path: e2.file.path, title: "Show", subtitle: "S1:E2", duration: 61 }, position: 0, paused: false, rate: 1, at: Date.now() });
    const st = await g1ev.wait((m) => m.type === "state" && m.media?.subtitle === "S1:E2");
    assert.notEqual(st.media.key, oldKey);
    assert.equal((await g1.get(`/api/party/probe?k=${oldKey}`)).status, 409);
  });

  test("a second guest joins with a new invite; the host sees both, online", async () => {
    const inv = (await s.post("/api/party/host/invite")).json;
    const g2 = guestClient(s.port);
    assert.equal((await g2.post("/api/party/join", { invite: inv.token, name: "Ali" })).status, 200);
    const ev2 = g2.events("/api/party/events");
    await ev2.ready;
    const list = await until(async () => { const l = (await s.get("/api/party/host/info")).json.guests; return l.filter((x) => x.online).length === 2 && l; });
    assert.deepEqual(list.map((x) => x.name).sort(), ["Ali", "Sara <b>"]);
    ev2.close();
  });

  test("a guest who drops off is shown offline, and comes back with the same access (no new invite)", async () => {
    g1ev.close();
    await host.wait((m) => m.type === "chat" && m.msg.system && /Sara <b> disconnected/.test(m.msg.text), 12000);
    g1ev = g1.events("/api/party/events");
    assert.equal(await g1ev.ready, 200);
    await g1ev.wait((m) => m.type === "state");
    await until(async () => (await s.get("/api/party/host/info")).json.guests.find((x) => x.name === "Sara <b>").online);
  });

  test("the host removes a guest: told at once, and the cookie stops working", async () => {
    const sara = (await s.get("/api/party/host/info")).json.guests.find((x) => x.name === "Sara <b>");
    await s.post("/api/party/host/revoke", { id: sara.id });
    const closed = await g1ev.wait((m) => m.type === "closed");
    assert.match(closed.reason, /removed/);
    assert.equal((await g1.post("/api/party/chat", { text: "still here?" })).status, 401);
  });

  test("the host ends the party: every guest is told, party pages close, and the chat is gone next time", async () => {
    const ali = guestClient(s.port);
    const inv = (await s.post("/api/party/host/invite")).json;
    await ali.post("/api/party/join", { invite: inv.token, name: "Bob" });
    const ev = ali.events("/api/party/events");
    await ev.ready;
    await s.post("/api/party/host/enable", { on: false });
    assert.match((await ev.wait((m) => m.type === "closed")).reason, /ended/);
    assert.equal((await ali.get("/party")).status, 403);
    await s.post("/api/party/host/enable", { on: true });
    const h2 = sse({ host: "127.0.0.1", port: s.port, path: "/api/party/host/events" });
    await h2.ready;
    const hello = await h2.wait((m) => m.type === "hello");
    assert.deepEqual(hello.chat, []);
    h2.close();
    await s.post("/api/party/host/enable", { on: false });
  });

  test("the party's guest limit: a 5th guest can't be invited", async () => {
    await s.post("/api/party/host/enable", { on: true });
    const joined = [];
    for (let i = 0; i < 5; i++) {
      const inv = await s.post("/api/party/host/invite");
      if (inv.status !== 200) { joined.push(`invite ${inv.status}`); break; }
      const g = guestClient(s.port);
      joined.push((await g.post("/api/party/join", { invite: inv.json.token, name: `G${i}` })).status);
    }
    assert.ok(joined.includes("invite 409"), JSON.stringify(joined));
    assert.ok(((await s.get("/api/party/host/info")).json.guests.length) <= 4);
    await s.post("/api/party/host/enable", { on: false });
    await sleep(50);
  });
});
