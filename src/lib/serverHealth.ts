/**
 * Is CiRoom's server (the service behind this window) still there? Not a constant poll: something that needed the
 * server and failed (a save, the commands stream, Play, a video stream) calls reportServerTrouble(), which pings
 * /api/ping. After 2 failed pings the state is "down" (ConnectionBar shows it) and the ping repeats until it answers
 * again (every 2 s for the first half minute, then every 5 s; paused while the window is hidden). Then the state is
 * "up" again and onServerBack listeners run (re-send unsaved changes, reload what may be stale: src/lib/reconnect.ts).
 * The desktop shell restarts a stopped server on the same port (src-tauri/src/lib.rs), so the window reconnects by itself.
 */
export type ServerHealth = "up" | "down";

let state: ServerHealth = "up";
let fails = 0;
let checking = false;
let timer = 0;
let downSince = 0;
const listeners = new Set<() => void>();
const backListeners = new Set<() => void>();

export const serverHealth = () => state;
/** Calls `fn` when serverHealth() changes. Returns the unsubscribe. */
export function onServerHealth(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Calls `fn` each time the server answers again after being down. Returns the unsubscribe. */
export function onServerBack(fn: () => void) {
  backListeners.add(fn);
  return () => { backListeners.delete(fn); };
}

function setState(s: ServerHealth) {
  if (s === state) return;
  state = s;
  for (const fn of listeners) fn();
  if (s === "up") for (const fn of backListeners) fn();
}

async function ping(): Promise<boolean> {
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch("/api/ping", { cache: "no-store", signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(t);
  }
}

function schedule(ms: number) {
  if (timer || checking) return;
  timer = window.setTimeout(() => { timer = 0; void check(); }, ms);
}

async function check() {
  if (document.hidden && state === "down") return; // resumed by visibilitychange
  checking = true;
  const ok = await ping();
  checking = false;
  if (ok) {
    fails = 0;
    setState("up");
    return;
  }
  fails++;
  if (fails >= 2 && state === "up") { downSince = Date.now(); setState("down"); }
  schedule(state === "down" ? (Date.now() - downSince < 30_000 ? 2000 : 5000) : 1000);
}

/** Something that needs the server failed: check whether it is still there (cheap to call often). */
export function reportServerTrouble() {
  // Only on a page served by CiRoom (not when the stores are loaded in Node for tests, which would ping forever).
  if (typeof window === "undefined" || !/^https?:$/.test(globalThis.location?.protocol ?? "")) return;
  schedule(0);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state === "down") schedule(0); });
}
