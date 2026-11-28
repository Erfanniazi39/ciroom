// Integration: Node server ↔ SQLite (node:sqlite) ↔ the data folder. Whole-state saves arriving together, a crash in
// the middle of a burst of saves, different modules sharing one database, a read-only data folder (the shared NTFS
// drive after Windows hibernates), and the window ↔ server hand-over of positions saved while no window was open.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan, until, sleep, scratch, userState, saveUser } from "../functional/env.js";
import { setReadOnly } from "./procs.js";

const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0; // root ignores file permissions
const states = Array.from({ length: 40 }, (_, i) => userState({
  favorites: [`fav-${i}`],
  history: [{ id: `seen-${i}`, at: 1_700_000_000_000 + i }],
  progress: Object.fromEntries(Array.from({ length: 60 }, (_, j) => [`item-${j}`, { position: i, duration: 100, watched: false, updatedAt: 1_700_000_000_000 + i }])),
}));
/** Every part of a saved state belongs to the same request (no mix of two saves). */
function oneSave(/** @type {any} */ u) {
  const positions = [...new Set(Object.values(u.progress).map((/** @type {any} */ p) => p.position))];
  return positions.length === 1 && Object.keys(u.progress).length === 60 && u.favorites[0] === `fav-${positions[0]}` && u.history[0]?.id === `seen-${positions[0]}` ? positions[0] : null;
}

describe("server ↔ SQLite: saves that collide or get cut off", () => {
  test("40 whole-state saves at the same moment: the result is exactly one of them, never a mix", async () => {
    const s = await startCiRoom({ layout: {} });
    try {
      await saveUser(s, userState());
      const rs = await Promise.all(states.map((state) => s.put("/api/userdata/user", { state })));
      assert.ok(rs.every((r) => r.status === 200));
      const u = (await s.get("/api/userdata")).json.user;
      assert.notEqual(oneSave(u), null, JSON.stringify(u.favorites));
    } finally { await s.stop(); }
  });

  test("server killed (SIGKILL) in the middle of a burst of saves: the database opens, passes its integrity check and holds one whole save", async () => {
    const dir = scratch("it-kill");
    let s = await startCiRoom({ dir, layout: {} });
    await saveUser(s, userState());
    let sent = 0;
    const burst = (async () => { for (let i = 0; i < 1000; i++) { try { await s.put("/api/userdata/user", { state: states[i % 40] }); sent++; } catch { return; } } })();
    await until(() => sent > 20, 10000);
    await s.stop({ keep: true, signal: "SIGKILL" });
    await burst;
    s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache });
    try {
      const u = (await s.get("/api/userdata")).json.user;
      assert.notEqual(oneSave(u), null, "one complete save survived");
      await s.stop({ keep: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(s.data, "ciroom.db"), { readOnly: true });
      try { assert.equal(/** @type {any} */ (db.prepare("PRAGMA integrity_check").get()).integrity_check, "ok"); } finally { db.close(); }
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("user data and settings live side by side: saving one never removes the other (also across a restart)", async () => {
    const dir = scratch("it-side");
    let s = await startCiRoom({ dir, layout: {} });
    await saveUser(s, userState({ favorites: ["a"], volume: 77 }));
    assert.equal((await s.put("/api/userdata/settings", { state: { autoplayNext: false, subtitleLanguages: ["Persian", "English"] } })).status, 200);
    await saveUser(s, userState({ favorites: ["a", "b"], volume: 66 }));
    await s.stop({ keep: true });
    s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache });
    try {
      const d = (await s.get("/api/userdata")).json;
      assert.deepEqual(d.user.favorites, ["a", "b"]);
      assert.equal(d.user.volume, 66);
      assert.deepEqual(d.settings, { autoplayNext: false, subtitleLanguages: ["Persian", "English"] });
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("server ↔ data folder that became read-only (Windows hibernated / Fast Startup on the shared drive)", { skip: ROOT_USER || process.platform === "win32" }, () => {
  test("D-22: the saved progress and lists can still be READ (the window falls back to its browser copy otherwise)", { todo: "D-22" }, async () => {
    const dir = scratch("it-ro");
    let s = await startCiRoom({ dir, layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" } });
    await scan(s);
    await saveUser(s, userState({ favorites: ["alpha"], progress: { alpha: { position: 5, duration: 12, watched: false, updatedAt: Date.now() } } }));
    await s.stop({ keep: true });
    setReadOnly(s.data, true);
    try {
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache });
      const r = await s.get("/api/userdata");
      assert.equal(r.status, 200, `GET /api/userdata answered ${r.status} ${r.text}`);
      assert.deepEqual(r.json.user.favorites, ["alpha"]);
    } finally {
      setReadOnly(s.data, false);
      await s.stop(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only data folder: the library still loads, a scan fails with a message instead of a crash, the server stays up", async () => {
    const dir = scratch("it-ro2");
    let s = await startCiRoom({ dir, layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" } });
    await scan(s);
    await s.stop({ keep: true });
    setReadOnly(s.data, true);
    try {
      s = await startCiRoom({ dir, media: s.media, data: s.data, cache: s.cache });
      const lib = await s.get("/api/library");
      assert.equal(lib.status, 200);
      assert.equal(lib.json.movies.length, 1);
      const sc = await s.post("/api/library/scan");
      assert.ok(sc.status >= 400, `scan answered ${sc.status}`);
      assert.ok(sc.json?.error, "an error text the window can show");
      assert.equal((await s.get("/api/ping")).status, 200);
    } finally {
      setReadOnly(s.data, false);
      await s.stop(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server ↔ window: positions saved while no window was open", () => {
  test("phone-pending entries are handed to the first window and then removed from disk; a crash before that keeps them", async () => {
    const dir = scratch("it-pend");
    const data = path.join(dir, "data");
    fs.mkdirSync(data, { recursive: true });
    const entry = { id: "alpha", position: 321, duration: 600, watched: 30, at: Date.now() - 1000, source: "mpv" };
    fs.writeFileSync(path.join(data, "phone-pending.json"), JSON.stringify({ alpha: entry }));
    let s = await startCiRoom({ dir, data, layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" } });
    await s.stop({ keep: true, signal: "SIGKILL" }); // no window ever connected
    assert.ok(fs.existsSync(path.join(data, "phone-pending.json")), "kept across a crash while no window was open");
    s = await startCiRoom({ dir, data, media: s.media, cache: s.cache });
    try {
      const { sse } = await import("./procs.js");
      const w = sse(s.port, "/api/remote/commands");
      await w.opened;
      const got = await until(() => w.messages.find((m) => m.cmd === "progress"), 3000);
      assert.deepEqual({ ...got, cmd: undefined }, { ...entry, cmd: undefined });
      await sleep(200);
      assert.ok(!fs.existsSync(path.join(data, "phone-pending.json")), "removed once handed over");
      w.close();
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
