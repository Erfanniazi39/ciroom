/**
 * Saving on close. The players register what must be saved at the very end (the page player: its exact position);
 * `beforeClose()` runs those and sends every pending save at once instead of after the usual 400 ms batching.
 *
 * Who calls it:
 * - the desktop shell, when the window's X is clicked (src-tauri/src/lib.rs: it calls `window.__ciroomBeforeClose()`
 *   and closes the window when that resolves, or after 1 s at most). A destroyed window never unmounts React and
 *   doesn't reliably fire `pagehide`, so without this the last pause/jump/seconds were lost (D-31);
 * - `pagehide` in browsers and on the phone (fire-and-forget: the saves use `keepalive`).
 */
import { flushUserData } from "./serverStorage";

const savers = new Set<() => void>();

/** Registers a last save to run on close; returns the function that removes it. */
export function onBeforeClose(fn: () => void): () => void {
  savers.add(fn);
  return () => { savers.delete(fn); };
}

/** Runs the last saves, then sends everything pending; resolves when the database has answered, or after `ms`. */
export function beforeClose(ms = 800): Promise<void> {
  for (const fn of savers) {
    try { fn(); } catch (e) { console.warn("[CiRoom] save on close failed", e); }
  }
  return Promise.race([flushUserData(), new Promise<void>((r) => window.setTimeout(r, ms))]);
}

declare global {
  interface Window { __ciroomBeforeClose?: () => Promise<void> }
}

if (typeof window !== "undefined") {
  window.__ciroomBeforeClose = () => beforeClose();
  window.addEventListener("pagehide", () => { void beforeClose(); });
}
