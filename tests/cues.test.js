import { test } from "node:test";
import assert from "node:assert/strict";
import { activeCueText, parseVtt } from "../src/api/stream.ts";

const cues = [
  { start: 1, end: 4, text: "Hello" },
  { start: 2, end: 3, text: "- Who's there?" },
  { start: 3, end: 6, text: "SIGN: Exit" },
  { start: 8, end: 9, text: "Later" },
];
test("activeCueText: overlapping cues are all shown, in start order", () => {
  assert.equal(activeCueText(cues, 2.5), "Hello\n- Who's there?");
  assert.equal(activeCueText(cues, 3.5), "Hello\nSIGN: Exit");
  assert.equal(activeCueText(cues, 1.5), "Hello");
});
test("activeCueText: adjacent cues don't both show at the boundary, gaps and ends are empty", () => {
  assert.equal(activeCueText(cues, 3), "Hello\nSIGN: Exit"); // 2nd ended at 3 (exclusive), 3rd starts at 3
  assert.equal(activeCueText(cues, 0.5), "");
  assert.equal(activeCueText(cues, 7), "");
  assert.equal(activeCueText(cues, 9), "");
  assert.equal(activeCueText([], 1), "");
});
test("overlap survives parseVtt", () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nA line\n\n00:00:02.000 --> 00:00:03.000\nB line\n";
  assert.equal(activeCueText(parseVtt(vtt), 2.5), "A line\nB line");
});
