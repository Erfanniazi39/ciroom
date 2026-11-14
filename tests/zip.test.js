import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listZip, readZipEntry } from "../server/lib/zip.js";

const hasZip = (() => { try { execFileSync("zip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("reads stored and deflated entries, bracketed names", { skip: !hasZip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zt-"));
  const a = "1\n00:00:01,000 --> 00:00:02,000\nسلام hello\n\n".repeat(50);
  const b = Buffer.from([0, 1, 2, 3, 255]);
  fs.writeFileSync(path.join(d, "Show [Group].srt"), a);
  fs.writeFileSync(path.join(d, "raw.bin"), b);
  execFileSync("zip", ["-q", "-9", "z.zip", "Show [Group].srt"], { cwd: d });
  execFileSync("zip", ["-q", "-0", "z.zip", "raw.bin"], { cwd: d });
  const zip = fs.readFileSync(path.join(d, "z.zip"));
  const es = listZip(zip);
  const e1 = es.find((e) => e.name === "Show [Group].srt");
  const e2 = es.find((e) => e.name === "raw.bin");
  assert.equal(e1.method, 8); assert.equal(e2.method, 0);
  assert.equal(readZipEntry(zip, e1).toString(), a);
  assert.deepEqual(readZipEntry(zip, e2), b);
  fs.rmSync(d, { recursive: true });
});

test("data-descriptor zip (streamed) and garbage", { skip: !hasZip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zt-"));
  fs.writeFileSync(path.join(d, "a.srt"), "hello world ".repeat(100));
  const zip = execFileSync("sh", ["-c", "cat a.srt | zip -q - -"], { cwd: d, maxBuffer: 1 << 20 });
  const es = listZip(zip);
  assert.equal(readZipEntry(zip, es[0]).toString(), "hello world ".repeat(100));
  assert.throws(() => listZip(Buffer.from("not a zip at all, definitely not")));
  fs.rmSync(d, { recursive: true });
});
