// @ts-check
/**
 * Publishes a new CiRoom version:  npm run release            (asks what's new)
 *                                  npm run release -- "Fixed the subtitle menu"
 * Bumps the version (1.2.3 → 1.2.4; add --minor for 1.3.0), commits, tags and pushes. GitHub then builds the
 * apps (.github/workflows/release.yml) and the installed CiRoom offers the update a few minutes later.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const root = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..");
const git = (/** @type {string[]} */ ...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

if (git("status", "--porcelain")) { console.error("There are unsaved changes. Commit them first (or ask Claude to)."); process.exit(1); }
if (git("branch", "--show-current") !== "main") { console.error("Release from the main branch."); process.exit(1); }

const pkgFile = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
const [a, b, c] = pkg.version.split(".").map(Number);
const next = process.argv.includes("--minor") ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;

let notes = process.argv.slice(2).filter((x) => !x.startsWith("--")).join(" ").trim();
if (!notes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  notes = (await rl.question(`What's new in ${next}? `)).trim();
  rl.close();
}
if (!notes) { console.error("Write a short line about what changed."); process.exit(1); }

pkg.version = next;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
const confFile = path.join(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(confFile, "utf8"));
conf.version = next;
fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + "\n");
const cargoFile = path.join(root, "src-tauri/Cargo.toml");
fs.writeFileSync(cargoFile, fs.readFileSync(cargoFile, "utf8").replace(/^version = "[^"]+"/m, `version = "${next}"`));
const lockFile = path.join(root, "src-tauri/Cargo.lock");
fs.writeFileSync(lockFile, fs.readFileSync(lockFile, "utf8").replace(/(name = "ciroom"\nversion = )"[^"]+"/, `$1"${next}"`));
const lockJs = path.join(root, "package-lock.json");
const lj = JSON.parse(fs.readFileSync(lockJs, "utf8"));
lj.version = next; if (lj.packages?.[""]) lj.packages[""].version = next;
fs.writeFileSync(lockJs, JSON.stringify(lj, null, 2) + "\n");

git("add", "package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
git("commit", "-m", `CiRoom ${next}\n\n${notes}`);
git("tag", "-a", `v${next}`, "-m", notes);
console.log(`Publishing CiRoom ${next}…`);
execFileSync("git", ["push", "origin", "main", `v${next}`], { cwd: root, stdio: "inherit" });
console.log(`Done. GitHub is building it now (about 10 minutes): https://github.com/Erfanniazi39/ciroom/actions`);
