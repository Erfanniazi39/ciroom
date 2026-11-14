import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../dev/fsutil.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-fsutil-"));

test("writes, reads back, leaves no .tmp file, creates folders", () => {
  const f = path.join(dir, "a", "b", "data.json");
  writeJsonAtomic(f, { x: 1 }, { space: 2 });
  writeJsonAtomic(f, { x: 2, list: [1, 2] });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { x: 2, list: [1, 2] });
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["data.json"]);
});

test("mode 0600 is kept, also when replacing an existing file", { skip: process.platform === "win32" }, () => {
  const f = path.join(dir, "secret.json");
  writeJsonAtomic(f, { k: 1 }, { mode: 0o600 });
  writeJsonAtomic(f, { k: 2 }, { mode: 0o600 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("a failed write keeps the old file and leaves no .tmp", () => {
  const f = path.join(dir, "keep.json");
  writeJsonAtomic(f, { good: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeJsonAtomic(f, circular));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { good: true });
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);
});
