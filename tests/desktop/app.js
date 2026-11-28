// Desktop end-to-end driver: runs the REAL packaged CiRoom app (the AppImage, or an extracted package) like a user would,
// fully isolated from the user's own CiRoom, and drives its window.
//
//   - Display: a private nested X server (Xephyr), so the app's window, its fullscreen and mpv's window never appear on
//     the user's desktop and real mouse/keyboard input (XTest) never moves the user's pointer. The Xephyr window itself
//     shows up on the desktop (titled "CiRoom tests").
//   - Isolation: its own HOME / XDG folders, its own D-Bus session (else the single-instance plugin would hand over to
//     the user's running CiRoom), its own data/cache/library folders, its own XDG_RUNTIME_DIR (mpv socket).
//   - Sound: a silent PipeWire sink; the page player (WebKit/GStreamer) and mpv both play into it, and a test can record
//     it to prove sound is really produced.
//   - Page access: WebKitGTK's remote inspector (WEBKIT_INSPECTOR_HTTP_SERVER, works in release builds), WebKit
//     Inspector Protocol over a WebSocket: evaluate JS, read the console. Clicks and keys are REAL X input at the
//     element's position (xinput.c), not synthetic DOM events.
//   - Close = WM_DELETE_WINDOW (the title bar's X); crash = SIGKILL of the app process.
//
// Needs: Xephyr, cc + libX11/libXtst headers, pw-cli/pw-record (PipeWire), xwd + ffmpeg (screenshots), dbus-run-session.
// App under test: CIROOM_APP=<path to an AppImage or to an extracted squashfs-root>, default ~/Applications/CiRoom.AppImage.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request, postJson, freePort } from "../helpers.js";

const here = import.meta.dirname;
export const APP = process.env.CIROOM_APP || path.join(os.homedir(), "Applications/CiRoom.AppImage");
const has = (/** @type {string} */ t) => { try { execFileSync("sh", ["-c", `command -v ${t}`], { stdio: "ignore" }); return true; } catch { return false; } };
export const MISSING = ["Xephyr", "cc", "pw-cli", "pw-record", "xwd", "ffmpeg", "dbus-run-session"].filter((t) => !has(t)).concat(fs.existsSync(APP) ? [] : [`app (${APP})`]);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
async function until(/** @type {() => any} */ fn, ms = 10000, step = 150, what = "") {
  const t0 = Date.now(); let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e instanceof Error ? e.message : e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out${what ? ` waiting for ${what}` : ""}; last: ${JSON.stringify(last)}`);
    await sleep(step);
  }
}

/** Builds the X input helper once (into the OS temp folder). */
function xinputBin() {
  const bin = path.join(os.tmpdir(), "ciroom-e2e-xinput");
  const src = path.join(here, "xinput.c");
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) execFileSync("cc", ["-O2", "-o", bin, src, "-lX11", "-lXtst"]);
  return bin;
}

/** A private X display (Xephyr). One per test file; stop() at the end. */
export async function startDisplay({ width = 1600, height = 1000 } = {}) {
  let n = 70; while (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) n++;
  const display = `:${n}`;
  const proc = spawn("Xephyr", [display, "-screen", `${width}x${height}`, "-ac", "-br", "-noreset", "-title", "CiRoom tests (automatic, safe to ignore)"], { stdio: "ignore" });
  await until(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), 10000, 100, "Xephyr");
  const xi = xinputBin();
  const x = (/** @type {string[]} */ ...args) => execFileSync(xi, args, { env: { ...process.env, DISPLAY: display }, encoding: "utf8" });
  return {
    display, width, height, x,
    /** Top-level windows: [{ id, pid, x, y, w, h, name }] */
    windows: () => x("wins").trim().split("\n").filter(Boolean).map((l) => { const [id, pid, wx, wy, w, h, ...name] = l.split(" "); return { id, pid: Number(pid), x: Number(wx), y: Number(wy), w: Number(w), h: Number(h), name: name.join(" ") }; }),
    /** Screenshot of the whole display or one window (real pixels, as composited by X). */
    shot(/** @type {string} */ file, /** @type {string=} */ win) {
      const xwd = execFileSync("xwd", ["-silent", ...(win ? ["-id", win] : ["-root"])], { env: { ...process.env, DISPLAY: display }, maxBuffer: 64 << 20 });
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", "-", file], { input: xwd });
      return file;
    },
    stop() { proc.kill("SIGTERM"); },
  };
}

/** A silent PipeWire sink the app plays into. level(sec) records it and returns the mean volume in dB (-91 = silence). */
export function silentSink(/** @type {string} */ name = `ciroom-e2e-${process.pid}`) {
  execFileSync("pw-cli", ["create-node", "adapter", `{ factory.name=support.null-audio-sink node.name=${name} media.class=Audio/Sink audio.position=[FL FR] object.linger=true }`], { stdio: "ignore" });
  return {
    name,
    async level(sec = 2) {
      const file = path.join(os.tmpdir(), `${name}-${Date.now()}.wav`);
      const rec = spawn("pw-record", ["-P", "{ stream.capture.sink=true }", "--target", name, file], { stdio: "ignore" });
      await sleep(sec * 1000); rec.kill("SIGINT"); await new Promise((r) => rec.once("exit", r));
      try {
        const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
        return Number(/mean_volume: (-?[\d.]+)/.exec(r.stderr ?? "")?.[1] ?? -91);
      }
      finally { fs.rmSync(file, { force: true }); }
    },
    /** Records the sink and returns { db, hz }: mean level and the main tone's frequency (zero crossings), to tell audio tracks apart. */
    async tone(sec = 2) {
      const file = path.join(os.tmpdir(), `${name}-${Date.now()}.wav`);
      const rec = spawn("pw-record", ["-P", "{ stream.capture.sink=true }", "--target", name, file], { stdio: "ignore" });
      await sleep(sec * 1000); rec.kill("SIGINT"); await new Promise((r) => rec.once("exit", r));
      try {
        const raw = spawnSync("ffmpeg", ["-loglevel", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 64 << 20 }).stdout;
        const n = Math.floor(raw.length / 2); let zc = 0, sq = 0, prev = 0, loud = 0;
        for (let i = 0; i < n; i++) { const v = raw.readInt16LE(i * 2); sq += v * v; if (Math.abs(v) > 300) { loud++; if ((v > 0) !== (prev > 0)) zc++; prev = v; } }
        const rms = Math.sqrt(sq / Math.max(1, n));
        return { db: rms > 0 ? Math.round(20 * Math.log10(rms / 32768) * 10) / 10 : -91, hz: loud ? Math.round((zc / 2) / (loud / 48000)) : 0 };
      } finally { fs.rmSync(file, { force: true }); }
    },
    destroy() {
      try {
        const ls = execFileSync("pw-cli", ["ls", "Node"], { encoding: "utf8" });
        const blocks = ls.split(/\n(?=\s*id \d+,)/);
        for (const b of blocks) if (b.includes(`node.name = "${name}"`)) execFileSync("pw-cli", ["destroy", /id (\d+)/.exec(b)?.[1] ?? ""], { stdio: "ignore" });
      } catch { /* already gone */ }
    },
  };
}

/** PATH folder with an `mpv` that plays its sound into the silent sink (video stays real, in the private display). */
function mpvWrapper(/** @type {string} */ dir, /** @type {string} */ sink) {
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin, { recursive: true });
  const real = ["/usr/bin/mpv", "/usr/local/bin/mpv"].find((p) => fs.existsSync(p)) ?? "mpv";
  fs.writeFileSync(path.join(bin, "mpv"), `#!/bin/sh\nexec ${real} "$@" --ao=pulse --audio-device=pulse/${sink}\n`, { mode: 0o755 });
  return bin;
}

/** All processes started below `pid` (inclusive). */
function tree(/** @type {number} */ pid) {
  const kids = new Map();
  for (const p of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try { const ppid = Number(fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(p)); } catch { /* gone */ }
  }
  const out = [pid]; for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
}
const exeOf = (/** @type {number} */ p) => { try { return fs.readlinkSync(`/proc/${p}/exe`); } catch { return ""; } };
const cmdOf = (/** @type {number} */ p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } };

/**
 * Launches the packaged app. `home` keeps HOME/XDG (pass the same one to "reopen" the app); data/cache/media default to
 * CIROOM_* folders inside `dir` unless `fresh: true` (a real first install: nothing set, everything under the private HOME).
 * @param {{ dir: string, disp: any, sink: any, media?: string, data?: string, cache?: string, fresh?: boolean, env?: Record<string,string>, mpv?: boolean }} o
 */
export async function launchApp(o) {
  const home = path.join(o.dir, "home");
  const run = path.join(o.dir, "run");
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const inspectPort = await freePort();
  const isDir = fs.statSync(APP).isDirectory();
  const uid = process.getuid?.() ?? 1000;
  /** @type {Record<string,string|undefined>} */
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_RUNTIME_DIR: run, DISPLAY: o.disp.display, GDK_BACKEND: "x11",
    WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${inspectPort}`, PULSE_SINK: o.sink.name, PULSE_SERVER: `unix:/run/user/${uid}/pulse/native`,
    PATH: `${mpvWrapper(o.dir, o.sink.name)}${path.delimiter}${process.env.PATH}`, NO_AT_BRIDGE: "1",
    ...(o.fresh ? {} : { CIROOM_DATA_DIR: o.data ?? path.join(o.dir, "data"), CIROOM_CACHE_DIR: o.cache ?? path.join(o.dir, "cache"), ...(o.media ? { CIROOM_MEDIA_ROOT: o.media } : {}) }),
    ...(isDir ? { APPDIR: APP, APPIMAGE: path.join(path.dirname(APP), "CiRoom-under-test.AppImage") } : {}),
    ...o.env,
  };
  delete env.WAYLAND_DISPLAY;
  const cmd = isDir ? ["bash", path.join(APP, "AppRun")] : [APP];
  const outFile = path.join(o.dir, `app-${Date.now()}.log`);
  const out = fs.openSync(outFile, "w");
  const proc = spawn("dbus-run-session", ["--", ...cmd], { env, stdio: ["ignore", out, out], cwd: home });
  const logDir = path.join(home, ".local/share/app.ciroom.media/logs");
  const serverLog = () => { try { return fs.readFileSync(path.join(logDir, "server.log"), "utf8"); } catch { return ""; } };
  const t0 = Date.now();
  const appPid = await until(() => tree(proc.pid ?? 0).find((p) => exeOf(p).endsWith("/usr/bin/ciroom")), 20000, 150, "the ciroom process");
  // The server writes "ready on http://127.0.0.1:<port>" (a fresh server.log per start).
  const port = Number(await until(() => /ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(serverLog())?.[1], 40000, 200, "the server's ready line"));
  const win = await until(() => o.disp.windows().find((/** @type {any} */ w) => w.pid === appPid && w.name === "CiRoom"), 30000, 200, "the CiRoom window");
  const page = await inspect(inspectPort);
  await page.waitFor(`document.readyState === "complete" && document.body.innerText.length > 20`, 30000);
  const startMs = Date.now() - t0;

  const app = {
    port, page, win, home, proc, appPid, startMs, outFile, serverLog, logDir,
    get: (/** @type {string} */ p) => request({ port, path: p }),
    post: (/** @type {string} */ p, /** @type {any} */ b = {}) => postJson(port, p, b),
    /** The window's current position/size on the private display. */
    geometry: () => o.disp.windows().find((/** @type {any} */ w) => w.pid === appPid && w.name === "CiRoom"),
    shot: (/** @type {string} */ file) => o.disp.shot(file),
    /** Real mouse click at an element's centre. `text`: visible text or aria-label (case-insensitive, contains); `=text`: exact visible text; `sel:<css>`: a selector. */
    async click(/** @type {string} */ text, scope = "button, a, [role=button], [role=switch], [role=tab], [role=menuitem], [role=option]") {
      const r = await page.box(text, scope);
      return app.clickAt(r.x + r.w / 2, r.y + r.h / 2);
    },
    /** Real mouse click at page (CSS px) coordinates. */
    async clickAt(/** @type {number} */ cx, /** @type {number} */ cy) {
      const g = app.geometry(); const dpr = await page.eval("window.devicePixelRatio");
      o.disp.x("focus", win.id);
      o.disp.x("click", String(Math.round(g.x + cx * dpr)), String(Math.round(g.y + cy * dpr)));
      await sleep(120);
      return { x: cx, y: cy };
    },
    async hover(/** @type {number} */ cx, /** @type {number} */ cy) {
      const g = app.geometry(); const dpr = await page.eval("window.devicePixelRatio");
      o.disp.x("move", String(Math.round(g.x + cx * dpr)), String(Math.round(g.y + cy * dpr)));
      await sleep(80);
    },
    /** Real key press (X keysym names: space, Right, Left, Escape, Return, k + ctrl, …). */
    async key(/** @type {string} */ keysym, /** @type {string[]} */ ...mods) { o.disp.x("focus", win.id); o.disp.x("key", keysym, ...mods); await sleep(100); },
    /** Types text into the focused field (any script, e.g. Persian, through the page's own input path). */
    async type(/** @type {string} */ text) { await page.eval(`document.execCommand("insertText", false, ${JSON.stringify(text)})`); await sleep(80); },
    /** Closes the window like the X in the title bar; resolves with how long the app took to exit. */
    async close(ms = 15000) {
      const t = Date.now();
      o.disp.x("close", win.id);
      await until(() => proc.exitCode !== null || proc.signalCode !== null || !tree(proc.pid ?? 0).some((p) => exeOf(p).endsWith("/usr/bin/ciroom")), ms, 100, "the app to exit after closing its window");
      page.disconnect();
      await app.waitGone();
      return Date.now() - t;
    },
    /** Kills the app process (crash / power-cut style); the server is left to notice by itself. */
    async kill(/** @type {NodeJS.Signals} */ sig = "SIGKILL") {
      try { process.kill(appPid, sig); } catch { /* gone */ }
      page.disconnect();
      await app.waitGone();
    },
    /** Waits until no process of this run is left (server, mpv, ffmpeg); kills leftovers after 10 s and reports them. */
    async waitGone(ms = 10000) {
      const left = () => tree(proc.pid ?? 0).filter((p) => p !== proc.pid && exeOf(p) && !/dbus-daemon|dbus-run-session/.test(exeOf(p)));
      try { await until(() => left().length === 0, ms, 150); return []; }
      catch { const l = left().map((p) => `${p} ${cmdOf(p).slice(0, 100)}`); for (const p of tree(proc.pid ?? 0).reverse()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } return l; }
      finally {
        try { process.kill(proc.pid ?? 0, "SIGTERM"); } catch { /* gone */ }
        // The private D-Bus session's gvfs/portal daemons mount FUSE folders in our XDG_RUNTIME_DIR: unmount them, else
        // the scratch folder can't be deleted.
        try { for (const m of fs.readFileSync("/proc/mounts", "utf8").split("\n").map((l) => l.split(" ")[1]).filter((x) => x && x.startsWith(run + "/"))) spawnSync("fusermount", ["-uz", m]); } catch { /* none */ }
      }
    },
    /** Processes of this run whose command line matches. */
    procs: (/** @type {RegExp} */ re) => tree(proc.pid ?? 0).filter((p) => re.test(cmdOf(p)) || re.test(exeOf(p))).map((p) => ({ pid: p, cmd: cmdOf(p) })),
  };
  return app;
}

/** Connects to the app's page through WebKit's remote inspector. */
export async function inspect(/** @type {number} */ port) {
  const socketPath = await until(async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    return /socket\/\d+\/\d+\/WebPage/.exec(html)?.[0];
  }, 30000, 250, "an inspectable page");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${socketPath}`);
  /** @type {string|null} */ let target = null;
  let id = 0;
  /** @type {Map<number, {res: Function, rej: Function}>} */ const waiting = new Map();
  /** @type {{level: string, text: string, url?: string}[]} */ const console_ = [];
  let open = true;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Target.targetCreated") { target = m.params.targetInfo.targetId; send0("Console.enable").catch(() => {}); send0("Runtime.enable").catch(() => {}); }
    else if (m.method === "Target.dispatchMessageFromTarget") {
      const r = JSON.parse(m.params.message);
      if (r.id && waiting.has(r.id)) { const w = waiting.get(r.id); waiting.delete(r.id); r.error ? w?.rej(new Error(r.error.message)) : w?.res(r.result); }
      else if (r.method === "Console.messageAdded") console_.push({ level: r.params.message.level, text: r.params.message.text, url: r.params.message.url });
    }
  });
  ws.addEventListener("close", () => { open = false; for (const w of waiting.values()) w.rej(new Error("inspector closed")); waiting.clear(); });
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("inspector socket failed")), { once: true }); });
  await until(() => target, 10000, 50, "the page target");
  function send0(/** @type {string} */ method, /** @type {any} */ params = {}) { return new Promise((res, rej) => {
    if (!open) return rej(new Error("inspector closed"));
    const i = ++id; waiting.set(i, { res, rej });
    ws.send(JSON.stringify({ id: 100000 + i, method: "Target.sendMessageToTarget", params: { targetId: target, message: JSON.stringify({ id: i, method, params }) } }));
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error(`inspector: ${method} timed out`)); } }, 20000);
  }); }

  const page = {
    console: console_,
    send: send0,
    disconnect() { try { ws.close(); } catch { /* gone */ } },
    /** Evaluates an expression (may be a promise) in the page, as if from a user gesture; returns its value. */
    async eval(/** @type {string} */ expr) {
      // WebKit's Runtime.evaluate can't await: evaluate to a promise object, then Runtime.awaitPromise it by value.
      const p = /** @type {any} */ (await send0("Runtime.evaluate", { expression: `(async () => (${expr}))()`, objectGroup: "e2e", emulateUserGesture: true }));
      if (p.wasThrown) throw new Error(`page: ${p.result?.description ?? JSON.stringify(p.result)}`);
      const r = /** @type {any} */ (await send0("Runtime.awaitPromise", { promiseObjectId: p.result.objectId, returnByValue: true }));
      send0("Runtime.releaseObjectGroup", { objectGroup: "e2e" }).catch(() => {});
      if (r.wasThrown) throw new Error(`page: ${r.result?.description ?? JSON.stringify(r.result)}`);
      return r.result?.value;
    },
    async waitFor(/** @type {string} */ expr, ms = 15000) {
      return until(() => page.eval(expr), ms, 150, expr.slice(0, 160));
    },
    /** Bounding box (CSS px) of the first visible element matching text / aria-label (or `sel:<css>`), scrolled into view. */
    async box(/** @type {string} */ text, scope = "button, a, [role=button]") {
      return page.waitFor(`(() => {
        const t = ${JSON.stringify(text)}; const want = t.toLowerCase();
        const pool = t.startsWith("sel:") ? [...document.querySelectorAll(t.slice(4))] : t.startsWith("=") ? [...document.querySelectorAll(${JSON.stringify(scope)})].filter((e) => (e.innerText || "").trim() === t.slice(1)) : [...document.querySelectorAll(${JSON.stringify(scope)})].filter((e) => {
          const label = ((e.innerText || "") + "\\n" + (e.getAttribute("aria-label") || "") + "\\n" + (e.getAttribute("title") || "")).toLowerCase();
          return label.includes(want); });
        const el = pool.find((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.pointerEvents !== "none"; });
        if (!el) return null; el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        // measure once layout/scrolling has settled (two frames, or 80 ms if frames don't run)
        return new Promise((res) => { let done = false; const go = () => { if (done) return; done = true; const r = el.getBoundingClientRect(); res(r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null); };
          requestAnimationFrame(() => requestAnimationFrame(go)); setTimeout(go, 80); }); })()`);
    },
    text: () => page.eval("document.body.innerText"),
    hash: () => page.eval("location.hash"),
    /** The page player's <video> element. */
    video: () => page.eval(`(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, ended: v.ended, muted: v.muted, volume: v.volume, rate: v.playbackRate, w: v.videoWidth, h: v.videoHeight, frames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null } : null; })()`),
    async goto(/** @type {string} */ hash) { await page.eval(`(location.hash = ${JSON.stringify(hash)}, 1)`); await sleep(300); },
    errors: () => console_.filter((m) => m.level === "error"),
  };
  return page;
}

/** Plays for a moment and checks the page player is really playing: time advances and frames are decoded. */
export async function assertPlaying(/** @type {any} */ page, ms = 1500) {
  const a = await page.video(); await sleep(ms); const b = await page.video();
  return { ok: !!a && !!b && !b.paused && b.t > a.t + ms / 2000 && (b.frames == null || b.frames > a.frames), a, b };
}
