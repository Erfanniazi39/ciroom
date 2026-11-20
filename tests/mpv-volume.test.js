// A saved volume of 0 must start mpv at 0, not at 100 (it used to go through `Number(v) || 100`). Fake mpv records its args.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, postJson } from "./helpers.js";

const waitFor = async (fn) => { for (let i = 0; i < 50; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

test("/api/play passes --volume=0 when the volume is 0, and 100 when it is missing or not a number", { skip: process.platform === "win32" }, async () => {
  const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ciroom-fakempv-"));
  const log = path.join(bin, "args.txt");
  fs.writeFileSync(path.join(bin, "mpv"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nexec sleep 3\n`, { mode: 0o755 });
  const s = await startServer({ env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  try {
    const f = path.join(s.media, "Movies", "tiny.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2", "-pix_fmt", "yuv420p", f]);
    for (const [volume, want] of [[0, "--volume=0"], [55, "--volume=55"], [200, "--volume=130"], [null, "--volume=100"], ["abc", "--volume=100"], [undefined, "--volume=100"]]) {
      fs.rmSync(log, { force: true });
      const r = await postJson(s.port, "/api/play", { path: f, level: false, ...(volume === undefined ? {} : { volume }) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const args = await waitFor(() => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : null));
      assert.ok(args, "fake mpv started");
      assert.ok(args.includes(want), `volume ${JSON.stringify(volume)} → ${want}, got ${args.find((a) => a.startsWith("--volume="))}`);
    }
  } finally { s.stop(); fs.rmSync(bin, { recursive: true, force: true }); }
});
