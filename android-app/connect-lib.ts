// The Connect screen's pure parts (no DOM): what addresses and QR codes are accepted. Tested in tests/connect-lib.test.js.

export const DEFAULT_PORT = 1420;

export interface Pc {
  host: string;
  port: number;
}

/** A private home-network IPv4 address: 10.x.x.x, 192.168.x.x, 172.16-31.x.x. Nothing else is ever contacted
 *  (Tailscale 100.x, public addresses, host names and IPv6 are refused). */
export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map((x) => (x.length > 1 && x.startsWith("0") ? NaN : Number(x))); // no "010" spellings
  if (o.some((n) => !(n >= 0 && n <= 255))) return false;
  return o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
}

function parsePort(p: string | undefined): number | null {
  if (p === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(p)) return null;
  const n = Number(p);
  return n >= 1 && n <= 65535 ? n : null;
}

/** What the user typed: `192.168.1.20` or `192.168.1.20:1430` (an `http://` start and a trailing `/` are forgiven). */
export function parseAddress(input: string): Pc | null {
  const m = /^(?:http:\/\/)?([\d.]+)(?::(\d+))?\/?$/.exec(input.trim());
  if (!m || !isPrivateIPv4(m[1])) return null;
  const port = parsePort(m[2]);
  return port === null ? null : { host: m[1], port };
}

/** The text of the PC's QR code: exactly `http://<private IPv4>[:port]/?pair=<digits>`, nothing more. */
export function parseQr(text: string): { pc: Pc; pin: string } | null {
  const m = /^http:\/\/([\d.]+)(?::(\d+))?\/\?pair=(\d{4,10})$/.exec(text.trim());
  if (!m || !isPrivateIPv4(m[1])) return null;
  const port = parsePort(m[2]);
  return port === null ? null : { pc: { host: m[1], port }, pin: m[3] };
}

/** The page the WebView opens. With a PIN, opening it pairs the phone. */
export function pcUrl(pc: Pc, pin?: string): string {
  return `http://${pc.host}:${pc.port}/` + (pin ? `?pair=${pin}` : "");
}

export function samePc(a: Pc, b: Pc): boolean {
  return a.host === b.host && a.port === b.port;
}

/** `192.168.1.20` (port left out when it is the usual one). */
export function pcLabel(pc: Pc): string {
  return pc.port === DEFAULT_PORT ? pc.host : `${pc.host}:${pc.port}`;
}

/** A saved PC read back from storage: anything that isn't a valid private address and port is dropped. */
export function readSaved(raw: string | null): Pc | null {
  try {
    const v = JSON.parse(raw ?? "null");
    if (v && typeof v.host === "string" && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 && isPrivateIPv4(v.host)) return { host: v.host, port: v.port };
  } catch {
    /* corrupt value: treated as nothing saved */
  }
  return null;
}

// ── "update available" (the app's Kotlin side asks GitHub and keeps the answer; the page only reads it) ──────

/** Only downloads from this repository's releases are ever opened. */
export const DOWNLOAD_PREFIX = "https://github.com/Erfanniazi39/ciroom/releases/download/";

/** `v1.2.3` or `1.2.3` → [1,2,3]; anything else (pre-release suffixes, words) → null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(typeof v === "string" ? v.trim() : "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `candidate` a higher version than `current`? Unreadable versions are never "newer". */
export function isNewer(candidate: unknown, current: unknown): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface UpdateInfo {
  /** A check is running right now. */
  checking: boolean;
  /** The last check in this run: true = GitHub answered, false = it didn't, null = none yet. */
  ok: boolean | null;
  /** The stored newer release with an Android APK, if any. */
  update: { version: string; url: string } | null;
}

/** What `CiRoomNative.updateInfo()` returned (JSON text), checked: anything odd reads as "nothing known". */
export function parseUpdateInfo(raw: unknown): UpdateInfo {
  const none: UpdateInfo = { checking: false, ok: null, update: null };
  try {
    const o = JSON.parse(typeof raw === "string" ? raw : "null");
    if (!o || typeof o !== "object") return none;
    const update = typeof o.version === "string" && typeof o.apkUrl === "string" ? { version: o.version, url: o.apkUrl } : null;
    return { checking: o.checking === true, ok: typeof o.ok === "boolean" ? o.ok : null, update };
  } catch {
    return none;
  }
}

/** The update to tell the user about: newer than this app, a download link of ours, and not the one they put off ("Later"). */
export function pendingUpdate(info: UpdateInfo, current: string, later: string | null): { version: string; url: string } | null {
  const u = info.update;
  if (!u || !isNewer(u.version, current) || !u.url.startsWith(DOWNLOAD_PREFIX)) return null;
  return parseVersion(later)?.join(".") === parseVersion(u.version)?.join(".") ? null : u;
}

export type StartAction = "error" | "connect" | "update" | "unpaired" | "home";

/**
 * What the Connect page does when it opens. `update` = a saved, paired PC would be opened, but there is a newer version
 * to tell the user about first: stay on the Connect screen (update bar + the big "Open <pc>" button).
 */
export function startAction(o: { error: boolean; noauto: boolean; saved: boolean; paired: boolean; update: boolean }): StartAction {
  if (o.error) return "error";
  if (!o.saved || o.noauto) return "home";
  if (!o.paired) return "unpaired";
  return o.update ? "update" : "connect";
}
