import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A renamed folder must keep its id: progress, favorites and artwork are keyed by it.
// (Real case: Windows' chkdsk removed folders named "Lord of the Rings: …"; renamed without ":" they got new ids.)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-rename-"));
process.env.XDG_DATA_HOME = path.join(tmp, "data");
delete process.env.CIROOM_DATA_DIR;
const { scanLibrary } = await import("../server/lib/scanner.js");
const { LIBRARY_FILE } = await import("../server/lib/paths.js");

const lib = path.join(tmp, "lib");
const put = (/** @type {string} */ rel, size = 10) => { const f = path.join(lib, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x".repeat(size)); };
const scan = () => { const r = scanLibrary(lib); fs.mkdirSync(path.dirname(LIBRARY_FILE), { recursive: true }); fs.writeFileSync(LIBRARY_FILE, JSON.stringify(r)); return r; };
const idOf = (/** @type {any} */ r, /** @type {string} */ title) => [...r.movies, ...r.series].find((m) => m.title === title)?.id;
const mv = (/** @type {string} */ a, /** @type {string} */ b) => fs.renameSync(path.join(lib, a), path.join(lib, b));

test("renamed folders keep their ids", () => {
  put("Movies/Lord of the Rings/Lord of the Rings: Fellowship of the Rings 2001/fotr.mp4", 11);
  put("Movies/Lord of the Rings/Lord of the Rings: The Two Towers 2002/ttt.mp4", 12);
  put("Movies/Bad Boys/Bad Boys 1995/bb.mkv", 13);
  put("Movies/Bad Boys/Bad Boys Ride or Ride/bb4.mkv", 14);
  put("Series/Old Show Name/S01/EP01/show.s01e01.mkv", 15);
  const a = scan();
  const fotr = idOf(a, "Lord of the Rings: Fellowship of the Rings"), ttt = idOf(a, "Lord of the Rings: The Two Towers");
  const bb4 = idOf(a, "Bad Boys Ride or Ride"), show = idOf(a, "Old Show Name");
  assert.equal(fotr, "lord-of-the-rings-fellowship-of-the-rings");

  // Same title without ":" (same slug), a fixed typo (different slug, same video file), a renamed series.
  mv("Movies/Lord of the Rings/Lord of the Rings: Fellowship of the Rings 2001", "Movies/Lord of the Rings/Lord of the Rings Fellowship of the Rings 2001");
  mv("Movies/Lord of the Rings/Lord of the Rings: The Two Towers 2002", "Movies/Lord of the Rings/Lord of the Rings The Two Towers 2002");
  mv("Movies/Bad Boys/Bad Boys Ride or Ride", "Movies/Bad Boys/Bad Boys Ride or Die 2024");
  mv("Series/Old Show Name", "Series/New Show Name");
  const b = scan();
  assert.equal(idOf(b, "Lord of the Rings Fellowship of the Rings"), fotr);
  assert.equal(idOf(b, "Lord of the Rings The Two Towers"), ttt);
  assert.equal(idOf(b, "Bad Boys Ride or Die"), bb4);
  assert.equal(idOf(b, "New Show Name"), show);
  assert.equal(idOf(b, "Bad Boys"), "bad-boys", "untouched folders keep theirs");

  // A second scan changes nothing, and the old folder names are gone from ids.json.
  const c = scan();
  assert.equal(idOf(c, "Lord of the Rings The Two Towers"), ttt);
  const ids = JSON.parse(fs.readFileSync(path.join(path.dirname(LIBRARY_FILE), "ids.json"), "utf8"));
  assert.ok(!Object.keys(ids).some((k) => k.includes(":")), "old folder names removed");
});

test("an id still in use by an existing folder is never taken", () => {
  put("Movies/Twin 2001/a.mkv", 21);
  const a = scan();
  put("Movies/Twin (2001) copy/b.mkv", 22); // new folder whose title slug collides with an existing one
  const b = scan();
  const byFolder = (/** @type {any} */ r, /** @type {string} */ f) => r.movies.find((m) => m.file.path.includes(`${path.sep}${f}${path.sep}`)).id;
  assert.equal(byFolder(b, "Twin 2001"), byFolder(a, "Twin 2001"));
  const ids = b.movies.filter((m) => m.title === "Twin").map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "no shared id");
});
