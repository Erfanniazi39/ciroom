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
