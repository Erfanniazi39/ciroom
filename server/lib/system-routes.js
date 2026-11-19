// @ts-check
/** The small routes about CiRoom itself: identity check, missing tools, trailer link, library folder. All for this PC only. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encoderStatus } from "./stream.js";
import { checkTools } from "./deps.js";
import { checkWritable } from "./diskcheck.js";
import { DATA_DIR, SHARED, isMediaRoot, openUrlCommand, saveMediaRoot, savedMediaRoot } from "./paths.js";
import { defineRoutes } from "./routes.js";

/** CiRoom's version: set by the desktop app (CIROOM_VERSION), else read from package.json (test version). */
function appVersion() {
  if (process.env.CIROOM_VERSION) return process.env.CIROOM_VERSION;
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

/** @param {string} rootAbs */
export function systemRoutes(rootAbs) {
  return defineRoutes("system", [
    // Identity check for the desktop app (src-tauri): is the thing on this port CiRoom?
    { method: "GET", path: "/api/ping", audience: "pc", handler: ({ res, u }) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      // The desktop shell starts us with a secret and checks that WE are the program on its port: it sends a nonce and
      // expects sha256(secret + nonce) back. The secret itself is never sent.
      const secret = process.env.CIROOM_SHELL_SECRET ?? "";
      const nonce = u.searchParams.get("nonce") ?? "";
      const proof = secret && /^[0-9a-f]{8,128}$/i.test(nonce) ? createHash("sha256").update(secret + nonce).digest("hex") : undefined;
      res.end(JSON.stringify({ app: "ciroom", version: appVersion(), ...(proof ? { proof } : {}) }));
    } },
    // Which of ffmpeg / ffprobe / mpv are missing (Settings shows it).
    { method: "GET", path: "/api/system/tools", audience: "pc", handler: async ({ res, u }) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ tools: await checkTools(u.searchParams.get("fresh") === "1"), storage: checkWritable(DATA_DIR), encoder: await encoderStatus() }));
    } },
    // Trailer → the system browser. Only a YouTube video id is accepted (never an arbitrary URL).
    { method: "POST", path: "/api/open-trailer", audience: "pc", handler: async ({ req, json, body }) => {
      const { key } = await body(req);
      if (!/^[\w-]{6,20}$/.test(String(key))) return json(400, { error: "Bad video id" });
      const [cmd, args] = openUrlCommand(`https://www.youtube.com/watch?v=${key}`);
      spawn(cmd, [...args], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      json(200, { ok: true });
    } },
    // Library folder (Settings). Takes effect when CiRoom restarts.
    { method: "GET", path: "/api/media-root", audience: "pc", handler: ({ json }) =>
      json(200, { current: rootAbs, saved: savedMediaRoot(), ok: isMediaRoot(rootAbs), dataDir: DATA_DIR, shared: SHARED }) },
    { method: "POST", path: "/api/media-root", audience: "pc", handler: async ({ req, json, body }) => {
      const p = path.resolve(String((await body(req)).path ?? "").trim());
      if (!isMediaRoot(p)) return json(400, { error: "That folder has no Movies or Series folder inside" });
      saveMediaRoot(p);
      json(200, { saved: p, restart: p !== rootAbs });
    } },
  ]);
}
