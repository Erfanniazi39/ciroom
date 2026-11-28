// Integration: scanner ↔ file system ↔ saved library ↔ stable ids, while other parts of the app keep reading.
// Real folders (synthetic clips), real scan worker. Covers what round 1 did not: reads during a scan, folders that change
// in the middle of a scan, and symbolic links.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startCiRoom, scan } from "../functional/env.js";
import { addEntry, buildClips } from "../fixtures/media.js";

describe("scanner ↔ readers: a scan never shows half a library", () => {
  test("1,500 movies: every read during a rescan returns the whole previous library; changes made mid-scan are caught by the next scan; ids stay put", async () => {
    const layout = /** @type {Record<string,string>} */ ({});
    for (let i = 0; i < 1500; i++) layout[`Movies/Film ${i} ${1950 + (i % 70)}/f${i}.mkv`] = "short.mkv";
    const s = await startCiRoom({ layout });
    try {
      const clips = await buildClips();
      const first = await scan(s);
      assert.equal(first.movies.length, 1500);
      fs.rmSync(path.join(s.media, "Movies/Film 7 1957"), { recursive: true });
      addEntry(s.media, "Movies/New One 2024/n.mkv", "short.mkv", clips);
      let done = false;
      const scanning = s.post("/api/library/scan").then((/** @type {any} */ r) => { done = true; return r; });
      const counts = [];
      while (!done) {
        const l = await s.get("/api/library");
        assert.equal(l.status, 200);
        counts.push(l.json.movies.length);
        if (counts.length === 2) addEntry(s.media, "Movies/During Scan 2024/d.mkv", "short.mkv", clips); // lands while the scan walks
      }
      const result = (await scanning).json;
      const whole = new Set([1500, result.movies.length]); // the old library, or the new one once the scan has saved it
      assert.ok(counts.every((n) => whole.has(n)), `reads saw ${[...new Set(counts)].join(", ")} movies (allowed: ${[...whole].join(" or ")})`);
      const after = await scan(s);
      assert.ok(after.movies.some((/** @type {any} */ m) => m.title === "During Scan"), "picked up by the next scan at the latest");
      assert.ok(!after.movies.some((/** @type {any} */ m) => m.title === "Film 7"));
      const ids = new Map(first.movies.map((/** @type {any} */ m) => [m.title, m.id]));
      const moved = after.movies.filter((/** @type {any} */ m) => ids.has(m.title) && ids.get(m.title) !== m.id);
      assert.equal(moved.length, 0, "no existing title changed its id");
    } finally { await s.stop(); }
  });
});

describe("scanner ↔ symbolic links (Linux users often link folders from a second drive)", { skip: process.platform === "win32" }, () => {
  /** @param {any} s @param {Record<string,string>} clips */
  function linkLayout(s, clips) {
    const other = path.join(s.dir, "other-drive");
    addEntry(other, "Gamma 2010/g.mkv", "short20.mkv", clips);
    addEntry(other, "loose/Delta.2011.mkv", "short30.mkv", clips);
    addEntry(other, "Show X/S01/Show.X.S01E01.mkv", "ep60.mkv", clips);
    fs.symlinkSync(path.join(other, "Gamma 2010"), path.join(s.media, "Movies/Gamma 2010"));
    fs.mkdirSync(path.join(s.media, "Movies/Delta 2011"));
    fs.symlinkSync(path.join(other, "loose/Delta.2011.mkv"), path.join(s.media, "Movies/Delta 2011/Delta.2011.mkv"));
    fs.symlinkSync(path.join(other, "Show X"), path.join(s.media, "Series/Show X"));
    fs.symlinkSync(path.join(s.media, "Movies"), path.join(s.media, "Movies/Loop 2000")); // a loop must not hang the scan
  }

  test("a linked video file is found and plays; a link loop doesn't hang the scan", async () => {
    const s = await startCiRoom({ layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" } });
    try {
      linkLayout(s, await buildClips());
      const t0 = Date.now();
      const lib = await scan(s);
      assert.ok(Date.now() - t0 < 10000);
      const delta = lib.movies.find((/** @type {any} */ m) => m.title === "Delta");
      assert.ok(delta, "linked file inside a real folder");
      assert.equal((await s.get(`/api/probe?path=${encodeURIComponent(delta.file.path)}`)).status, 200);
    } finally { await s.stop(); }
  });

  test("D-26: a linked movie folder and a linked series folder show up in the library", async () => {
    const s = await startCiRoom({ layout: { "Movies/Alpha 2001/a.mkv": "short.mkv" } });
    try {
      linkLayout(s, await buildClips());
      const lib = await scan(s);
      assert.ok(lib.movies.some((/** @type {any} */ m) => m.title === "Gamma"), `movies: ${lib.movies.map((/** @type {any} */ m) => m.title).join(", ")}`);
      assert.ok(lib.series.some((/** @type {any} */ x) => x.title === "Show X"), `series: ${lib.series.map((/** @type {any} */ x) => x.title).join(", ") || "none"}`);
      assert.equal(lib.movies.length, 3, "Alpha, Delta, Gamma: the loop link adds nothing");
      const gamma = lib.movies.find((/** @type {any} */ m) => m.title === "Gamma");
      assert.equal(gamma.file.path, path.join(s.media, "Movies/Gamma 2010/g.mkv"), "the library path, not the link's target");
      const episode = lib.series[0].seasons[0].episodes[0];
      for (const file of [gamma.file.path, episode.file.path]) {
        const r = await s.get(`/api/stream?path=${encodeURIComponent(file)}`);
        assert.equal(r.status, 200, file);
        assert.ok(r.text.length > 0, file);
      }
      // A linked sub-folder is searched too when the video inside was renamed since the scan.
      fs.mkdirSync(path.join(s.dir, "other-drive/Part"), { recursive: true });
      fs.renameSync(path.join(s.media, "Movies/Alpha 2001/a.mkv"), path.join(s.dir, "other-drive/Part/renamed.mkv"));
      fs.symlinkSync(path.join(s.dir, "other-drive/Part"), path.join(s.media, "Movies/Alpha 2001/Part"));
      assert.equal((await s.get(`/api/probe?path=${encodeURIComponent(path.join(s.media, "Movies/Alpha 2001/a.mkv"))}`)).status, 200);
    } finally { await s.stop(); }
  });
});
