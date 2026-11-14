import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

test("the main page carries a CSP with no inline scripts and no framing", async () => {
  const s = await startServer();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /img-src [^;]*https:\/\/image\.tmdb\.org/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    // Deep links serve the same page, with the same header.
    assert.ok((await fetch(`http://127.0.0.1:${s.port}/movies/x`)).headers.get("content-security-policy"));
  } finally { await s.stop(); }
});
