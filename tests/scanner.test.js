import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFolder } from "../dev/scanner.js";

const cases = [
  ["Test 2020", "Test", 2020],
  ["Inception 2010", "Inception", 2010],
  ["Inception (2010) [1080p]", "Inception", 2010],
  ["Movie.Name.2010.1080p.BluRay.x264-GRP", "Movie Name", 2010],
  ["Nested.2019.1080p", "Nested", 2019],
  ["Movie Name (2010) 1080p BluRay YIFY", "Movie Name", 2010],
  ["Some.Film.1080p.WEB-DL.x265-GRP", "Some Film", undefined],
  ["11.22.63 2016", "11.22.63", 2016],
  ["11.22.63", "11.22.63", undefined],
  ["2012 2009", "2012", 2009],
  ["Rick & Morty", "Rick & Morty", undefined],
  ["HIMYM", "How I Met Your Mother", undefined],
  ["HOTDG", "House of the Dragon", undefined],
  ["A knight of the seven kingdoms", "A Knight of the Seven Kingdoms", undefined],
  ["Better Call Saul", "Better Call Saul", undefined],
  ["Dahmer – Monster The Jeffrey Dahmer Story 2022", "Dahmer – Monster The Jeffrey Dahmer Story", 2022],
  ["Shameless (US)", "Shameless (US)", undefined],
  ["Lord of the Rings: Fellowship of the Rings 2001", "Lord of the Rings: Fellowship of the Rings", 2001],
  ["Harry Potter 2001", "Harry Potter", 2001],
];
for (const [input, title, year] of cases)
  test(`parseFolder ${input}`, () => assert.deepEqual(parseFolder(input), { title, year }));
