// @ts-check
/** Finding the real video file for a path the library expects (folder-based identity). Read-only. */
import fs from "node:fs";
import path from "node:path";

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts|wmv)$/i;

/**
 * The library's expected path may not be the exact on-disk name. Walk up (never above the title folder) and pick the matching video.
 * @param {string} rootAbs the absolute media root
 * @returns {(expected: string) => string}
 */
export function makeResolveVideo(rootAbs) {
  return function resolveVideo(expected) {
    const abs = path.resolve(expected);
    if (!abs.startsWith(rootAbs + path.sep)) throw new Error("Path outside the media library");
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;

    const parts = path.relative(rootAbs, abs).split(path.sep);
    const floor = path.join(rootAbs, ...parts.slice(0, 2)); // <root>/Movies|Series/<Title>
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir) && dir.length > floor.length) dir = path.dirname(dir);
    if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${path.relative(rootAbs, floor)}`);

    /** @type {{p: string, depth: number, size: number}[]} */
    const found = [];
    const walk = (/** @type {string} */ d, depth = 0) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (VIDEO.test(e.name)) found.push({ p, depth, size: fs.statSync(p).size });
      }
    };
    walk(dir);
    if (!found.length) throw new Error("No video file found in this folder");

    const m = path.basename(abs).match(/S(\d+)E(\d+)/i);
    let pool = found;
    if (m) {
      const re = new RegExp(`(^|\\D)S?0*${Number(m[1])}\\W*(?:E|EP|x)0*${Number(m[2])}(?!\\d)`, "i");
      // Folder beats filename (SPEC §7.2): "S03/EP02/E.mkv" is S03E02.
      const rel = (/** @type {string} */ f) => path.relative(floor, f);
      pool = found.filter((f) => re.test(path.dirname(rel(f.p))));
      if (!pool.length) pool = found.filter((f) => re.test(rel(f.p)));
      if (!pool.length) throw new Error(`Episode S${m[1]}E${m[2]} not found on disk`);
    }
    return pool.sort((a, b) => a.depth - b.depth || b.size - a.size)[0].p;
  };
}
