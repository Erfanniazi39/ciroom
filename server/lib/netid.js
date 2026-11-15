// @ts-check
/**
 * Which network is this PC on right now? Used by the phone remote's "trusted networks": phones are served only
 * on networks the user approved. The id is stable (Wi-Fi name, or the router's MAC on a wired network).
 *
 * Tests only: CIROOM_FAKE_NETWORK=<id>|<label> returns that instead of asking the system.
 * Never log or store real network names anywhere but the user's own data folder (remote.json).
 */
import { execFile } from "node:child_process";

/** @typedef {{ id: string, label: string, kind: "wifi" | "wired" | "unknown" }} NetworkInfo */
const UNKNOWN = /** @type {NetworkInfo} */ ({ id: "", label: "Unknown network", kind: "unknown" });

/** `nmcli -t -f ACTIVE,SSID dev wifi` → the active SSID ("" when none). nmcli escapes ":" and "\" with a backslash. */
export function parseNmcli(/** @type {string} */ out) {
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("yes:")) continue;
    return line.slice(4).replace(/\\(.)/g, "$1").trim();
  }
  return "";
}

/** `netsh wlan show interfaces` → the SSID line (not BSSID; the word may be localised, so match the shape). */
export function parseNetsh(/** @type {string} */ out) {
  for (const line of out.split(/\r?\n/)) {
    if (/^\s*BSSID/i.test(line)) continue;
    const m = line.match(/^\s*SSID\s*:\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return "";
}

/** `ip neigh show <gw>` → the gateway's MAC (lowercase) or "". */
export function parseIpNeigh(/** @type {string} */ out) {
  const m = out.match(/lladdr\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})/i);
  return m ? m[1].toLowerCase() : "";
}

/** `ip route show default` → the gateway address or "". */
export function parseDefaultRoute(/** @type {string} */ out) {
  const m = out.match(/default via (\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? m[1] : "";
}

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: 3000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  } catch { resolve(""); }
});

/** @type {{ at: number, value: NetworkInfo } | null} */
let cache = null;

/** @returns {Promise<NetworkInfo>} */
async function detect() {
  const fake = process.env.CIROOM_FAKE_NETWORK;
  if (fake !== undefined) {
    const [id, label] = fake.split("|");
    return id ? { id, label: label || id, kind: id.startsWith("wired:") ? "wired" : "wifi" } : UNKNOWN;
  }
  if (process.platform === "win32") {
    const ssid = parseNetsh(await run("netsh", ["wlan", "show", "interfaces"]));
    return ssid ? { id: `wifi:${ssid}`, label: ssid, kind: "wifi" } : UNKNOWN;
  }
  let ssid = parseNmcli(await run("nmcli", ["-t", "-f", "ACTIVE,SSID", "dev", "wifi"]));
  if (!ssid) ssid = (await run("iwgetid", ["-r"])).trim();
  if (ssid) return { id: `wifi:${ssid}`, label: ssid, kind: "wifi" };
  const gw = parseDefaultRoute(await run("ip", ["route", "show", "default"]));
  if (gw) {
    const mac = parseIpNeigh(await run("ip", ["neigh", "show", gw]));
    if (mac) return { id: `wired:${mac}`, label: `Wired network (${gw})`, kind: "wired" };
  }
  return UNKNOWN;
}

/** The current network, cached for 10 seconds. Never throws. @returns {Promise<NetworkInfo>} */
export async function currentNetwork() {
  if (cache && Date.now() - cache.at < 10_000 && process.env.CIROOM_FAKE_NETWORK === undefined) return cache.value;
  let value = UNKNOWN;
  try { value = await detect(); } catch { /* keep unknown */ }
  cache = { at: Date.now(), value };
  return value;
}
