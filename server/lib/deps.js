// First-run dependency check: are ffmpeg, ffprobe and mpv runnable? (Asked by running `<tool> -version`,
// so a bundled copy added to PATH by the desktop app counts too.) Shown in Settings.
import { execFile } from "node:child_process";

const WIN = process.platform === "win32";

export const TOOLS = [
  { name: "ffmpeg", args: ["-version"], needed: "the page player, thumbnails, subtitles, skip intro" },
  { name: "ffprobe", args: ["-version"], needed: "reading video details" },
  { name: "mpv", args: ["--version"], needed: "the full player" },
];

const HELP = {
  linux: "Install it with your package manager, e.g. `sudo apt install ffmpeg mpv`, then reopen CiRoom.",
  win32: "Install it (e.g. `winget install ffmpeg mpv`) and make sure it is on PATH, then reopen CiRoom.",
  darwin: "Install it with Homebrew: `brew install ffmpeg mpv`, then reopen CiRoom.",
};

function probe(tool) {
  return new Promise((resolve) => {
    execFile(tool.name, tool.args, { timeout: 8000, windowsHide: true }, (err, out) => {
      const found = !err;
      const version = found ? (String(out).split("\n")[0].match(/\d+(\.\d+)+/) || [""])[0] || null : null;
      resolve({ name: tool.name, ok: found, version, needed: tool.needed, help: found ? null : HELP[process.platform] || HELP.linux });
    });
  });
}

let cache = null;
/** Checked once per start (and again when `fresh`), since installing a tool needs a reopen anyway. */
export async function checkTools(fresh = false) {
  if (!cache || fresh) cache = Promise.all(TOOLS.map(probe));
  return cache;
}
