// The merge of changes kept in the window while the data folder was read-only with a database that changed meanwhile
// (src/lib/mergeUser.ts, used by src/lib/serverStorage.ts). D-22.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSettings, mergeUser } from "../src/lib/mergeUser.ts";

const T = 1_800_000_000_000;
const p = (position, updatedAt) => ({ position, duration: 600, watched: false, updatedAt });
const user = (o = {}) => ({ favorites: [], watchlist: [], progress: {}, history: [], watchLog: {}, subDelays: {}, subPrefs: {}, audioPrefs: {}, volume: 100, levelling: true, ...o });

test("progress: an older entry in the window never replaces a newer one in the database", () => {
  const base = user({ progress: { a: p(10, T) } });
  const local = user({ progress: { a: p(50, T + 1000) } }); // watched in the window while read-only
  const db = user({ progress: { a: p(300, T + 5000) } }); // watched later on another window
  assert.deepEqual(mergeUser(base, local, db).progress.a, p(300, T + 5000));
});

test("progress: a newer entry in the window wins over the database's", () => {
  const base = user({ progress: { a: p(10, T) } });
  const local = user({ progress: { a: p(120, T + 9000) } });
  const db = user({ progress: { a: p(60, T + 2000) } });
  assert.deepEqual(mergeUser(base, local, db).progress.a, p(120, T + 9000));
});

test("progress: a tie keeps the database's; entries only one side has are kept; also without a base", () => {
  const local = user({ progress: { a: p(1, T), mine: p(5, T) } });
  const db = user({ progress: { a: p(2, T), theirs: p(7, T) } });
  for (const base of [user(), null]) {
    const m = mergeUser(base, local, db).progress;
    assert.deepEqual(m, { a: p(2, T), mine: p(5, T), theirs: p(7, T) });
  }
});

test("progress: \"Reset watching\" in the window stays reset, unless the database saved the item after the reset's base", () => {
  const base = user({ progress: { a: p(10, T), b: p(20, T) } });
  const local = user({ progress: {} }); // reset in the window
  const db = user({ progress: { a: p(10, T), b: p(99, T + 1) } }); // b watched elsewhere meanwhile
  assert.deepEqual(mergeUser(base, local, db).progress, { b: p(99, T + 1) });
});

test("history: union by id, the later time wins, newest first", () => {
  const base = user({ history: [{ id: "a", at: T }] });
  const local = user({ history: [{ id: "b", at: T + 30 }, { id: "a", at: T + 10 }] });
  const db = user({ history: [{ id: "a", at: T + 20 }, { id: "c", at: T + 5 }] });
  assert.deepEqual(mergeUser(base, local, db).history, [{ id: "b", at: T + 30 }, { id: "a", at: T + 20 }, { id: "c", at: T + 5 }]);
});

test("lists: additions from both sides kept, a removal in the window applied; without a base the database's list is kept", () => {
  const base = user({ favorites: ["x", "y"], watchlist: ["w"] });
  const local = user({ favorites: ["n", "x"], watchlist: ["w"] }); // added n, removed y
  const db = user({ favorites: ["o", "x", "y"], watchlist: [] }); // added o; w removed elsewhere
  const m = mergeUser(base, local, db);
  assert.deepEqual(m.favorites, ["n", "o", "x"]);
  assert.deepEqual(m.watchlist, []);
  assert.deepEqual(mergeUser(null, local, db).favorites, ["o", "x", "y"]);
});

test("watch time: the window's added seconds go on top of the database's (without a base: the larger)", () => {
  const base = user({ watchLog: { "2026-11-28": { a: 100 } } });
  const local = user({ watchLog: { "2026-11-28": { a: 160, b: 30 } } });
  const db = user({ watchLog: { "2026-11-28": { a: 400 } } });
  assert.deepEqual(mergeUser(base, local, db).watchLog, { "2026-11-28": { a: 460, b: 30 } });
  assert.deepEqual(mergeUser(null, local, db).watchLog, { "2026-11-28": { a: 400, b: 30 } });
});

test("choices and settings: a value changed in the window wins, otherwise the database's", () => {
  const base = user({ volume: 100, subPrefs: { s: { off: true } }, audioPrefs: { s: "eng" } });
  const local = user({ volume: 80, subPrefs: { s: { off: true } }, audioPrefs: { s: "jpn" } });
  const db = user({ volume: 100, subPrefs: { s: { language: "English", name: "" } }, audioPrefs: { s: "eng", t: "fre" } });
  const m = mergeUser(base, local, db);
  assert.equal(m.volume, 80);
  assert.deepEqual(m.subPrefs, { s: { language: "English", name: "" } });
  assert.deepEqual(m.audioPrefs, { s: "jpn", t: "fre" });
  assert.deepEqual(mergeSettings({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3, c: 4 }), { a: 2, b: 3, c: 4 });
});

test("an unchanged database merges to exactly the window's copy", () => {
  const base = user({ favorites: ["x"], progress: { a: p(1, T) }, history: [{ id: "a", at: T }], watchLog: { d: { a: 10 } } });
  const local = user({ favorites: ["n", "x"], progress: { a: p(9, T + 1), b: p(3, T + 2) }, history: [{ id: "b", at: T + 2 }, { id: "a", at: T + 1 }], watchLog: { d: { a: 25 } }, volume: 70 });
  assert.deepEqual(mergeUser(base, local, base), local);
});
