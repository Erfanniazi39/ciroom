// @ts-check
/**
 * Packaged-app smoke test hook (scripts/smoke-appimage.sh). Completely off unless CIROOM_SMOKE=1, and only for this PC.
 *   GET  /api/smoke          200 when the hook is on (the page asks once at start; without the env var: 404)
 *   POST /api/smoke {ok,t}   the page reports how far the video got: writes <data>/smoke-result.json and exits 0 (ok) or 1
 */
import fs from "node:fs";
import path from "node:path";
import { LOCAL_DIR } from "./paths.js";

/** @returns {Promise<boolean>} true if the request was handled */
export async function handleSmoke(/** @type {import("node:http").IncomingMessage} */ req, /** @type {import("node:http").ServerResponse} */ res) {
  if (process.env.CIROOM_SMOKE !== "1" || String(req.url).split("?")[0] !== "/api/smoke") return false;
  const ip = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (ip !== "127.0.0.1" && ip !== "::1") { res.statusCode = 403; res.end(); return true; }
  if (req.method === "GET") { res.statusCode = 200; res.end("{}"); return true; }
  if (req.method !== "POST") { res.statusCode = 405; res.end(); return true; }
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 4096) break; }
  /** @type {any} */ let r = {};
  try { r = JSON.parse(raw); } catch { /* reported as a failure below */ }
  const ok = r.ok === true;
  fs.writeFileSync(path.join(LOCAL_DIR, "smoke-result.json"), JSON.stringify({ ok, t: Number(r.t) || 0, why: String(r.why ?? "") }));
  res.statusCode = 200;
  res.end("{}", () => setTimeout(() => process.exit(ok ? 0 : 1), 100));
  return true;
}
