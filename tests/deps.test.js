import test from "node:test";
import assert from "node:assert/strict";
import { checkTools, TOOLS } from "../server/lib/deps.js";

test("checkTools reports every tool with ok/help consistent", async () => {
  const r = await checkTools(true);
  assert.deepEqual(r.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of r) assert.equal(t.ok, t.help === null);
});

test("a missing tool is reported with install help", async () => {
  const old = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const r = await checkTools(true);
    assert.ok(r.every((t) => !t.ok && t.help));
  } finally { process.env.PATH = old; await checkTools(true); }
});
