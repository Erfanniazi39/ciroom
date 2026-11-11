// @ts-check
/**
 * CiRoom's standalone server: what the installed app runs (no Vite). Serves the built page (dist/) and every
 * CiRoom route from dev/mpv-bridge.js, with the same gates as the test version (phone remote off until paired,
 * watch party off until switched on, mpv only from this PC).
 *
 *   node server/index.js
 *   CIROOM_PORT        port (default 1420)
 *   CIROOM_MEDIA_ROOT  folder holding Movies/ and Series/ (default: Settings → Library folder, else the folder above the app folder)
 *   CIROOM_DIST        built page folder (default: ../dist)
 *   CIROOM_DATA_DIR, CIROOM_CACHE_DIR, CIROOM_DEV: see dev/paths.js
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createCiRoom } from "../dev/mpv-bridge.js";
import { DATA_DIR, isMediaRoot, savedMediaRoot } from "../dev/paths.js";

const here = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const PORT = Number(process.env.CIROOM_PORT) || 1420;
// Library folder: CIROOM_MEDIA_ROOT, else the one chosen in Settings, else the folder above the app folder.
const MEDIA_ROOT = process.env.CIROOM_MEDIA_ROOT || savedMediaRoot() || path.resolve(here, "../..");
if (!isMediaRoot(MEDIA_ROOT)) console.warn(`[ciroom] no Movies or Series folder in ${MEDIA_ROOT}: choose your library folder in Settings`);
const DIST = path.resolve(process.env.CIROOM_DIST || path.join(here, "../dist"));

const TYPES = /** @type {Record<string, string>} */ ({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json",
});

/** The built page. Unknown paths get index.html (the app's own routes, e.g. /series/…). */
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
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  // Hashed build files never change; the page itself must always be fresh (it names the current files).
  res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

const app = createCiRoom(MEDIA_ROOT);
const server = http.createServer((req, res) => {
  app.handle(req, res, () => serveStatic(req, res)).catch(() => { if (!res.headersSent) { res.statusCode = 500; res.end(); } });
});
server.on("upgrade", (req, socket) => { app.upgrade(req, socket); if (!socket.destroyed) socket.destroy(); }); // no WebSockets outside dev
server.on("error", (e) => {
  console.error(/** @type {any} */ (e).code === "EADDRINUSE" ? `[ciroom] port ${PORT} is already in use (is CiRoom already running?)` : e);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", () => {
  app.setPort(PORT);
  app.start();
  console.log(`[ciroom] ready on http://127.0.0.1:${PORT}  (media: ${MEDIA_ROOT}, data: ${DATA_DIR})`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); process.exit(0); });
// Started by the installed app: quit when the app ends (its end of this pipe closes, even after a crash).
if (process.env.CIROOM_EXIT_WITH_STDIN === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}
