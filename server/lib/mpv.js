// @ts-check
/**
 * Controlling mpv (the full player): start it, talk to it over its JSON IPC socket, mirror its properties.
 * Flow: spawn mpv → JSON IPC over a unix socket → observe properties → send commands.
 *
 *   POST /api/play          { path, startAt, subDelay?, dryRun? }
 *   GET  /api/player        → full snapshot (position, duration, pause, volume, speed, sub-delay, tracks…)
 *   POST /api/player/cmd    { cmd, value? }  cmd ∈ pause | seek | seek-rel | set | stop
 *     Commands sent while mpv is still starting are held and sent once the file is open; the answer is then
 *     { ok: true, queued: true }. They are thrown away if mpv exits or can't be reached.
 *   /api/play answers 503 { error } when mpv itself can't be started (not installed, not runnable…).
 *
 * All three are for this PC only (mpv opens a window here). Safety: read-only on media; only paths inside the media root.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { subtitleLanguage, subtitlesFor } from "./subtitles.js";
import { audioTrackFor, cachedGain, levelFilter, measureGainInBackground } from "./stream.js";
import { LIBRARY_FILE, MPV_SOCKET } from "./paths.js";
import { defineRoutes } from "./routes.js";

/** Track language codes (ISO 639) ↔ the language names CiRoom uses for subtitles. */
const LANG_CODES = /** @type {Record<string, string[]>} */ ({
  English: ["en", "eng"], Persian: ["fa", "per", "fas"], Arabic: ["ar", "ara"], Turkish: ["tr", "tur"], French: ["fr", "fre", "fra"],
  Spanish: ["es", "spa"], German: ["de", "ger", "deu"], Russian: ["ru", "rus"], Italian: ["it", "ita"], Japanese: ["ja", "jpn"],
  Korean: ["ko", "kor"], Chinese: ["zh", "chi", "zho"], Dutch: ["nl", "dut", "nld"], Polish: ["pl", "pol"],
});
const langFromCode = (/** @type {string | null | undefined} */ code) =>
  code ? Object.keys(LANG_CODES).find((k) => LANG_CODES[k].includes(code.toLowerCase())) ?? null : null;

/**
 * The remembered subtitle: `files` = subtitle files that would do, best first; `name` / `language` as saved
 * ({language, name}: a file's base name, "embedded:<N>:<tag>" from the page player, or a built-in track's title from mpv).
 * @typedef {{ name: string, language: string | null, files: string[], exact: boolean }} SubWant
 */

/** The remembered subtitle in mpv's own track list (never by counting: mpv skips files it can't read).
 *  @param {any[]} tracks @param {SubWant} want @returns {any} the track, or null to leave mpv's own choice */
function pickSubTrack(tracks, { name, language, files, exact }) {
  const subs = tracks.filter((t) => t.type === "sub");
  const builtIn = subs.filter((t) => !t.external);
  const sameLang = (/** @type {any} */ t) => !language || langFromCode(t.lang) === language;
  const fileTrack = (/** @type {string} */ f) =>
    subs.find((t) => t.external && t["external-filename"] && path.resolve(t["external-filename"]) === path.resolve(f));
  const embedded = /^embedded:(\d+):(.*)$/.exec(name);
  if (embedded) { // the N-th built-in subtitle, if it's still the same language (another episode may differ)
    const t = builtIn[Number(embedded[1])];
    if (t && ((t.lang ?? "und").toLowerCase() === embedded[2] || (language && sameLang(t)))) return t;
  }
  const [first, ...rest] = files;
  return (exact && fileTrack(first))
    || (name && builtIn.find((t) => t.title === name && sameLang(t)))
    || (exact ? rest : files).map(fileTrack).find(Boolean)
    || (language && builtIn.find(sameLang))
    || null;
}

/** Skip-intro markers → the controller's script options. @param {{ intro: {start:number,end:number}|null, credits: number|null } | null} m */
const markerOpts = (m) => [
  ...(m?.intro ? [`--script-opts-append=marquee-osc-intro_start=${m.intro.start}`, `--script-opts-append=marquee-osc-intro_end=${m.intro.end}`] : []),
  ...(m?.credits ? [`--script-opts-append=marquee-osc-credits=${m.credits}`] : []),
];

const MPV_CONFIG = fileURLToPath(new URL("../../mpv", import.meta.url));

/** mpv properties we mirror, and which ones the UI may set. */
const OBSERVED = ["time-pos", "duration", "pause", "eof-reached", "volume", "mute", "speed", "sub-delay", "sid", "aid", "track-list"];
const SETTABLE = new Set(["pause", "volume", "mute", "speed", "sub-delay", "sid", "aid"]);
const NUMERIC = new Set(["volume", "speed", "sub-delay"]);
/** How many commands are held while mpv is starting (the oldest go first when it's full). */
const MAX_QUEUED = 50;

/** How long /api/play waits to hear whether mpv started; no answer by then counts as started. */
const SPAWN_WAIT_MS = 2000;

/** Resolves once the process is running (null) or couldn't be started (the error). @param {import("node:child_process").ChildProcess} proc */
const startError = (proc) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), SPAWN_WAIT_MS);
  const done = (/** @type {Error | null} */ e) => { clearTimeout(timer); resolve(e); };
  proc.once("spawn", () => done(null));
  proc.once("error", done);
});

/** What the window shows when mpv can't be started. */
const startFailure = (/** @type {any} */ e) => (e?.code === "ENOENT" ? "mpv isn't installed" : "mpv isn't installed or can't be started");

/**
 * @param {{ rootAbs: string, resolveVideo: (p: string) => string, markersFor: (file: string) => { intro: {start:number,end:number}|null, credits: number|null } | null, finalSave: () => void }} deps
 *   finalSave: called when mpv goes away, to keep its last position (the progress code lives in remote.js).
 */
export function createMpv({ rootAbs, resolveVideo, markersFor, finalSave }) {
  /** The later parts of a multi-part movie (from the saved scan), checked like any played path; [] for everything else. */
  const morePartsOf = (/** @type {string} */ file) => {
    try {
      const lib = JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
      const m = (lib.movies ?? []).find((/** @type {any} */ x) => x.parts?.[0]?.path === file);
      return (m?.parts ?? []).slice(1).map((/** @type {any} */ x) => { try { return resolveVideo(String(x.path)); } catch { return ""; } }).filter(Boolean);
    } catch { return []; }
  };
  const socketPath = MPV_SOCKET;

  /** @type {any} */ const st = { proc: null, sock: null, running: false, file: "", props: {}, ended: false, hasNext: false, itemId: null };
  const resetProps = () => { st.subPick = null; st.nextRequested = false; st.ready = false; st.queue = []; st.props = { "time-pos": 0, duration: 0, pause: false, volume: 100, mute: false, speed: 1, "sub-delay": 0, sid: false, aid: false, "track-list": [] }; st.ended = false; };
  resetProps();


  /** Straight to the socket (or Windows pipe): nothing happens if it isn't connected. */
  const write = (/** @type {unknown[]} */ command, /** @type {number | undefined} */ request_id) =>
    st.sock?.write(JSON.stringify({ command, request_id }) + "\n");
  /** A player command. Until mpv has the file open it is held: before the connection it would vanish, and a seek would fail. */
  function send(/** @type {unknown[]} */ command) {
    if (st.ready) write(command);
    else if (st.running && st.queue) { st.queue.push(command); if (st.queue.length > MAX_QUEUED) st.queue.shift(); }
  }
  function flushQueue() {
    st.ready = true;
    for (const command of st.queue ?? []) write(command);
    st.queue = [];
  }

  /** Stops mpv. Resolves once a taken-over mpv (no child process to watch) is really gone, so its socket can't vanish under the next one. */
  function stop() {
    if (st.running) finalSave();
    write(["quit"]);
    st.queue = [];
    st.ready = false;
    st.proc?.kill("SIGTERM");
    st.sock?.destroy();
    const pid = st.adopted?.pid;
    st.proc = null;
    st.sock = null;
    st.running = false;
    st.adopted = null;
    return pid ? gone(pid, 2000) : Promise.resolve();
  }

  const isAlive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** Waits up to `ms` for a process to end (it was asked to quit), then SIGTERMs it and waits a little more. */
  async function gone(/** @type {number} */ pid, /** @type {number} */ ms) {
    const until = Date.now() + ms;
    while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    if (!isAlive(pid)) return;
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 20 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  }

  /** Asks whatever answers on CiRoom's socket for its pid, file and CiRoom options. null = nobody answers (a stale file). */
  function probe(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const names = ["pid", "path", "script-opts"];
      /** @type {Record<string, any>} */ const got = {};
      const sock = net.connect(socketPath);
      let buf = "";
      const done = (/** @type {any} */ v) => { clearTimeout(timer); sock.destroy(); resolve(v); };
      const timer = setTimeout(() => done(null), timeoutMs);
      sock.setEncoding("utf8");
      sock.on("connect", () => names.forEach((n, i) => sock.write(JSON.stringify({ command: ["get_property", n], request_id: 901 + i }) + "\n")));
      sock.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            const n = names[Number(msg.request_id) - 901];
            if (n) got[n] = msg.error === "success" ? msg.data : null;
          } catch { /* partial line */ }
        }
        if (names.every((n) => n in got)) done(got);
      });
      sock.on("error", () => done(null));
    });
  }

  /**
   * After a crash (D-23): an mpv started by the previous server may still be playing on CiRoom's socket. Take it over
   * (observe it again, keep saving its position, Now Playing and the phone work again) instead of starting a second one.
   * Nobody answers → the socket file is stale and is removed.
   */
  async function adopt() {
    if (st.running) return;
    const info = /** @type {any} */ (await probe());
    if (st.running) return; // a play started meanwhile (it waited for us, so this doesn't happen; just in case)
    if (!info || !Number.isInteger(info.pid) || info.pid <= 0) { try { fs.unlinkSync(socketPath); } catch { /* not there */ } return; }
    const opts = info["script-opts"] && typeof info["script-opts"] === "object" ? info["script-opts"] : {};
    const itemId = typeof opts["ciroom-item"] === "string" && /^[a-z0-9-]{1,200}$/.test(opts["ciroom-item"]) ? opts["ciroom-item"] : null;
    resetProps();
    Object.assign(st, { running: true, proc: null, file: typeof info.path === "string" ? info.path : "", hasNext: opts["marquee-osc-has_next"] === "yes", itemId, adopted: { pid: info.pid } });
    connect();
  }
  /** Set by `adopt()`; /api/play waits for it so a play never races the take-over. */
  let adopting = Promise.resolve();

  /** Applies the remembered subtitle once the file is loaded. Request ids: 1 = list the tracks, 2 = list them again after the change. */
  function subPickReply(/** @type {any} */ msg) {
    const tracks = Array.isArray(msg.data) ? msg.data : null;
    if (tracks) st.props["track-list"] = tracks;
    const t = msg.request_id === 1 && tracks ? pickSubTrack(tracks, st.subPick.want) : null;
    if (!t || t.selected) { st.subPick = null; return; }
    st.props.sid = t.id;
    write(["set_property", "sid", t.id]);
    write(["get_property", "track-list"], 2); // mpv answers in order
  }

  function connect(attempt = 0) {
    const sock = net.connect(socketPath);
    sock.on("connect", () => {
      st.sock = sock;
      OBSERVED.forEach((p, i) => write(["observe_property", i + 1, p]));
    });
    let buf = "";
    sock.setEncoding("utf8"); // a file name (Persian…) must not be cut in the middle of a character
    sock.on("data", (d) => {
      if (st.sock !== sock) return; // a socket of an mpv that went away: its last messages must not land on the next one
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.event === "client-message" && msg.args?.[0] === "marquee-next") { st.nextRequested = true; continue; }
          if (st.subPick && (msg.request_id === 1 || msg.request_id === 2)) { subPickReply(msg); continue; }
          // A real playback time means the file is open and every subtitle file has been added (or skipped).
          if (msg.name === "time-pos" && typeof msg.data === "number") {
            if (st.subPick && !st.subPick.asked) { st.subPick.asked = true; write(["get_property", "track-list"], 1); }
            if (!st.ready) flushQueue();
          }
          if (msg.event !== "property-change" || msg.data === undefined) continue;
          if (msg.name === "eof-reached") { if (msg.data) st.ended = true; continue; }
          if (msg.data !== null) st.props[msg.name] = msg.data;
        } catch { /* partial line */ }
      }
    });
    // A taken-over mpv has no child process: its socket closing is how we learn it went away (closed by the user, or crashed).
    sock.on("close", () => {
      if (st.sock !== sock || !st.adopted) return; // stop() already cleared it, or this is our own child (proc "exit" handles it)
      finalSave();
      Object.assign(st, { running: false, sock: null, ready: false, queue: [], adopted: null });
    });
    sock.on("error", () => {
      if (st.adopted && !st.sock) { Object.assign(st, { running: false, queue: [], adopted: null }); return; } // it answered a moment ago and is gone now
      if (attempt < 200 && st.running) setTimeout(() => connect(attempt + 1), 150); // mpv still starting (~30 s: a slow drive or a cold start)
      else if (!st.sock) st.queue = null; // gave up: drop what was held and hold nothing more
    });
  }

  function snapshot(peek = false) {
    const p = st.props;
    /** @type {any[]} */
    // No tracks until the remembered subtitle is on: the window must not take mpv's first pick for a user's change.
    const tracks = !st.subPick && Array.isArray(p["track-list"]) ? p["track-list"] : [];
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

  /** Apply a player command (shared by /api/player/cmd and the phone remote). @returns {boolean} false if unknown, or if a number is missing or broken */
  function playerCmd(/** @type {{cmd:string,name?:string,value?:any}} */ { cmd, name, value }) {
    const needsNumber = cmd === "seek" || cmd === "seek-rel" || (cmd === "set" && NUMERIC.has(name ?? ""));
    if (needsNumber && !Number.isFinite(value)) return false; // NaN would reach mpv and the mirrored state
    if (cmd === "pause") send(["cycle", "pause"]);
    else if (cmd === "seek") send(["seek", value, "absolute"]);
    else if (cmd === "seek-rel") send(["seek", value, "relative"]);
    else if (cmd === "set" && name && SETTABLE.has(name)) {
      send(["set_property", name, value]);
      st.props[name] = value; // optimistic; mpv confirms via property-change
    } else if (cmd === "stop") stop();
    else return false;
    return true;
  }

  /** Skip intro / credits while mpv plays (for the phone): what the button would do right now, or null. */
  function mpvSkipState() {
    if (!st.running || !st.file) return null;
    const m = markersFor(st.file);
    const pos = Number(st.props["time-pos"]) || 0, dur = Number(st.props.duration) || 0;
    if (m?.intro && pos >= m.intro.start && pos < m.intro.end - 1) return { kind: "intro", label: "Skip intro" };
    if (m?.credits && pos >= m.credits && (!dur || pos < dur - 2)) return { kind: "credits", label: st.hasNext ? "Next episode" : "Skip credits" };
    return null;
  }
  function mpvSkip() {
    const k = mpvSkipState();
    const m = st.file ? markersFor(st.file) : null;
    if (!k || !m) return false;
    if (k.kind === "intro" && m.intro) send(["seek", m.intro.end, "absolute"]);
    else if (st.hasNext) st.nextRequested = true; // the window starts the next episode (same path as N in mpv)
    else send(["seek", Math.max(0, (Number(st.props.duration) || 0) - 1), "absolute"]);
    return true;
  }

  /** Clean shutdown: ask mpv to quit, wait up to 1 s, then SIGTERM. `beforeQuit` queues mpv's last position first. */
  async function shutdown(/** @type {() => void} */ beforeQuit) {
    if (!st.running) return;
    try { beforeQuit(); } catch { /* best effort */ }
    const proc = st.proc;
    const adoptedPid = st.adopted?.pid;
    st.adopted = null; // its socket closing is now expected: no second save
    write(["quit"]);
    if (proc && proc.exitCode === null) {
      await Promise.race([new Promise((r) => proc.once("exit", r)), new Promise((r) => setTimeout(r, 1000))]);
      if (proc.exitCode === null) proc.kill("SIGTERM");
    } else if (adoptedPid) await gone(adoptedPid, 1000);
    st.running = false;
  }

  return {
    snapshot, shutdown,
    /** At server start: take over an mpv the previous server left playing (after a crash). Never called by `vite build`. */
    adopt: () => (adopting = adopt().catch(() => {})),
    /** What the phone remote needs from mpv (see remote.js). */
    forRemote: { itemId: () => st.itemId ?? null, running: () => !!st.running, snapshot: (/** @type {boolean} */ peek) => snapshot(peek), command: playerCmd, skipState: mpvSkipState, skip: mpvSkip },
    routes: defineRoutes("mpv", [
      { method: "GET", path: "/api/player", audience: "pc", handler: ({ json }) => json(200, snapshot()) },
      { method: "POST", path: "/api/play", audience: "pc", handler: async ({ req, json, body }) => {
          const { path: p, startAt = 0, subDelay = 0, volume = 100, title = "", hasNext = false, dryRun = false, level = true, subPref = null, audioLang = null, itemId = null } = await body(req);
          const file = resolveVideo(String(p));
          // Remembered per-series choices (the UI sends them): subtitle language/off and audio language.
          const subs = subtitlesFor(file);
          let slang = ["en", "eng"];
          /** @type {string[]} */ const sidArg = [];
          /** @type {SubWant | null} */ let subWant = null;
          if (subPref && subPref.off) sidArg.push("--sid=no");
          else if (subPref && (subPref.language || subPref.name)) {
            const name = String(subPref.name ?? ""), language = subPref.language ? String(subPref.language) : null;
            const named = subs.find((f) => path.basename(f) === name && (!language || subtitleLanguage(f) === language));
            const others = language ? subs.filter((f) => f !== named && subtitleLanguage(f) === language) : [];
            subWant = { name, language, exact: !!named, files: named ? [named, ...others] : others };
            if (language && LANG_CODES[language]) slang = [...LANG_CODES[language], ...slang]; // mpv's own start, before the pick
          }
          const alang = [...(typeof audioLang === "string" && /^[a-z]{2,3}$/i.test(audioLang) ? [audioLang] : []), "en", "eng"];
          const track = level ? await audioTrackFor(file, alang) : 0; // the gain of the track mpv will play
          const knownGain = level ? cachedGain(file, track) : undefined;
          if (level && knownGain === undefined) measureGainInBackground(file, track); // don't block the play button; next play has it
          const levelAf = knownGain !== undefined ? levelFilter(knownGain) : null; // same levelling as the page player
          if (dryRun) return json(200, { ok: true, file });
          await adopting; // a take-over at start-up finishes first: never two mpv at once
          await stop();
          try { fs.unlinkSync(socketPath); } catch { /* not there */ }
          resetProps();
          Object.assign(st, { running: true, file, hasNext: !!hasNext, itemId: typeof itemId === "string" && /^[a-z0-9-]{1,200}$/.test(itemId) ? itemId : null, adopted: null });
          st.props["time-pos"] = startAt;
          if (subWant) st.subPick = { want: subWant, asked: false };
          /** No mpv after all: forget it (no position to save) and tell the window why. */
          const failed = (/** @type {any} */ e) => {
            Object.assign(st, { running: false, proc: null, queue: [] });
            console.error(`mpv couldn't be started: ${e?.message ?? e}`);
            return json(503, { error: startFailure(e) });
          };
          let proc;
          try { proc = spawn("mpv", [
            `--config-dir=${MPV_CONFIG}`, // Marquee's own look + shortcuts (mpv/), not the user's ~/.config/mpv
            `--input-ipc-server=${socketPath}`,
            "--fullscreen", `--slang=${slang.join(",")}`, `--alang=${alang.join(",")}`, ...sidArg,
            `--force-media-title=${String(title).trim() || path.parse(file).name}`,
            `--script-opts-append=marquee-osc-has_next=${hasNext ? "yes" : "no"}`, // Next-episode button
            ...(st.itemId ? [`--script-opts-append=ciroom-item=${st.itemId}`] : []), // lets a restarted server know what this mpv plays (D-23)
            ...markerOpts(markersFor(file)), // Skip intro / Skip credits button
            ...subs.map((f) => `--sub-file=${f}`),
            `--start=${Math.max(0, Math.floor(startAt))}`,
            `--sub-delay=${Number(subDelay) || 0}`,
            `--volume=${Math.max(0, Math.min(130, volume !== null && volume !== "" && Number.isFinite(Number(volume)) ? Number(volume) : 100))}`, "--volume-max=130",
            ...(levelAf ? [`--af=lavfi=[${levelAf}]`] : []),
            file, ...morePartsOf(file), // a multi-part movie (CD1/CD2) is one mpv playlist
          ], { stdio: "ignore" }); } catch (e) { return failed(e); } // some failures throw instead of emitting "error"
          st.proc = proc;
          proc.on("exit", () => { if (st.proc === proc) { finalSave(); st.running = false; st.proc = null; st.sock?.destroy(); st.sock = null; st.ready = false; st.queue = []; } });
          proc.on("error", () => { if (st.proc === proc) st.running = false; });
          const error = await startError(proc);
          if (error && st.proc === proc) return failed(error);
          if (error) return json(503, { error: startFailure(error) }); // a newer play took over meanwhile: leave its state alone
          setTimeout(() => connect(), 200);
          return json(200, { ok: true, file });
      } },
      { method: "POST", path: "/api/player/cmd", audience: "pc", handler: async ({ req, json, body }) => {
        if (!playerCmd(await body(req))) return json(400, { error: "Unknown command or bad value" });
        json(200, st.running && !st.ready ? { ok: true, queued: true } : { ok: true });
      } },
    ]),
  };
}
