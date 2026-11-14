// Subtitle helpers: encodings, language detection by name and by content, SRT repair, bracketed zip names (see zip.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subs-"));
process.env.CIROOM_DATA_DIR = path.join(scratch, "data");
process.env.CIROOM_CACHE_DIR = path.join(scratch, "cache");
const { decodeSubtitle } = await import("../dev/subtitle-search.js");
const { languageOf, subtitleLanguage, subtitlesFor } = await import("../dev/subtitles.js");

// Windows-1256 has the Arabic yeh (ي), not the Persian one (ی), so real old files use ي.
const fa = "سلام، چطوري؟ من پارسي صحبت ميکنم و گوشي را برداشتم.";
const hasIconv = (() => { try { execFileSync("iconv", ["-l"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("decodeSubtitle: UTF-8, UTF-8 BOM, UTF-16 LE/BE", () => {
  assert.equal(decodeSubtitle(Buffer.from(fa), "FA"), fa);
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fa)]), ""), fa);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fa, "utf16le")]);
  assert.equal(decodeSubtitle(le, ""), fa);
  const be = Buffer.from(le); be.swap16(); // BOM becomes fe ff, text big-endian
  assert.equal(decodeSubtitle(be, ""), fa);
});

test("decodeSubtitle: Windows-1256 Persian", { skip: !hasIconv }, () => {
  const buf = execFileSync("iconv", ["-f", "utf-8", "-t", "cp1256"], { input: fa });
  assert.equal(decodeSubtitle(buf, "FA"), fa);
});

test("decodeSubtitle: legacy Latin falls back to Windows-1252", () => {
  assert.equal(decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9]), ""), "café");
});

test("languageOf: names; .hi means hearing-impaired, not Hindi", () => {
  assert.equal(languageOf("Show.S01E01.en.srt"), "English");
  assert.equal(languageOf("Show.S01E01.fa.srt"), "Persian");
  assert.equal(languageOf("Show.Persian.srt"), "Persian");
  assert.equal(languageOf("Show.fr.srt"), "French");
  assert.equal(languageOf("Show.S01E01.hi.srt"), null);
  assert.equal(languageOf("Show.S01E01.hin.srt"), "Hindi");
  assert.equal(languageOf("Show.S01E01.hin.2.srt"), "Hindi");
  assert.equal(languageOf("Show.srt"), null);
});

test("subtitleLanguage: Persian and English by content, even in Windows-1256", { skip: !hasIconv }, () => {
  const long = (fa + "\n").repeat(12);
  const cues = (t) => t.split("\n").filter(Boolean).map((l, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},900\n${l}\n`).join("\n");
  const p = path.join(scratch, "a.srt");
  fs.writeFileSync(p, execFileSync("iconv", ["-f", "utf-8", "-t", "cp1256"], { input: cues(long) }));
  assert.equal(subtitleLanguage(p), "Persian");
  const e = path.join(scratch, "b.srt");
  fs.writeFileSync(e, cues("I think you are the one and that is what this is\nWhat do you want me to do with it, we can't be in this\n".repeat(8)));
  assert.equal(subtitleLanguage(e), "English");
});

test("subtitlesFor: a malformed SRT is repaired into a cached copy, the original is untouched", () => {
  const dir = path.join(scratch, "Movies", "Film 2020"); fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, "Film 2020.mkv"); fs.writeFileSync(video, "x");
  const bad = "garbage line\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:04.000\nWorld\n";
  const sub = path.join(dir, "Film 2020.en.srt"); fs.writeFileSync(sub, bad);
  const out = subtitlesFor(video);
  assert.equal(out.length, 1);
  assert.notEqual(out[0], sub);
  assert.match(fs.readFileSync(out[0], "utf8"), /^1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n$/);
  assert.equal(fs.readFileSync(sub, "utf8"), bad);
});

test("subtitlesFor: a well-formed SRT is used as it is", () => {
  const dir = path.join(scratch, "Movies", "Ok 2021"); fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, "Ok 2021.mkv"); fs.writeFileSync(video, "x");
  const sub = path.join(dir, "Ok 2021.en.srt"); fs.writeFileSync(sub, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");
  assert.deepEqual(subtitlesFor(video), [sub]);
});

test("subtitlesFor: a flat season folder gives each episode only its own subtitles", () => {
  const dir = path.join(scratch, "Series", "Flat", "Season 1"); fs.mkdirSync(path.join(dir, "Subs"), { recursive: true });
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
  for (const n of ["Show.S01E01.mkv", "Show.S01E02.mkv", "Lonely.mkv"]) fs.writeFileSync(path.join(dir, n), "x");
  const files = ["Show.S01E01.en.srt", "Show.S01E02.en.srt", "Show.S01E02.fa.srt", "Subs/show 1x01.fa.srt", "Lonely.en.srt", "other.srt"];
  for (const n of files) fs.writeFileSync(path.join(dir, n), srt);
  const names = (/** @type {string} */ v) => subtitlesFor(path.join(dir, v)).map((p) => path.relative(dir, p)).sort();
  assert.deepEqual(names("Show.S01E01.mkv"), ["Show.S01E01.en.srt", "Subs/show 1x01.fa.srt"]);
  assert.deepEqual(names("Show.S01E02.mkv"), ["Show.S01E02.en.srt", "Show.S01E02.fa.srt"]);
  assert.deepEqual(names("Lonely.mkv"), ["Lonely.en.srt"]); // matched by name
  // no match at all: fall back to every subtitle
  fs.writeFileSync(path.join(dir, "Show.S01E03.mkv"), "x");
  assert.equal(names("Show.S01E03.mkv").length, files.length);
});
