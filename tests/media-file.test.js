// resolveVideo (server/lib/media-file.js): a video renamed inside its own folder still plays; anything else that is
// gone is "not found", never another video (D-09). Empty files stand in for videos: the lookup never reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-mf-"));
process.env.XDG_DATA_HOME = path.join(tmp, "xdg");
process.env.CIROOM_DATA_DIR = path.join(tmp, "data");
process.env.CIROOM_CACHE_DIR = path.join(tmp, "cache");
const { makeResolveVideo } = await import("../server/lib/media-file.js");

const root = path.join(tmp, "media");
const put = (/** @type {string} */ rel, bytes = 0) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes)); return p; };
const at = (/** @type {string} */ rel) => path.join(root, rel);
const resolve = makeResolveVideo(root);

test("renamed episode in season 2 (episode folders, token-free names) resolves by its folders", () => {
  put("Series/Show/S02/EP01/new-name.mkv");
  put("Series/Show/S02/EP02/b.mkv");
  put("Series/Show/S01/EP01/c.mkv");
  assert.equal(resolve(at("Series/Show/S02/EP01/E.mkv")), at("Series/Show/S02/EP01/new-name.mkv"));
});

test("renamed episode in a flat season folder: only the same SxxEyy is chosen", () => {
  put("Series/Flat/Season 2/Flat.S02E03.v2.mkv");
  put("Series/Flat/Season 2/Flat.S02E04.mkv", 10);
  assert.equal(resolve(at("Series/Flat/Season 2/Flat.S02E03.mkv")), at("Series/Flat/Season 2/Flat.S02E03.v2.mkv"));
  assert.throws(() => resolve(at("Series/Flat/Season 2/Flat.S02E05.mkv")), /S2E5 not found/);
  assert.throws(() => resolve(at("Series/Flat/Season 2/ep7.mkv")), /not found/, "no identity → not found, not the largest file");
});

test("absolute numbering: only the same trailing number is chosen", () => {
  put("Series/Anime/Anime - 012 [1080p].mkv");
  put("Series/Anime/Anime - 013.mkv", 10);
  assert.equal(resolve(at("Series/Anime/Anime - 012.mkv")), at("Series/Anime/Anime - 012 [1080p].mkv"));
  assert.throws(() => resolve(at("Series/Anime/Anime - 014.mkv")), /not found/);
});

test("a deleted movie never plays its Sample/ or Extras/ video, nor a small sample file", () => {
  put("Movies/Film 2010/Sample/film.sample.mkv", 5);
  put("Movies/Film 2010/Extras/making-of.mkv", 5);
  put("Movies/Film 2010/film-sample.mkv", 5);
  assert.throws(() => resolve(at("Movies/Film 2010/film.mkv")), /No video file/);
  put("Movies/Film 2010/film.redownload.mkv", 1);
  assert.equal(resolve(at("Movies/Film 2010/film.mkv")), at("Movies/Film 2010/film.redownload.mkv"));
});

test("a movie in parts: a missing part never plays another part", () => {
  put("Movies/Long 1990/long.cd1.mkv", 20);
  put("Movies/Long 1990/long.part2.renamed.mkv"); // not a part token at the end → not part 2
  assert.throws(() => resolve(at("Movies/Long 1990/long.cd2.mkv")), /Part 2 not found/);
  put("Movies/Long 1990/long-v2 cd2.mkv");
  assert.equal(resolve(at("Movies/Long 1990/long.cd2.mkv")), at("Movies/Long 1990/long-v2 cd2.mkv"));
});

test("never searches above the own folder: collection member, title folder, Movies/ itself", () => {
  put("Movies/Saga/One 2001/one.mkv");
  put("Movies/Saga/Two 2002/two.mkv");
  put("Movies/loose.mkv");
  assert.throws(() => resolve(at("Movies/Saga/Three 2003/three.mkv")), /Folder not found/);
  assert.throws(() => resolve(at("Movies/Saga/One 2001/Sub/one.mkv")), /Folder not found/);
  assert.throws(() => resolve(at("Movies/does-not-exist.mkv")), /not found/);
  assert.throws(() => resolve(at("Other/Title/x.mkv")), /not found/);
  assert.equal(resolve(at("Movies/loose.mkv")), at("Movies/loose.mkv"), "an existing file is always returned as is");
  assert.throws(() => resolve(path.join(tmp, "elsewhere.mkv")), /outside the media library/);
});
