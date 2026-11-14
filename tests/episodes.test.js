import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep the scan's ids.json out of the user's real data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-ep-"));
process.env.XDG_DATA_HOME = path.join(tmp, "data");
const { parseEpisode, scanLibrary } = await import("../server/lib/scanner.js");

test("double episode S01E01E02 / S01E01-E02", () => {
  assert.equal(parseEpisode([], "Show.S01E01E02.mkv").alsoEpisode, 2);
  assert.equal(parseEpisode([], "Show S01E05-E06 720p.mkv").alsoEpisode, 6);
  assert.equal(parseEpisode([], "Show.S01E03.mkv").alsoEpisode, undefined);
  assert.equal(parseEpisode([], "Show.S01E03.E1.mkv").alsoEpisode, undefined, "decreasing range ignored");
});

test("episode 0 is a real episode", () => {
  const r = parseEpisode(["Season 1"], "Show.S01E00.Pilot.mkv");
  assert.equal(r.episode, 0);
});

test("scan: episode 0 kept, double file fills both, stray E999 adds no placeholders", () => {
  const lib = path.join(tmp, "lib");
  const s = path.join(lib, "Series", "Test Show", "Season 1");
  fs.mkdirSync(s, { recursive: true });
  fs.mkdirSync(path.join(lib, "Movies"), { recursive: true });
  for (const f of ["Test.Show.S01E00.mkv", "Test.Show.S01E01E02.mkv", "Test.Show.S01E03.mkv", "Test.Show.S01E999.mkv"])
    fs.writeFileSync(path.join(s, f), "x");
  const lib2 = scanLibrary(lib);
  const season = lib2.series[0].seasons[0];
  const nums = season.episodes.map((e) => e.number);
  assert.deepEqual(nums, [0, 1, 2, 3, 999]);
  const byNum = Object.fromEntries(season.episodes.map((e) => [e.number, e]));
  assert.equal(byNum[1].file.path, byNum[2].file.path);
  assert.ok(byNum[0].file && byNum[999].file);
});
