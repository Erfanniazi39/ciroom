// @ts-check
/**
 * CiRoom's standalone server: what the installed app runs (no Vite). Serves the built page (dist/) and every
 * CiRoom route from server/lib/mpv-bridge.js, with the same gates as the test version (phone remote off until paired,
 * watch party off until switched on, mpv only from this PC).
 *
 *   node server/index.js
 *   CIROOM_PORT        port (default 1420)
 *   CIROOM_MEDIA_ROOT  folder holding Movies/ and Series/ (default: Settings → Library folder, else the folder above the app folder)
 *   CIROOM_DIST        built page folder (default: ../dist)
 *   CIROOM_DATA_DIR, CIROOM_CACHE_DIR, CIROOM_DEV: see server/lib/paths.js
 *   CIROOM_LISTEN_ALL=1  tests only: listen on all addresses even with the remote off
 *   CIROOM_SMOKE=1     scripts/smoke-appimage.sh only: /api/smoke (server/lib/smoke.js)
 *   CIROOM_FAKE_NETWORK=<id>|<label>  tests only: pretend this is the current network (server/lib/netid.js)
 *  CIROOM_FAKE_NETWORK_FILE=<file>  tests only: same, read from a file each time so a test can switch networks
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCiRoom } from "./lib/mpv-bridge.js";
import { handleSmoke, smokePage } from "./lib/smoke.js";
import { DATA_DIR, isMediaRoot, savedMediaRoot } from "./lib/paths.js";
import { closeDb } from "./lib/userdb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CIROOM_PORT) || 1420;
// Library folder: CIROOM_MEDIA_ROOT, else the one chosen in Settings, else the folder above the app folder.
const MEDIA_ROOT = process.env.CIROOM_MEDIA_ROOT || savedMediaRoot() || path.resolve(here, "../..");
if (!isMediaRoot(MEDIA_ROOT)) console.warn(`[ciroom] no Movies or Series folder in ${MEDIA_ROOT}: choose your library folder in Settings`);
const DIST = path.resolve(process.env.CIROOM_DIST || path.join(here, "../dist"));
process.env.CIROOM_DIST = DIST; // server/lib/party.js serves the prebuilt guest page from here

const TYPES = /** @type {Record<string, string>} */ ({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json",
});

/** The built page. Unknown paths get index.html (the app's own routes, e.g. /series/…). */
// What the page may load: only itself (plus TMDB posters, blob: video from the page player, Tauri's own IPC). No inline
// scripts, no other sites, no framing. Inline styles stay allowed (React `style=` and two <style> tags).
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
  "img-src 'self' data: blob: https://image.tmdb.org", "media-src 'self' blob:", "connect-src 'self' ipc: http://ipc.localhost",
  "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

function serveStatic(/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; return res.end(); }
  let rel;
  try { rel = decodeURIComponent(new URL(String(req.url), "http://x").pathname); } catch { res.statusCode = 400; return res.end(); }
  let file = path.join(DIST, path.normalize(rel));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) { res.statusCode = 403; return res.end(); } // never outside dist/
  let st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || st.isDirectory()) {
    if (path.extname(rel)) { res.statusCode = 404; return res.end("Not found"); } // a missing asset, not a page
    file = path.join(DIST, "index.html");
    st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) { res.statusCode = 500; return res.end("CiRoom's page is missing (run npm run build)"); }
  }
  const page = file === path.join(DIST, "index.html") ? Buffer.from(smokePage(fs.readFileSync(file, "utf8"))) : null;
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", page ? page.length : st.size);
  // Hashed build files never change; the page itself must always be fresh (it names the current files).
  res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (file.endsWith(".html")) { res.setHeader("Content-Security-Policy", CSP); res.setHeader("X-Frame-Options", "DENY"); }
  if (req.method === "HEAD") return res.end();
  if (page) return res.end(page);
  fs.createReadStream(file).pipe(res);
}

const app = createCiRoom(MEDIA_ROOT);
const server = http.createServer(async (req, res) => {
  if (await handleSmoke(req, res).catch(() => false)) return;
  if (req.method === "POST" && String(req.url).split("?")[0] === "/api/shutdown") return handleShutdown(req, res);
  app.handle(req, res, () => serveStatic(req, res)).catch(() => { if (!res.headersSent) { res.statusCode = 500; res.end(); } });
});
/** @type {Set<import("node:net").Socket>} */
const conns = new Set();
server.on("connection", (c) => { conns.add(c); c.on("close", () => conns.delete(c)); });
server.on("upgrade", (req, socket) => { app.upgrade(req, socket); if (!socket.destroyed) socket.destroy(); }); // no WebSockets outside dev
server.on("error", (e) => {
  console.error(/** @type {any} */ (e).code === "EADDRINUSE" ? `[ciroom] port ${PORT} is already in use (is CiRoom already running?)` : e);
  process.exit(1);
});
// Only this PC can reach the server, unless the phone remote or the watch party is on (then other devices can too).
const listenAll = process.env.CIROOM_LISTEN_ALL === "1"; // tests: pretend other devices are allowed in
const wantHost = () => (listenAll || app.wantsNetwork() ? "0.0.0.0" : "127.0.0.1");
let host = wantHost();
server.listen(PORT, host, () => {
  app.setPort(PORT);
  app.start();
  console.log(`[ciroom] ready on http://127.0.0.1:${PORT}  (listening on ${host}; media: ${MEDIA_ROOT}, data: ${DATA_DIR})`);
});
// Re-listen when the phone remote or the party is switched on/off. close() stops accepting new connections at once;
// open ones (the page, event streams) stay up, and the switch-off handlers already end the other devices' streams.
app.onNetworkChange(() => {
  const want = wantHost();
  if (want === host) return;
  host = want;
  server.close();
  server.listen(PORT, host, () => console.log(`[ciroom] now listening on ${host}:${PORT}`));
  // Switching off: drop connections from other devices that are still open (keep-alive).
  if (host === "127.0.0.1") for (const c of conns) if (!/^(127\.|::1$|::ffff:127\.)/.test(c.remoteAddress ?? "")) c.destroy();
});

// ── Clean shutdown ──────────────────────────────────────────────────────────────────────────
// Runs once, whatever asks (signal, the app closing our stdin, POST /api/shutdown), and always ends within 3 s.
let shuttingDown = false;
async function shutdown(/** @type {string} */ reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ciroom] shutting down (${reason})`);
  setTimeout(() => process.exit(0), 3000); // hard deadline: nothing below may keep us alive
  try { await app.shutdown(); } catch (e) { console.warn("[ciroom] shutdown: mpv:", e instanceof Error ? e.message : e); } // 1. mpv: last position, then quit
  try { closeDb(); } catch (e) { console.warn("[ciroom] shutdown: database:", e instanceof Error ? e.message : e); } // 2. database: checkpoint + close (worker threads need no step: they end with the process)
  try { server.close(); server.closeAllConnections(); } catch { /* closing */ } // 3. event streams and keep-alive connections
  process.exit(0);
}
/** Loopback only, JSON only (a web page on another site can't send that without a CORS preflight, which we never grant), and our own Host. */
function handleShutdown(/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) {
  const ip = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const hostOk = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host ?? ""));
  const jsonOk = /^application\/json/i.test(String(req.headers["content-type"] ?? ""));
  if ((ip !== "127.0.0.1" && ip !== "::1") || !hostOk || !jsonOk) { res.statusCode = 403; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "Not allowed from this device" })); }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }), () => { void shutdown("request"); });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void shutdown(sig); });
// Started by the installed app: quit when the app ends (its end of this pipe closes, even after a crash).
if (process.env.CIROOM_EXIT_WITH_STDIN === "1") {
  process.stdin.on("end", () => { void shutdown("app closed"); });
  process.stdin.on("error", () => { void shutdown("app closed"); });
  process.stdin.resume();
}
