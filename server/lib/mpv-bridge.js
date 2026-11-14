// @ts-check
/**
 * mpv bridge: plays the real files in mpv and serves all of CiRoom's routes. Runs inside the standalone
 * server (server/index.js) and, in the test version, inside Vite. Flow:
 * spawn mpv → JSON IPC over a unix socket → observe properties → send commands.
 *
 * Endpoints (this PC only unless the phone remote or a party is on):
 *   POST /api/play          { path, startAt, subDelay?, dryRun? }
 *   GET  /api/player        → full snapshot (position, duration, pause, volume, speed, sub-delay, tracks…)
 *   POST /api/player/cmd    { cmd, value? }  cmd ∈ pause | seek | seek-rel | set | stop
 *
 * Plus the artwork/TMDB endpoints from ./artwork-store.js.
 * Safety: read-only on media. Only paths inside the media root are accepted.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { artworkRoutes } from "./artwork-store.js";
import { subtitleLanguage, subtitlesFor } from "./subtitles.js";
import { levelFilter, levelGain, streamRoutes } from "./stream.js";
import { metadataRoutes } from "./metadata.js";
import { scannerRoutes } from "./scanner.js";
import { subtitleSearchRoutes } from "./subtitle-search.js";
import { remoteRoutes } from "./remote.js";
import { partyRoutes } from "./party.js";
import { userdbRoutes } from "./userdb.js";
import { introRoutes } from "./intro.js";
import { checkTools } from "./deps.js";
import { fileURLToPath } from "node:url";
import { DATA_DIR, MPV_SOCKET, SHARED, isMediaRoot, openUrlCommand, saveMediaRoot, savedMediaRoot } from "./paths.js";

/** Marquee's mpv profile (mpv.conf, input.conf, script-opts/osc.conf). */
/** Track language codes (ISO 639) ↔ the language names CiRoom uses for subtitles. */
const LANG_CODES = /** @type {Record<string, string[]>} */ ({
  English: ["en", "eng"], Persian: ["fa", "per", "fas"], Arabic: ["ar", "ara"], Turkish: ["tr", "tur"], French: ["fr", "fre", "fra"],
  Spanish: ["es", "spa"], German: ["de", "ger", "deu"], Russian: ["ru", "rus"], Italian: ["it", "ita"], Japanese: ["ja", "jpn"],
  Korean: ["ko", "kor"], Chinese: ["zh", "chi", "zho"], Dutch: ["nl", "dut", "nld"], Polish: ["pl", "pol"],
});
const langFromCode = (/** @type {string | null | undefined} */ code) =>
  code ? Object.keys(LANG_CODES).find((k) => LANG_CODES[k].includes(code.toLowerCase())) ?? null : null;

/** Number of subtitle streams inside the video file (mpv numbers external subtitle files after them). */
const embeddedSubCount = (/** @type {string} */ file) => new Promise((resolve) => {
  execFile("ffprobe", ["-v", "error", "-select_streams", "s", "-show_entries", "stream=index", "-of", "csv=p=0", file], { timeout: 30_000, killSignal: "SIGKILL" }, (err, out) =>
    resolve(err ? 0 : String(out).trim().split("\n").filter(Boolean).length));
});

/** Skip-intro markers → the controller's script options. @param {{ intro: {start:number,end:number}|null, credits: number|null } | null} m */
const markerOpts = (m) => [
  ...(m?.intro ? [`--script-opts-append=marquee-osc-intro_start=${m.intro.start}`, `--script-opts-append=marquee-osc-intro_end=${m.intro.end}`] : []),
  ...(m?.credits ? [`--script-opts-append=marquee-osc-credits=${m.credits}`] : []),
];

const MPV_CONFIG = fileURLToPath(new URL("../../mpv", import.meta.url));

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts|wmv)$/i;

/** mpv properties we mirror, and which ones the UI may set. */
const OBSERVED = ["time-pos", "duration", "pause", "eof-reached", "volume", "mute", "speed", "sub-delay", "sid", "aid", "track-list"];
const SETTABLE = new Set(["pause", "volume", "mute", "speed", "sub-delay", "sid", "aid"]);

/** CiRoom's version: set by the desktop app (CIROOM_VERSION), else read from package.json (test version). */
function appVersion() {
  if (process.env.CIROOM_VERSION) return process.env.CIROOM_VERSION;
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

/**
 * CiRoom's server: every /api route, the phone remote and the watch party. Used by the Vite dev server (the
 * test version, mpvBridge below) and by the standalone server (server/index.js) the installed app runs.
 * @param {string} mediaRoot
 */
export function createCiRoom(mediaRoot) {
  const rootAbs = path.resolve(mediaRoot);
  const socketPath = MPV_SOCKET;

  /** @type {any} */
  const st = { proc: null, sock: null, running: false, file: "", props: {}, ended: false, hasNext: false };
  const resetProps = () => { st.nextRequested = false; st.props = { "time-pos": 0, duration: 0, pause: false, volume: 100, mute: false, speed: 1, "sub-delay": 0, sid: false, aid: false, "track-list": [] }; st.ended = false; };
  resetProps();

  const send = (/** @type {unknown[]} */ command) => st.sock?.write(JSON.stringify({ command }) + "\n");

  function stop() {
    send(["quit"]);
    st.proc?.kill("SIGTERM");
    st.sock?.destroy();
    st.proc = null;
    st.sock = null;
    st.running = false;
  }

  function connect(attempt = 0) {
    const sock = net.connect(socketPath);
    sock.on("connect", () => {
      st.sock = sock;
      OBSERVED.forEach((p, i) => send(["observe_property", i + 1, p]));
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.event === "client-message" && msg.args?.[0] === "marquee-next") { st.nextRequested = true; continue; }
          if (msg.event !== "property-change" || msg.data === undefined) continue;
          if (msg.name === "eof-reached") { if (msg.data) st.ended = true; continue; }
          if (msg.data !== null) st.props[msg.name] = msg.data;
        } catch { /* partial line */ }
      }
    });
    sock.on("error", () => {
      if (attempt < 40 && st.running) setTimeout(() => connect(attempt + 1), 150); // mpv still starting
    });
  }

  function snapshot(peek = false) {
    const p = st.props;
    /** @type {any[]} */
    const tracks = Array.isArray(p["track-list"]) ? p["track-list"] : [];
    const pick = (/** @type {string} */ type) =>
      tracks.filter((t) => t.type === type).map((t) => ({
        id: t.id, title: t.title ?? null, lang: t.lang ?? null, codec: t.codec ?? null,
        external: !!t.external, selected: !!t.selected,
        label: t.external && t["external-filename"] ? path.basename(t["external-filename"]) : null,
        // Language name ("Persian"): read from the subtitle file's text for external files, else the track tag.
        language: type === "sub" && t.external && t["external-filename"] ? subtitleLanguage(t["external-filename"]) : langFromCode(t.lang),
      }));
    const nextRequested = st.nextRequested;
    if (!peek) st.nextRequested = false; // deliver once (the phone remote only peeks)
    return {
      running: st.running, ended: st.ended, nextRequested, file: st.file ? path.relative(rootAbs, st.file) : "",
      position: p["time-pos"] ?? 0, duration: p.duration ?? 0, paused: !!p.pause,
      volume: p.volume ?? 100, muted: !!p.mute, speed: p.speed ?? 1, subDelay: p["sub-delay"] ?? 0,
      sid: p.sid === false ? null : p.sid, aid: p.aid === false ? null : p.aid,
      subtitles: pick("sub"), audio: pick("audio"),
    };
  }

  /**
   * The library's expected path may not be the exact on-disk name (folder-based identity).
   * Walk up (never above the title folder) and pick the matching video.
   * @param {string} expected
   */
  function resolveVideo(expected) {
    const abs = path.resolve(expected);
    if (!abs.startsWith(rootAbs + path.sep)) throw new Error("Path outside the media library");
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;

    const parts = path.relative(rootAbs, abs).split(path.sep);
    const floor = path.join(rootAbs, ...parts.slice(0, 2)); // <root>/Movies|Series/<Title>
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir) && dir.length > floor.length) dir = path.dirname(dir);
    if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${path.relative(rootAbs, floor)}`);

    /** @type {{p: string, depth: number, size: number}[]} */
    const found = [];
    const walk = (/** @type {string} */ d, depth = 0) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (VIDEO.test(e.name)) found.push({ p, depth, size: fs.statSync(p).size });
      }
    };
    walk(dir);
    if (!found.length) throw new Error("No video file found in this folder");

    const m = path.basename(abs).match(/S(\d+)E(\d+)/i);
    let pool = found;
    if (m) {
      const re = new RegExp(`(^|\\D)S?0*${Number(m[1])}\\W*(?:E|EP|x)0*${Number(m[2])}(?!\\d)`, "i");
      // Folder beats filename (SPEC §7.2): "S03/EP02/E.mkv" is S03E02.
      const rel = (/** @type {string} */ f) => path.relative(floor, f);
      pool = found.filter((f) => re.test(path.dirname(rel(f.p))));
      if (!pool.length) pool = found.filter((f) => re.test(rel(f.p)));
      if (!pool.length) throw new Error(`Episode S${m[1]}E${m[2]} not found on disk`);
    }
    return pool.sort((a, b) => a.depth - b.depth || b.size - a.size)[0].p;
  }

  /** Largest request body we read: 1 MB, or 20 MB for an artwork upload (a picture as a data URL). */
  const bodyLimit = (/** @type {import("node:http").IncomingMessage} */ req) =>
    String(req.url ?? "").split("?")[0] === "/api/art/upload" ? 20 * 1024 * 1024 : 1024 * 1024;

  /** Thrown when a request body is over the limit; the handlers' catch turns it into HTTP 413. */
  class BodyTooLarge extends Error {
    constructor() { super("Request body too large"); }
  }

  /** @param {import("node:http").IncomingMessage} req @returns {Promise<any>} */
  const body = (req) => new Promise((resolve, reject) => {
    const limit = bodyLimit(req);
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { chunks.length = 0; reject(new BodyTooLarge()); return; }
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { resolve({}); } });
  });

  /** Apply a player command (shared by /api/player/cmd and the phone remote). @returns {boolean} false if unknown */
  function playerCmd(/** @type {{cmd:string,name?:string,value?:any}} */ { cmd, name, value }) {
    if (cmd === "pause") send(["cycle", "pause"]);
    else if (cmd === "seek") send(["seek", Number(value), "absolute"]);
    else if (cmd === "seek-rel") send(["seek", Number(value), "relative"]);
    else if (cmd === "set" && name && SETTABLE.has(name)) {
      send(["set_property", name, value]);
      st.props[name] = value; // optimistic; mpv confirms via property-change
    } else if (cmd === "stop") stop();
    else return false;
    return true;
  }

  const intro = introRoutes(resolveVideo, rootAbs);
  /** Skip intro / credits while mpv plays (for the phone): what the button would do right now, or null. */
  function mpvSkipState() {
    if (!st.running || !st.file) return null;
    const m = intro.markersFor(st.file);
    const pos = Number(st.props["time-pos"]) || 0, dur = Number(st.props.duration) || 0;
    if (m?.intro && pos >= m.intro.start && pos < m.intro.end - 1) return { kind: "intro", label: "Skip intro" };
    if (m?.credits && pos >= m.credits && (!dur || pos < dur - 2)) return { kind: "credits", label: st.hasNext ? "Next episode" : "Skip credits" };
    return null;
  }
  function mpvSkip() {
    const k = mpvSkipState();
    const m = st.file ? intro.markersFor(st.file) : null;
    if (!k || !m) return false;
    if (k.kind === "intro" && m.intro) send(["seek", m.intro.end, "absolute"]);
    else if (st.hasNext) st.nextRequested = true; // the window starts the next episode (same path as N in mpv)
    else send(["seek", Math.max(0, (Number(st.props.duration) || 0) - 1), "absolute"]);
    return true;
  }
  /** @type {(() => void)[]} called when the phone remote or the watch party is switched on/off */
  const netListeners = [];
  const remote = remoteRoutes({ running: () => !!st.running, snapshot: (/** @type {boolean} */ peek) => snapshot(peek), command: playerCmd, skipState: mpvSkipState, skip: mpvSkip }, () => server_port, () => netListeners.forEach((f) => f()));

  const art = artworkRoutes();
  const userdb = userdbRoutes();
  const stream = streamRoutes(resolveVideo);
  const meta = metadataRoutes();
  const scanner = scannerRoutes(rootAbs);
  const subSearch = subtitleSearchRoutes(resolveVideo);
  const party = partyRoutes({ resolveVideo, stream, getPort: () => server_port, onToggle: () => netListeners.forEach((f) => f()) });

  /**
   * DNS-rebinding guard: a web page on another site could point its own domain name at 127.0.0.1 and then read
   * this API as "same origin". Our middleware runs before Vite's own host check, so we check here: only plain IP
   * addresses and localhost may be used to reach CiRoom.
   * @param {string | undefined} host
   */
  const hostAllowed = (host) => {
    const h = String(host ?? "").toLowerCase().replace(/:\d+$/, "");
    return h === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h);
  };

  let server_port = 1420;
  return {
    /** Starts the background work (skip-intro analysis). Never called by `vite build`. */
    start: () => { intro.start(); },
    setPort: (/** @type {number} */ p) => { server_port = p; },
    /** True when other devices may need to reach this server (phone remote or watch party on). */
    wantsNetwork: () => remote.isEnabled() || party.isEnabled(),
    /** Calls `fn` whenever the phone remote or the watch party is switched on or off. */
    onNetworkChange: (/** @type {() => void} */ fn) => { netListeners.push(fn); },
    /** WebSocket upgrades (Vite's live reload only): nothing on another device needs them. */
    upgrade: (/** @type {import("node:http").IncomingMessage} */ req, /** @type {import("node:stream").Duplex} */ socket) => {
      const ip = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (ip !== "127.0.0.1" && ip !== "::1") socket.destroy();
    },
    /**
     * Connect-style handler: answers CiRoom's routes, calls next() for everything else (the page itself).
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {() => void} next
     */
    handle: async (req, res, next) => {
        const peer = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
        const onThisPc = peer === "127.0.0.1" || peer === "::1";
        if (!hostAllowed(req.headers.host)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Use an IP address or localhost to reach CiRoom" }));
          return;
        }
        // Cross-site protection: a web page in the user's browser can POST text/plain to 127.0.0.1 without a
        // preflight. Anything that changes something must come from our own page (same origin) and be JSON.
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
          const origin = req.headers.origin;
          if (origin !== undefined && origin !== `http://${req.headers.host}`) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Cross-site request refused" }));
            return;
          }
          if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
            res.statusCode = 415;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "JSON only" }));
            return;
          }
          // Honest clients announce the size: refuse before reading anything (chunked bodies are cut off in body()).
          if (Number(req.headers["content-length"] ?? 0) > bodyLimit(req)) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Connection", "close");
            res.end(JSON.stringify({ error: "Request body too large" }));
            return;
          }
        }
        // Watch party: its own gate and allow-list (server/lib/party.js); guests never reach the rest of the app.
        if (party.owns(req.url)) {
          const pjson = (/** @type {number} */ code, /** @type {unknown} */ data) => {
            if (res.headersSent) return void res.end();
            res.statusCode = code;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(data));
          };
          try {
            await party.handle(req, res, peer, onThisPc, pjson, body);
          } catch (e) {
            if (e instanceof BodyTooLarge) return void pjson(413, { error: e.message });
            pjson(400, { error: onThisPc && e instanceof Error ? e.message : "Something went wrong" });
          }
          return;
        }
        // Identity check for the desktop app (src-tauri): is the thing on this port CiRoom? This PC only.
        if (onThisPc && req.method === "GET" && String(req.url).split("?")[0] === "/api/ping") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ app: "ciroom", version: appVersion() }));
          return;
        }
        // Which of ffmpeg / ffprobe / mpv are missing (Settings shows it). This PC only.
        if (onThisPc && req.method === "GET" && String(req.url).split("?")[0] === "/api/system/tools") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ tools: await checkTools(String(req.url).includes("fresh=1")) }));
          return;
        }
        if (!onThisPc) {
          // Other devices (the phone remote): off unless the user turned it on, then token-gated (server/lib/remote.js).
          const refuse = remote.gate(req, peer);
          if (refuse) {
            res.statusCode = refuse;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: refuse === 401 ? "Not paired" : "Not allowed from this device" }));
            return;
          }
        }
        if (!req.url?.startsWith("/api/")) return next();
        // Home-network only: phones on the Wi-Fi may browse and stream; nothing else may connect.
        // Launching/controlling mpv (which opens a window on this PC) is limited to this PC itself.
        const ip = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
        const local = ip === "127.0.0.1" || ip === "::1";
        const lan = local || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
        if (!lan || (!local && /^\/api\/(play|player)/.test(req.url) && !req.url.startsWith("/api/remote/"))) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Not allowed from this device" }));
          return;
        }
        const json = (/** @type {number} */ code, /** @type {unknown} */ data) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        try {
          if (await remote.handle(req, res, json, body, local)) return;
          if (await userdb.handle(req, json, body, local)) return;
          if (await intro.handle(req, json)) return;
          if (await art.handle(req, res, body, json)) return;
          if (await stream.handle(req, res, json, body)) return;
          if (await subSearch.handle(req, res, json, body)) return;
          if (await meta.handle(req, res, body, json)) return;
          if (await scanner.handle(req, res, json)) return;

          if (req.url === "/api/player" && req.method === "GET") return json(200, snapshot());

          if (req.url === "/api/play" && req.method === "POST") {
            const { path: p, startAt = 0, subDelay = 0, volume = 100, title = "", hasNext = false, dryRun = false, level = true, subPref = null, audioLang = null } = await body(req);
            const file = resolveVideo(String(p));
            // Remembered per-series choices (the UI sends them): subtitle language/off and audio language.
            const subs = subtitlesFor(file);
            let slang = ["en", "eng"];
            /** @type {string[]} */ const sidArg = [];
            if (subPref && subPref.off) sidArg.push("--sid=no");
            else if (subPref && (subPref.language || subPref.name)) {
              const k = subs.findIndex((f) => path.basename(f) === subPref.name && (!subPref.language || subtitleLanguage(f) === subPref.language));
              const k2 = k >= 0 ? k : subPref.language ? subs.findIndex((f) => subtitleLanguage(f) === subPref.language) : -1;
              if (k2 >= 0) sidArg.push(`--sid=${(await embeddedSubCount(file)) + k2 + 1}`);
              else if (subPref.language && LANG_CODES[subPref.language]) slang = [...LANG_CODES[subPref.language], ...slang]; // maybe a built-in track
            }
            const alang = [...(typeof audioLang === "string" && /^[a-z]{2,3}$/i.test(audioLang) ? [audioLang] : []), "en", "eng"];
            const levelAf = level ? levelFilter(await levelGain(file).catch(() => 0)) : null; // same levelling as the page player
            if (dryRun) return json(200, { ok: true, file });
            stop();
            try { fs.unlinkSync(socketPath); } catch { /* not there */ }
            resetProps();
            Object.assign(st, { running: true, file, hasNext: !!hasNext });
            st.props["time-pos"] = startAt;
            const proc = spawn("mpv", [
              `--config-dir=${MPV_CONFIG}`, // Marquee's own look + shortcuts (mpv/), not the user's ~/.config/mpv
              `--input-ipc-server=${socketPath}`,
              "--fullscreen", `--slang=${slang.join(",")}`, `--alang=${alang.join(",")}`, ...sidArg,
              `--force-media-title=${String(title).trim() || path.parse(file).name}`,
              `--script-opts-append=marquee-osc-has_next=${hasNext ? "yes" : "no"}`, // Next-episode button
              ...markerOpts(intro.markersFor(file)), // Skip intro / Skip credits button
              ...subs.map((f) => `--sub-file=${f}`),
              `--start=${Math.max(0, Math.floor(startAt))}`,
              `--sub-delay=${Number(subDelay) || 0}`,
              `--volume=${Math.max(0, Math.min(130, Number(volume) || 100))}`, "--volume-max=130",
              ...(levelAf ? [`--af=lavfi=[${levelAf}]`] : []),
              file,
            ], { stdio: "ignore" });
            st.proc = proc;
            proc.on("exit", () => { if (st.proc === proc) { st.running = false; st.proc = null; st.sock = null; } });
            proc.on("error", () => { st.running = false; });
            setTimeout(() => connect(), 200);
            return json(200, { ok: true, file });
          }

          // Trailer → the system browser. This PC only; only a YouTube video id is accepted (never an arbitrary URL).
          if (req.url === "/api/open-trailer" && req.method === "POST") {
            if (!local) return json(403, { error: "Not allowed from this device" });
            const { key } = await body(req);
            if (!/^[\w-]{6,20}$/.test(String(key))) return json(400, { error: "Bad video id" });
            const [cmd, args] = openUrlCommand(`https://www.youtube.com/watch?v=${key}`);
            spawn(cmd, [...args], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
            return json(200, { ok: true });
          }

          // Library folder (Settings). This PC only. Takes effect when CiRoom restarts.
          if (req.url === "/api/media-root") {
            if (!local) return json(403, { error: "Not allowed from this device" });
            if (req.method === "GET") return json(200, { current: rootAbs, saved: savedMediaRoot(), ok: isMediaRoot(rootAbs), dataDir: DATA_DIR, shared: SHARED });
            if (req.method === "POST") {
              const p = path.resolve(String((await body(req)).path ?? "").trim());
              if (!isMediaRoot(p)) return json(400, { error: "That folder has no Movies or Series folder inside" });
              saveMediaRoot(p);
              return json(200, { saved: p, restart: p !== rootAbs });
            }
          }

          if (req.url === "/api/player/cmd" && req.method === "POST") {
            if (!playerCmd(await body(req))) return json(400, { error: "Unknown command" });
            return json(200, { ok: true });
          }

          return json(404, { error: "Unknown endpoint" });
        } catch (e) {
          if (e instanceof BodyTooLarge) return json(413, { error: e.message });
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
    },
  };
}

/** Vite plugin: the dev server (test version) runs CiRoom's server inside Vite. @param {string} mediaRoot */
export function mpvBridge(mediaRoot) {
  const app = createCiRoom(mediaRoot);
  return {
    name: "marquee-dev-bridge",
    /** @param {import("vite").ViteDevServer} server */
    configureServer(server) {
      app.start(); // dev server only (not during `vite build`)
      server.httpServer?.once("listening", () => app.setPort(Number(/** @type {any} */ (server.httpServer?.address())?.port) || 1420));
      // Vite's live-reload WebSocket only checks its token when the request has an Origin header (browsers),
      // so a script on another device could still connect: refuse those first.
      server.httpServer?.prependListener("upgrade", app.upgrade);
      server.middlewares.use((req, res, next) => { app.handle(req, res, next); });
    },
  };
}
