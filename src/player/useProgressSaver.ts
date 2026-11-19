import { useCallback, useEffect, useRef } from "react";

export interface ProgressSaverOptions {
  /** Where the video is now (seconds of the file). */
  getPosition: () => number;
  /** Is the video playing right now? (The 10 s timer only saves while it is.) */
  isPlaying: () => boolean;
  /** True while another screen has this title: our older position must not rewind its progress. */
  blocked: () => boolean;
  /** Does the real saving: the PC writes to the user store, the phone posts to the PC. Return false when it failed (no "saved" mark then). */
  save: (position: number, final: boolean) => boolean | void | Promise<boolean | void>;
  /** The position the player starts at (nothing is saved until it has moved from here). */
  startAt: number;
  /** Phone: unreported watch time counts as "something to save" even if the position hasn't moved. */
  hasPending?: () => boolean;
  /** Save when the component unmounts and the position is past 1 s (the PC page player). */
  saveOnUnmount?: boolean;
  /** Save when the page is hidden or closed (the phone). */
  saveOnHide?: boolean;
  /** Reset the "last saved" mark and re-arm when this changes (a new video). */
  resetKey?: unknown;
}

/**
 * The progress rules shared by the PC and phone players: save every 10 s while playing, on pause, on leave; never when
 * another screen has the title (`blocked`); never when nothing moved by ≥ 1 s since the last save (an idle player never writes).
 * Returns `save(final)` for the callers' own events (pause, close, hand-over) and `markSaved(pos)` for jumps they already reported.
 */
export function useProgressSaver(o: ProgressSaverOptions) {
  const opts = useRef(o);
  opts.current = o;
  const lastSaved = useRef(o.startAt);
  useEffect(() => { lastSaved.current = opts.current.startAt; }, [o.resetKey]);

  const save = useCallback(async (final = false): Promise<boolean> => {
    const c = opts.current;
    if (c.blocked()) return true;
    const pos = c.getPosition();
    if (Math.abs(pos - lastSaved.current) < 1 && !c.hasPending?.()) return true;
    const r = await c.save(pos, final);
    if (r === false) return false;
    lastSaved.current = pos;
    return true;
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => { if (opts.current.isPlaying()) void save(false); }, 10_000);
    return () => window.clearInterval(t);
  }, [save]);

  useEffect(() => {
    if (!o.saveOnHide) return;
    const hide = () => { if (document.visibilityState === "hidden") void save(true); };
    const gone = () => { void save(true); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", gone);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", gone); };
  }, [o.saveOnHide, save]);

  useEffect(() => () => { if (opts.current.saveOnUnmount && opts.current.getPosition() > 1) void save(true); }, [save]);

  const markSaved = useCallback((pos: number) => { lastSaved.current = pos; }, []);
  return { save, markSaved };
}
