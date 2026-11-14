// @ts-check
/**
 * Phone remote control (dev bridge, session 4). The phone opens CiRoom's /remote page over the home Wi-Fi,
 * pairs once with a one-time PIN (shown as a QR code in Settings on the PC), and then controls what plays on the PC.
 *
 * Security model:
 *  - OFF by default. While off, nothing but this PC itself is served.
 *  - On: only private-network addresses are served, and every API call except pairing needs the device's
 *    token (an HttpOnly cookie, stored hashed on the PC; revocable per phone in Settings).
 *  - Pairing PINs are random, single-use, expire after 5 minutes, and wrong guesses lock pairing for a minute.
 *  - A paired phone may only browse the library (read-only) and send the remote commands below.
 *    It cannot reach settings (API keys), file streams, subtitle downloads, artwork edits or mpv launching.
 *
 * Routes (PC window only, 127.0.0.1): /api/remote/info|enable|pair/start|pair/cancel|revoke|report|commands
 * Routes (phone): /api/remote/pair|me|events|cmd
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./artwork-store.js";
import { writeJsonAtomic } from "./fsutil.js";

const FILE = path.join(DATA_DIR, "remote.json");
const COOKIE = "ciroom_remote";
const PIN_TTL_MS = 5 * 60_000;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Linux names, then Windows adapter names (Hyper-V/WSL "vEthernet", VirtualBox, VMware, loopback).
const VIRTUAL_IFACE = /^(docker|br-|veth|tun|tap|outline|tailscale|virbr|vboxnet|vmnet|lo$|vethernet|virtualbox|vmware|loopback|bluetooth)/i;

/** What a paired phone may call. Everything else under /api is for this PC only. */
const PHONE_GET = [/^\/api\/library(\?|$)/, /^\/api\/meta(\?|$)/, /^\/api\/art(\?|$)/, /^\/api\/art\/file\//, /^\/api\/thumb\?/, /^\/api\/remote\/events$/];
const PHONE_POST = [/^\/api\/remote\/cmd$/];

const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");

/** @param {any} mpv adapter: { running(): boolean, snapshot(): any, command(c: any): void } */
export function remoteRoutes(mpv, getPort = () => 1420) {
  /** @type {{ enabled: boolean, devices: { id: string, hash: string, name: string, created: number, lastSeen: number }[] }} */
  let cfg = { enabled: false, devices: [] };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* first run */ }
  const save = () => {
    try { writeJsonAtomic(FILE, cfg, { mode: 0o600, space: 2 }); } catch { /* read-only disk: keep in memory */ }
  };

  /** @type {{ pin: string, expires: number, tries: number } | null} */
  let pairing = null;
  let lockedUntil = 0;
  /** Last report from the PC window: what the page player is doing + what the phone may browse by. */
  /** @type {{ at: number, now: any, user: any }} */
  let report = { at: 0, now: null, user: null };
  /** @type {Set<import("node:http").ServerResponse>} */
  const phones = new Set();
  /** @type {Set<import("node:http").ServerResponse>} */
  const windows = new Set();
  let lastSent = "";
  /** @type {NodeJS.Timeout | null} */
  let tick = null;

  const cookieOf = (/** @type {import("node:http").IncomingMessage} */ req) => {
    const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
    return m ? m[1] : "";
  };
  const deviceOf = (/** @type {import("node:http").IncomingMessage} */ req) => {
    const t = cookieOf(req);
    if (!t) return null;
    const h = sha(t);
    return cfg.devices.find((d) => crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h))) ?? null;
  };

  const lanUrls = () => {
    /** @type {string[]} */
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_IFACE.test(name)) continue;
      for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && PRIVATE_IP.test(a.address)) out.push(`http://${a.address}:${getPort()}`);
    }
    return out;
  };

  /** The state the phone shows: live mpv numbers if the full player runs, else the page player's last report. */
  function nowPlaying() {
    const meta = report.now?.meta ?? null;
    if (mpv.running()) {
      const s = mpv.snapshot(true);
      return {
        source: "mpv", id: meta?.id ?? null, title: meta?.title ?? "Full player", subtitle: meta?.subtitle ?? null,
        position: s.position, duration: s.duration, paused: s.paused, volume: s.volume, muted: s.muted,
        hasNext: false, fullscreen: false, subDelay: s.subDelay ?? 0, skip: mpv.skipState?.() ?? null, subs: s.subtitles.map((/** @type {any} */ t) => ({ id: t.id, label: t.label ?? t.title ?? t.lang ?? `Track ${t.id}` })), subId: s.sid ?? -1,
      };
    }
    return report.now && report.now.page ? { source: "page", ...report.now.page, ...(meta ?? {}) } : null;
  }
  const windowOnline = () => windows.size > 0 || Date.now() - report.at < 6000;
  const publicState = () => ({ online: windowOnline(), now: nowPlaying(), user: report.user });

  function pushPhones(force = false) {
    if (!phones.size) return;
    const s = JSON.stringify(publicState());
    if (!force && s === lastSent) return;
    lastSent = s;
    for (const r of phones) r.write(`data: ${s}\n\n`);
  }
  function ensureTick() {
    if (phones.size && !tick) tick = setInterval(() => pushPhones(), 700);
    if (!phones.size && tick) { clearInterval(tick); tick = null; }
  }

  const sse = (/** @type {import("node:http").ServerResponse} */ res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": ok\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => clearInterval(ping));
  };

  return {
    /**
     * Gate for requests from other devices (this PC is never gated). Returns an HTTP status to refuse with, or 0 to continue.
     * @param {import("node:http").IncomingMessage} req @param {string} ip
     */
    gate(req, ip) {
      if (!cfg.enabled || !PRIVATE_IP.test(ip)) return 403;
      const url = req.url ?? "/";
      if (!url.startsWith("/api/")) return 0; // the phone page itself (HTML/JS/CSS): no secrets in it
      if (url === "/api/remote/me" || url === "/api/remote/pair") return 0;
      const dev = deviceOf(req);
      if (!dev) return 401;
      const ok = (req.method === "GET" ? PHONE_GET : req.method === "POST" ? PHONE_POST : []).some((re) => re.test(url));
      if (!ok) return 403;
      if (Date.now() - dev.lastSeen > 60_000) { dev.lastSeen = Date.now(); save(); }
      return 0;
    },

    /**
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
     * @param {(code: number, data: unknown) => void} json @param {(req: any) => Promise<any>} body @param {boolean} local
     */
    async handle(req, res, json, body, local) {
      const url = req.url ?? "";
      if (!url.startsWith("/api/remote/")) return false;
      const route = url.split("?")[0];

      // ── Phone ────────────────────────────────────────────────────────────────────────────
      if (route === "/api/remote/me" && req.method === "GET") { json(200, { enabled: cfg.enabled, paired: !!deviceOf(req) }); return true; }

      if (route === "/api/remote/pair" && req.method === "POST") {
        const { pin, name } = await body(req);
        if (Date.now() < lockedUntil) { json(429, { error: "Too many wrong PINs. Wait a minute and try again." }); return true; }
        if (!pairing || Date.now() > pairing.expires) { json(409, { error: "No pairing is open. On the PC, open Settings → Phone remote → Pair a phone." }); return true; }
        const a = Buffer.from(String(pin ?? "").padEnd(6, "x").slice(0, 6));
        const b = Buffer.from(pairing.pin);
        if (!crypto.timingSafeEqual(a, b)) {
          pairing.tries++;
          if (pairing.tries >= 5) { pairing = null; lockedUntil = Date.now() + 60_000; }
          json(401, { error: "Wrong PIN." });
          return true;
        }
        pairing = null;
        const token = crypto.randomBytes(32).toString("hex");
        const ua = String(req.headers["user-agent"] ?? "");
        const guess = /Android/i.test(ua) ? "Android phone" : /iPhone|iPad/i.test(ua) ? "iPhone" : "Phone";
        cfg.devices.push({ id: crypto.randomBytes(6).toString("hex"), hash: sha(token), name: String(name || guess).slice(0, 40), created: Date.now(), lastSeen: Date.now() });
        save();
        res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
        json(200, { ok: true });
        return true;
      }

      if (route === "/api/remote/events" && req.method === "GET") {
        sse(res);
        phones.add(res);
        res.on("close", () => { phones.delete(res); ensureTick(); });
        ensureTick();
        res.write(`data: ${JSON.stringify(publicState())}\n\n`);
        return true;
      }

      if (route === "/api/remote/cmd" && req.method === "POST") {
        const c = await body(req);
        const cmd = String(c.cmd ?? "");
        const value = Number(c.value);
        if (!windowOnline()) { json(409, { error: "CiRoom isn't open on the PC." }); return true; }
        if (mpv.running() && cmd === "skip") { const ok = !!mpv.skip?.(); json(ok ? 200 : 409, ok ? { ok: true } : { error: "Nothing to skip right now" }); pushPhones(); return true; }
        const usesMpv = mpv.running() && ["toggle", "seekBy", "seekTo", "volume", "mute", "stop", "subtitle", "subDelay"].includes(cmd);
        if (usesMpv) {
          if (cmd === "toggle") mpv.command({ cmd: "pause" });
          else if (cmd === "seekBy") mpv.command({ cmd: "seek-rel", value });
          else if (cmd === "seekTo") mpv.command({ cmd: "seek", value });
          else if (cmd === "volume") mpv.command({ cmd: "set", name: "volume", value: Math.max(0, Math.min(130, value)) });
          else if (cmd === "mute") mpv.command({ cmd: "set", name: "mute", value: !mpv.snapshot(true).muted });
          else if (cmd === "subtitle") mpv.command({ cmd: "set", name: "sid", value: value < 0 ? "no" : value });
          else if (cmd === "subDelay") mpv.command({ cmd: "set", name: "sub-delay", value: Math.round(value * 10) / 10 });
          else if (cmd === "stop") mpv.command({ cmd: "stop" });
          json(200, { ok: true });
          pushPhones();
          return true;
        }
        if (mpv.running() && cmd === "fullscreen") { json(409, { error: "The full player (mpv) is already fullscreen." }); return true; }
        if (mpv.running() && cmd === "next") { json(409, { error: "Next episode isn't available from the phone while the full player (mpv) is open." }); return true; }
        const allowed = ["toggle", "seekBy", "seekTo", "volume", "mute", "next", "stop", "subtitle", "subDelay", "fullscreen", "play", "skip"];
        if (!allowed.includes(cmd)) { json(400, { error: "Unknown command" }); return true; }
        const msg = JSON.stringify({ cmd, value: Number.isFinite(value) ? value : undefined, id: typeof c.id === "string" ? c.id.slice(0, 200) : undefined, fromStart: !!c.fromStart });
        for (const w of windows) w.write(`data: ${msg}\n\n`);
        json(200, { ok: true });
        return true;
      }

      // ── This PC only ───────────────────────────────────────────────────────────────────
      if (!local) { json(403, { error: "This PC only" }); return true; }

      if (route === "/api/remote/info" && req.method === "GET") {
        json(200, {
          enabled: cfg.enabled, urls: lanUrls(),
          pairing: pairing && Date.now() < pairing.expires ? { pin: pairing.pin, expiresIn: Math.round((pairing.expires - Date.now()) / 1000) } : null,
          devices: cfg.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen })),
          phonesConnected: phones.size,
        });
        return true;
      }
      if (route === "/api/remote/enable" && req.method === "POST") {
        const { on } = await body(req);
        cfg.enabled = !!on;
        if (!cfg.enabled) { pairing = null; for (const r of phones) r.end(); phones.clear(); ensureTick(); }
        save();
        json(200, { ok: true });
        return true;
      }
      if (route === "/api/remote/pair/start" && req.method === "POST") {
        if (!cfg.enabled) { json(409, { error: "Turn the phone remote on first." }); return true; }
        pairing = { pin: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), expires: Date.now() + PIN_TTL_MS, tries: 0 };
        json(200, { pin: pairing.pin, expiresIn: PIN_TTL_MS / 1000 });
        return true;
      }
      if (route === "/api/remote/pair/cancel" && req.method === "POST") { pairing = null; json(200, { ok: true }); return true; }
      if (route === "/api/remote/revoke" && req.method === "POST") {
        const { id } = await body(req);
        cfg.devices = cfg.devices.filter((d) => d.id !== id);
        save();
        json(200, { ok: true });
        return true;
      }
      if (route === "/api/remote/report" && req.method === "POST") {
        const b = await body(req);
        report = { at: Date.now(), now: b.now ?? null, user: b.user ?? report.user };
        json(200, { ok: true });
        pushPhones();
        return true;
      }
      if (route === "/api/remote/commands" && req.method === "GET") {
        sse(res);
        windows.add(res);
        res.on("close", () => { windows.delete(res); pushPhones(); });
        pushPhones(true);
        return true;
      }
      return false;
    },
  };
}
