// @ts-check
/**
 * Phone remote control. The phone opens CiRoom's /remote page over the home Wi-Fi,
 * pairs once with a one-time PIN (shown as a QR code in Settings on the PC), and then controls what plays on the PC.
 *
 * Security model:
 *  - OFF by default. While off, nothing but this PC itself is served.
 *  - Trusted networks: even when switched on, phones are served only while this PC is on a network the user approved
 *    (Wi-Fi name, or the router of a wired network). On any other network the remote behaves as if it were off.
 *  - On: only private-network addresses are served, and every API call except pairing needs the device's
 *    token (an HttpOnly cookie, stored hashed on the PC; revocable per phone in Settings).
 *  - Pairing PINs are random, single-use, expire after 5 minutes, and wrong guesses lock pairing for a minute.
 *  - A paired phone may only browse the library (read-only) and send the remote commands below.
 *    It cannot reach settings (API keys), file streams, subtitle downloads, artwork edits or mpv launching.
 *
 * Routes (PC window only, 127.0.0.1): /api/remote/info|enable|trust|untrust|pair/start|pair/cancel|revoke|report|commands
 * Routes (phone): /api/remote/pair|me|events|cmd|progress|state, /api/remote/watch/* (server/lib/phone-watch.js)
 *
 * One screen at a time: the same title plays on one screen only. A phone reports {id, position, playing} to /api/remote/state;
 * on a paused → playing edge for the title the PC is playing, the PC is paused (mpv directly, the page player through a
 * "yield" message on the commands stream). The PC window's own paused → playing edge is seen by the phone through /events.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./artwork-store.js";
import { writeJsonAtomic } from "./fsutil.js";
import { currentNetwork } from "./netid.js";
import { itemFor, phoneWatchRoutes } from "./phone-watch.js";
import { defineRoutes } from "./routes.js";

const FILE = path.join(DATA_DIR, "remote.json");
/** Progress from a phone while the PC window is closed: the newest entry per video, handed over when a window connects. */
const PENDING_FILE = path.join(DATA_DIR, "phone-pending.json");
const COOKIE = "ciroom_remote";
const PIN_TTL_MS = 5 * 60_000;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Linux names, then Windows adapter names (Hyper-V/WSL "vEthernet", VirtualBox, VMware, loopback).
const VIRTUAL_IFACE = /^(docker|br-|veth|tun|tap|outline|tailscale|virbr|vboxnet|vmnet|lo$|vethernet|virtualbox|vmware|loopback|bluetooth)/i;

const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * @param {any} mpv adapter: { running(): boolean, snapshot(): any, command(c: any): void, itemId?(): string | null }
 * @param {() => number} [getPort] @param {() => void} [onToggle]
 * @param {{ resolveVideo: (p: string) => string, stream: any } | null} [media] what phone watching needs (file lookup + streaming)
 */
export function remoteRoutes(mpv, getPort = () => 1420, onToggle = () => {}, media = null) {
  /** @type {{ enabled: boolean, trusted: { id: string, label: string, added: number }[], devices: { id: string, hash: string, name: string, created: number, lastSeen: number }[] }} */
  let cfg = { enabled: false, trusted: [], devices: [] };
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
  /** Open phone event streams → the device each belongs to. @type {Map<import("node:http").ServerResponse, string>} */
  const phones = new Map();
  /** @type {Set<import("node:http").ServerResponse>} */
  const windows = new Set();
  let lastSent = "";
  /** @type {NodeJS.Timeout | null} */
  let tick = null;

  /** The network this PC is on now (refreshed every 15 s while the remote is on) and whether phones are served on it. */
  /** @type {import("./netid.js").NetworkInfo} */
  let netNow = { id: "", label: "Unknown network", kind: "unknown" };
  const isTrusted = (/** @type {string} */ id) => id !== "" && cfg.trusted.some((t) => t.id === id);
  const isActive = () => !!cfg.enabled && isTrusted(netNow.id);
  let wasActive = false;
  /** @type {NodeJS.Timeout | null} */
  let netTimer = null;
  // Vite reloads this module inside the same process: only the newest instance may keep a timer (archive §10d).
  const G = /** @type {any} */ (globalThis);
  const gen = (G.__ciroomRemoteGen = (G.__ciroomRemoteGen ?? 0) + 1);

  /** When "phones are served" flips, drop other devices' streams (off) and re-listen on the right address. */
  function syncActive() {
    const a = isActive();
    if (a === wasActive) return;
    wasActive = a;
    if (!a) { pairing = null; phoneNow.clear(); eventStreams.clear(); for (const r of phones.keys()) r.destroy(); phones.clear(); ensureTick(); for (const c of [...phoneStreams.keys()]) c(); }
    onToggle();
  }
  async function refreshNet(fresh = false) {
    netNow = await currentNetwork(fresh);
    syncActive();
  }
  /** Runs the 15-second network check while the remote is on; never while it is off, never during `vite build`. */
  function ensureNetTimer() {
    if (cfg.enabled && !netTimer && G.__ciroomRemoteGen === gen) {
      netTimer = setInterval(() => {
        if (G.__ciroomRemoteGen !== gen || !cfg.enabled) { if (netTimer) clearInterval(netTimer); netTimer = null; return; }
        refreshNet().catch(() => {});
      }, 15_000);
      netTimer.unref?.();
    }
    if (!cfg.enabled && netTimer) { clearInterval(netTimer); netTimer = null; }
  }
  /** Phone media streams (watching): closer → device. Called when phones are switched off or that phone is removed. @type {Map<() => void, string>} */
  const phoneStreams = new Map();

  /** @type {Record<string, { id: string, position: number, duration: number, watched: number, at: number }>} */
  let pending = {};
  try { pending = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) ?? {}; } catch { /* none */ }
  const savePending = () => {
    try {
      if (Object.keys(pending).length) writeJsonAtomic(PENDING_FILE, pending, { mode: 0o600, space: 0 });
      else fs.rmSync(PENDING_FILE, { force: true });
    } catch { /* read-only disk: keep in memory */ }
  };
  /** Last accepted progress report per device (rate limit). @type {Map<string, number>} */
  const lastProgress = new Map();

  /** What each phone is doing now (reported by /api/remote/state): fresh within 15 s, else it counts as not playing. @type {Map<string, { id: string, position: number, playing: boolean, at: number, name: string }>} */
  const phoneNow = new Map();
  const PHONE_FRESH_MS = 15_000;
  /** Recent state posts per device (rate limit: 4 per 2 s). @type {Map<string, number[]>} */
  const stateHits = new Map();
  /** Open event streams per device, to drop a phone's state when its last one closes. @type {Map<string, number>} */
  const eventStreams = new Map();
  const freshPhones = () => [...phoneNow.values()].filter((p) => Date.now() - p.at < PHONE_FRESH_MS);
  const sendWindows = (/** @type {any} */ msg) => { const s = `data: ${JSON.stringify(msg)}\n\n`; for (const w of windows) w.write(s); };
  /** A phone just started playing `id`: if the PC shows the same title (playing OR paused) it must take the phone's spot and stop saving its own. */
  function phoneTookOver(/** @type {string} */ id, /** @type {number} */ position) {
    const metaId = report.now?.meta?.id ?? null;
    if (mpv.running()) {
      if (metaId !== id) return;
      // An absolute pause, never a toggle: while mpv starts the snapshot can't be trusted, and two toggles cancel out (D-27).
      if (!mpv.snapshot(true).paused) { mpv.command({ cmd: "set", name: "pause", value: true }); pushPhones(); }
      sendWindows({ cmd: "yield", id, position, by: "phone" });
      return;
    }
    const page = report.now?.page;
    if (windows.size && Date.now() - report.at < 6000 && page && metaId === id) sendWindows({ cmd: "yield", id, position, by: "phone" });
  }

  /** Open streams per device (watching on the phone), so one phone can't start unlimited ffmpeg processes. @type {Map<string, { n: number }>} */
  const streamCounts = new Map();
  const watch = media ? phoneWatchRoutes({
    resolveVideo: media.resolveVideo, stream: media.stream,
    streamsOf: (id) => { let c = streamCounts.get(id); if (!c) streamCounts.set(id, (c = { n: 0 })); return c; },
    onStream: (close, deviceId) => { phoneStreams.set(close, deviceId); return () => phoneStreams.delete(close); },
  }) : null;

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

  /** The windows only report to the phone while a phone is connected: tell them the count whenever it changes. */
  let lastPhoneCount = -1;
  const announcePhones = () => { if (phones.size === lastPhoneCount) return; lastPhoneCount = phones.size; sendWindows({ cmd: "phones", count: phones.size }); };
  function pushPhones(force = false) {
    if (!phones.size) return;
    const s = JSON.stringify(publicState());
    if (!force && s === lastSent) return;
    lastSent = s;
    for (const r of phones.keys()) r.write(`data: ${s}\n\n`);
  }
  function ensureTick() {
    if (phones.size && !tick) tick = setInterval(() => pushPhones(), 700);
    if (!phones.size && tick) { clearInterval(tick); tick = null; }
  }
  /** A removed phone is cut off at once: its open connections would otherwise outlive its pairing. */
  function dropDevice(/** @type {string} */ id) {
    for (const [r, dev] of [...phones]) if (dev === id) { phones.delete(r); r.destroy(); }
    for (const [close, dev] of [...phoneStreams]) if (dev === id) close();
    phoneNow.delete(id);
    ensureTick();
    announcePhones();
  }

  const sse = (/** @type {import("node:http").ServerResponse} */ res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": ok\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => clearInterval(ping));
  };

  // ── mpv progress while no window is open ───────────────────────────────────────────────
  // The window owns the user state and saves mpv's position itself (NowPlayingBar). When NO window is connected the
  // server queues the same kind of entry a phone would (pending file → replayed when a window connects), so closing
  // the window while mpv plays doesn't lose the place. Never writes the database.
  const MPV_SAVE_MS = Math.max(50, Number(process.env.CIROOM_MPV_SAVE_MS) || 15_000);
  /** @type {{ id: string, pos: number, at: number } | null} */
  let mpvTrack = null; // the item being followed: last saved position and when we last looked
  /** Watch seconds are only counted while mpv is really playing, as the window does. */
  function mpvSaveTick(final = false, force = false) {
    const id = mpv.itemId?.() ?? null;
    if (!id || !mpv.running()) { mpvTrack = null; return; }
    const item = itemFor(id);
    if (!item) return;
    const snap = mpv.snapshot(true);
    const now = Date.now();
    const duration = Number(snap.duration) > 0 ? Number(snap.duration) : 0;
    const position = snap.ended && duration ? duration : Number(snap.position);
    if (!mpvTrack || mpvTrack.id !== id) mpvTrack = { id, pos: Number.isFinite(position) ? position : 0, at: now };
    const movedBy = position - mpvTrack.pos;
    const sinceLast = Math.min(120, (now - mpvTrack.at) / 1000);
    const playing = !snap.paused && movedBy > 0 && movedBy < sinceLast + 5;
    mpvTrack.at = now;
    if (!Number.isFinite(position) || position < 0 || !duration || position > duration + 1) return;
    if (windows.size && !force) { mpvTrack.pos = position; return; } // a window is open: it saves (unchanged behaviour)
    if (freshPhones().some((p) => p.id === id && p.playing)) { mpvTrack.pos = position; return; } // a phone holds this title: its position wins
    // Not moved since the last save. On the final save (mpv went away) that's only true when this exact spot is
    // already saved: a tick that just started tracking saves nothing, so mpv dying right after it lost the position.
    if (!snap.ended && Math.abs(movedBy) < 1 && (!final || Math.abs((pending[id]?.position ?? -9) - position) < 1)) return;
    const old = pending[id];
    pending[id] = { id, position: Math.min(position, duration), duration, watched: Math.min(43200, (old?.watched ?? 0) + (playing ? Math.min(movedBy, sinceLast) : 0)), at: now, source: "mpv" };
    mpvTrack.pos = position;
    savePending();
    if (final) mpvTrack = null;
  }
  const mpvTimer = () => { const t = setInterval(() => { try { mpvSaveTick(); } catch { /* keep going */ } }, MPV_SAVE_MS); t.unref?.(); return t; };

  return {
    /** True while phones are served: the remote is on AND this PC is on a trusted network (the server then listens for other devices). */
    isEnabled: () => isActive(),
    /** True when the user switched the remote on (even if this network isn't trusted). */
    isSwitchedOn: () => !!cfg.enabled,
    /** One progress check for mpv (also called by the bridge when mpv exits, with final=true; force=true on shutdown: the window is going away too). */
    mpvSaveTick,
    /** Starts the network check. Called when the server starts (never by `vite build`). */
    start: () => { mpvTimer(); ensureNetTimer(); if (cfg.enabled) refreshNet(true).catch(() => {}); },
    /**
     * Gate for requests from other devices (this PC is never gated). Returns an HTTP status to refuse with, or 0 to continue.
     * mode "page": the phone page itself (HTML/JS/CSS, no secrets). "open": a phone that is not paired yet (to pair). "phone": a paired phone.
     * "refuse": the route is not for phones, so the answer is always a refusal (a phone that isn't paired is told so).
     * @param {import("node:http").IncomingMessage} req @param {string} ip @param {"page" | "open" | "phone" | "refuse"} mode
     */
    gate(req, ip, mode) {
      if (!isActive() || !PRIVATE_IP.test(ip)) return 403;
      if (mode === "page" || mode === "open") return 0;
      const dev = deviceOf(req);
      if (!dev) return 401;
      if (mode === "refuse") return 403;
      if (Date.now() - dev.lastSeen > 60_000) { dev.lastSeen = Date.now(); save(); }
      return 0;
    },

    routes: defineRoutes("remote", [
      // ── Phone ────────────────────────────────────────────────────────────────────────────
      { method: "GET", path: "/api/remote/me", audience: "phone", open: true, handler: async ({ req, json }) => {
        json(200, { enabled: isActive(), paired: !!deviceOf(req) }); return true;
      } },

      { method: "POST", path: "/api/remote/pair", audience: "phone", open: true, handler: async ({ req, res, json, body }) => {
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
      } },

      // What a paired phone watches: addressed by library id, never by path (server/lib/phone-watch.js).
      ...(watch ? ["probe", "seekpoint", "stream", "subtitle.vtt", "thumb"].map((what) => ({
        method: "GET", path: `/api/remote/watch/${what}`, audience: "phone",
        handler: async (/** @type {import("./routes.js").Ctx} */ { req, res, json, body }) => {
          const dev = deviceOf(req);
          if (!dev) return json(401, { error: "Not paired" });
          await watch.serve(req, res, json, body, dev.id, what);
        },
      })) : []),

      { method: "GET", path: "/api/remote/events", audience: "phone", handler: async ({ req, res }) => {
        const evDev = deviceOf(req)?.id;
        sse(res);
        phones.set(res, evDev ?? "");
        announcePhones();
        if (evDev) eventStreams.set(evDev, (eventStreams.get(evDev) ?? 0) + 1);
        res.on("close", () => {
          phones.delete(res); ensureTick(); announcePhones();
          if (evDev) { const n = (eventStreams.get(evDev) ?? 1) - 1; if (n > 0) eventStreams.set(evDev, n); else { eventStreams.delete(evDev); phoneNow.delete(evDev); } }
        });
        ensureTick();
        res.write(`data: ${JSON.stringify(publicState())}\n\n`);
        return true;
      } },

      { method: "POST", path: "/api/remote/progress", audience: "phone", handler: async ({ req, json, body }) => {
        // The phone never writes to the database: the PC window owns it (a window save replaces the whole state).
        const dev = deviceOf(req);
        if (!dev) { json(401, { error: "Not paired" }); return true; }
        const b = await body(req);
        const item = itemFor(b.id);
        const position = Number(b.position), duration = Number(b.duration), watchedRaw = b.watched === undefined ? 0 : Number(b.watched);
        if (!item || !Number.isFinite(position) || !Number.isFinite(duration) || !Number.isFinite(watchedRaw)
          || position < 0 || duration <= 0 || position > duration || duration > 24 * 3600 || watchedRaw < 0 || watchedRaw > 120) { json(400, { error: "Bad progress" }); return true; }
        // 1 per 3 s per phone; a final save (closing, pausing, leaving) only needs 0.5 s so it isn't lost.
        const now = Date.now();
        if (now - (lastProgress.get(dev.id) ?? 0) < (b.final ? 500 : 3000)) { json(429, { error: "Too fast" }); return true; }
        lastProgress.set(dev.id, now);
        const msg = { cmd: "progress", id: item.id, position, duration, watched: watchedRaw, at: now };
        if (windows.size) { for (const w of windows) w.write(`data: ${JSON.stringify(msg)}\n\n`); json(200, { ok: true, delivered: true }); return true; }
        const old = pending[item.id];
        pending[item.id] = { id: item.id, position, duration, watched: Math.min(43200, (old?.watched ?? 0) + watchedRaw), at: now };
        savePending();
        json(200, { ok: true, delivered: false });
        return true;
      } },

      { method: "POST", path: "/api/remote/state", audience: "phone", handler: async ({ req, json, body }) => {
        const dev = deviceOf(req);
        if (!dev) { json(401, { error: "Not paired" }); return true; }
        const b = await body(req);
        const item = itemFor(b.id);
        const position = Number(b.position);
        if (!item || !Number.isFinite(position) || position < 0 || position > 24 * 3600 || typeof b.playing !== "boolean") { json(400, { error: "Bad state" }); return true; }
        const now = Date.now();
        const hits = (stateHits.get(dev.id) ?? []).filter((t) => now - t < 2000);
        if (hits.length >= 4) { stateHits.set(dev.id, hits); json(429, { error: "Too fast" }); return true; }
        hits.push(now); stateHits.set(dev.id, hits);
        const prev = phoneNow.get(dev.id);
        const wasPlaying = !!prev && prev.playing && prev.id === item.id && now - prev.at < PHONE_FRESH_MS;
        phoneNow.set(dev.id, { id: item.id, position, playing: b.playing, at: now, name: dev.name });
        // Edges only: a heartbeat of an already playing phone never pauses the PC again.
        if (b.playing && !wasPlaying) phoneTookOver(item.id, position);
        sendWindows({ cmd: "phoneState", id: item.id, position, playing: b.playing, at: now });
        json(200, { ok: true });
        return true;
      } },

      { method: "POST", path: "/api/remote/cmd", audience: "phone", handler: async ({ req, json, body }) => {
        const c = await body(req);
        const cmd = String(c.cmd ?? "");
        const value = Number(c.value);
        if (["seekBy", "seekTo", "volume", "subtitle", "subDelay"].includes(cmd) && !Number.isFinite(c.value)) { json(400, { error: "That command needs a number." }); return true; }
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
        const allowed = ["toggle", "seekBy", "seekTo", "volume", "mute", "next", "stop", "subtitle", "subDelay", "fullscreen", "play", "skip", "subPref"];
        if (!allowed.includes(cmd)) { json(400, { error: "Unknown command" }); return true; }
        /** @type {any} */
        let pref;
        if (cmd === "subPref") {
          // The phone's subtitle choice for a series/movie: off, or a language + file name. The window applies it.
          const p = c.pref;
          const str = (/** @type {unknown} */ v, /** @type {number} */ n) => (typeof v === "string" ? v.slice(0, n) : null);
          if (!itemFor(c.id)) { json(400, { error: "Bad id" }); return true; }
          if (p && p.off === true) pref = { off: true };
          else if (p && typeof p === "object" && (p.language === null || typeof p.language === "string") && typeof p.name === "string") pref = { language: str(p.language, 20), name: str(p.name, 200) ?? "" };
          else { json(400, { error: "Bad subtitle choice" }); return true; }
        }
        const msg = JSON.stringify({ cmd, value: Number.isFinite(value) ? value : undefined, id: typeof c.id === "string" ? c.id.slice(0, 200) : undefined, fromStart: !!c.fromStart, pref });
        for (const w of windows) w.write(`data: ${msg}\n\n`);
        json(200, { ok: true });
        return true;
      } },

      // ── This PC only ───────────────────────────────────────────────────────────────────

      { method: "GET", path: "/api/remote/info", audience: "pc", handler: async ({ json }) => {
        if (cfg.enabled) await refreshNet(); else netNow = await currentNetwork();
        json(200, {
          enabled: cfg.enabled, active: isActive(), urls: lanUrls(),
          network: { label: netNow.label, kind: netNow.kind, trusted: isTrusted(netNow.id) },
          trusted: cfg.trusted.map((t) => ({ id: t.id, label: t.label, added: t.added })),
          pairing: pairing && Date.now() < pairing.expires ? { pin: pairing.pin, expiresIn: Math.round((pairing.expires - Date.now()) / 1000) } : null,
          devices: cfg.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen })),
          phonesConnected: phones.size,
          phones: freshPhones().map((p) => ({ name: p.name, id: p.id, position: p.position, playing: p.playing, at: p.at })),
        });
        return true;
      } },
      { method: "POST", path: "/api/remote/enable", audience: "pc", handler: async ({ req, json, body }) => {
        const { on } = await body(req);
        cfg.enabled = !!on;
        save();
        ensureNetTimer();
        if (cfg.enabled) await refreshNet(true); else syncActive();
        json(200, { ok: true });
        return true;
      } },
      { method: "POST", path: "/api/remote/trust", audience: "pc", handler: async ({ json }) => {
        // The server reads the network itself: the page never says which network to trust.
        const n = await currentNetwork(true);
        if (n.kind === "unknown" || !n.id) { json(409, { error: "CiRoom can't tell which network this is, so it can't be trusted." }); return true; }
        if (!isTrusted(n.id)) { cfg.trusted.push({ id: n.id, label: n.label, added: Date.now() }); save(); }
        netNow = n;
        syncActive();
        json(200, { ok: true });
        return true;
      } },
      { method: "POST", path: "/api/remote/untrust", audience: "pc", handler: async ({ req, json, body }) => {
        const { id } = await body(req);
        cfg.trusted = cfg.trusted.filter((t) => t.id !== id);
        save();
        syncActive();
        json(200, { ok: true });
        return true;
      } },
      { method: "POST", path: "/api/remote/pair/start", audience: "pc", handler: async ({ json }) => {
        if (!cfg.enabled) { json(409, { error: "Turn the phone remote on first." }); return true; }
        if (!isActive()) { json(409, { error: "Trust this network first: phones are off on networks you haven't approved." }); return true; }
        pairing = { pin: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), expires: Date.now() + PIN_TTL_MS, tries: 0 };
        json(200, { pin: pairing.pin, expiresIn: PIN_TTL_MS / 1000 });
        return true;
      } },
      { method: "POST", path: "/api/remote/pair/cancel", audience: "pc", handler: async ({ json }) => {
        pairing = null; json(200, { ok: true }); return true;
      } },
      { method: "POST", path: "/api/remote/revoke", audience: "pc", handler: async ({ req, json, body }) => {
        const { id } = await body(req);
        cfg.devices = cfg.devices.filter((d) => d.id !== id);
        save();
        dropDevice(String(id));
        json(200, { ok: true });
        return true;
      } },
      { method: "POST", path: "/api/remote/report", audience: "pc", handler: async ({ req, json, body }) => {
        const b = await body(req);
        report = { at: Date.now(), now: b.now ?? null, user: b.user ?? report.user };
        json(200, { ok: true });
        pushPhones();
        return true;
      } },
      { method: "GET", path: "/api/remote/commands", audience: "pc", handler: async ({ res }) => {
        sse(res);
        // Hand over what phones watched while no window was open (before anything else on this stream).
        for (const p of Object.values(pending)) res.write(`data: ${JSON.stringify({ cmd: "progress", ...p })}\n\n`);
        if (Object.keys(pending).length) { pending = {}; savePending(); }
        res.write(`data: ${JSON.stringify({ cmd: "phones", count: phones.size })}\n\n`); // so a new window knows whether to report
        windows.add(res);
        res.on("close", () => { windows.delete(res); pushPhones(); });
        pushPhones(true);
        return true;
      } },
    ]),
  };
}
