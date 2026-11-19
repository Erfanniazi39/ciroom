import { useSyncExternalStore } from "react";

/** What changes ~4×/s (the clock and the loaded range) lives outside React state, so only the seek bar and the timecode re-render for it. */
export interface ClockState { time: number; bufStart: number; bufferedEnd: number }

export function createClock(t: number) {
  let s: ClockState = { time: t, bufStart: t, bufferedEnd: t };
  const subs = new Set<() => void>();
  return {
    get: () => s,
    set(p: Partial<ClockState>) {
      const n = { ...s, ...p };
      if (n.time === s.time && n.bufStart === s.bufStart && n.bufferedEnd === s.bufferedEnd) return;
      s = n;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export type Clock = ReturnType<typeof createClock>;
export const useClock = (c: Clock) => useSyncExternalStore(c.subscribe, c.get);
