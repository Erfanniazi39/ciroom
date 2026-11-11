// @ts-check
/**
 * In-page playback for the watch page (dev bridge; Stage 3 ports this to Rust).
 *
 * The webview can't play the library's .mkv files directly, so ffmpeg repackages them on the fly
 * as fragmented MP4:
 *   - H.264 8-bit + AAC (≈93% of the library) → stream copy: no re-encode, original quality, ~0 CPU
 *   - HEVC / 10-bit video                    → libx264 veryfast, ≤720p
 *   - non-AAC audio (Opus, AC3, DTS…)        → AAC stereo
 * Seeking restarts the stream at the new time (?t=). The client tracks that offset.
 *
 *   GET /api/probe?path=…                 → { duration, width, height, video, audio, copyVideo, copyAudio, subtitles[] }
 *   GET /api/stream?path=…&t=SECONDS      → video/mp4 (fragmented, progressive)
 *   GET /api/subtitle.vtt?path=…&i=N      → WebVTT (absolute times; the client applies offset/delay)
 *   GET /api/thumb?path=…&t=SECONDS       → JPEG frame for the seek-bar hover preview
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { subtitleLanguage, subtitlesFor } from "./subtitles.js";
import { CACHE_DIR } from "./paths.js";

const run = promisify(execFile);
const LOUD_FILE = path.join(CACHE_DIR, "loudness.json");
const LEVEL_TARGET = -18; // LUFS: a comfortable TV level (Hannibal/Rick & Morty sit around -16…-18)
const FACTS_FILE = path.join(CACHE_DIR, "facts.json");
const TEXT_SUB = /\.(srt|ass|ssa|vtt)$/i;

/** @type {Map<string, any>} */ const probeCache = new Map();
/** @type {Map<string, string>} */ const vttCache = new Map();
/** @type {Map<string, Buffer>} */ const thumbCache = new Map();

/** Text subtitles for the page player. Listed fresh each time: subtitles found online can appear at any moment. */
const subtitleList = (/** @type {string} */ file) =>
  subtitlesFor(file).filter((f) => TEXT_SUB.test(f))
    .map((f, i) => {
      const language = subtitleLanguage(f);
      return { index: i, name: path.basename(f), language, label: prettySubName(path.basename(f), language), format: path.extname(f).slice(1).toLowerCase() };
    });

async function probe(/** @type {string} */ file) {
  if (probeCache.has(file)) return { ...probeCache.get(file), subtitles: subtitleList(file) };
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 8 << 20 });
  const info = JSON.parse(stdout);
  const v = info.streams.find((/** @type {any} */ s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = info.streams.find((/** @type {any} */ s) => s.codec_type === "audio");
  const result = {
    duration: Number(info.format?.duration) || 0,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    video: v ? `${v.codec_name}${v.pix_fmt?.includes("10") ? " 10-bit" : ""}` : null,
    audio: a ? `${a.codec_name}${a.channels ? ` ${a.channels}ch` : ""}` : null,
    copyVideo: !!v && v.codec_name === "h264" && /^(yuv420p|yuvj420p)$/.test(v.pix_fmt ?? ""),
    copyAudio: !!a && a.codec_name === "aac",
    hasAudio: !!a,
    // RFC 6381 codec string of the STREAM's video, for MediaSource (copied: the file's H.264; else our High@4.0).
    codecs: { video: v && v.codec_name === "h264" && /^(yuv420p|yuvj420p)$/.test(v.pix_fmt ?? "") ? avc1(v.profile, v.level) : "avc1.640028" },
    subtitles: subtitleList(file),
  };
  probeCache.set(file, result);
  return result;
}

/**
 * Source time that output time 0 of `/api/stream?t=` corresponds to, for stream-copied files.
 * Stream copy can only start at a keyframe, and ffmpeg's seek may even land on an earlier one, so we
 * run the SAME seek and read the first timestamps. -avoid_negative_ts make_zero shifts the output so
 * the earliest dts becomes 0, so that earliest dts is the offset the player must add.
 */
function streamOrigin(/** @type {string} */ file, /** @type {string} */ ss) {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "quiet", "-nostdin", "-ss", ss, "-i", file,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-copyts", "-frames:v", "3", "-f", "nut", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const pr = spawn("ffprobe", ["-v", "quiet", "-show_entries", "packet=dts_time", "-of", "csv=p=0", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    ff.stdout.pipe(pr.stdin);
    pr.stdin.on("error", () => {});
    let out = "";
    pr.stdout.on("data", (d) => { out += d; });
    const fallback = Number(ss);
    const timer = setTimeout(() => { ff.kill("SIGKILL"); pr.kill("SIGKILL"); resolve(fallback); }, 8000);
    pr.on("close", () => {
      clearTimeout(timer);
      const ts = out.split("\n").filter((l) => l.trim() && l.trim() !== "N/A").map(Number).filter(Number.isFinite);
      resolve(ts.length ? Math.min(...ts) : fallback);
    });
  });
}

/** "High", 31 → "avc1.64001f". */
function avc1(/** @type {string|undefined} */ profile, /** @type {number|undefined} */ level) {
  const p = /** @type {Record<string,string>} */ ({ "Constrained Baseline": "4240", Baseline: "4200", Main: "4d00", High: "6400", "High 10": "6e00" })[profile ?? ""] ?? "6400";
  const l = Math.max(10, Math.min(62, Number(level) || 40));
  return `avc1.${p}${l.toString(16).padStart(2, "0")}`;
}

function prettySubName(/** @type {string} */ name, /** @type {string | null} */ lang) {
  const n = name.replace(/\.(srt|ass|ssa|vtt)$/i, "");
  const sdh = /\b(sdh|hi|cc)\b/i.test(n) ? " (SDH)" : "";
  return lang ? `${lang}${sdh} · ${n.length > 34 ? n.slice(0, 32) + "…" : n}` : (n.length > 48 ? n.slice(0, 46) + "…" : n);
}

/**
 * Volume levelling: how many dB to boost/cut this file so it plays at LEVEL_TARGET.
 * Some releases are extremely quiet (Breaking Bad S2/S3 ≈ -44 LUFS, peaks at -21 dB), others normal (-16).
 * Measured once on four 30 s samples (~1 s total), cached by path+size. A fixed gain per file (no pumping);
 * the stream/mpv add a limiter so boosted peaks never clip.
 * @type {Map<string, number>}
 */
const loudCache = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(LOUD_FILE, "utf8")); } catch { return {}; } })()));
export async function levelGain(/** @type {string} */ file) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}`;
  if (loudCache.has(key)) return /** @type {number} */ (loudCache.get(key));
  const info = await probe(file);
  if (!info.hasAudio || !info.duration) return 0;
  const points = [0.15, 0.35, 0.55, 0.75].map((f) => Math.max(0, info.duration * f));
  /** @type {number[]} */ const lufs = [];
  for (const t of points) {
    try {
      const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-ss", t.toFixed(1), "-t", "30", "-i", file, "-map", "0:a:0", "-vn", "-sn", "-af", "ebur128", "-f", "null", "-"], { maxBuffer: 64 << 20 });
      const m = String(stderr).split("Summary:").pop()?.match(/I:\s+(-?[\d.]+)\s+LUFS/);
      if (m && Number(m[1]) > -70) lufs.push(Number(m[1]));
    } catch { /* sample failed: use the others */ }
  }
  if (!lufs.length) return 0;
  const loudness = 10 * Math.log10(lufs.reduce((a, l) => a + 10 ** (l / 10), 0) / lufs.length); // energy average
  const gain = Math.round(Math.max(-8, Math.min(26, LEVEL_TARGET - loudness)) * 10) / 10;
  loudCache.set(key, gain);
  try { fs.mkdirSync(path.dirname(LOUD_FILE), { recursive: true }); fs.writeFileSync(LOUD_FILE, JSON.stringify(Object.fromEntries(loudCache))); } catch { /* cache only */ }
  return gain;
}
/** The ffmpeg/mpv audio filter for a gain, or null when no change is needed. Limiter: no clipping. */
export const levelFilter = (/** @type {number} */ gain) => (Math.abs(gain) < 1 ? null : `volume=${gain}dB,alimiter=limit=0.9:attack=5:release=80:level=0`);

/** Subtitle file → { name, language?, sdh, format } for the UI's file panel. */
function subFact(/** @type {string} */ f) {
  const n = path.basename(f);
  const language = subtitleLanguage(f) ?? undefined;
  return { name: n, language, sdh: /\b(sdh|hi|cc)\b/i.test(n), format: path.extname(f).slice(1).toLowerCase() };
}

/** Real facts about each library video (size, resolution, codec, length, subtitles). Cached by path+size+mtime. */
async function filesFacts(/** @type {string[]} */ expected, /** @type {(e: string) => string} */ resolveVideo) {
  /** @type {Record<string, any>} */ const disk = (() => { try { return JSON.parse(fs.readFileSync(FACTS_FILE, "utf8")); } catch { return {}; } })();
  /** @type {Record<string, any>} */ const out = {};
  let dirty = false;
  const queue = [...new Set(expected)];
  const worker = async () => {
    for (let e = queue.shift(); e !== undefined; e = queue.shift()) {
      try {
        const file = resolveVideo(e);
        const st = fs.statSync(file);
        const key = `${file}|${st.size}|${st.mtimeMs}`;
        let f = disk[key];
        if (!f || f.mtime === undefined) {
          const p = await probe(file);
          f = { file, sizeBytes: st.size, width: p.width, height: p.height, video: p.video, audio: p.audio, duration: Math.round(p.duration), mtime: Math.round(st.mtimeMs) };
          disk[key] = f; dirty = true;
        }
        out[e] = { ...f, subtitles: subtitlesFor(file).map(subFact) }; // subtitles re-listed each time (cheap)
      } catch (err) {
        out[e] = { error: err instanceof Error ? err.message : "Not found" };
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (dirty) { fs.mkdirSync(path.dirname(FACTS_FILE), { recursive: true }); fs.writeFileSync(FACTS_FILE, JSON.stringify(disk)); }
  return out;
}

/** @param {(expected: string) => string} resolveVideo */
export function streamRoutes(resolveVideo) {
  return {
    /** @returns {Promise<boolean>} true if handled */
    async handle(/** @type {any} */ req, /** @type {any} */ res, /** @type {(c:number,d:unknown)=>void} */ json, /** @type {(r:any)=>Promise<any>} */ body) {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/api/files/facts" && req.method === "POST") {
        const { paths } = await body(req);
        json(200, await filesFacts(Array.isArray(paths) ? paths.map(String) : [], resolveVideo));
        return true;
      }
      if (!["/api/probe", "/api/stream", "/api/seekpoint", "/api/subtitle.vtt", "/api/thumb"].includes(u.pathname)) return false;
      const file = resolveVideo(String(u.searchParams.get("path") ?? ""));

      if (u.pathname === "/api/probe") {
        json(200, { ...(await probe(file)), levelGainDb: await levelGain(file) });
        return true;
      }

      // Where a stream requested at t REALLY starts (source time of output 0). Stream copy can only cut at a
      // keyframe (gaps of 10 s+ in this library), so the player uses this as its offset, then skips ahead.
      // Transcoded streams decode from the keyframe and drop frames up to t, so they start at t exactly.
      if (u.pathname === "/api/seekpoint") {
        const info = await probe(file);
        const t = Math.max(0, Number(u.searchParams.get("t")) || 0);
        json(200, { start: info.copyVideo && t > 0 ? await streamOrigin(file, t.toFixed(3)) : t });
        return true;
      }

      if (u.pathname === "/api/stream") {
        const info = await probe(file);
        const t = Math.max(0, Number(u.searchParams.get("t")) || 0);
        const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
        if (t > 0) args.push("-ss", t.toFixed(3)); // same string /api/seekpoint measured
        args.push("-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_chapters", "-1");
        if (info.copyVideo) args.push("-c:v", "copy");
        else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.0", "-vf", "scale=-2:'min(720,ih)'", "-g", "48");
        const level = u.searchParams.get("level") !== "0" ? levelFilter(await levelGain(file)) : null;
        // Audio is ALWAYS re-encoded (levelling only adds the gain filter). Copying the source audio untouched makes
        // WebKitGTK's MediaSource freeze the whole page (99% CPU, 2+ GB, never recovers) on large files, e.g. movies;
        // re-encoded audio is solid. 192k AAC stereo is transparent for this library (all stereo AAC/Opus).
        if (info.hasAudio) args.push(...(level ? ["-af", level] : []), "-c:a", "aac", "-b:a", "192k", "-ac", "2");
        args.push("-avoid_negative_ts", "make_zero", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");

        const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        ff.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
        res.statusCode = 200;
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Stream-Mode", `${info.copyVideo ? "copy" : "transcode"}/aac${level ? " levelled" : ""}`);
        ff.stdout.pipe(res);
        const stop = () => { if (ff.exitCode === null) ff.kill("SIGKILL"); };
        req.on("close", stop);
        res.on("close", stop);
        ff.on("exit", (code) => { if (code && code !== 255 && err) console.error("[stream] ffmpeg:", err.trim()); });
        return true;
      }

      if (u.pathname === "/api/subtitle.vtt") {
        const subs = subtitlesFor(file).filter((f) => TEXT_SUB.test(f));
        const sub = subs[Number(u.searchParams.get("i")) || 0];
        if (!sub) { json(404, { error: "No text subtitles for this video" }); return true; }
        let vtt = vttCache.get(sub);
        if (!vtt) {
          const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", sub, "-f", "webvtt", "pipe:1"], { maxBuffer: 32 << 20 });
          vtt = stdout;
          vttCache.set(sub, vtt);
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        res.end(vtt);
        return true;
      }

      if (u.pathname === "/api/thumb") {
        const t = Math.max(0, Math.round(Number(u.searchParams.get("t")) || 0));
        const key = `${file}|${t}`;
        let jpg = thumbCache.get(key);
        if (!jpg) {
          const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-ss", String(t), "-i", file, "-frames:v", "1", "-an", "-sn",
            "-vf", "scale=320:-2", "-q:v", "5", "-f", "mjpeg", "pipe:1"], { encoding: "buffer", maxBuffer: 4 << 20 });
          jpg = /** @type {Buffer} */ (stdout);
          if (thumbCache.size > 600) thumbCache.clear();
          thumbCache.set(key, jpg);
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.end(jpg);
        return true;
      }
      return false;
    },
  };
}
