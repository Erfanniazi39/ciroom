// @ts-check
/**
 * Skip intro / skip credits analysis for one season (runs in a worker thread so the server never stalls).
 *
 * Every episode's audio is fingerprinted with Chromaprint (built into ffmpeg: no install): the first
 * HEAD_S seconds and the last TAIL_S seconds. The intro is the stretch of audio an episode shares with
 * the other episodes of its season (the theme song); the credits are the shared stretch near the end.
 * A stretch counts only when several episodes agree on it, so a one-off match (a recap, a sting) is
 * ignored. ffmpeg runs with the lowest CPU and disk priority (nice 19, ionice idle) and reads only the
 * start and end of each file. Read-only: video files are never modified.
 *
 * Input  (workerData): { files: string[] }  (one season, in episode order)
 * Output (message):    { results: { [file]: { duration, intro: [start, end] | null, credits: number | null } } }
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import { parentPort, workerData } from "node:worker_threads";

export const HEAD_S = 600; // intros start within the first 10 minutes (Breaking Bad's can be after a 3.5 min cold open)
export const TAIL_S = 300; // credits start within the last 5 minutes
const STEP = 0.1238; // seconds per Chromaprint item (4096-sample hop at 11025 Hz, 1/3 overlap)
const NEIGHBOURS = 2; // compare each episode with up to 2 before and 2 after it

const pop = (/** @type {number} */ x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const LOW_PRIORITY = (() => { try { execFileSync("ionice", ["-c3", "true"]); return true; } catch { return false; } })();

/** Raw Chromaprint fingerprint of part of a file's audio. */
function fingerprint(/** @type {string} */ file, /** @type {"head"|"tail"} */ part) {
  const range = part === "head" ? ["-t", String(HEAD_S), "-i", file] : ["-sseof", `-${TAIL_S}`, "-i", file];
  const args = ["-v", "error", ...range, "-vn", "-ac", "1", "-ar", "11025", "-f", "chromaprint", "-fp_format", "raw", "-"];
  const cmd = LOW_PRIORITY ? "ionice" : "nice";
  const full = LOW_PRIORITY ? ["-c3", "nice", "-n", "19", "ffmpeg", ...args] : ["-n", "19", "ffmpeg", ...args];
  try {
    const b = execFileSync(cmd, full, { maxBuffer: 1 << 26, timeout: 180_000 });
    return new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  } catch {
    return new Uint32Array(0);
  }
}

function duration(/** @type {string} */ file) {
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 30_000 }).toString().trim()) || 0;
  } catch { return 0; }
}

/**
 * The longest stretches the two fingerprints share (up to 3, not overlapping), in seconds from each start.
 * For every alignment, runs of near-identical items are found (short dropouts allowed); near-constant
 * runs (silence) are rejected.
 * @returns {{ a: number, b: number, len: number }[]}
 */
function shared(/** @type {Uint32Array} */ a, /** @type {Uint32Array} */ b, minSec = 6, maxSec = 150) {
  const minItems = Math.ceil(minSec / STEP);
  /** @type {{ a: number, b: number, len: number }[]} */ const found = [];
  for (let off = -b.length + 1; off < a.length; off++) {
    const lo = Math.max(0, off), hi = Math.min(a.length, b.length + off);
    if (hi - lo < minItems) continue;
    let start = -1, last = -1, bad = 0;
    for (let i = lo; i <= hi; i++) {
      const ok = i < hi && pop(a[i] ^ b[i - off]) <= 9;
      if (ok) { if (start < 0) start = i; last = i; bad = 0; continue; }
      if (start < 0) continue;
      if (++bad > 8 || i === hi) {
        const n = last - start;
        if (n >= minItems && n * STEP <= maxSec && new Set(a.subarray(start, last)).size > n * 0.5)
          found.push({ a: start * STEP, b: (start - off) * STEP, len: n * STEP });
        start = -1; bad = 0;
      }
    }
  }
  found.sort((x, y) => y.len - x.len);
  /** @type {typeof found} */ const out = [];
  for (const f of found) {
    const clash = out.some((o) => (f.a < o.a + o.len && o.a < f.a + f.len) || (f.b < o.b + o.len && o.b < f.b + f.len));
    if (!clash) out.push(f);
    if (out.length === 3) break;
  }
  return out;
}

const median = (/** @type {number[]} */ v) => { const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * For each episode, the stretch most other episodes agree on: [start, end] in seconds of that part, or null.
 * @param {Uint32Array[]} fps
 * @param {{ minSec: number, maxSec: number }} o
 */
function agreed(fps, o) {
  const n = fps.length;
  /** @type {Map<string, ReturnType<typeof shared>>} */ const pairs = new Map();
  const pair = (/** @type {number} */ i, /** @type {number} */ j) => {
    const k = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (!pairs.has(k)) pairs.set(k, i < j ? shared(fps[i], fps[j], o.minSec, o.maxSec) : shared(fps[j], fps[i], o.minSec, o.maxSec));
    const segs = /** @type {ReturnType<typeof shared>} */ (pairs.get(k));
    return i < j ? segs : segs.map((s) => ({ a: s.b, b: s.a, len: s.len })); // seen from episode i
  };
  return fps.map((fp, i) => {
    if (!fp.length) return null;
    const others = [];
    for (let j = Math.max(0, i - NEIGHBOURS); j <= Math.min(n - 1, i + NEIGHBOURS); j++) if (j !== i && fps[j].length) others.push(j);
    if (!others.length) return null;
    /** @type {{ s: number, e: number, j: number }[]} */ const cands = [];
    for (const j of others) for (const seg of pair(i, j)) cands.push({ s: seg.a, e: seg.a + seg.len, j });
    let best = null, bestSupport = 0, bestLen = 0;
    for (const c of cands) {
      const sup = cands.filter((d) => Math.min(c.e, d.e) - Math.max(c.s, d.s) >= 0.5 * Math.min(c.e - c.s, d.e - d.s));
      const support = new Set(sup.map((d) => d.j)).size;
      if (support > bestSupport || (support === bestSupport && c.e - c.s > bestLen)) {
        best = sup; bestSupport = support; bestLen = c.e - c.s;
      }
    }
    const need = Math.min(2, others.length); // two other episodes must agree (one if the season has only two)
    if (!best || bestSupport < need) return null;
    return /** @type {[number, number]} */ ([median(best.map((d) => d.s)), median(best.map((d) => d.e))]);
  });
}

/** Analyse one season. @param {string[]} files */
export function analyseSeason(files) {
  const durations = files.map(duration);
  const heads = files.map((f) => fingerprint(f, "head"));
  const tails = files.map((f, i) => (durations[i] > TAIL_S + 120 ? fingerprint(f, "tail") : new Uint32Array(0)));
  const intros = agreed(heads, { minSec: 6, maxSec: 150 });
  const credits = agreed(tails, { minSec: 10, maxSec: TAIL_S });
  /** @type {Record<string, { duration: number, intro: [number, number] | null, credits: number | null }>} */ const results = {};
  files.forEach((f, i) => {
    const d = durations[i];
    const intro = intros[i];
    // Credits: the agreed stretch near the end, as an absolute time; must leave the episode's last 5 s and start after the intro.
    const c = credits[i] && d ? d - TAIL_S + credits[i][0] : null;
    results[f] = {
      duration: Math.round(d * 10) / 10,
      intro: intro ? [Math.round(intro[0] * 10) / 10, Math.round(intro[1] * 10) / 10] : null,
      credits: c && c < d - 5 && (!intro || c > intro[1] + 60) ? Math.round(c * 10) / 10 : null,
    };
  });
  return results;
}

if (parentPort && workerData?.files) {
  try { os.setPriority(19); } catch { /* not allowed: fine */ }
  parentPort.postMessage({ results: analyseSeason(workerData.files) });
}
