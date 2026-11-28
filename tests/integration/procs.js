// Process and stream helpers for the integration tests (Linux /proc; the tests that need them skip elsewhere).
// Every lookup is scoped to one test server (its pid, its scratch folder), so a test never sees or touches the user's
// own CiRoom, mpv or ffmpeg.
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

export const LINUX = process.platform === "linux";

/** Every process: pid, parent pid, short name, full command line. */
export function processes() {
  /** @type {{ pid: number, ppid: number, comm: string, cmd: string }[]} */
  const out = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      out.push({ pid: Number(d), ppid, comm: fs.readFileSync(`/proc/${d}/comm`, "utf8").trim(), cmd: fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ") });
    } catch { /* ended meanwhile */ }
  }
  return out;
}

export const alive = (/** @type {number} */ pid) => fs.existsSync(`/proc/${pid}`) && !/\) Z /.test((() => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return ") Z "; } })());

/** Programs `name` started directly by the process `pid`. */
export const childrenNamed = (/** @type {number} */ pid, /** @type {string} */ name) => processes().filter((p) => p.ppid === pid && p.comm === name);

const which = (/** @type {string} */ t) => ["/usr/bin/", "/usr/local/bin/"].map((d) => d + t).find((p) => fs.existsSync(p));
/** A PATH folder that holds only the named tools (symlinks to the real ones). */
export function pathWith(/** @type {string} */ dir, /** @type {string[]} */ tools) {
  const bin = path.join(dir, "only-bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const t of tools) { const real = which(t); if (real) fs.symlinkSync(real, path.join(bin, t)); }
  return bin;
}

/** The page-stream ffmpeg processes of a server (not its loudness measuring or thumbnails, which run alongside). */
export const streamsOf = (/** @type {number} */ pid) => childrenNamed(pid, "ffmpeg").filter((p) => p.cmd.includes("frag_keyframe"));

/** The mpv processes of one test server: its control socket lives in the server's private run folder. */
export const mpvOf = (/** @type {{ dir: string }} */ s) => processes().filter((p) => p.comm === "mpv" && p.cmd.includes(`--input-ipc-server=${path.join(s.dir, "run")}`));

/** ffmpeg/ffprobe working on files of one test library (whoever started them). */
export const mediaToolsOn = (/** @type {string} */ mediaDir) => processes().filter((p) => (p.comm === "ffmpeg" || p.comm === "ffprobe") && p.cmd.includes(mediaDir));

/** Kill leftovers a failed test may leave (by pid only). */
export const killAll = (/** @type {{ pid: number }[]} */ list) => { for (const p of list) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } } };

/**
 * Opens a GET and keeps reading it like a player would. `done` resolves when the response ends or breaks.
 * @param {number} port @param {string} p
 */
export function openStream(port, p) {
  const st = { status: 0, bytes: 0, endedAt: 0, error: "" };
  let req;
  const done = new Promise((resolve) => {
    req = http.get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
      st.status = res.statusCode ?? 0;
      res.on("data", (c) => { st.bytes += c.length; });
      res.on("end", () => { st.endedAt ||= Date.now(); resolve(st); });
      res.on("close", () => { st.endedAt ||= Date.now(); resolve(st); });
    });
    req.on("error", (e) => { st.error = /** @type {any} */ (e).code ?? e.message; st.endedAt ||= Date.now(); resolve(st); });
  });
  return { st, done, close: () => req.destroy() };
}

/** A fingerprint of every file under `dir` (size, mtime, hash of the first and last 64 KB): media must never change. */
export function fingerprint(/** @type {string} */ dir) {
  /** @type {Record<string, string>} */ const out = {};
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      const st = fs.statSync(abs);
      const fd = fs.openSync(abs, "r");
      const h = crypto.createHash("sha256");
      const buf = Buffer.alloc(65536);
      h.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)));
      h.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - buf.length))));
      fs.closeSync(fd);
      out[path.relative(dir, abs)] = `${st.size}|${Math.round(st.mtimeMs)}|${h.digest("hex").slice(0, 16)}`;
    }
  };
  walk(dir);
  return out;
}

/** A server-sent-events reader: collects `data:` messages. */
export function sse(/** @type {number} */ port, /** @type {string} */ p) {
  /** @type {any[]} */ const messages = [];
  let req;
  const opened = new Promise((resolve, reject) => {
    req = http.get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) { try { messages.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ } }
        }
      });
      resolve(res.statusCode);
    });
    req.on("error", reject);
  });
  return { messages, opened, close: () => req.destroy() };
}

/** Makes a folder and everything in it read-only (true) or writable again (false). */
export function setReadOnly(/** @type {string} */ dir, /** @type {boolean} */ ro) {
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (!ro) fs.chmodSync(abs, 0o755); walk(abs); if (ro) fs.chmodSync(abs, 0o555); }
      else fs.chmodSync(abs, ro ? 0o444 : 0o644);
    }
  };
  if (!ro) fs.chmodSync(dir, 0o755);
  walk(dir);
  if (ro) fs.chmodSync(dir, 0o555);
}
