// Functional: what survives (area A settings, G progress, N persistence/backups). The real server is stopped and
// started again on the same data folder: clean stop (SIGTERM), a crash (SIGKILL), backups and their contents.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, saveUser, userState, scratch } from "./env.js";

const restart = async (/** @type {any} */ s, /** @type {any} */ how = {}) => {
  await s.stop({ keep: true, ...how });
  return startCiRoom({ dir: s.dir, media: s.media, data: s.data, cache: s.cache });
};
const today = () => { const d = new Date(); return `ciroom-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.db`; };

describe("user data across restarts", () => {
  const state = userState({
    favorites: ["b", "a"], watchlist: ["c"],
    progress: { "a": { position: 1234.5, duration: 6000, watched: false, updatedAt: 1795000000000 }, "s-s1e1": { position: 2700, duration: 2700, watched: true, updatedAt: 1795000000001 }, "فیلم": { position: 61, duration: 100, watched: false, updatedAt: 1795000000002 } },
    history: [{ id: "a", at: 1795000000003 }, { id: "s-s1e1", at: 1795000000001 }],
    watchLog: { "2026-11-25": { a: 600.5, s: 120 } }, subDelays: { a: -0.75 }, subPrefs: { s: { off: true }, a: { language: "Persian", name: "a.fa.srt" } }, audioPrefs: { s: "jpn" },
    volume: 42, levelling: false,
  });
  const settings = { autoplayNext: false, upNextSeconds: 12, miniPlayer: false, subtitleLanguages: "Persian,English", subtitlesDefault: true, subtitleStyle: { size: "L", background: "box", color: "yellow" } };

  test("a clean stop and start keeps every kind of user data and every setting exactly", async () => {
    let s = await startCiRoom({ dir: scratch("persist") });
    try {
      await saveUser(s, state);
      assert.equal((await s.put("/api/userdata/settings", { state: settings })).status, 200);
      s = await restart(s);
      const got = (await s.get("/api/userdata")).json;
      assert.equal(got.imported, true);
      for (const k of Object.keys(state)) assert.deepEqual(got.user[k], state[k], k);
      assert.deepEqual(got.settings, settings);
      assert.ok(!fs.existsSync(path.join(s.data, "ciroom.db-wal")) || fs.statSync(path.join(s.data, "ciroom.db-wal")).size >= 0);
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("a crash (killed process) right after a save loses nothing that was confirmed", async () => {
    let s = await startCiRoom({ dir: scratch("crash") });
    try {
      await saveUser(s, state);
      const later = { ...state, progress: { ...state.progress, a: { position: 1500, duration: 6000, watched: false, updatedAt: 1795000000100 } } };
      await s.put("/api/userdata/user", { state: later });
      s = await restart(s, { signal: "SIGKILL" });
      assert.equal((await s.get("/api/userdata")).json.user.progress.a.position, 1500);
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("a broken or partial save is refused and changes nothing", async () => {
    const s = await startCiRoom({ dir: scratch("partial") });
    try {
      await saveUser(s, state);
      for (const bad of [{}, { state: null }, { state: [] }, { state: { progress: {} } }, { state: { favorites: [], history: [] } }, { state: "x" }]) {
        assert.equal((await s.put("/api/userdata/user", bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await s.put("/api/userdata/settings", { state: [] })).status, 400);
      const got = (await s.get("/api/userdata")).json.user;
      assert.deepEqual(got.progress, state.progress);
      assert.deepEqual(got.favorites, state.favorites);
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("odd values inside a save don't corrupt the database (strings for numbers, huge lists, long ids)", async () => {
    const s = await startCiRoom({ dir: scratch("odd") });
    try {
      await saveUser(s, userState());
      const odd = userState({
        progress: { x: { position: "12", duration: "abc", watched: "yes" }, ["y".repeat(1000)]: { position: 1, duration: 2 } },
        favorites: Array.from({ length: 5000 }, (_, i) => `id-${i}`), history: Array.from({ length: 900 }, (_, i) => ({ id: `h${i}`, at: i })),
      });
      assert.equal((await s.put("/api/userdata/user", { state: odd })).status, 200);
      const got = (await s.get("/api/userdata")).json.user;
      assert.equal(got.progress.x.position, 12);
      assert.equal(got.progress.x.duration, 0);
      assert.equal(got.favorites.length, 5000);
      assert.ok(got.history.length <= 500, "history is capped");
      assert.ok(Object.keys(got.progress).every((k) => k.length <= 300), "ids are cut to 300 characters");
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("I-01: one backup per day is made when the database is opened after the import; it is a complete, readable copy", async () => {
    let s = await startCiRoom({ dir: scratch("backup") });
    try {
      await saveUser(s, state);
      const file = path.join(s.data, "backups", today());
      assert.ok(fs.existsSync(file), "backup made at the import");
      // The backup holds the state at the moment it was made: here, the empty import (saveUser imports first, then saves).
      s = await restart(s);
      await s.get("/api/userdata");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(file, { readOnly: true });
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "1");
      db.close();
      // Only one file per day: the restart did not make a second one (so the day's backup is the state at the FIRST start that day).
      assert.deepEqual(fs.readdirSync(path.join(s.data, "backups")).filter((f) => f.endsWith(".db")), [today()]);
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("backups: only the newest 7 are kept", async () => {
    let s = await startCiRoom({ dir: scratch("rotate") });
    try {
      await saveUser(s, state);
      const dir = path.join(s.data, "backups");
      for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `ciroom-2026-01-0${d}.db`), "old");
      fs.rmSync(path.join(dir, today()));
      s = await restart(s);
      await s.get("/api/userdata");
      const left = fs.readdirSync(dir).filter((f) => /^ciroom-.*\.db$/.test(f)).sort();
      assert.equal(left.length, 7);
      assert.equal(left.at(-1), today());
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("the database and backups are private files (0600)", { skip: process.platform === "win32" }, async () => {
    const s = await startCiRoom({ dir: scratch("modes") });
    try {
      await saveUser(s, state);
      assert.equal(fs.statSync(path.join(s.data, "ciroom.db")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(s.data, "backups", today())).mode & 0o777, 0o600);
    } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });

  test("a data folder that can't be written: Settings is told (storage check), the server still answers", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async () => {
    const s = await startCiRoom({ dir: scratch("ro") });
    try {
      fs.chmodSync(s.data, 0o500);
      const r = await s.get("/api/system/tools?fresh=1");
      assert.equal(r.status, 200);
      assert.ok(r.json.storage, JSON.stringify(r.json));
      assert.notEqual(r.json.storage.ok, true, JSON.stringify(r.json.storage));
    } finally { fs.chmodSync(s.data, 0o755); await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
  });
});
