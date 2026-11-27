// One TMDB matcher, one threshold (task 13): canned TMDB results, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, MATCH_MIN, similarity } from "../server/lib/match.js";

const R = (tmdbId, title, year) => ({ tmdbId, title, year });
const canned = (list) => async () => list;

test("exact title and year: matched, high score", async () => {
  const m = await bestMatch(canned([R(1, "Zombieland", 2009), R(2, "Zombieland: Double Tap", 2019)]), "movie", "Zombieland", 2009);
  assert.equal(m.matched, true);
  assert.equal(m.best.tmdbId, 1);
  assert.ok(m.score >= 0.95, String(m.score));
});

test("a sequel and its original: the year decides", async () => {
  const list = [R(10, "Bad Boys", 1995), R(11, "Bad Boys II", 2003), R(12, "Bad Boys for Life", 2020)];
  const m2003 = await bestMatch(canned(list), "movie", "Bad Boys", 2003);
  assert.equal(m2003.best.tmdbId, 11, "folder says 2003 → Bad Boys II");
  const m1995 = await bestMatch(canned(list), "movie", "Bad Boys", 1995);
  assert.equal(m1995.best.tmdbId, 10);
  const noYear = await bestMatch(canned(list), "movie", "Bad Boys");
  assert.equal(noYear.best.tmdbId, 10, "no year: the exact title wins");
});

test("wrong year: lower score, still the right film when nothing else is close", async () => {
  const m = await bestMatch(canned([R(5, "Heat", 1995)]), "movie", "Heat", 2005);
  assert.equal(m.matched, true); // title exact (0.75) + unknown-or-far year (0) = 0.75 ≥ 0.6
  assert.ok(m.score < 0.8);
});

test("junk title: not matched, nothing chosen, candidates listed", async () => {
  const m = await bestMatch(canned([R(1, "Completely Different Movie", 2001), R(2, "Another Film", 1999), R(3, "Third", 2010)]), "movie", "xq zzv 1080p", 2014);
  assert.equal(m.matched, false);
  assert.ok(m.reason.length > 5);
  assert.ok(m.candidates.length >= 1 && m.candidates.length <= 5);
});

test("a half-matching title below the threshold is refused, not guessed", async () => {
  // folder "Walking Man" vs TMDB "The Walking Dead": 2·1/(2+2) = 0.5 → 0.375 + unknown year 0.1 = 0.475
  const m = await bestMatch(canned([R(1, "The Walking Dead", 2010)]), "tv", "Walking Man", undefined);
  assert.equal(m.matched, false);
  assert.equal(m.best.tmdbId, 1);
  assert.ok(m.best.score < MATCH_MIN);
});

test("no results", async () => {
  const m = await bestMatch(canned([]), "tv", "Nothing", 2020);
  assert.deepEqual([m.matched, m.candidates.length], [false, 0]);
});

test("similarity basics", () => {
  assert.equal(similarity("The Office", "office"), 1);
  assert.ok(similarity("Bad Boys", "Bad Boys II") > 0.7 && similarity("Bad Boys", "Bad Boys II") < 1);
});

test("non-Latin titles: original title counts, Persian spelling variants match, empty never matches (D-07)", async () => {
  const m = await bestMatch(canned([{ ...R(7, "About Elly", 2009), originalTitle: "درباره الی" }]), "movie", "درباره الی", 2009);
  assert.equal(m.matched, true);
  assert.equal(similarity("\u064A\u0643", "\u06CC\u06A9"), 1, "Arabic yeh/kaf = Persian");
  assert.equal(similarity("می\u200Cشود", "میشود"), 1, "zero-width non-joiner");
  assert.equal(similarity("جـدایی", "جدایی"), 1, "tatweel");
  assert.equal(similarity("درباره الی", "جدایی نادر از سیمین"), 0);
  assert.equal(similarity("...", "!!!"), 0);
  assert.equal(similarity("Amélie", "Amelie"), 1);
});
