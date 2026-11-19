import { useEffect, useState, type RefObject } from "react";
import { activeCueText, type Cue } from "@/api/stream";

/** Loads the cue list for the chosen subtitle. `load` is null when subtitles are off. `error` = the file couldn't be read (or, with `emptyIsError`, had no lines). */
export function useCues(load: (() => Promise<Cue[]>) | null, deps: unknown[], emptyIsError = false): { cues: Cue[]; error: boolean } {
  const [cues, setCues] = useState<Cue[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!load) { setCues([]); setError(false); return; }
    let alive = true;
    setError(false);
    load().then(
      (c) => { if (alive) { setCues(c); if (!c.length && emptyIsError) setError(true); } },
      () => { if (alive) { setCues([]); setError(true); } },
    );
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps -- `load` is a fresh closure every render; callers list what it depends on
  return { cues, error };
}

/**
 * The subtitle line at the video's current time (plus the title's sync delay). Not a per-frame loop: re-checked on
 * play/pause/seek/time updates, and while playing by a timer set for the next cue boundary (at most 1 s away, so a
 * rate change or a stall can't leave a wrong line for long). Boundaries are hit within ~20 ms.
 * `offset` is the source time of the video element's time 0 (0 for MediaSource streams).
 */
export function useActiveCue(videoRef: RefObject<HTMLVideoElement>, cues: Cue[], offset: number, delay: number): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!cues.length) { setText(""); return; }
    const v = videoRef.current;
    if (!v) return;
    let timer = 0;
    let last = "";
    const update = () => {
      window.clearTimeout(timer);
      const t = offset + v.currentTime - delay;
      const txt = activeCueText(cues, t);
      if (txt !== last) { last = txt; setText(txt); }
      if (v.paused || v.ended) return;
      let next = Infinity; // the next moment the line changes: a cue starting, or an active one ending
      for (const c of cues) { if (c.start > t) { next = Math.min(next, c.start); break; } if (t < c.end) next = Math.min(next, c.end); }
      const wait = Number.isFinite(next) ? Math.max(15, Math.min(1000, ((next - t) / (v.playbackRate || 1)) * 1000 + 5)) : 1000;
      timer = window.setTimeout(update, wait);
    };
    const events = ["play", "playing", "pause", "seeked", "seeking", "ratechange", "timeupdate"] as const;
    for (const e of events) v.addEventListener(e, update);
    update();
    return () => { window.clearTimeout(timer); for (const e of events) v.removeEventListener(e, update); };
  }, [videoRef, cues, offset, delay]);
  return text;
}
