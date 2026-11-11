// @ts-check
/**
 * Subtitle discovery + repair (dev bridge; Stage 3 ports this to Rust).
 *
 * Finds every subtitle next to a video (and in a Subs/ subfolder) and hands mpv an explicit list.
 * Some real-world .srt files are malformed. For example, MY-SUBS files start with a timestamp and
 * no cue number, so mpv refuses them ("Can not open external file"). Those are rewritten into a
 * clean copy in Marquee's cache. **The original file is never modified.**
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foundSubtitles } from "./subtitle-search.js";

const SUB = /\.(srt|ass|ssa|vtt|sub)$/i;
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "marquee", "subs");
const TIME = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/;

/** @param {string} videoPath @returns {string[]} subtitle paths to pass to mpv (originals or repaired copies) */
export function subtitlesFor(videoPath) {
  const dir = path.dirname(videoPath);
  const candidates = [];
  for (const d of [dir, path.join(dir, "Subs"), path.join(dir, "subs")]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) if (SUB.test(name)) candidates.push(path.join(d, name));
  }
  candidates.push(...foundSubtitles(videoPath)); // subtitles found online (stored in CiRoom's data folder, never next to the video)
  const stem = path.parse(videoPath).name.toLowerCase();
  const online = new Set(foundSubtitles(videoPath));
  // Most likely match first: same stem, then English, then non-SDH. Subtitles found online come after the ones next to the video.
  const rank = (/** @type {string} */ p) => {
    const n = path.basename(p).toLowerCase();
    return (online.has(p) ? 10 : 0) + (n.startsWith(stem) ? 0 : 4) + (/\b(en|eng|english)\b/.test(n) ? 0 : 2) + (/\b(sdh|hi|cc)\b/.test(n) ? 1 : 0);
  };
  return [...new Set(candidates)].sort((a, b) => rank(a) - rank(b)).map((p) => (/\.srt$/i.test(p) ? repairSrt(p) : p));
}

/** Return the original path if it's a well-formed SRT, else a repaired cached copy. */
function repairSrt(/** @type {string} */ file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return file;
  }
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const wellFormed = first >= 0 && /^\d+\s*$/.test(lines[first]) && TIME.test(lines[first + 1] ?? "");
  if (wellFormed) return file;

  // Rebuild: every block that contains a timestamp line becomes a numbered cue.
  const cues = [];
  for (const block of clean.split(/\n\s*\n/)) {
    const bl = block.split("\n");
    const t = bl.findIndex((l) => TIME.test(l));
    if (t < 0) continue;
    const body = bl.slice(t + 1).join("\n").trim();
    if (body) cues.push(`${cues.length + 1}\n${bl[t].trim().replace(/\./g, ",")}\n${body}`);
  }
  if (!cues.length) return file; // not SRT at all; let mpv try

  const st = fs.statSync(file);
  const key = crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
  const out = path.join(CACHE, key, path.basename(file)); // keep the original name so the track label is readable
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, cues.join("\n\n") + "\n");
  }
  return out;
}

/** @type {Map<string, string | null>} */ const sniffCache = new Map();

/**
 * Language of a subtitle file: from its name when it says so ("x.fa.srt"), otherwise read from the text itself.
 * Many real files don't name their language (Rick & Morty's Persian ones are "… [Phr0stY].srt"), so the first
 * 64 KB are decoded (UTF-8, else Windows-1256, the usual Persian encoding) and the script is counted:
 * Arabic script with Persian-only letters (پ چ ژ گ) → Persian; Latin with common English words → English.
 * Read-only; cached by path + size + mtime.
 * @param {string} file @returns {string | null}
 */
export function subtitleLanguage(file) {
  const named = languageOf(path.basename(file));
  if (named) return named;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (sniffCache.has(key)) return sniffCache.get(key) ?? null;
  let lang = null;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(st.size, 64 << 10));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let text;
    if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder("utf-16le").decode(buf);
    else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder("utf-16be").decode(buf);
    else try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, cutUtf8(buf))); }
    catch { text = new TextDecoder("windows-1256").decode(buf); }
    text = text.replace(/^\s*\d+\s*$/gm, " ").replace(/\d{1,2}:\d{2}:\d{2}[,.]\d+/g, " ").replace(/<[^>]*>|\{[^}]*\}/g, " ");
    const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (arabic > 50 && arabic > latin) lang = /[پچژگ]/.test(text) ? "Persian" : "Arabic";
    else if (latin > 40) {
      const words = text.toLowerCase().match(/[a-z']+/g) || [];
      const common = words.filter((w) => /^(the|you|i|and|to|a|is|it|what|that|of|in|me|this|we|don't|i'm|no|be|for)$/.test(w)).length;
      if (words.length && common / words.length > 0.12) lang = "English";
    }
  } catch { /* unreadable: unknown */ }
  sniffCache.set(key, lang);
  return lang;
}

/** Length of the buffer without a UTF-8 sequence cut in half at the end (so a valid file doesn't fail decoding). */
function cutUtf8(/** @type {Buffer} */ b) {
  let i = b.length;
  for (let k = 1; k <= 3 && i - k >= 0; k++) {
    const c = b[i - k];
    if ((c & 0xc0) === 0x80) continue; // continuation byte
    if (c >= 0xc0) return i - k; // lead byte of a possibly incomplete sequence: drop it
    break;
  }
  return i;
}

/** Display language of a subtitle file name ("x.fa.srt" → "Persian"), or null when unknown. */
export function languageOf(/** @type {string} */ name) {
  const n = name.replace(/\.(srt|ass|ssa|vtt)$/i, "");
  if (/\b(eng|english|en)\b/i.test(n)) return "English";
  if (/\b(per|persian|farsi|fa)\b/i.test(n)) return "Persian";
  const table = /** @type {Record<string,string>} */ ({ ar: "Arabic", tr: "Turkish", fr: "French", es: "Spanish", de: "German", ru: "Russian", it: "Italian", ja: "Japanese", ko: "Korean", zh: "Chinese", nl: "Dutch", pl: "Polish" });
  const m = n.match(/\.(ar|tr|fr|es|de|ru|it|ja|ko|zh|nl|pl)(?:\.\d+)?$/i); // not "hi": that's hearing-impaired (SDH), not Hindi
  return m ? table[m[1].toLowerCase()] : null;
}
