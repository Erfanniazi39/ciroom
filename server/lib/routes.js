// @ts-check
/**
 * The one route table. Every route CiRoom answers is an entry { method, path, audience, handler } that a module
 * exports in its `routes` list. `createRouter(table, gates).dispatch(...)` does the rest, in this order:
 *   1. the checks every request gets (Host name, cross-site, JSON only, body size),
 *   2. find the route by METHOD + pathname (the query string is never part of the match),
 *   3. check the AUDIENCE with the existing gates, before the handler runs,
 *   4. call the handler.
 *
 * Audiences:
 *   "pc"     this PC only (loopback). Any other device is refused like an unpaired phone, so it learns nothing.
 *   "phone"  this PC, or a paired phone on a trusted network (`open: true` = a phone that is not paired yet, to pair).
 *   "guest"  a joined watch-party guest (`open: true` = not joined yet: the page, who-am-I, join).
 *   "public" anyone who passes the checks in step 1. Nothing uses it today: adding a route here is a decision.
 *
 * Only paths in the table are served. An unknown /api/… path is a 404 on this PC and a plain refusal for others.
 */

export const AUDIENCES = ["pc", "phone", "guest", "public"];
const METHODS = ["GET", "POST", "PUT", "DELETE"];

/**
 * @typedef {{ req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, u: URL, json: (code: number, data: unknown) => void,
 *   body: (req: any) => Promise<any>, local: boolean, peer: string, guest?: any }} Ctx
 * @typedef {{ method: string, path: string, audience: string, open?: boolean, limit?: number, handler: (ctx: Ctx) => unknown, owner?: string }} Route
 */

/** Thrown when a request body is over the limit; the router turns it into HTTP 413. */
export class BodyTooLarge extends Error {
  constructor() { super("Request body too large"); }
}
/** Thrown when the client goes away before the body is complete. The socket is gone, so nothing is answered. */
export class BodyAborted extends Error {
  constructor() { super("Request body aborted"); }
}

const DEFAULT_LIMIT = 1024 * 1024;

/** Reads a JSON body (an empty or broken one is `{}`), at most `limit` bytes. @param {import("node:http").IncomingMessage} req @param {number} limit @returns {Promise<any>} */
export const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let done = false;
  const settle = (/** @type {() => void} */ f) => {
    if (done) return;
    done = true;
    req.off("data", onData); req.off("end", onEnd); req.off("error", onAbort); req.off("close", onClose);
    f();
  };
  const onData = (/** @type {Buffer} */ c) => {
    size += c.length;
    if (size > limit) { chunks.length = 0; settle(() => reject(new BodyTooLarge())); req.on("data", () => {}); return; } // keep draining: the 413 goes out while the client is still sending
    chunks.push(c);
  };
  const onEnd = () => settle(() => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { resolve({}); } });
  const onAbort = () => settle(() => reject(new BodyAborted()));
  const onClose = () => { if (!req.complete) onAbort(); };
  req.on("data", onData); req.on("end", onEnd); req.on("error", onAbort); req.on("close", onClose);
});

/**
 * Checks a module's route list: every entry names a method, a path and an audience (there is no default).
 * @param {string} owner @param {Omit<Route, "owner">[]} list @returns {Route[]}
 */
export function defineRoutes(owner, list) {
  return list.map((r) => {
    if (!METHODS.includes(r.method)) throw new Error(`${owner}: route ${r.method} ${r.path} has no valid method`);
    if (!r.path || r.path[0] !== "/") throw new Error(`${owner}: route ${r.method} ${r.path} needs a path starting with /`);
    if (!AUDIENCES.includes(r.audience)) throw new Error(`${owner}: route ${r.method} ${r.path} has no audience`);
    if (r.open && r.audience !== "phone" && r.audience !== "guest") throw new Error(`${owner}: route ${r.method} ${r.path}: only phone and guest routes can be open`);
    if (typeof r.handler !== "function") throw new Error(`${owner}: route ${r.method} ${r.path} has no handler`);
    return { ...r, owner };
  });
}

/** Joins the modules' route lists into the one table. Two entries for the same method + path are a mistake. @param {Route[][]} lists @returns {Route[]} */
export function buildTable(lists) {
  const table = lists.flat();
  const seen = new Set();
  for (const r of table) {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) throw new Error(`Route ${k} is defined twice`);
    seen.add(k);
  }
  return table;
}

/** Finds the route for a method + pathname. A path ending in `/*` matches everything below it. @param {Route[]} table */
export function matchRoute(table, /** @type {string} */ method, /** @type {string} */ pathname) {
  const exact = table.find((r) => r.method === method && r.path === pathname);
  if (exact) return exact;
  return table.find((r) => r.method === method && r.path.endsWith("/*") && pathname.startsWith(r.path.slice(0, -1)));
}

/**
 * Runs the matching route of a list without any gate (this PC's own code and the tests use it). False if there is none.
 * @param {Route[]} table @param {Omit<Ctx, "u" | "peer">} c
 */
export async function runRoute(table, c) {
  const u = new URL(c.req.url ?? "/", "http://localhost");
  const r = matchRoute(table, c.req.method ?? "GET", u.pathname);
  if (!r) return false;
  await r.handler({ ...c, u, peer: c.local ? "127.0.0.1" : "" });
  return true;
}

/** Is this a request from this PC itself? @param {string} peer */
const isLoopback = (peer) => peer === "127.0.0.1" || peer === "::1";

/**
 * @param {Route[]} table
 * @param {{
 *   hostAllowed: (host: string | undefined) => boolean,
 *   partyOwns: (url: string | undefined) => boolean,
 *   phone: (req: import("node:http").IncomingMessage, peer: string, mode: "page" | "open" | "phone" | "refuse") => number,
 *   party: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, peer: string, local: boolean, r: { audience: string, open?: boolean }) => { guest?: any } | null,
 * }} gates
 */
export function createRouter(table, gates) {
  /** @param {import("node:http").ServerResponse} res @param {number} code @param {unknown} data @param {Record<string, string>} [headers] */
  const send = (res, code, data, headers = {}) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(data));
  };
  /** The refusal a device gets from outside this PC, from the phone gate. @param {import("node:http").ServerResponse} res @param {number} status */
  const refuse = (res, status) => send(res, status, { error: status === 401 ? "Not paired" : "Not allowed from this device" });

  return {
    table,
    /**
     * Connect-style: answers CiRoom's routes, calls next() for everything else (the page itself).
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {() => void} next
     */
    async dispatch(req, res, next) {
      const peer = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const local = isLoopback(peer);
      const method = req.method ?? "GET";

      // 1. Checks for every request.
      if (!gates.hostAllowed(req.headers.host)) return send(res, 403, { error: "Use an IP address or localhost to reach CiRoom" });
      // Cross-site reads: a web page could embed /api/stream?path=… (starts ffmpeg, tells whether a path exists).
      // Our own page, the phone page and the guest page are always same-origin; browsers say so in Sec-Fetch-Site.
      if (String(req.url).startsWith("/api/")) {
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        const site = req.headers["sec-fetch-site"];
        if (site === "cross-site" || site === "same-site") return send(res, 403, { error: "Cross-site request refused" });
      }

      const u = new URL(req.url ?? "/", "http://localhost");
      const route = matchRoute(table, method, u.pathname);
      const limit = route?.limit ?? DEFAULT_LIMIT;

      // Cross-site protection: a web page in the user's browser can POST text/plain to 127.0.0.1 without a
      // preflight. Anything that changes something must come from our own page (same origin) and be JSON.
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${req.headers.host}`) return send(res, 403, { error: "Cross-site request refused" });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return send(res, 415, { error: "JSON only" });
        // Honest clients announce the size: refuse before reading anything (chunked bodies are cut off in readBody()).
        if (Number(req.headers["content-length"] ?? 0) > limit) return send(res, 413, { error: "Request body too large" }, { Connection: "close" });
      }

      const partyPath = gates.partyOwns(req.url);
      const isApi = u.pathname.startsWith("/api/");
      /** @type {any} */ let guest;
      let owner = route?.owner ?? (partyPath ? "party" : "");

      // 2–3. Who may call this? (An unknown path is checked as its neighbours are, so it never says more.)
      if (partyPath || route?.owner === "party") {
        const audience = route ? route.audience : u.pathname.startsWith("/api/party/host/") ? "pc" : "guest";
        const g = gates.party(req, res, peer, local, { audience, open: route?.open });
        if (!g) return; // refused (the gate already answered)
        guest = g.guest;
      } else if (!route) {
        if (!local) {
          const status = gates.phone(req, peer, isApi ? "refuse" : "page");
          if (status) return refuse(res, status);
        }
        if (!isApi) return next();
        return send(res, 404, { error: "Unknown endpoint" });
      } else if (route.audience === "pc") {
        if (!local) return refuse(res, gates.phone(req, peer, "refuse") || 403);
      } else if (route.audience === "phone") {
        if (!local) {
          const status = gates.phone(req, peer, route.open ? "open" : "phone");
          if (status) return refuse(res, status);
        }
      }
      // "public" passes: step 1 was all it needs.

      if (!route) return send(res, 404, { error: "Unknown endpoint" }); // an unknown path under /party or /api/party/ for a joined guest or this PC

      const party = owner === "party";
      const json = party
        ? (/** @type {number} */ code, /** @type {unknown} */ data) => { if (res.headersSent) return void res.end(); send(res, code, data); }
        : (/** @type {number} */ code, /** @type {unknown} */ data) => send(res, code, data);
      try {
        await route.handler({ req, res, u, json, body: (r) => readBody(r, limit), local, peer, guest });
      } catch (e) {
        if (e instanceof BodyTooLarge) return json(413, { error: e.message });
        if (e instanceof BodyAborted) return void res.destroy();
        if (party) return json(400, { error: local && e instanceof Error ? e.message : "Something went wrong" }); // guests are told nothing about this PC
        json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
