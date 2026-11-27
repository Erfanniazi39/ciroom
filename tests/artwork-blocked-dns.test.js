// A network that blocks TMDB by answering its names with a private address (the proxy still reaches it): posters TMDB
// offers must still download, while a pasted picture link to such an address stays refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, postJson } from "./helpers.js";

const PRELOAD = `
import dns from "node:dns/promises";
const realFetch = globalThis.fetch;
dns.lookup = async (host, opts) => (opts?.all ? [{ address: "10.10.34.36", family: 4 }] : { address: "10.10.34.36", family: 4 });
globalThis.fetch = async (input, init) => {
  const u = new URL(input instanceof Request ? input.url : input);
  if (u.hostname === "api.themoviedb.org") return Response.json({ poster_path: "/p.png", backdrop_path: "/b.png" });
  if (u.hostname === "image.tmdb.org") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  return realFetch(input, init);
};
`;

test("TMDB pictures download when DNS answers with a private address; pasted links stay refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ciroom-dns-"));
  const preload = path.join(dir, "blocked-dns.mjs");
  fs.writeFileSync(preload, PRELOAD);
  const s = await startServer({ env: { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` } });
  try {
    fs.writeFileSync(path.join(s.data, "settings.json"), JSON.stringify({ tmdbKey: "x" }));
    const applied = await postJson(s.port, "/api/tmdb/apply", { id: "venom", type: "movie", tmdbId: 1 });
    assert.equal(applied.status, 200, JSON.stringify(applied));
    const pasted = await postJson(s.port, "/api/art/url", { id: "venom", kind: "poster", url: "https://image.tmdb.org/t/p/w500/p.png" });
    assert.notEqual(pasted.status, 200);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
