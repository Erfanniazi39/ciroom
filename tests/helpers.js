// Shared test helper: starts the real server (server/index.js) on a random port with scratch data, and returns
// small request helpers. Never touches the user's data or running app.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); });
  s.on("error", rej);
});

/** The first private LAN address of this machine (a request to it arrives from a non-loopback peer), or null. */
export const lanIp = () => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
  return null;
};

/** @param {{ library?: object, files?: string[] }} [opts] files: relative paths (under the scratch media root) to create empty */
export async function startServer(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-test-"));
  const media = path.join(dir, "lib");
  for (const sub of ["Movies", "Series"]) fs.mkdirSync(path.join(media, sub), { recursive: true });
  for (const f of opts.files ?? []) { fs.mkdirSync(path.dirname(path.join(media, f)), { recursive: true }); fs.writeFileSync(path.join(media, f), "x"); }
  const data = path.join(dir, "data");
  fs.mkdirSync(data, { recursive: true });
  if (opts.library) fs.writeFileSync(path.join(data, process.platform === "win32" ? "library-windows.json" : "library.json"), JSON.stringify(opts.library));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server/index.js")], {
    cwd: root,
    env: { ...process.env, CIROOM_PORT: String(port), CIROOM_DEV: "1", CIROOM_MEDIA_ROOT: media, CIROOM_DATA_DIR: data, CIROOM_CACHE_DIR: path.join(dir, "cache"), CIROOM_DIST: path.join(root, "dist") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try { const r = await request({ port, path: "/api/ping" }); if (r.status === 200) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error("server exited: " + log);
    if (Date.now() - t0 > 15000) { child.kill(); throw new Error("server did not start: " + log); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, dir, media, data, log: () => log, stop() { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** @param {{ port: number, host?: string, path: string, method?: string, headers?: Record<string,string>, body?: string, hostHeader?: string }} o */
export const request = (o) => new Promise((resolve, reject) => {
  const req = http.request({ host: o.host ?? "127.0.0.1", port: o.port, path: o.path, method: o.method ?? "GET", headers: { ...(o.hostHeader ? { Host: o.hostHeader } : {}), ...o.headers } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      resolve({ status: res.statusCode, text, json });
    });
  });
  req.on("error", reject);
  req.end(o.body);
});

export const postJson = (/** @type {number} */ port, /** @type {string} */ p, /** @type {any} */ body = {}, /** @type {Record<string,string>} */ headers = {}, method = "POST") =>
  request({ port, path: p, method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
