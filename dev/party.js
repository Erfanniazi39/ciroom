// @ts-check
/**
 * Watch party (dev bridge, session 5). The host plays a title in CiRoom's page player; a guest opens a link
 * in their browser (reached over Tailscale, a private WireGuard network) and watches the same video streamed
 * from this PC, kept in sync, with a chat.
 *
 * Security model (the guest is on the internet side of a private tunnel, so assume the link could leak):
 *  - OFF by default. While off, every party path answers 403, even the page.
 *  - Only this PC, Tailscale addresses (100.64.0.0/10) and the home network may reach party paths.
 *  - Joining needs an invite: 144 random bits, single use, expires in 30 minutes, kept only as a hash.
 *    Joining sets a guest cookie (256 random bits, HttpOnly, SameSite=Strict, stored hashed, revocable,
 *    expires after 30 days, and only valid while the party is on).
 *  - The guest never loads CiRoom's app: she gets one self-contained page (/party, strict CSP). Everything
 *    outside /party and /api/party/* is refused to her by the gate in mpv-bridge.js / remote.js.
 *  - She can only stream the file the host is playing RIGHT NOW: the file path never leaves this PC; her
 *    stream requests carry a media key and are rewritten here to the host's current file.
 *  - POSTs must be JSON (cross-site forms can't send that without a CORS preflight, which we never allow).
 *  - Limits: 4 guests, 3 live connections and 2 streams per guest, chat rate and length limits.
 *
 * Host routes (this PC only): /api/party/host/info|enable|invite|invite/cancel|revoke|settings|state|chat|events
 * Guest routes: /party (page), /party/app.js, /party/app.css, /api/party/me|join|leave|events|status|chat|cmd|probe|seekpoint|stream|subtitle.vtt
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./artwork-store.js";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./fsutil.js";

const FILE = path.join(DATA_DIR, "party.json");
const COOKIE = "ciroom_guest";
const INVITE_TTL_MS = 30 * 60_000;
const GUEST_TTL_MS = 30 * 24 * 3600_000;
const MAX_GUESTS = 4;
const MAX_SSE_PER_GUEST = 3;
const MAX_STREAMS_PER_GUEST = 2;
const CHAT_KEEP = 100;
export const TAILSCALE_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./; // 100.64.0.0/10
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const VIRTUAL_IFACE = /^(docker|br-|veth|tun|tap|outline|virbr|vboxnet|vmnet|lo$|vethernet|virtualbox|vmware|loopback|bluetooth)/i;
const SRC = fileURLToPath(new URL("../src", import.meta.url));
/** The installed app has no sources: the guest page is built ahead (scripts/build-party.js → dist/party/). */
const prebuilt = (/** @type {string} */ name) => (process.env.CIROOM_DIST ? path.join(process.env.CIROOM_DIST, "party", name) : null);

const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");
const safeEq = (/** @type {string} */ a, /** @type {string} */ b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Printable text only (no control characters except newlines), trimmed and length-limited. */
const clean = (/** @type {unknown} */ s, /** @type {number} */ max) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>CiRoom · Watch party</title>
<link rel="stylesheet" href="/party/app.css"></head>
<body><div id="app"></div><script type="module" src="/party/app.js"></script></body></html>`;

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * @param {{ resolveVideo: (p: string) => string, stream: { handle: Function }, getPort: () => number, onToggle?: () => void }} deps
 */
export function partyRoutes({ resolveVideo, stream, getPort, onToggle = () => {} }) {
  /** @type {{ enabled: boolean, hostName: string, guestControl: boolean, guests: { id: string, hash: string, name: string, created: number, lastSeen: number, expires: number }[] }} */
  let cfg = { enabled: false, hostName: "Host", guestControl: true, guests: [] };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* first run */ }
  cfg.guests = cfg.guests.filter((g) => g.expires > Date.now());
  const save = () => {
    try { writeJsonAtomic(FILE, cfg, { mode: 0o600, space: 2 }); } catch { /* keep in memory */ }
  };

  /** @type {{ hash: string, expires: number } | null} */
  let invite = null;
  let failed = 0;
  let lockedUntil = 0;

  /** What the host is playing. `file` never leaves this module. */
  /** @type {{ key: string, id: string, title: string, subtitle: string | null, duration: number, file: string, pathIn: string } | null} */
  let media = null;
  let play = { position: 0, paused: true, rate: 1, at: 0 };
  let hostSeen = 0;

  /** Live guests: SSE connections, last status, stream count, chat rate limiting. */
  /** @type {Map<string, { conns: Set<import("node:http").ServerResponse>, status: any, streams: number, chatTimes: number[], cmdTimes: number[], leaveTimer: NodeJS.Timeout | null }>} */
  const live = new Map();
  /** @type {Set<import("node:http").ServerResponse>} */
  const hosts = new Set();
  /** @type {{ id: string, from: string, text: string, at: number, host?: boolean, system?: boolean }[]} */
  const chat = [];
  const hostChatTimes = /** @type {number[]} */ ([]);

  const liveOf = (/** @type {string} */ id) => {
    let l = live.get(id);
    if (!l) { l = { conns: new Set(), status: null, streams: 0, chatTimes: [], cmdTimes: [], leaveTimer: null }; live.set(id, l); }
    return l;
  };

  const cookieOf = (/** @type {import("node:http").IncomingMessage} */ req) => {
    const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})(?:;|$)`));
    return m ? m[1] : "";
  };
  const guestOf = (/** @type {import("node:http").IncomingMessage} */ req) => {
    const t = cookieOf(req);
    if (!t) return null;
    const h = sha(t);
    const g = cfg.guests.find((x) => safeEq(x.hash, h)) ?? null;
    return g && g.expires > Date.now() ? g : null;
  };

  // ── Server-sent events ─────────────────────────────────────────────────────────────────────
  const sse = (/** @type {import("node:http").ServerResponse} */ res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": ok\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => clearInterval(ping));
  };
  const send = (/** @type {Iterable<import("node:http").ServerResponse>} */ to, /** @type {unknown} */ msg) => {
    const s = `data: ${JSON.stringify(msg)}\n\n`;
    for (const r of to) r.write(s);
  };
  const allGuestConns = () => [...live.values()].flatMap((l) => [...l.conns]);

  const hostOnline = () => hosts.size > 0 || Date.now() - hostSeen < 6000;
  const stateMsg = () => ({
    type: "state", hostName: cfg.hostName, hostOnline: hostOnline(), guestControl: cfg.guestControl,
    media: media ? { key: media.key, title: media.title, subtitle: media.subtitle, duration: media.duration } : null,
    position: play.position, paused: play.paused, rate: play.rate, at: play.at, now: Date.now(),
  });
  const guestList = () => cfg.guests.map((g) => {
    const l = live.get(g.id);
    return { id: g.id, name: g.name, online: !!l && l.conns.size > 0, status: l?.status ?? null, lastSeen: g.lastSeen };
  });
  const pushGuests = () => send(hosts, { type: "guests", list: guestList() });
  const pushState = () => send(allGuestConns(), stateMsg());
  setInterval(() => { if (live.size) pushState(); }, 2000).unref();

  function addChat(/** @type {{ from: string, text: string, host?: boolean, system?: boolean }} */ m) {
    const msg = { id: crypto.randomBytes(6).toString("hex"), at: Date.now(), ...m };
    chat.push(msg);
    if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
    send([...hosts, ...allGuestConns()], { type: "chat", msg });
  }
  /** Sliding-window rate limit: at most `n` events per `ms`. */
  const allow = (/** @type {number[]} */ times, n = 8, ms = 10_000) => {
    const now = Date.now();
    while (times.length && now - times[0] > ms) times.shift();
    if (times.length >= n) return false;
    times.push(now);
    return true;
  };

  function dropGuest(/** @type {string} */ id, /** @type {string} */ reason) {
    const l = live.get(id);
    if (l) { send(l.conns, { type: "closed", reason }); for (const r of l.conns) r.end(); live.delete(id); }
  }

  const urls = () => {
    /** @type {{ label: string, url: string }[]} */
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family !== "IPv4" || a.internal) continue;
        if (TAILSCALE_IP.test(a.address)) out.unshift({ label: "Tailscale", url: `http://${a.address}:${getPort()}/party` });
        else if (!VIRTUAL_IFACE.test(name) && PRIVATE_IP.test(a.address)) out.push({ label: "Home network (for testing)", url: `http://${a.address}:${getPort()}/party` });
      }
    }
    return out;
  };

  // ── The guest page (built from src/party/guest.ts with esbuild, rebuilt when its sources change) ──
  /** @type {{ stamp: string, js: string } | null} */
  let bundle = null;
  async function guestJs() {
    const pre = prebuilt("app.js");
    if (pre && fs.existsSync(pre)) return (bundle ??= { stamp: "prebuilt", js: fs.readFileSync(pre, "utf8") }).js;
    const files = [path.join(SRC, "party/guest.ts"), path.join(SRC, "lib/mse.ts"), path.join(SRC, "api/stream.ts")];
    const stamp = files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join("|");
    if (bundle?.stamp === stamp) return bundle.js;
    const esbuild = await import("esbuild");
    const r = await esbuild.build({
      entryPoints: [files[0]], bundle: true, write: false, format: "esm", target: "es2020", minify: true,
      alias: { "@": SRC }, legalComments: "none", logLevel: "silent",
    });
    bundle = { stamp, js: r.outputFiles[0].text };
    return bundle.js;
  }

  /** Refuse with a status and a JSON error. */
  const deny = (/** @type {import("node:http").ServerResponse} */ res, /** @type {number} */ code, /** @type {string} */ error) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error }));
    return true;
  };

  return {
    /** True while the watch party is switched on (the server then listens for other devices). */
    isEnabled: () => !!cfg.enabled,
    /** True for every path this module answers (the guest page and the party API). */
    owns(/** @type {string | undefined} */ url) {
      const u = url ?? "";
      return u === "/party" || u.startsWith("/party/") || u.startsWith("/party?") || u.startsWith("/party#") || u.startsWith("/api/party/");
    },

    /**
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
     * @param {string} peer @param {boolean} local
     * @param {(code: number, data: unknown) => void} json @param {(req: any) => Promise<any>} body
     */
    async handle(req, res, peer, local, json, body) {
      const u = new URL(req.url ?? "/", "http://localhost");
      const route = u.pathname;
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");

      if (req.method === "POST" && !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return deny(res, 415, "JSON only");

      // ── Host (this PC's window only) ─────────────────────────────────────────────────────────
      if (route.startsWith("/api/party/host/")) {
        if (!local) return deny(res, 403, "This PC only");
        res.setHeader("Cache-Control", "no-store");
        if (route === "/api/party/host/info" && req.method === "GET") {
          json(200, {
            enabled: cfg.enabled, hostName: cfg.hostName, guestControl: cfg.guestControl, urls: urls(),
            invite: invite && Date.now() < invite.expires ? { expiresIn: Math.round((invite.expires - Date.now()) / 1000) } : null,
            guests: guestList(), media: media ? { id: media.id, title: media.title } : null,
          });
          return true;
        }
        if (route === "/api/party/host/enable" && req.method === "POST") {
          const { on } = await body(req);
          cfg.enabled = !!on;
          if (!cfg.enabled) {
            invite = null;
            for (const id of [...live.keys()]) dropGuest(id, "The host ended the watch party.");
            chat.length = 0; // the chat ends with the party: the next party's guests never see it
            hostChatTimes.length = 0;
          }
          save();
          send(hosts, { type: "hello", enabled: cfg.enabled, guests: guestList(), chat });
          onToggle();
          json(200, { ok: true });
          return true;
        }
        if (route === "/api/party/host/invite" && req.method === "POST") {
          if (!cfg.enabled) { json(409, { error: "Turn the watch party on first." }); return true; }
          if (cfg.guests.length >= MAX_GUESTS) { json(409, { error: `At most ${MAX_GUESTS} guests. Remove one first.` }); return true; }
          const token = crypto.randomBytes(18).toString("base64url"); // 144 bits
          invite = { hash: sha(token), expires: Date.now() + INVITE_TTL_MS };
          failed = 0;
          const base = urls();
          json(200, { token, links: base.map((b) => ({ label: b.label, url: `${b.url}#i=${token}` })), expiresIn: INVITE_TTL_MS / 1000 });
          return true;
        }
        if (route === "/api/party/host/invite/cancel" && req.method === "POST") { invite = null; json(200, { ok: true }); return true; }
        if (route === "/api/party/host/revoke" && req.method === "POST") {
          const { id } = await body(req);
          const g = cfg.guests.find((x) => x.id === id);
          cfg.guests = cfg.guests.filter((x) => x.id !== id);
          save();
          if (g) dropGuest(g.id, "The host removed your access.");
          pushGuests();
          json(200, { ok: true });
          return true;
        }
        if (route === "/api/party/host/settings" && req.method === "POST") {
          const b = await body(req);
          if (typeof b.hostName === "string") cfg.hostName = clean(b.hostName, 24) || "Host";
          if (typeof b.guestControl === "boolean") cfg.guestControl = b.guestControl;
          save();
          pushState();
          json(200, { ok: true });
          return true;
        }
        if (route === "/api/party/host/state" && req.method === "POST") {
          const b = await body(req);
          hostSeen = Date.now();
          const m = b.media;
          if (!m || typeof m.path !== "string") {
            if (media) { media = null; pushState(); }
          } else if (!media || media.pathIn !== m.path || media.id !== m.id) {
            let file = "";
            try { file = resolveVideo(m.path); } catch { file = ""; }
            media = file ? { key: crypto.randomBytes(6).toString("hex"), id: clean(m.id, 200), title: clean(m.title, 200), subtitle: m.subtitle ? clean(m.subtitle, 200) : null, duration: Number(m.duration) || 0, file, pathIn: m.path } : null;
          } else if (Number(m.duration) > 0) media.duration = Number(m.duration);
          const at = Math.min(Date.now(), Number(b.at) || Date.now()); // same machine: the window's clock is ours
          const next = { position: Math.max(0, Number(b.position) || 0), paused: !!b.paused, rate: Math.max(0.25, Math.min(4, Number(b.rate) || 1)), at };
          const expected = play.paused ? play.position : play.position + ((at - play.at) / 1000) * play.rate;
          const changed = next.paused !== play.paused || next.rate !== play.rate || Math.abs(next.position - expected) > 0.75 || !!b.force;
          play = next;
          if (changed) pushState();
          json(200, { ok: true });
          return true;
        }
        if (route === "/api/party/host/chat" && req.method === "POST") {
          const text = clean((await body(req)).text, 500);
          if (!text) { json(400, { error: "Empty message" }); return true; }
          if (!allow(hostChatTimes, 15, 10_000)) { json(429, { error: "Slow down a little." }); return true; }
          addChat({ from: cfg.hostName, text, host: true });
          json(200, { ok: true });
          return true;
        }
        if (route === "/api/party/host/events" && req.method === "GET") {
          sse(res);
          hosts.add(res);
          res.on("close", () => { hosts.delete(res); });
          send([res], { type: "hello", enabled: cfg.enabled, guests: guestList(), chat });
          return true;
        }
        return deny(res, 404, "Unknown endpoint");
      }

      // ── Guest side ───────────────────────────────────────────────────────────────────────────
      if (!local && !TAILSCALE_IP.test(peer) && !PRIVATE_IP.test(peer)) return deny(res, 403, "Not allowed from this network");
      if (!cfg.enabled) return deny(res, 403, "There's no watch party right now.");
      res.setHeader("Cache-Control", "no-store");

      if (req.method === "GET" && route === "/party") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", CSP);
        res.setHeader("X-Frame-Options", "DENY");
        res.end(PAGE);
        return true;
      }
      if (req.method === "GET" && route === "/party/app.js") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(await guestJs());
        return true;
      }
      if (req.method === "GET" && route === "/party/app.css") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        const pre = prebuilt("app.css");
        res.end(fs.readFileSync(pre && fs.existsSync(pre) ? pre : path.join(SRC, "party/guest.css")));
        return true;
      }

      if (route === "/api/party/me" && req.method === "GET") {
        const g = guestOf(req);
        json(200, { guest: g ? { id: g.id, name: g.name } : null, hostName: cfg.hostName });
        return true;
      }

      if (route === "/api/party/join" && req.method === "POST") {
        const b = await body(req);
        if (Date.now() < lockedUntil) { json(429, { error: "Too many wrong invites. Try again in a few minutes." }); return true; }
        const token = String(b.invite ?? "");
        const ok = !!invite && Date.now() < invite.expires && /^[A-Za-z0-9_-]{24}$/.test(token) && safeEq(invite.hash, sha(token));
        if (!ok) {
          if (++failed >= 10) { invite = null; lockedUntil = Date.now() + 5 * 60_000; failed = 0; }
          json(401, { error: "This invite link isn't valid any more. Ask the host for a new one." });
          return true;
        }
        if (cfg.guests.length >= MAX_GUESTS) { json(409, { error: "The party is full." }); return true; }
        invite = null; // single use
        const name = clean(b.name, 24) || "Guest";
        const secret = crypto.randomBytes(32).toString("hex");
        const g = { id: crypto.randomBytes(6).toString("hex"), hash: sha(secret), name, created: Date.now(), lastSeen: Date.now(), expires: Date.now() + GUEST_TTL_MS };
        cfg.guests.push(g);
        save();
        res.setHeader("Set-Cookie", `${COOKIE}=${secret}; Path=/; Max-Age=${GUEST_TTL_MS / 1000}; HttpOnly; SameSite=Strict`);
        pushGuests();
        json(200, { guest: { id: g.id, name: g.name } });
        return true;
      }

      // Everything below needs a joined guest.
      const g = guestOf(req);
      if (!g) return deny(res, 401, "Not joined");
      if (Date.now() - g.lastSeen > 60_000) { g.lastSeen = Date.now(); save(); }
      const l = liveOf(g.id);

      if (route === "/api/party/leave" && req.method === "POST") {
        cfg.guests = cfg.guests.filter((x) => x.id !== g.id);
        save();
        res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
        json(200, { ok: true });
        dropGuest(g.id, "You left the watch party.");
        addChat({ from: "", text: `${g.name} left`, system: true });
        pushGuests();
        return true;
      }

      if (route === "/api/party/events" && req.method === "GET") {
        if (l.conns.size >= MAX_SSE_PER_GUEST) return deny(res, 429, "Too many open tabs");
        const wasOnline = l.conns.size > 0 || !!l.leaveTimer;
        if (l.leaveTimer) { clearTimeout(l.leaveTimer); l.leaveTimer = null; }
        sse(res);
        l.conns.add(res);
        res.on("close", () => {
          l.conns.delete(res);
          if (!l.conns.size && live.get(g.id) === l) {
            l.leaveTimer = setTimeout(() => { l.leaveTimer = null; if (!l.conns.size) { l.status = null; addChat({ from: "", text: `${g.name} disconnected`, system: true }); pushGuests(); } }, 8000);
          }
          pushGuests();
        });
        send([res], { type: "hello", me: { id: g.id, name: g.name }, chat });
        send([res], stateMsg());
        if (!wasOnline) addChat({ from: "", text: `${g.name} joined`, system: true });
        pushGuests();
        return true;
      }

      if (route === "/api/party/status" && req.method === "POST") {
        const b = await body(req);
        const prev = l.status;
        l.status = { buffering: !!b.buffering, position: Number(b.position) || 0, paused: !!b.paused, onKey: media ? b.key === media.key : false, at: Date.now() };
        if (!prev || prev.buffering !== l.status.buffering || Date.now() - (prev.pushed ?? 0) > 2000) { l.status.pushed = Date.now(); pushGuests(); } else l.status.pushed = prev.pushed;
        json(200, { now: Date.now() }); // the guest's clock-offset sample
        return true;
      }

      if (route === "/api/party/chat" && req.method === "POST") {
        const text = clean((await body(req)).text, 500);
        if (!text) { json(400, { error: "Empty message" }); return true; }
        if (!allow(l.chatTimes)) { json(429, { error: "Slow down a little." }); return true; }
        addChat({ from: g.name, text });
        json(200, { ok: true });
        return true;
      }

      if (route === "/api/party/cmd" && req.method === "POST") {
        if (!cfg.guestControl) { json(403, { error: "The host has turned off guest controls." }); return true; }
        const b = await body(req);
        const cmd = String(b.cmd ?? "");
        if (!["play", "pause", "seekTo"].includes(cmd)) { json(400, { error: "Unknown command" }); return true; }
        if (!media || b.key !== media.key) { json(409, { error: "The host changed the video." }); return true; }
        if (!allow(l.cmdTimes, 10, 5000)) { json(429, { error: "Slow down a little." }); return true; }
        const value = Number(b.value);
        send(hosts, { type: "cmd", cmd, value: Number.isFinite(value) ? Math.max(0, value) : undefined, from: g.name });
        json(200, { ok: true });
        return true;
      }

      // Media: only the host's current file, addressed by its key. The path is filled in here.
      if (["/api/party/probe", "/api/party/seekpoint", "/api/party/stream", "/api/party/subtitle.vtt"].includes(route) && req.method === "GET") {
        if (!media || u.searchParams.get("k") !== media.key) return deny(res, 409, "The host changed the video.");
        const q = new URLSearchParams({ path: media.file });
        const t = Math.max(0, Math.min(Number(u.searchParams.get("t")) || 0, media.duration || 1e6));
        if (route !== "/api/party/probe" && route !== "/api/party/subtitle.vtt") q.set("t", t.toFixed(3));
        if (route === "/api/party/subtitle.vtt") {
          if (u.searchParams.has("e")) q.set("e", String(Math.max(0, Math.min(99, Math.floor(Number(u.searchParams.get("e")) || 0))))); // built-in track
          else q.set("i", String(Math.max(0, Math.min(99, Math.floor(Number(u.searchParams.get("i")) || 0)))));
        }
        if (route === "/api/party/stream" && u.searchParams.get("level") === "0") q.set("level", "0");
        if (route === "/api/party/stream") {
          if (l.streams >= MAX_STREAMS_PER_GUEST) return deny(res, 429, "Too many streams");
          l.streams++;
          res.on("close", () => { l.streams--; });
        }
        req.url = `${route.replace("/api/party/", "/api/")}?${q}`;
        if (route === "/api/party/probe") {
          // Same answer as /api/probe minus anything about the file's location.
          const orig = json;
          const filtered = (/** @type {number} */ code, /** @type {any} */ data) => orig(code, code === 200 && data ? { duration: data.duration, width: data.width, height: data.height, video: data.video, audio: data.audio, codecs: data.codecs, hasAudio: data.hasAudio, copyVideo: data.copyVideo, levelGainDb: data.levelGainDb, subtitles: (data.subtitles ?? []).map((/** @type {any} */ s) => ({ index: s.index, label: s.label, format: s.format, ...(s.embedded ? { embedded: true, stream: s.stream } : {}) })) } : { error: "Could not read the video" });
          await stream.handle(req, res, filtered, body);
        } else {
          await stream.handle(req, res, json, body);
        }
        return true;
      }

      return deny(res, 404, "Unknown endpoint");
    },
  };
}
