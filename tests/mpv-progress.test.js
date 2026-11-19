// mpv progress without a window (task 06): the server queues the position in phone-pending.json when no window is
// connected; stays out of the way when a window is open or a phone plays the same title. Fake mpv, real routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { postJson } from "./helpers.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LIB = {
  movies: [
    { kind: "movie", id: "tiny", title: "Tiny", year: 2020, file: { path: "/x/tiny.mp4", sizeBytes: 1, subtitles: [], status: "present" } },
    { kind: "movie", id: "other", title: "Other", year: 2020, file: { path: "/x/other.mp4", sizeBytes: 1, subtitles: [], status: "present" } },
  ],
  series: [], collections: [], roots: [], review: [], scannedAt: new Date().toISOString(),
};

test("mpv progress is queued by the server only when no window is open and no phone holds the title", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-mpvp-"));
  process.env.CIROOM_DATA_DIR = dir;
  process.env.CIROOM_FAKE_NETWORK = "wifi:HomeWifi|HomeWifi";
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "library-windows.json" : "library.json"), JSON.stringify(LIB));
  const { remoteRoutes } = await import("../server/lib/remote.js");
  const { runRoute } = await import("../server/lib/routes.js");
  const m = { running: true, id: "tiny", position: 100, paused: false, ended: false };
  const remote = remoteRoutes({ itemId: () => m.id, running: () => m.running, snapshot: () => ({ paused: m.paused, position: m.position, duration: 1000, ended: m.ended, subtitles: [], volume: 100, muted: false }), command: () => {} });
  const srv = http.createServer((req, res) => {
    const json = (c, d) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    const body = (r) => new Promise((ok) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => ok(t ? JSON.parse(t) : {})); });
    runRoute(remote.routes, { req, res, json, body, local: true }).then((h) => { if (!h) json(404, {}); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const pendingFile = path.join(dir, "phone-pending.json");
  const pend = () => { try { return JSON.parse(fs.readFileSync(pendingFile, "utf8")); } catch { return {}; } };
  let win;
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    // 1. no window: first tick only starts following; later ticks queue the moved position
    remote.mpvSaveTick();
    assert.deepEqual(pend(), {}, "nothing moved yet");
    m.position = 130; remote.mpvSaveTick();
    assert.equal(pend().tiny?.position, 130);
    assert.equal(pend().tiny?.source, "mpv");
    assert.equal(pend().tiny?.duration, 1000);
    m.position = 130.4; remote.mpvSaveTick();
    assert.equal(pend().tiny.position, 130, "moved less than 1 s: not saved again");
    // 2. a window connects: it gets the entry, the file is emptied, and new ticks write nothing
    const got = [];
    win = http.get({ host: "127.0.0.1", port, path: "/api/remote/commands", agent: false }, (res) => {
      let buf = ""; res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const part = buf.slice(0, i); buf = buf.slice(i + 2); if (part.startsWith("data: ")) try { got.push(JSON.parse(part.slice(6))); } catch { /* ignore */ } } });
    });
    win.on("error", () => {});
    await wait(200);
    assert.ok(got.some((g) => g.cmd === "progress" && g.id === "tiny" && g.position === 130), "window receives the queued progress");
    assert.deepEqual(pend(), {}, "pending emptied after hand-over");
    m.position = 200; remote.mpvSaveTick();
    assert.deepEqual(pend(), {}, "window connected: the server writes nothing");
    win.destroy(); win = null; await wait(200);
    // 3. a phone playing the same title wins
    const pin = (await postJson(port, "/api/remote/enable", { on: true })) && (await postJson(port, "/api/remote/trust")) && (await postJson(port, "/api/remote/pair/start")).json.pin;
    const cookie = await new Promise((ok) => { const q = http.request({ host: "127.0.0.1", port, path: "/api/remote/pair", method: "POST", headers: { "Content-Type": "application/json" } }, (r) => { r.resume(); ok(String(r.headers["set-cookie"]).split(";")[0]); }); q.end(JSON.stringify({ pin, name: "p" })); });
    assert.equal((await postJson(port, "/api/remote/state", { id: "tiny", position: 50, playing: true }, { Cookie: cookie })).status, 200);
    m.position = 260; remote.mpvSaveTick();
    assert.deepEqual(pend(), {}, "phone holds the title: nothing written");
    // 4. phone stops (not playing): writing resumes
    await wait(2100);
    assert.equal((await postJson(port, "/api/remote/state", { id: "tiny", position: 50, playing: false }, { Cookie: cookie })).status, 200);
    m.position = 300; remote.mpvSaveTick();
    assert.equal(pend().tiny?.position, 300);
    // 5. quit: final save with the last position; ended → full duration
    skew += 15_000; m.position = 315; remote.mpvSaveTick(); // 15 s later, moved 15 s: real watching
    assert.ok(Math.abs(pend().tiny.watched - 15) < 1, "watch seconds: " + pend().tiny.watched);
    m.position = 450; remote.mpvSaveTick(true);
    assert.equal(pend().tiny.position, 450, "final save on exit");
    assert.ok(pend().tiny.watched >= 15 && pend().tiny.watched <= 43200);
    // a different title / a missing id is followed separately and never saved without an id
    m.id = null; m.position = 600; remote.mpvSaveTick();
    assert.equal(pend().tiny.position, 450);
    m.id = "other"; m.position = 10; remote.mpvSaveTick(); m.ended = true; remote.mpvSaveTick(true);
    assert.equal(pend().other?.position, 1000, "end of file saves the full length");
  } finally { Date.now = realNow; win?.destroy(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
