// @ts-check
/** Finding the real video file for a path the library expects (folder-based identity). Read-only. */
import fs from "node:fs";
import path from "node:path";
import { SKIP_DIR, PART_TOKEN, parseEpisode, absoluteNumber } from "./scanner.js";

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts|wmv)$/i;
const isDir = (/** @type {string} */ p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * The library's expected path may not be the exact on-disk name: a video renamed inside its own folder (e.g. a
 * re-download under another name) still plays. Nothing else does: if the expected file's own folder is gone, or no
 * video there is the same episode / movie part, the answer is "not found" (never another title's or episode's video).
 * @param {string} rootAbs the absolute media root
 * @returns {(expected: string) => string}
 */
export function makeResolveVideo(rootAbs) {
  return function resolveVideo(expected) {
    const abs = path.resolve(expected);
    if (!abs.startsWith(rootAbs + path.sep)) throw new Error("Path outside the media library");
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;

    // <root>/Movies|Series/<Title>/…/video: anything shorter has no title folder to search in.
    const parts = path.relative(rootAbs, abs).split(path.sep);
    if (parts.length < 3 || (parts[0] !== "Movies" && parts[0] !== "Series")) throw new Error(`Video not found: ${parts.join("/")}`);
    const dir = path.dirname(abs); // the expected file's own folder: the only place searched, never a parent
    if (!isDir(dir)) throw new Error(`Folder not found: ${path.relative(rootAbs, dir)}`);

    // Videos in the own folder and a few levels below, skipping what the scanner skips (Sample/, Extras/, small samples).
    /** @type {{p: string, name: string, depth: number, size: number}[]} */
    const found = [];
    const walk = (/** @type {string} */ d, depth = 0) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 3 && !SKIP_DIR.test(e.name)) walk(p, depth + 1); continue; }
        if (!VIDEO.test(e.name)) continue;
        let size;
        try { size = fs.statSync(p).size; } catch { continue; }
        if (/sample/i.test(e.name) && size < 300 * 1024 * 1024) continue;
        found.push({ p, name: e.name, depth, size });
      }
    };
    walk(dir);
    if (!found.length) throw new Error("No video file found in this folder");

    const name = path.basename(abs);
    let pool = found;
    if (parts[0] === "Series") {
      // Same identity as the scan (scanner.js parseEpisode: folder beats file name). Folders count from the series
      // folder, so a season folder above the own folder still sets the season.
      const show = path.join(rootAbs, parts[0], parts[1]);
      const dirsOf = (/** @type {string} */ f) => path.relative(show, path.dirname(f)).split(path.sep).filter(Boolean);
      const want = parseEpisode(parts.slice(2, -1), name);
      if (want.episode !== undefined) {
        pool = found.filter((f) => { const g = parseEpisode(dirsOf(f.p), f.name); return g.season === want.season && g.episode === want.episode; });
        if (!pool.length) throw new Error(`Episode S${want.season}E${want.episode} not found on disk`);
      } else {
        // Absolute numbering ("Show - 012.mkv"): the trailing number is the identity.
        const n = absoluteNumber(name);
        pool = n === undefined ? [] : found.filter((f) => parseEpisode(dirsOf(f.p), f.name).episode === undefined && absoluteNumber(f.name) === n);
        if (!pool.length) throw new Error(n === undefined ? `Video not found: ${parts.join("/")}` : `Episode ${n} not found on disk`);
      }
    } else {
      // A movie in parts (cd1/cd2): a missing part must not play another part.
      const part = name.match(PART_TOKEN);
      if (part) {
        pool = found.filter((f) => f.name.match(PART_TOKEN)?.[1] === part[1]);
        if (!pool.length) throw new Error(`Part ${part[1]} not found on disk`);
      }
    }
    return pool.sort((a, b) => a.depth - b.depth || b.size - a.size)[0].p;
  };
}
