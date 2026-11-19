import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { absoluteNumber, moviePartsOf } from "../server/lib/scanner.js";

test("absoluteNumber: trailing number after tags", () => {
  assert.equal(absoluteNumber("Show - 001.mkv"), 1);
  assert.equal(absoluteNumber("One Piece 1071.mkv"), 1071);
  assert.equal(absoluteNumber("[Grp] One Piece - 0123 [1080p x265].mkv"), 123);
  assert.equal(absoluteNumber("Show.2010.05.1080p.x264.mkv"), 5);
  assert.equal(absoluteNumber("Show Name.mkv"), undefined);
  assert.equal(absoluteNumber("Movie 2010.mkv"), undefined);
});

test("moviePartsOf: cd/part/pt/disc, in order; real duplicates are not parts", () => {
  const f = (/** @type {string[]} */ ...n) => n.map((name) => ({ name }));
  assert.deepEqual(moviePartsOf(f("Movie CD2.avi", "Movie CD1.avi"))?.map((x) => x.name), ["Movie CD1.avi", "Movie CD2.avi"]);
  assert.equal(moviePartsOf(f("movie.part1.mkv", "movie.part2.mkv"))?.length, 2);
  assert.equal(moviePartsOf(f("Movie pt1.mkv", "Movie pt2.mkv"))?.length, 2);
  assert.equal(moviePartsOf(f("Movie (Disc 1).mkv", "Movie (Disc 2).mkv"))?.length, 2);
  assert.equal(moviePartsOf(f("movie.mkv", "movie.1080p.mkv")), null);
  assert.equal(moviePartsOf(f("Movie CD1.avi", "Other CD2.avi")), null);
});

/** Run the scanner on a scratch library (empty files, own data dir) in a child process. */
async function scan(/** @type {(root: string) => void} */ build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-scan-"));
  build(dir);
  const { execFileSync } = await import("node:child_process");
  const code = `import {scanLibrary} from ${JSON.stringify(new URL("../server/lib/scanner.js", import.meta.url).href)};console.log(JSON.stringify(scanLibrary(${JSON.stringify(dir)})))`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, CIROOM_DATA_DIR: path.join(dir, "data") }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out);
}
const touch = (/** @type {string} */ root, /** @type {string} */ rel) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); };
const epNums = (/** @type {any} */ lib) => lib.series[0].seasons.map((/** @type {any} */ s) => [s.number, s.episodes.filter((/** @type {any} */ e) => e.file).map((/** @type {any} */ e) => e.number)]);

test("series: absolute numbering becomes season 1", async () => {
  const lib = await scan((r) => { for (let i = 1; i <= 12; i++) touch(r, `Series/Some Show/Some Show - ${String(i).padStart(3, "0")}.mkv`); fs.mkdirSync(path.join(r, "Movies"), { recursive: true }); });
  assert.deepEqual(epNums(lib), [[1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]]);
  assert.equal(lib.review.filter((/** @type {any} */ x) => x.kind === "unidentified").length, 0);
});

test("series: a mixed folder is not converted", async () => {
  const lib = await scan((r) => { touch(r, "Series/Mixed/Mixed S01E01.mkv"); touch(r, "Series/Mixed/Mixed - 07.mkv"); touch(r, "Series/Mixed/Mixed S01E02.mkv"); });
  assert.deepEqual(epNums(lib), [[1, [1, 2]]]);
  assert.equal(lib.review.filter((/** @type {any} */ x) => x.kind === "unidentified").length, 1);
});

test("movies: CD1/CD2 is one movie with parts; a real duplicate stays a duplicate", async () => {
  const lib = await scan((r) => {
    touch(r, "Movies/Big Film 2001/Big Film CD1.avi"); touch(r, "Movies/Big Film 2001/Big Film CD2.avi");
    touch(r, "Movies/Dup Film 2002/dup.mkv"); touch(r, "Movies/Dup Film 2002/dup.1080p.mkv");
  });
  const big = lib.movies.find((/** @type {any} */ m) => m.title === "Big Film");
  assert.deepEqual(big.parts.map((/** @type {any} */ p) => path.basename(p.path)), ["Big Film CD1.avi", "Big Film CD2.avi"]);
  assert.equal(big.file.path, big.parts[0].path);
  assert.equal(lib.review.filter((/** @type {any} */ x) => x.kind === "duplicate" && x.path.includes("Big Film")).length, 0);
  assert.equal(lib.review.filter((/** @type {any} */ x) => x.kind === "duplicate" && x.path.includes("Dup Film")).length, 1);
  assert.equal(lib.movies.find((/** @type {any} */ m) => m.title === "Dup Film").parts, undefined);
});
