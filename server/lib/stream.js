// @ts-check
/**
 * In-page playback for the watch page.
 *
 * The webview can't play the library's .mkv files directly, so ffmpeg repackages them on the fly
 * as fragmented MP4:
 *   - H.264 8-bit + AAC (≈93% of the library) → stream copy: no re-encode, original quality, ~0 CPU
 *   - HEVC / 10-bit video                    → libx264 veryfast, ≤720p
 *   - non-AAC audio (Opus, AC3, DTS…)        → AAC stereo
 * Seeking restarts the stream at the new time (?t=). The client tracks that offset.
 *
 *   GET /api/probe?path=…                 → { duration, width, height, video, audio, copyVideo, copyAudio, subtitles[] }
 *   GET /api/stream?path=…&t=SECONDS[&a=N] → video/mp4 (a = audio stream number, default 0) (fragmented, progressive)
 *   GET /api/subtitle.vtt?path=…&i=N      → WebVTT (absolute times; the client applies offset/delay)
 *   GET /api/thumb?path=…&t=SECONDS       → JPEG frame for the seek-bar hover preview
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { decodeSubtitle } from "./subtitle-search.js";
import { subtitleLanguage, subtitlesFor } from "./subtitles.js";
import { CACHE_DIR } from "./paths.js";
import { writeJsonAtomic } from "./fsutil.js";
import { defineRoutes } from "./routes.js";

const execFileP = promisify(execFile);
/** ffprobe/ffmpeg helper: every call is killed after `timeout` ms (default 30 s) so a stalled drive can't hang a request forever. */
const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {import("node:child_process").ExecFileOptions} */ opts = {}) =>
  execFileP(cmd, args, { timeout: 30_000, killSignal: "SIGKILL", windowsHide: true, ...opts });
const LOUD_FILE = path.join(CACHE_DIR, "loudness.json");
const LEVEL_TARGET = -18; // LUFS: a comfortable TV level (Hannibal/Rick & Morty sit around -16…-18)
const FACTS_FILE = path.join(CACHE_DIR, "facts.json");
/** subtitleLanguage() names → the codes decodeSubtitle() knows. */
const SUB_CODE = /** @type {Record<string,string>} */ ({ Persian: "FA", Arabic: "AR", Turkish: "TR", Russian: "RU", Polish: "PL" });
const TEXT_SUB = /\.(srt|ass|ssa|vtt)$/i;

/** @type {Map<string, any>} */ const probeCache = new Map();
/** @type {Map<string, string>} */ const vttCache = new Map();
/** @type {Map<string, Buffer>} */ const thumbCache = new Map();

const THUMB_DIR = path.join(CACHE_DIR, "thumbs");
const THUMB_MAX_PARALLEL = 3;
const THUMB_TIMEOUT_MS = 15_000;
let thumbRunning = 0;
const THUMB_MAX_WAITING = Number(process.env.CIROOM_TEST_THUMB_QUEUE) || 24;
/** @type {Array<{ go: (run: boolean) => void, closed?: () => boolean }>} */ const thumbWaiting = [];

// The thumbnails on disk are a cache: over 200 MB the oldest are deleted down to 75 % (a fully scrubbed 2-hour film is
// ~1,440 files and the system disk is small). Checked after a write, at most once a minute, in the background.
const THUMB_MAX_BYTES = Math.max(1, Number(process.env.CIROOM_THUMB_MAX_MB ?? 200) * 1024 * 1024);
const THUMB_PRUNE_EVERY_MS = process.env.CIROOM_THUMB_PRUNE_MS !== undefined ? Number(process.env.CIROOM_THUMB_PRUNE_MS) : 60_000;
let thumbPruneAt = 0;
let thumbPruning = false;
async function pruneThumbs() {
  if (thumbPruning || Date.now() - thumbPruneAt < THUMB_PRUNE_EVERY_MS) return;
  thumbPruning = true;
  thumbPruneAt = Date.now();
  try {
    const names = await fs.promises.readdir(THUMB_DIR);
    /** @type {{ f: string, size: number, mtime: number }[]} */ const files = [];
    for (const n of names) {
      try { const st = await fs.promises.stat(path.join(THUMB_DIR, n)); if (st.isFile()) files.push({ f: path.join(THUMB_DIR, n), size: st.size, mtime: st.mtimeMs }); } catch { /* removed meanwhile */ }
    }
    let total = files.reduce((a, x) => a + x.size, 0);
    if (total <= THUMB_MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const x of files) {
      if (total <= THUMB_MAX_BYTES * 0.75) break;
      try { await fs.promises.unlink(x.f); total -= x.size; } catch { /* already gone */ }
    }
  } catch { /* no folder yet */ } finally { thumbPruning = false; }
}

/** One JPEG frame at t seconds. At most 3 ffmpeg run at once, each is killed after 15 s, and results are kept on disk.
 *  At most THUMB_MAX_WAITING requests wait: past that the OLDEST waiter is dropped (null), and so is any waiter whose
 *  request already closed. Returns an empty Buffer if ffmpeg failed or timed out, null if the request was dropped. */
async function thumbnail(/** @type {string} */ file, /** @type {number} */ t, /** @type {(() => boolean) | undefined} */ closed = undefined, /** @type {number} */ vi = 0) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}|${t}`; // (vi is 0 except for cover-art files, whose thumbnails are new anyway)
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const diskFile = path.join(THUMB_DIR, createHash("sha1").update(key).digest("hex") + ".jpg");
  try { const b = fs.readFileSync(diskFile); if (b.length) { thumbCache.set(key, b); return b; } } catch { /* not cached yet */ }
  if (thumbRunning >= THUMB_MAX_PARALLEL) {
    const run = await new Promise((r) => {
      thumbWaiting.push({ go: r, closed });
      while (thumbWaiting.length > THUMB_MAX_WAITING) /** @type {any} */ (thumbWaiting.shift()).go(false);
    });
    if (!run) return null;
  } else thumbRunning++;
  try {
    const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-ss", String(t), "-i", file, "-map", `0:v:${vi}`, "-frames:v", "1", "-an", "-sn",
      "-vf", "scale=320:-2", "-q:v", "5", "-f", "mjpeg", "pipe:1"], { encoding: "buffer", maxBuffer: 4 << 20, timeout: THUMB_TIMEOUT_MS, killSignal: "SIGKILL" });
    const jpg = /** @type {Buffer} */ (stdout);
    if (jpg.length) {
      if (thumbCache.size > 600) thumbCache.clear();
      thumbCache.set(key, jpg);
      try { fs.mkdirSync(THUMB_DIR, { recursive: true }); const tmp = diskFile + ".tmp"; fs.writeFileSync(tmp, jpg); fs.renameSync(tmp, diskFile); void pruneThumbs(); } catch { /* cache only */ }
    }
    return jpg;
  } catch { return Buffer.alloc(0); }
  finally {
    let next = thumbWaiting.shift();
    while (next && next.closed?.()) { next.go(false); next = thumbWaiting.shift(); }
    if (next) next.go(true); else thumbRunning--;
  }
}

/** Embedded subtitle codecs ffmpeg can turn into WebVTT (not the picture formats: PGS, DVD, DVB). */
const EMBED_TEXT = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);
/** ISO 639-2 tags in MKV/MP4 → the language names subtitleLanguage() uses. */
const LANG_NAME = /** @type {Record<string,string>} */ ({ eng: "English", per: "Persian", fas: "Persian", ara: "Arabic", tur: "Turkish", rus: "Russian", pol: "Polish", fre: "French", fra: "French", ger: "German", deu: "German", spa: "Spanish", ita: "Italian", por: "Portuguese", hin: "Hindi", jpn: "Japanese", kor: "Korean", chi: "Chinese", zho: "Chinese", dut: "Dutch", nld: "Dutch", swe: "Swedish", heb: "Hebrew", ukr: "Ukrainian" });

/** Text subtitle streams inside the video. `stream` = position among ALL its subtitle streams (ffmpeg `-map 0:s:N`). */
function embeddedSubs(/** @type {any[]} */ streams) {
  return streams.filter((s) => s.codec_type === "subtitle").flatMap((s, n) => {
    if (!EMBED_TEXT.has(s.codec_name)) return [];
    const tag = String(s.tags?.language ?? "").toLowerCase();
    const language = LANG_NAME[tag] ?? null;
    const title = String(s.tags?.title ?? "").trim();
    const sdh = s.disposition?.hearing_impaired || /\b(sdh|hi|cc)\b/i.test(title) ? " (SDH)" : "";
    const bit = title && title.toLowerCase() !== (language ?? "").toLowerCase() ? title : "";
    const label = `${language ?? (tag && tag !== "und" ? tag.toUpperCase() : `Track ${n + 1}`)}${sdh} · ${bit ? (bit.length > 30 ? bit.slice(0, 28) + "…" : bit) : "built-in"}`;
    return [{ name: `embedded:${n}:${tag || "und"}`, language, label, format: s.codec_name, embedded: true, stream: n }];
  });
}

/** Subtitles for the page player: files next to the video first, then the ones built in. Files are listed fresh
 *  each time (subtitles found online can appear at any moment); `index` is the position in this combined list. */
const subtitleList = (/** @type {string} */ file, /** @type {any[]} */ embedded = []) =>
  [
    ...subtitlesFor(file).filter((f) => TEXT_SUB.test(f)).map((f) => {
      const language = subtitleLanguage(f);
      return { name: path.basename(f), language, label: prettySubName(path.basename(f), language), format: path.extname(f).slice(1).toLowerCase() };
    }),
    ...embedded,
  ].map((s, i) => ({ index: i, ...s }));

/** `&q=low`: a small 480p ~1 Mbps re-encode (the watch party's "low data" choice for guests on a slow connection).
 *  Always x264 (X-Encoder: x264), never VA-API: it must respect a bitrate cap, and the iHD driver here only offers CQP. */
const wantsLow = (/** @type {URL} */ u) => u.searchParams.get("q") === "low";

/** The audio stream asked for with `&a=N` (or another parameter name): only a number that exists, otherwise the first one. */
function audioIndex(/** @type {any} */ info, /** @type {URL} */ u, param = "a") {
  const n = Math.floor(Number(u.searchParams.get(param)));
  return Number.isFinite(n) && n > 0 && n < (info.audioTracks?.length ?? 0) ? n : 0;
}

/** Set in a Map, dropping the oldest entries past `max` so a long session can't grow it forever. */
function cacheSet(/** @type {Map<string, any>} */ map, /** @type {string} */ key, /** @type {any} */ value, max = 300) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/** videoIndex of an already probed file, else 0. */
function cachedVideoIndex(/** @type {string} */ file) {
  try { const st = fs.statSync(file); return probeCache.get(`${file}|${st.size}|${st.mtimeMs}`)?.videoIndex ?? 0; } catch { return 0; }
}

async function probe(/** @type {string} */ file) {
  // Keyed by path + size + mtime: a replaced or re-encoded file is probed again.
  let key = file;
  try { const st = fs.statSync(file); key = `${file}|${st.size}|${st.mtimeMs}`; } catch { /* ffprobe below reports it */ }
  if (probeCache.has(key)) { const c = probeCache.get(key); return { ...c, subtitles: subtitleList(file, c.embedded) }; }
  let info;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 8 << 20 });
    info = JSON.parse(stdout);
  } catch (e) {
    // The details (command line, full path) stay in the log: this message reaches the UI, phones and party guests included.
    console.error("[stream] probe:", e instanceof Error ? e.message : e);
    throw new Error(/** @type {any} */ (e)?.code === "ENOENT"
      ? "FFmpeg wasn't found on the PC, so this video can't be read."
      : "This file can't be read. It may be damaged or still downloading.");
  }
  const v = info.streams.find((/** @type {any} */ s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = info.streams.find((/** @type {any} */ s) => s.codec_type === "audio");
  // ffmpeg's `-map 0:v:N` counts ALL video streams, cover art included.
  const videoIndex = Math.max(0, info.streams.filter((/** @type {any} */ s) => s.codec_type === "video").indexOf(v));
  const result = {
    videoIndex,
    duration: Number(info.format?.duration) || 0,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    video: v ? `${v.codec_name}${v.pix_fmt?.includes("10") ? " 10-bit" : ""}` : null,
    audio: a ? `${a.codec_name}${a.channels ? ` ${a.channels}ch` : ""}` : null,
    // HDR (PQ / HLG): the page stream is plain SDR, so colours look washed out; mpv tone-maps it properly.
    hdr: !!v && /^(smpte2084|arib-std-b67)$/.test(v.color_transfer ?? ""),
    copyVideo: !!v && v.codec_name === "h264" && /^(yuv420p|yuvj420p)$/.test(v.pix_fmt ?? ""),
    copyAudio: !!a && a.codec_name === "aac",
    hasAudio: !!a,
    audioTracks: info.streams.filter((/** @type {any} */ s) => s.codec_type === "audio").map((/** @type {any} */ s, /** @type {number} */ i) => ({
      index: i,
      language: s.tags?.language && s.tags.language !== "und" ? String(s.tags.language).toLowerCase() : null,
      title: s.tags?.title ? String(s.tags.title) : null,
      codec: s.codec_name ?? "",
      channels: s.channels ?? 0,
    })),
    // RFC 6381 codec string of the STREAM's video, for MediaSource (copied: the file's H.264; else our High@4.0).
    codecs: { video: v && v.codec_name === "h264" && /^(yuv420p|yuvj420p)$/.test(v.pix_fmt ?? "") ? avc1(v.profile, v.level) : "avc1.640028" },
    embedded: embeddedSubs(info.streams),
  };
  cacheSet(probeCache, key, result);
  return { ...result, subtitles: subtitleList(file, result.embedded) };
}

/**
 * Source time that output time 0 of `/api/stream?t=` corresponds to, for stream-copied files.
 * Stream copy can only start at a keyframe, and ffmpeg's seek may even land on an earlier one, so we
 * run the SAME seek and read the first timestamps. -avoid_negative_ts make_zero shifts the output so
 * the earliest dts becomes 0, so that earliest dts is the offset the player must add.
 */
const SEEKPOINT_TIMEOUT_MS = Number(process.env.CIROOM_TEST_SEEKPOINT_TIMEOUT_MS) || 8000; // tests may shorten it
/** @returns {Promise<{ start: number, exact: boolean }>} exact=false: the lookup timed out or found nothing, `start` is just the asked time. */
function streamOrigin(/** @type {string} */ file, /** @type {string} */ ss, /** @type {number} */ aud = 0, /** @type {number} */ vi = 0) {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "quiet", "-nostdin", "-ss", ss, "-i", file,
      "-map", `0:v:${vi}`, "-map", `0:a:${aud}?`, "-c", "copy", "-copyts", "-frames:v", "3", "-f", "nut", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const pr = spawn("ffprobe", ["-v", "quiet", "-show_entries", "packet=dts_time", "-of", "csv=p=0", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    ff.stdout.pipe(pr.stdin);
    pr.stdin.on("error", () => {});
    let out = "";
    pr.stdout.on("data", (d) => { out += d; });
    const fallback = Number(ss);
    const timer = setTimeout(() => { ff.kill("SIGKILL"); pr.kill("SIGKILL"); resolve({ start: fallback, exact: false }); }, SEEKPOINT_TIMEOUT_MS);
    pr.on("close", () => {
      clearTimeout(timer);
      const ts = out.split("\n").filter((l) => l.trim() && l.trim() !== "N/A").map(Number).filter(Number.isFinite);
      resolve(ts.length ? { start: Math.min(...ts), exact: true } : { start: fallback, exact: false });
    });
  });
}

// ── Hardware encoding (VA-API: Intel/AMD GPU, Linux only) ──────────────────────────────────────────
// A software x264 transcode of a 10-bit HEVC file needs ~5 cores; the GPU does it for ~5 % of one. Detected once with a
// 1-second test encode; CIROOM_NO_VAAPI=1 turns it off. If a VA-API encode fails before sending anything, VA-API is
// switched off for the rest of the session and that stream is redone with x264.
/** @type {Promise<string | null> | null} */ let vaapiDev = null;
let vaapiBroken = false;
async function detectVaapi() {
  if (process.platform === "win32" || process.env.CIROOM_NO_VAAPI === "1") return null;
  let devices = [];
  try { devices = process.env.CIROOM_VAAPI_DEVICE ? [process.env.CIROOM_VAAPI_DEVICE] : fs.readdirSync("/dev/dri").filter((n) => /^renderD\d+$/.test(n)).sort().map((n) => `/dev/dri/${n}`); } catch { return null; }
  for (const dev of devices) {
    try {
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-vaapi_device", dev, "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=1", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-rc_mode", "CQP", "-global_quality", "26", "-f", "null", "-"], { timeout: 10_000 });
      return dev;
    } catch { /* this device can't encode: try the next */ }
  }
  return null;
}
const vaapiDevice = () => (vaapiDev ??= detectVaapi().catch(() => null));
/** "vaapi" when transcodes run on the GPU, else "cpu". */
export async function encoderStatus() { return (await vaapiDevice()) && !vaapiBroken ? "vaapi" : "cpu"; }
// ── Pacing ────────────────────────────────────────────────────────────────────────────────────────
// WebKitGTK's fetch keeps downloading a response the page stopped reading (no back-pressure), so ffmpeg made the
// whole rest of a movie at full speed: one core at 100 % for minutes, and the window holding it all in memory.
// So after a head start (the player's 120 s look-ahead) ffmpeg reads only a little faster than the player plays
// (`speed` = its playback rate, sent by the page). Needs ffmpeg 6.1+ (-readrate_initial_burst): checked once.
// (0.2.6 also closed and reopened the stream every 2 minutes instead: the joins cut the sound in the installed app.)
const PACE_MARGIN = 1.25; // × the playback speed: enough to refill after a stall, little extra memory in the window
const PACE_BURST = 150; // seconds at full speed at the start of every stream (start, seek)
/** @type {Promise<boolean> | null} */ let paceOk = null;
const canPace = () => (paceOk ??= (async () => {
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-readrate", "1.25", "-readrate_initial_burst", "150", "-f", "lavfi", "-i", "anullsrc", "-t", "0.1", "-f", "null", "-"], { timeout: 10_000 });
    return true;
  } catch {
    console.warn("[stream] this ffmpeg can't pace its output (needs 6.1+); streams run at full speed");
    return false;
  }
})());
/** ffmpeg input options that pace a stream for a player at this speed ([] when this ffmpeg can't). */
async function pacing(/** @type {number} */ speed) {
  const s = Math.min(2, Math.max(1, Number.isFinite(speed) ? speed : 1));
  return (await canPace()) ? ["-readrate", (PACE_MARGIN * s).toFixed(2), "-readrate_initial_burst", String(PACE_BURST)] : [];
}

/** Source codecs the GPU can decode too (others are decoded in software, then uploaded). */
const VAAPI_DECODE = new Set(["h264", "hevc", "vp9", "mpeg2video", "vc1"]);

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
/** @type {Set<string>} */ const memOnly = new Set(); // gains that are not worth saving (no audio / measurement failed)
/** Cache key per audio track. Track 0 keeps the old key (no suffix), so gains measured before tracks were told apart still count. */
const gainKey = (/** @type {string} */ file, /** @type {number} */ audio = 0) => `${file}|${fs.statSync(file).size}${audio > 0 ? `|a${audio}` : ""}`;
/** The known gain for a file's audio track, or undefined if it hasn't been measured yet. Instant: never measures. */
export function cachedGain(/** @type {string} */ file, /** @type {number} */ audio = 0) {
  try { return loudCache.get(gainKey(file, audio)); } catch { return undefined; }
}
/** @type {Map<string, Promise<number>>} */ const gainInFlight = new Map();
/** Measure (once at a time per file: concurrent callers share one run), cache and return the gain. Low priority. */
export function measureGain(/** @type {string} */ file, /** @type {number} */ audio = 0) {
  const key = gainKey(file, audio);
  const known = loudCache.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let p = gainInFlight.get(key);
  if (!p) {
    p = doMeasure(file, key, audio).finally(() => gainInFlight.delete(key));
    gainInFlight.set(key, p);
  }
  return p;
}
/** Start a measurement without waiting for it (errors are swallowed; the next request just asks again). */
export function measureGainInBackground(/** @type {string} */ file, /** @type {number} */ audio = 0) {
  try { measureGain(file, audio).catch(() => {}); } catch { /* file vanished */ }
}
async function doMeasure(/** @type {string} */ file, /** @type {string} */ key, /** @type {number} */ audio = 0) {
  const info = await probe(file);
  if (!info.hasAudio || !info.duration) { memOnly.add(key); loudCache.set(key, 0); return 0; } // nothing to level (kept in memory only)
  const points = [0.15, 0.35, 0.55, 0.75].map((f) => Math.max(0, info.duration * f));
  /** @type {number[]} */ const lufs = [];
  for (const t of points) {
    try {
      const ffArgs = ["-nostdin", "-hide_banner", "-ss", t.toFixed(1), "-t", "30", "-i", file, "-map", `0:a:${audio}`, "-vn", "-sn", "-af", "ebur128", "-f", "null", "-"];
      const opts = { maxBuffer: 64 << 20, timeout: 60_000 };
      const { stderr } = process.platform === "win32" ? await run("ffmpeg", ffArgs, opts) : await run("nice", ["-n", "10", "ffmpeg", ...ffArgs], opts);
      const m = String(stderr).split("Summary:").pop()?.match(/I:\s+(-?[\d.]+)\s+LUFS/);
      if (m && Number(m[1]) > -70) lufs.push(Number(m[1]));
    } catch { /* sample failed: use the others */ }
  }
  if (!lufs.length) { memOnly.add(key); loudCache.set(key, 0); return 0; } // memory only: a later restart tries again
  const loudness = 10 * Math.log10(lufs.reduce((a, l) => a + 10 ** (l / 10), 0) / lufs.length); // energy average
  const gain = Math.round(Math.max(-8, Math.min(26, LEVEL_TARGET - loudness)) * 10) / 10;
  loudCache.set(key, gain);
  try { writeJsonAtomic(LOUD_FILE, Object.fromEntries([...loudCache].filter(([k]) => !memOnly.has(k)))); } catch { /* cache only */ }
  return gain;
}
/** Which audio track mpv will pick for these language codes (first match in order, like --alang): index among the file's audio streams, 0 if none matches. */
export async function audioTrackFor(/** @type {string} */ file, /** @type {string[]} */ langs) {
  try {
    const tracks = /** @type {{ index: number, language: string | null }[]} */ ((await probe(file)).audioTracks ?? []);
    for (const l of langs.map((x) => x.toLowerCase())) {
      const hit = tracks.find((t) => t.language && (t.language === l || t.language.startsWith(l) || l.startsWith(t.language)));
      if (hit) return hit.index;
    }
  } catch { /* unreadable: the first track */ }
  return 0;
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
  if (dirty) { writeJsonAtomic(FACTS_FILE, disk); }
  return out;
}

/** @param {(expected: string) => string} resolveVideo */
export function streamRoutes(resolveVideo) {
  /** Serves the five media routes for the request's own URL. This PC reaches them through the table below; a phone or a party guest through their own filtered routes, which rewrite `req.url` first. */
  const serve = async (/** @type {any} */ req, /** @type {any} */ res, /** @type {(c:number,d:unknown)=>void} */ json) => {
    {
      const u = new URL(req.url, "http://localhost");
      if (!["/api/probe", "/api/stream", "/api/seekpoint", "/api/subtitle.vtt", "/api/thumb"].includes(u.pathname)) return false;
      const file = resolveVideo(String(u.searchParams.get("path") ?? ""));

      if (u.pathname === "/api/probe") {
        const info = await probe(file);
        const track = audioIndex(info, u, "audio"); // `?audio=N`: the gain of that track (default: the first)
        const levelGainDb = cachedGain(file, track);
        if (levelGainDb === undefined) measureGainInBackground(file, track); // answer now; the number shows up on the next probe
        json(200, { ...info, levelGainDb });
        return true;
      }

      // Where a stream requested at t REALLY starts (source time of output 0). Stream copy can only cut at a
      // keyframe (gaps of 10 s+ in this library), so the player uses this as its offset, then skips ahead.
      // Transcoded streams decode from the keyframe and drop frames up to t, so they start at t exactly.
      if (u.pathname === "/api/seekpoint") {
        const info = await probe(file);
        const t = Math.max(0, Number(u.searchParams.get("t")) || 0);
        if (!info.copyVideo || wantsLow(u)) { json(200, { start: t, mode: "transcode" }); return true; } // re-encoded: starts exactly at t
        if (t <= 0) { json(200, { start: 0, mode: "copy" }); return true; }
        // A copy can only cut at a keyframe. If the lookup fails or times out we don't know where it would cut,
        // so this seek is streamed in exact (re-encoded) mode instead of guessing: /api/stream?mode=transcode.
        const o = await streamOrigin(file, t.toFixed(3), audioIndex(info, u), info.videoIndex ?? 0);
        json(200, o.exact ? { start: o.start, mode: "copy" } : { start: t, mode: "transcode" });
        return true;
      }

      if (u.pathname === "/api/stream") {
        const info = await probe(file);
        const t = Math.max(0, Number(u.searchParams.get("t")) || 0);
        const low = wantsLow(u);
        const exact = u.searchParams.get("mode") === "transcode"; // the player's keyframe lookup failed: re-encode this stream so it starts exactly at t
        const copying = !low && info.copyVideo && !exact;
        // low data is always x264: it must respect the ~1 Mbps cap (-maxrate), and the iHD driver here only offers CQP
        const vdev = copying || low || vaapiBroken ? null : await vaapiDevice();
        const pace = await pacing(Number(u.searchParams.get("speed")) || 1);
        /** Everything up to the audio options. useVa: encode on the GPU (h264_vaapi, constant quality: same GOP, profile and level as x264). */
        const buildArgs = (/** @type {boolean} */ useVa) => {
          const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
          if (useVa && vdev) args.push("-vaapi_device", vdev, ...(VAAPI_DECODE.has(String(info.video)) ? ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"] : []));
          if (t > 0) args.push("-ss", t.toFixed(3)); // same string /api/seekpoint measured
          args.push(...pace, "-i", file, "-map", `0:v:${info.videoIndex ?? 0}`, "-map", `0:a:${audioIndex(info, u)}?`, "-sn", "-dn", "-map_chapters", "-1");
          const h = low ? 480 : 720;
          if (copying) args.push("-c:v", "copy");
          else if (useVa && vdev) {
            const scale = `scale_vaapi=w=-2:h='min(${h},ih)':format=nv12`; // h is 720 here (low never gets this far)
            args.push("-vf", VAAPI_DECODE.has(String(info.video)) ? scale : `format=nv12,hwupload,${scale}`,
              "-c:v", "h264_vaapi", "-rc_mode", "CQP", "-global_quality", "26", "-profile:v", "high", "-level", "40", "-g", "48");
          }
          else if (low) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-maxrate", "900k", "-bufsize", "1800k", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "3.1", "-vf", "scale=-2:'min(480,ih)'", "-g", "48");
          else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.0", "-vf", "scale=-2:'min(720,ih)'", "-g", "48");
          return args;
        };
        const wantLevel = u.searchParams.get("level") !== "0";
        const track = audioIndex(info, u); // the gain belongs to the track that is playing
        const known = wantLevel ? cachedGain(file, track) : undefined;
        if (wantLevel && known === undefined) measureGainInBackground(file, track); // this stream starts unlevelled; the next load has the gain
        const level = known !== undefined ? levelFilter(known) : null;
        // Audio is ALWAYS re-encoded (levelling only adds the gain filter). Copying the source audio untouched makes
        // WebKitGTK's MediaSource freeze the whole page (99% CPU, 2+ GB, never recovers) on large files, e.g. movies;
        // re-encoded audio is solid. 192k AAC stereo is transparent for this library (all stereo AAC/Opus).
        const tail = [...(info.hasAudio ? [...(level ? ["-af", level] : []), "-c:a", "aac", "-b:a", low ? "96k" : "192k", "-ac", "2"] : []),
          "-avoid_negative_ts", "make_zero", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"];
        res.statusCode = 200;
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Cache-Control", "no-store");
        if (known !== undefined) res.setHeader("X-Level-Gain", String(known)); // dB applied to the playing track (tests, debugging)
        res.setHeader("X-Stream-Mode", `${info.copyVideo && !low && !exact ? "copy" : low ? "low" : "transcode"}/aac${level ? " levelled" : wantLevel && known === undefined ? " unlevelled-pending" : ""}`);
        /** @param {boolean} useVa */
        const launch = (useVa) => {
          res.setHeader("X-Encoder", copying ? "copy" : useVa && vdev ? "vaapi" : "x264");
          const ff = spawn("ffmpeg", [...buildArgs(useVa), ...tail], { stdio: ["ignore", "pipe", "pipe"] });
          let err = "", sent = 0;
          ff.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
          ff.stdout.on("data", (c) => { sent += c.length; });
          ff.stdout.pipe(res, { end: false });
          ff.on("close", (code, signal) => {
            if (useVa && vdev && code && !signal && !sent && !res.destroyed) {
              // The GPU encode failed before sending anything: don't use it again this session, redo this stream with x264.
              if (!vaapiBroken) console.warn("[stream] VA-API encode failed, using x264 from now on:", err.trim().split("\n").pop());
              vaapiBroken = true;
              cur = launch(false);
              return;
            }
            if (code && code !== 255 && err) console.error("[stream] ffmpeg:", err.trim());
            if (!res.writableEnded) res.end();
          });
          return ff;
        };
        let cur = launch(!!vdev);
        const stop = () => { if (cur.exitCode === null && cur.signalCode === null) cur.kill("SIGKILL"); };
        req.on("close", stop);
        res.on("close", stop);
        return true;
      }

      if (u.pathname === "/api/subtitle.vtt" && u.searchParams.has("e")) {
        // A subtitle built into the video: extract that stream (cached by path+size+mtime+stream).
        const n = Math.floor(Number(u.searchParams.get("e")));
        try {
          const st = fs.statSync(file);
          const ok = Number.isInteger(n) && n >= 0 && (await probe(file)).embedded.some((/** @type {any} */ s) => s.stream === n);
          if (!ok) { json(404, { error: "No such built-in subtitle" }); return true; }
          const key = `${file}|${st.size}|${st.mtimeMs}|e${n}`;
          let vtt = vttCache.get(key);
          if (!vtt) {
            const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-map", `0:s:${n}`, "-f", "webvtt", "pipe:1"], { maxBuffer: 32 << 20, timeout: 120_000 });
            vtt = stdout;
            cacheSet(vttCache, key, vtt);
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/vtt; charset=utf-8");
          res.end(vtt);
        } catch (e) {
          console.error("[stream] embedded subtitle:", e instanceof Error ? e.message : e);
          json(422, { error: "This subtitle couldn't be read" });
        }
        return true;
      }

      if (u.pathname === "/api/subtitle.vtt") {
        const subs = subtitlesFor(file).filter((f) => TEXT_SUB.test(f));
        const sub = subs[Number(u.searchParams.get("i")) || 0];
        if (!sub) { json(404, { error: "No text subtitles for this video" }); return true; }
        let vtt;
        try {
          const st = fs.statSync(sub);
          const key = `${sub}|${st.size}|${st.mtimeMs}`;
          vtt = vttCache.get(key);
          if (!vtt) {
            // Decode to UTF-8 first (Windows-1256 Persian, UTF-16…): ffmpeg assumes UTF-8. The original is never touched.
            const text = decodeSubtitle(fs.readFileSync(sub), SUB_CODE[subtitleLanguage(sub) ?? ""] ?? "").replace(/^\uFEFF/, "");
            const dir = path.join(CACHE_DIR, "subs-utf8");
            fs.mkdirSync(dir, { recursive: true });
            const copy = path.join(dir, `${createHash("sha1").update(key).digest("hex")}${path.extname(sub).toLowerCase()}`);
            fs.writeFileSync(copy, text);
            const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", copy, "-f", "webvtt", "pipe:1"], { maxBuffer: 32 << 20 });
            vtt = stdout;
            cacheSet(vttCache, key, vtt);
          }
        } catch (e) {
          console.error("[stream] subtitle:", e instanceof Error ? e.message : e);
          json(422, { error: "This subtitle couldn't be read" });
          return true;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        res.end(vtt);
        return true;
      }

      if (u.pathname === "/api/thumb") {
        const t = Math.max(0, Math.round(Number(u.searchParams.get("t")) || 0));
        // The player probes before it asks for thumbnails; if it didn't, 0 is right unless cover art comes first (no extra ffprobe per hover).
        const vi = cachedVideoIndex(file);
        const jpg = await thumbnail(file, t, () => req.destroyed || res.destroyed || res.writableEnded, vi);
        if (!jpg) { json(503, { error: "thumbnail queue full" }); return true; }
        if (!jpg.length) { json(504, { error: "thumbnail failed" }); return true; }
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.end(jpg);
        return true;
      }
      return false;
    }
  };
  return {
    serve,
    routes: defineRoutes("stream", [
      { method: "POST", path: "/api/files/facts", audience: "pc", handler: async ({ req, json, body }) => {
        const { paths } = await body(req);
        json(200, await filesFacts(Array.isArray(paths) ? paths.map(String) : [], resolveVideo));
      } },
      ...["/api/probe", "/api/stream", "/api/seekpoint", "/api/subtitle.vtt", "/api/thumb"].map((path) =>
        ({ method: "GET", path, audience: "pc", handler: (/** @type {import("./routes.js").Ctx} */ c) => serve(c.req, c.res, c.json) })),
    ]),
  };
}
