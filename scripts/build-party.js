// @ts-check
/**
 * Builds the watch-party guest page ahead (dist/party/app.js + app.css), for the installed app, which has no
 * sources. Same settings dev/party.js uses when it builds the page on the fly in the test version.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src"), out = path.join(root, "dist", "party");
fs.mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(src, "party/guest.ts")], bundle: true, outfile: path.join(out, "app.js"), format: "esm", target: "es2020",
  minify: true, alias: { "@": src }, legalComments: "none", logLevel: "warning",
});
fs.copyFileSync(path.join(src, "party/guest.css"), path.join(out, "app.css"));
console.log("[build-party] guest page built (dist/party/)");
