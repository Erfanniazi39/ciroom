// Skip-intro queue (C1): a season whose episode file is missing must not be picked again and again.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, request } from "./helpers.js";

test("missing episode files: no endless queue, no log spam, status counts only real files", async () => {
  const rel = (n) => `Series/Show/Season ${n}/`;
  const p = (s, e) => `${rel(s)}Show S0${s}E0${e}.mkv`;
  // S1: two episodes, S2: one episode. Create the files, build the library, then delete one of each.
  const s = await startServer({ files: [p(1, 1), p(1, 2), p(2, 1)] });
  try {
    const abs = (r) => path.join(s.media, r);
    const ep = (id, r) => ({ id, file: { path: abs(r) } });
    fs.writeFileSync(path.join(s.data, "library.json"), JSON.stringify({ movies: [], collections: [], series: [{ id: "show", title: "Show", seasons: [
      { number: 1, episodes: [ep("e11", p(1, 1)), ep("e12", p(1, 2))] },
      { number: 2, episodes: [ep("e21", p(2, 1))] },
    ] }] }));
    fs.rmSync(abs(p(1, 2))); fs.rmSync(abs(p(2, 1)));

    const st = await request({ port: s.port, path: "/api/markers/status" });
    assert.equal(st.status, 200);
    assert.equal(st.json.total, 1); // only Show S01E01 still exists

    // Asking for the remaining file: its season has one file now, so there is nothing to compare with.
    const m = await request({ port: s.port, path: "/api/markers?path=" + encodeURIComponent(abs(p(1, 1))) });
    assert.equal(m.json.status, "none");

    await new Promise((r) => setTimeout(r, 3500));
    const lines = s.log().split("\n").filter((l) => /skip intro/.test(l));
    assert.ok(lines.length <= 1, "log spam: " + lines.join(" | "));
    const again = await request({ port: s.port, path: "/api/markers/status" });
    assert.equal(again.json.running, null);
  } finally { s.stop(); }
});
