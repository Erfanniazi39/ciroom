// Clean shutdown (task 07): stdin close / SIGTERM / POST /api/shutdown end the server within 3 s with the database
// checkpointed (no .db-wal left), a running mpv is gone, and the second backup copy lands on the system disk (last 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, request, postJson, lanIp } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts server/index.js; `env` entries set to null are removed. */
async function boot(env) {
  const port = await freePort();
  const full = { ...process.env, CIROOM_PORT: String(port), CIROOM_DEV: "1", ...env };
  for (const [k, v] of Object.entries(env)) if (v === null) delete full[k];
  const child = spawn(process.execPath, [path.join(root, "server/index.js")], { cwd: root, env: full, stdio: ["pipe", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((r) => child.once("exit", () => r(Date.now())));
  for (let i = 0; i < 150; i++) {
    try { if ((await request({ port, path: "/api/ping" })).status === 200) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error("server exited: " + log);
    await wait(100);
  }
  return { port, child, exited, log: () => log };
}
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-sd-"));
  const media = path.join(dir, "lib"); fs.mkdirSync(path.join(media, "Movies"), { recursive: true });
  fs.writeFileSync(path.join(media, "Movies", "a.mp4"), "x");
  const data = path.join(dir, "data"); fs.mkdirSync(data, { recursive: true });
  return { dir, media, data, env: { CIROOM_DATA_DIR: data, CIROOM_CACHE_DIR: path.join(dir, "cache"), CIROOM_MEDIA_ROOT: media, CIROOM_DIST: path.join(root, "dist"), CIROOM_EXIT_WITH_STDIN: "1" } };
};
async function saveSomething(port) {
  assert.equal((await postJson(port, "/api/userdata/import", { user: { progress: {}, favorites: [], watchlist: [], history: [] }, settings: {} })).status, 200);
  const state = { progress: { m1: { position: 120, duration: 6000, watched: false, updatedAt: Date.now() } }, favorites: ["m1"], watchlist: [], history: [] };
  assert.equal((await postJson(port, "/api/userdata/user", { state }, {}, "PUT")).status, 200);
}
async function checkDb(data) {
  const wal = path.join(data, "ciroom.db-wal");
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, "no write-ahead log left");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(data, "ciroom.db"), { readOnly: true });
  const row = db.prepare("SELECT position FROM watch_progress WHERE item_id = 'm1'").get();
  db.close();
  assert.equal(row?.position, 120, "the saved progress is in the database file");
}

test("stdin closing: the server exits within 3 s, database checkpointed", async () => {
  const s = scratch(); const srv = await boot(s.env);
  try {
    await saveSomething(srv.port);
    const t0 = Date.now(); srv.child.stdin.end();
    const t1 = await srv.exited;
    assert.ok(t1 - t0 < 3000, `exit took ${t1 - t0} ms`);
    await checkDb(s.data);
  } finally { srv.child.kill("SIGKILL"); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test("SIGTERM: the same clean exit", async () => {
  const s = scratch(); const srv = await boot(s.env);
  try {
    await saveSomething(srv.port);
    const t0 = Date.now(); srv.child.kill("SIGTERM");
    const t1 = await srv.exited;
    assert.ok(t1 - t0 < 3000, `exit took ${t1 - t0} ms`);
    await checkDb(s.data);
  } finally { srv.child.kill("SIGKILL"); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test("POST /api/shutdown: refused without JSON, refused from a LAN address, works from this PC", async () => {
  const s = scratch(); const srv = await boot({ ...s.env, CIROOM_EXIT_WITH_STDIN: null, CIROOM_LISTEN_ALL: "1" });
  try {
    await saveSomething(srv.port);
    assert.equal((await request({ port: srv.port, path: "/api/shutdown", method: "POST" })).status, 403, "no JSON content type");
    assert.equal((await request({ port: srv.port, path: "/api/shutdown", method: "POST", headers: { "Content-Type": "application/json" }, hostHeader: "evil.example" })).status, 403, "foreign Host");
    const ip = lanIp();
    if (ip) assert.equal((await request({ port: srv.port, host: ip, path: "/api/shutdown", method: "POST", headers: { "Content-Type": "application/json" }, hostHeader: `${ip}:${srv.port}` })).status, 403, "from a LAN address");
    assert.equal(srv.child.exitCode, null, "still running after the refusals");
    const t0 = Date.now();
    assert.equal((await request({ port: srv.port, path: "/api/shutdown", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 200);
    const t1 = await srv.exited;
    assert.ok(t1 - t0 < 3000, `exit took ${t1 - t0} ms`);
    await checkDb(s.data);
  } finally { srv.child.kill("SIGKILL"); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test("a running mpv is gone after shutdown", { skip: process.platform === "win32" }, async () => {
  const s = scratch();
  const bin = path.join(s.dir, "bin"); fs.mkdirSync(bin);
  const pidFile = path.join(s.dir, "mpv.pid");
  fs.writeFileSync(path.join(bin, "mpv"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 }); // ignores the IPC quit: SIGTERM must do it
  const srv = await boot({ ...s.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  let pid = 0;
  try {
    const r = await postJson(srv.port, "/api/play", { path: path.join(s.media, "Movies", "a.mp4"), startAt: 0, level: false });
    assert.equal(r.status, 200, r.text);
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await wait(100);
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 1);
    const t0 = Date.now(); srv.child.stdin.end();
    const t1 = await srv.exited;
    assert.ok(t1 - t0 < 3000, `exit took ${t1 - t0} ms`);
    await wait(200);
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, "mpv process is gone");
  } finally { srv.child.kill("SIGKILL"); try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ } fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test("second backup copy goes to this system's own disk, last 3 kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-bk-"));
  const media = path.join(dir, "lib"); fs.mkdirSync(path.join(media, "Movies"), { recursive: true });
  const xdg = path.join(dir, "xdg"); const local = path.join(xdg, "marquee"); fs.mkdirSync(local, { recursive: true });
  const shared = path.join(media, "CiRoom-data"); fs.mkdirSync(shared);
  fs.writeFileSync(path.join(local, "local.json"), JSON.stringify({ mediaRoot: media }));
  const env = { CIROOM_DATA_DIR: null, XDG_DATA_HOME: xdg, CIROOM_CACHE_DIR: path.join(dir, "cache"), CIROOM_MEDIA_ROOT: media, CIROOM_DIST: path.join(root, "dist"), CIROOM_EXIT_WITH_STDIN: null };
  const localBk = path.join(local, "backups"); fs.mkdirSync(localBk);
  for (const d of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]) fs.writeFileSync(path.join(localBk, `ciroom-${d}.db`), "old");
  let srv = await boot(env);
  try {
    await saveSomething(srv.port);          // first run: the import makes backups worthwhile
    srv.child.kill("SIGTERM"); await srv.exited;
    srv = await boot(env);                   // next start: the daily backup runs when the database opens
    assert.equal((await request({ port: srv.port, path: "/api/userdata" })).status, 200);
    const names = fs.readdirSync(localBk).filter((f) => /^ciroom-.*\.db$/.test(f)).sort();
    assert.equal(names.length, 3, names.join(","));
    assert.ok(names.at(-1) > "ciroom-2024", "today's copy is the newest: " + names);
    assert.ok(fs.statSync(path.join(localBk, names.at(-1))).size > 1000, "a real database copy");
    assert.ok(fs.readdirSync(path.join(shared, "backups")).some((f) => /^ciroom-/.test(f)), "the copy next to the data is still made");
  } finally { srv.child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); }
});
