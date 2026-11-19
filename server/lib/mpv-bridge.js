// @ts-check
/**
 * CiRoom's server, wired together: every module's routes go into one table (routes.js), mpv is controlled in mpv.js.
 * Runs inside the standalone server (server/index.js) and, in the test version, inside Vite.
 *
 * Safety: read-only on media. Who may call what is decided in the route table (server/lib/routes.js), not here.
 */
import path from "node:path";
import { artworkRoutes } from "./artwork-store.js";
import { streamRoutes } from "./stream.js";
import { metadataRoutes } from "./metadata.js";
import { scannerRoutes } from "./scanner.js";
import { subtitleSearchRoutes } from "./subtitle-search.js";
import { remoteRoutes } from "./remote.js";
import { partyRoutes } from "./party.js";
import { userdbRoutes } from "./userdb.js";
import { introRoutes } from "./intro.js";
import { makeResolveVideo } from "./media-file.js";
import { createMpv } from "./mpv.js";
import { systemRoutes } from "./system-routes.js";
import { buildTable, createRouter } from "./routes.js";

/**
 * DNS-rebinding guard: a web page on another site could point its own domain name at 127.0.0.1 and then read
 * this API as "same origin". Our middleware runs before Vite's own host check, so we check here: only plain IP
 * addresses and localhost may be used to reach CiRoom.
 * @param {string | undefined} host
 */
const hostAllowed = (host) => {
  const h = String(host ?? "").toLowerCase().replace(/:\d+$/, "");
  return h === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h);
};

/**
 * CiRoom's server: every /api route, the phone remote and the watch party. Used by the Vite dev server (the
 * test version, mpvBridge below) and by the standalone server (server/index.js) the installed app runs.
 * @param {string} mediaRoot
 */
export function createCiRoom(mediaRoot) {
  const rootAbs = path.resolve(mediaRoot);
  const resolveVideo = makeResolveVideo(rootAbs);
  let server_port = 1420;
  /** @type {(() => void)[]} called when the phone remote or the watch party is switched on/off */
  const netListeners = [];
  const networkChanged = () => netListeners.forEach((f) => f());

  const intro = introRoutes(resolveVideo, rootAbs);
  // mpv and the remote need each other (the remote saves mpv's progress); `remote` is set a few lines down, before anything runs.
  const mpv = createMpv({ rootAbs, resolveVideo, markersFor: intro.markersFor, finalSave: () => { try { remote.mpvSaveTick(true); } catch { /* best effort */ } } });
  const stream = streamRoutes(resolveVideo);
  const remote = remoteRoutes(mpv.forRemote, () => server_port, networkChanged, { resolveVideo, stream });
  const party = partyRoutes({ resolveVideo, stream, getPort: () => server_port, onToggle: networkChanged });

  const table = buildTable([
    systemRoutes(rootAbs), mpv.routes, remote.routes, userdbRoutes().routes, intro.routes, artworkRoutes().routes,
    stream.routes, subtitleSearchRoutes(resolveVideo).routes, metadataRoutes().routes, scannerRoutes(rootAbs).routes, party.routes,
  ]);
  const router = createRouter(table, {
    hostAllowed,
    partyOwns: (url) => party.owns(url),
    phone: (req, peer, mode) => remote.gate(req, peer, mode),
    party: (req, res, peer, local, r) => party.gate(req, res, peer, local, r),
  });

  return {
    /** Every route, with its audience (tests read it). */
    routes: table,
    /** Starts the background work (skip-intro analysis). Never called by `vite build`. */
    start: () => { intro.start(); remote.start(); },
    setPort: (/** @type {number} */ p) => { server_port = p; },
    /** Clean shutdown: queue mpv's last position (even if a window is still connected), ask mpv to quit, wait up to 1 s, then SIGTERM. */
    shutdown: () => mpv.shutdown(() => remote.mpvSaveTick(true, true)),
    /** True when other devices may need to reach this server (phone remote or watch party on). */
    wantsNetwork: () => remote.isEnabled() || party.isEnabled(),
    /** Calls `fn` whenever the phone remote or the watch party is switched on or off. */
    onNetworkChange: (/** @type {() => void} */ fn) => { netListeners.push(fn); },
    /** WebSocket upgrades (Vite's live reload only): nothing on another device needs them. */
    upgrade: (/** @type {import("node:http").IncomingMessage} */ req, /** @type {import("node:stream").Duplex} */ socket) => {
      const ip = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (ip !== "127.0.0.1" && ip !== "::1") socket.destroy();
    },
    /**
     * Connect-style handler: answers CiRoom's routes, calls next() for everything else (the page itself).
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {() => void} next
     */
    handle: (req, res, next) => router.dispatch(req, res, next),
  };
}

/** Vite plugin: the dev server (test version) runs CiRoom's server inside Vite. @param {string} mediaRoot */
export function mpvBridge(mediaRoot) {
  const app = createCiRoom(mediaRoot);
  return {
    name: "marquee-dev-bridge",
    /** @param {import("vite").ViteDevServer} server */
    configureServer(server) {
      app.start(); // dev server only (not during `vite build`)
      server.httpServer?.once("listening", () => app.setPort(Number(/** @type {any} */ (server.httpServer?.address())?.port) || 1420));
      // Vite's live-reload WebSocket only checks its token when the request has an Origin header (browsers),
      // so a script on another device could still connect: refuse those first.
      server.httpServer?.prependListener("upgrade", app.upgrade);
      server.middlewares.use((req, res, next) => { app.handle(req, res, next); });
    },
  };
}
