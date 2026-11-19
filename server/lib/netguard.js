// @ts-check
/**
 * Which addresses CiRoom may fetch on the user's behalf ("use this picture link"): public ones only. A link into the
 * home network (router page, NAS, another PC), this PC itself, or a cloud metadata address must never be fetched.
 */
import dns from "node:dns/promises";
import net from "node:net";

/** True for loopback, private, link-local, CGNAT/Tailscale, unique-local, multicast, unspecified and reserved addresses. */
export function isPrivateAddress(/** @type {string} */ addr) {
  const a = String(addr).replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const v = net.isIP(a);
  if (v === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 0 || p === 10 || p === 127 || p >= 224
      || (p === 169 && q === 254)
      || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168)
      || (p === 100 && q >= 64 && q <= 127)   // CGNAT, Tailscale
      || (p === 192 && q === 0)                // 192.0.0.0/24 and 192.0.2.0/24
      || (p === 198 && (q === 18 || q === 19)); // benchmarking
  }
  if (v === 6) {
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped: judge the IPv4 address
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) { const n = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16); return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")); }
    if (a === "::" || a === "::1") return true;
    const first = parseInt(a.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00      // fc00::/7 unique-local
      || (first & 0xffc0) === 0xfe80        // fe80::/10 link-local
      || (first & 0xff00) === 0xff00;       // multicast
  }
  return true; // not an IP at all: refuse
}

/** Throws unless every address `hostname` resolves to is public. */
export async function assertPublicHost(/** @type {string} */ hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) throw new Error("That address is on this computer or your home network, so CiRoom won't fetch it");
}
