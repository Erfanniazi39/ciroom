// Synthetic test media for the functional and end-to-end tests. Everything is generated with ffmpeg (lavfi test
// sources: colour bars + sine tones), so no real film or third-party file is ever used. See tests/fixtures/README.md.
//
//   const clips = await buildClips();            // generated once per FIXTURE_VERSION into the OS temp folder
//   const lib = makeLibrary(dir, LAYOUT_FULL);    // a library folder tree of hard links (copies if links fail)
//
// The clip cache is shared between runs (generation takes ~10 s); each test gets its own library tree, so a test
// can add, rename and delete folders without touching another test or the cache.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_VERSION = 5; // 5: built in a private folder, then moved into place (v4 caches could be corrupt)
const CACHE = path.join(os.tmpdir(), `ciroom-fixture-clips-v${FIXTURE_VERSION}`);

export const hasTool = (/** @type {string} */ t) => { try { execFileSync(t, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } };
export const HAS_FFMPEG = hasTool("ffmpeg") && hasTool("ffprobe");
export const HAS_MPV = (() => { try { execFileSync("mpv", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
export const HAS_ICONV = (() => { try { execFileSync("iconv", ["-l"], { stdio: "ignore" }); return true; } catch { return false; } })();

// Persian test text. Windows-1256 has the Arabic yeh/kaf (ي ك), not the Persian ones, so the cp1256 file uses those.
const FA_LINES = ["سلام، چطوري؟", "من پارسي صحبت ميکنم.", "گوشي را برداشتم و رفتم.", "اين يک زيرنويس آزمايشي است.", "فردا دوباره مي‌بينمت."];
const EN_LINES = ["Hello, how are you?", "I think that is what you want.", "We can't be in this place.", "What do you want me to do with it?", "See you tomorrow, then."];
const ts = (/** @type {number} */ s) => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(x)).padStart(2, "0")},${String(Math.round((x % 1) * 1000)).padStart(3, "0")}`; };
/** An SRT with `n` cues every 4 s (cue k says the line plus "#k", so a test can tell which cue shows). */
export const srt = (/** @type {string[]} */ lines, n = 40, start = 1) =>
  Array.from({ length: n }, (_, k) => `${k + 1}\n${ts(start + k * 4)} --> ${ts(start + k * 4 + 3)}\n${lines[k % lines.length]} #${k + 1}\n`).join("\n");

/** ffmpeg, quiet, throws with its stderr on failure. */
function ff(/** @type {string[]} */ args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

const V = (/** @type {number} */ d, size = "160x90", rate = 10) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${d}`];
const A = (/** @type {number} */ d, f = 440) => ["-f", "lavfi", "-i", `sine=frequency=${f}:sample_rate=48000:duration=${d}`];
const X264 = (/** @type {number} */ gop) => ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "38", "-pix_fmt", "yuv420p", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0"];

/**
 * Builds (once) and returns the paths of every clip. Clip names say what they are.
 * @returns {Promise<Record<string,string>>}
 */
export async function buildClips() {
  const done = path.join(CACHE, ".done");
  const names = ["long.mkv", "long.mp4", "short.mkv", "short20.mkv", "short30.mkv", "ep60.mkv", "ep61.mkv", "ep62.mkv", "ep63.mkv", "ep64.mkv", "ep65.mkv", "ep66.mkv", "ep67.mkv",
    "hevc10.mkv", "noaudio.mkv", "ac3_51.mkv", "broken.mkv", "en.srt", "fa-utf8.srt", "fa-utf16.srt", "fa-cp1256.srt", "broken.srt", "styled.ass"];
  const out = Object.fromEntries(names.map((n) => [n, path.join(CACHE, n)]));
  if (fs.existsSync(done)) return out;
  if (!HAS_FFMPEG) throw new Error("ffmpeg/ffprobe are needed to build the test media");
  // Test files run in parallel processes and all call this. Each builds in its own folder and moves it into place in
  // one step, so two builds never write the same file (that made corrupt clips and random failures on a fresh cache).
  const build = `${CACHE}.build-${process.pid}-${Date.now()}`;
  fs.mkdirSync(build, { recursive: true });
  const tmp = (/** @type {string} */ n) => path.join(build, n);
  fs.writeFileSync(tmp("en.srt"), srt(EN_LINES, 140));
  fs.writeFileSync(tmp("fa-utf8.srt"), srt(FA_LINES, 140));
  fs.writeFileSync(tmp("fa-utf16.srt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(srt(FA_LINES, 140), "utf16le")]));
  const cp = srt(FA_LINES.map((l) => l.replace(/ی/g, "ي").replace(/ک/g, "ك").replace(/‌/g, " ")), 140);
  fs.writeFileSync(tmp("fa-cp1256.srt"), HAS_ICONV ? execFileSync("iconv", ["-f", "utf-8", "-t", "cp1256"], { input: cp }) : Buffer.from(cp));
  fs.writeFileSync(tmp("broken.srt"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x13]).toString("binary").repeat(64), "binary");
  fs.writeFileSync(tmp("styled.ass"), [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 640", "PlayResY: 360", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1", "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...Array.from({ length: 40 }, (_, k) => `Dialogue: 0,${ts(1 + k * 4).replace(",", ".").slice(1, -1)},${ts(4 + k * 4).replace(",", ".").slice(1, -1)},Default,,0,0,0,,{\\b1}Styled line #${k + 1}`),
  ].join("\n"));

  // The long movie: 10 min (subtitles end at 9:20, so they never make the file longer than its video), keyframe every 2 s, two audio tracks (eng 440 Hz, fre 1200 Hz), two built-in text subtitles.
  ff([...V(600), ...A(600, 440), ...A(600, 1200), "-i", tmp("en.srt"), "-i", tmp("fa-utf8.srt"),
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map", "4:s", ...X264(20), "-c:a", "aac", "-b:a", "48k", "-c:s", "srt",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fre", "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=per", tmp("long.mkv")]);
  ff([...V(600), ...A(600), ...X264(20), "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", tmp("long.mp4")]);
  ff([...V(12), ...A(12), ...X264(20), "-c:a", "aac", "-b:a", "48k", tmp("short.mkv")]);
  ff([...V(20), ...A(20), ...X264(20), "-c:a", "aac", "-b:a", "48k", tmp("short20.mkv")]);
  ff([...V(30), ...A(30), ...X264(20), "-c:a", "aac", "-b:a", "48k", tmp("short30.mkv")]);
  // Episodes: 60–67 s, so every episode file has its own size (renames are matched by name + size).
  for (let d = 60; d <= 67; d++) ff([...V(d), ...A(d, 300 + d), ...X264(20), "-c:a", "aac", "-b:a", "48k", tmp(`ep${d}.mkv`)]);
  ff([...V(10), ...A(10), "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error", "-c:a", "libopus", "-b:a", "48k", tmp("hevc10.mkv")]);
  ff([...V(10), ...X264(20), tmp("noaudio.mkv")]);
  ff([...V(10), "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=10", "-filter_complex", "[1:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a]", "-map", "0:v", "-map", "[a]", ...X264(20), "-c:a", "ac3", "-b:a", "192k", tmp("ac3_51.mkv")]);
  // A file with a video extension that is not a video (corrupted download).
  fs.writeFileSync(tmp("broken.mkv"), Buffer.alloc(256 * 1024, 0x5a));
  fs.writeFileSync(path.join(build, ".done"), new Date().toISOString());
  try { fs.renameSync(build, CACHE); } // atomic: CACHE appears complete or not at all
  catch (e) {
    fs.rmSync(build, { recursive: true, force: true });
    if (!fs.existsSync(done)) throw e; // not "another process was first": a real error
  }
  return out;
}

/**
 * Library layout: relative path → clip name (or null = empty folder, or { text } = a small file with that text).
 * @typedef {Record<string, string | null | { text: string }>} Layout
 */

/** The broad layout most functional tests start from. README.md says what every entry is for. */
export const LAYOUT_FULL = /** @type {Layout} */ ({
  // Movies
  "Movies/Alpha Movie 2001/Alpha.Movie.2001.720p.mkv": "long.mkv",
  "Movies/Alpha Movie 2001/Alpha.Movie.2001.en.srt": "en.srt",
  "Movies/Alpha Movie 2001/Alpha.Movie.2001.fa.srt": "fa-cp1256.srt",
  "Movies/Alpha Movie 2001/Alpha.Movie.2001.utf16.srt": "fa-utf16.srt",
  "Movies/Alpha Movie 2001/Alpha.Movie.2001.broken.srt": "broken.srt",
  "Movies/Alpha Movie 2001/Alpha.Movie.2001.styled.ass": "styled.ass",
  "Movies/Beta Film (2005) [1080p] BluRay x264/beta.film.mp4": "long.mp4",
  "Movies/Gamma Saga/Gamma One 2010/gamma1.mkv": "short20.mkv",
  "Movies/Gamma Saga/Gamma Two 2012/gamma2.mkv": "short30.mkv",
  "Movies/Wrapper Folder/Delta Movie 2015/delta.mkv": "short.mkv",
  "Movies/Epsilon 2018/Epsilon.2018.cd1.mkv": "short20.mkv",
  "Movies/Epsilon 2018/Epsilon.2018.cd2.mkv": "short30.mkv",
  "Movies/Zeta Twin 2019/zeta.mkv": "short30.mkv",
  "Movies/Zeta Twin 2019/zeta.copy.mkv": "short30.mkv",
  "Movies/درباره الی 2009/film.mkv": "short.mkv",
  "Movies/Name with 'quotes' & [brackets] 2020/odd #1 file.mkv": "short20.mkv",
  "Movies/HEVC Ten 2021/hevc.mkv": "hevc10.mkv",
  "Movies/Silent Film 1927/silent.mkv": "noaudio.mkv",
  "Movies/Surround 2022/surround.mkv": "ac3_51.mkv",
  "Movies/Broken Download 2023/broken.mkv": "broken.mkv",
  "Movies/Still Downloading 2024": null,
  "Movies/Extensionless 2024/movie": "short.mkv",
  "Movies/loose.video.2020.mkv": "short.mkv",
  // Series
  "Series/Show One/S01/EP01/show.one.e1.mkv": "ep60.mkv",
  "Series/Show One/S01/EP02/Show.One.S01E01.mkv": "ep61.mkv",
  "Series/Show One/S01/EP03": null,
  "Series/Show One/S02/Show.One.S02E01.mkv": "ep62.mkv",
  "Series/Show One/S02/Show.One.S02E03.mkv": "ep63.mkv",
  "Series/Show One/S02/Show.One.S02E01.en.srt": "en.srt",
  "Series/Show One/S02/Show.One.S02E03.fa.srt": "fa-utf8.srt",
  "Series/Show Two 2016/S01 E01/a.mkv": "ep64.mkv",
  "Series/Show Two 2016/S01 E02/b.mkv": "ep65.mkv",
  "Series/Flat Show/Flat.Show.S01E01.mkv": "ep66.mkv",
  "Series/Flat Show/Flat.Show.S01E02.mkv": "ep67.mkv",
  "Series/Flat Show/Flat.Show.S01E02.REPACK.small.mkv": "short.mkv",
  "Series/Flat Show/Flat.Show.1x03.mkv": "short20.mkv",
  "Series/Abs Show/Abs Show - 001.mkv": "short.mkv",
  "Series/Abs Show/Abs Show - 002.mkv": "short20.mkv",
  "Series/Abs Show/Abs Show - 003.mkv": "short30.mkv",
  "Series/Double Show/Double.Show.S01E01E02.mkv": "short20.mkv",
  "Series/Double Show/Double.Show.S01E03.mkv": "short30.mkv",
  "Series/Empty Series": null,
  "Series/Zip Show/S01/EP01/zip.show.mkv": "short.mkv",
  "Series/Zip Show/S01/EP01/subs.zip": { text: "PK not really a zip" },
});

/**
 * Creates the library tree under `dir` (dir/Movies, dir/Series always exist). Video files are hard links to the clip cache
 * (copies when the file system can't link), so the cache itself is never modified by a test.
 * @param {string} dir @param {Layout} layout @param {Record<string,string>} clips
 */
export function makeLibrary(dir, layout, clips) {
  for (const sub of ["Movies", "Series"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const [rel, src] of Object.entries(layout)) addEntry(dir, rel, src, clips);
  return dir;
}

/** Adds one entry (see Layout) to a library. @param {string} dir @param {string} rel @param {string | null | {text:string}} src @param {Record<string,string>} clips */
export function addEntry(dir, rel, src, clips) {
  const abs = path.join(dir, rel);
  if (src === null) { fs.mkdirSync(abs, { recursive: true }); return abs; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (typeof src === "object") { fs.writeFileSync(abs, src.text); return abs; }
  const from = clips[src];
  if (!from) throw new Error(`unknown clip ${src}`);
  if (/\.(srt|ass|vtt)$/.test(src)) { fs.copyFileSync(from, abs); return abs; } // subtitles: real copies (tests may decode/repair them)
  try { fs.linkSync(from, abs); } catch { fs.copyFileSync(from, abs); }
  return abs;
}
