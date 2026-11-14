/**
 * User state: favorites, watchlist, progress, history.
 * Prototype persists to localStorage; Stage 2 moves this to SQLite (watch_progress,
 * watch_history, user_list_items) and this store becomes a cache of it.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { serverStorage } from "@/lib/serverStorage";
import type { Progress } from "@/types/media";

/** Watched at ≥ 90%, or < 3 min remaining. The 3-min rule only applies to videos long enough for it to mean something:
 *  a 2-minute clip would otherwise count as watched the moment it starts. */
export const isCompleted = (position: number, duration: number) =>
  duration > 0 && (position / duration >= 0.9 || (duration > 600 && duration - position < 180));

/** A remembered subtitle choice for a series (or movie): off, or a language (+ the file picked, as a fallback). */
export type SubPref = { off: true } | { off?: false; language: string | null; name: string };

interface HistoryEntry {
  id: string; // playable id
  at: number;
}

interface UserState {
  favorites: string[];
  watchlist: string[];
  progress: Record<string, Progress>;
  history: HistoryEntry[];
  /** Subtitle choice per series/movie id: the next episodes open with the same language (or off). */
  subPrefs: Record<string, SubPref>;
  setSubPref: (titleId: string, pref: SubPref) => void;
  /** Audio language chosen in the full player (mpv) per series/movie id, e.g. "jpn". */
  audioPrefs: Record<string, string>;
  setAudioPref: (titleId: string, lang: string) => void;
  /** Subtitle sync offset per movie/episode, seconds (+ = later). */
  subDelays: Record<string, number>;
  volume: number;
  /** Real time spent watching: day → title id (movie or series) → seconds. Counted while video actually plays. */
  watchLog: Record<string, Record<string, number>>;
  addWatchTime: (titleId: string, seconds: number) => void;
  /** Forget all progress, history and watch time (favorites and the watchlist stay). */
  resetWatching: () => void;
  /** Volume levelling: boost quiet files to a normal loudness (both players). */
  levelling: boolean;
  setLevelling: (on: boolean) => void;
  setSubDelay: (id: string, seconds: number) => void;
  setVolume: (v: number) => void;
  toggleFavorite: (titleId: string) => void;
  toggleWatchlist: (titleId: string) => void;
  savePosition: (id: string, position: number, duration: number) => void;
  setWatched: (ids: string[], watched: boolean, durations?: Record<string, number>) => void;
}

/** Local calendar day key, e.g. "2026-11-10". */
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const useUser = create<UserState>()(
  persist(
    (set) => ({
      favorites: [],
      watchlist: [],
      progress: {},
      history: [],
      watchLog: {},
      addWatchTime: (titleId, seconds) =>
        set((s) => {
          const day = dayKey();
          const today = { ...(s.watchLog[day] ?? {}) };
          today[titleId] = Math.round(((today[titleId] ?? 0) + seconds) * 10) / 10;
          return { watchLog: { ...s.watchLog, [day]: today } };
        }),
      resetWatching: () => set({ progress: {}, history: [], watchLog: {} }),
      subPrefs: {},
      setSubPref: (titleId, pref) => set((s) => ({ subPrefs: { ...s.subPrefs, [titleId]: pref } })),
      audioPrefs: {},
      setAudioPref: (titleId, lang) => set((s) => ({ audioPrefs: { ...s.audioPrefs, [titleId]: lang } })),
      subDelays: {},
      volume: 100,
      levelling: true,
      setLevelling: (on) => set({ levelling: on }),
      setSubDelay: (id, seconds) =>
        set((s) => {
          const subDelays = { ...s.subDelays };
          if (Math.abs(seconds) < 0.001) delete subDelays[id];
          else subDelays[id] = Math.round(seconds * 1000) / 1000;
          return { subDelays };
        }),
      setVolume: (v) => set({ volume: Math.max(0, Math.min(130, Math.round(v))) }),
      toggleFavorite: (id) =>
        set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((x) => x !== id) : [id, ...s.favorites] })),
      toggleWatchlist: (id) =>
        set((s) => ({ watchlist: s.watchlist.includes(id) ? s.watchlist.filter((x) => x !== id) : [id, ...s.watchlist] })),
      savePosition: (id, position, duration) =>
        set((s) => {
          const prev = s.progress[id];
          const watched = isCompleted(position, duration) || (prev?.watched ?? false);
          return {
            progress: { ...s.progress, [id]: { position, duration, watched, updatedAt: Date.now() } },
            history: [{ id, at: Date.now() }, ...s.history.filter((h) => h.id !== id)].slice(0, 200),
          };
        }),
      setWatched: (ids, watched, durations = {}) =>
        set((s) => {
          const progress = { ...s.progress };
          for (const id of ids) {
            const duration = durations[id] ?? progress[id]?.duration ?? 0;
            progress[id] = { position: watched ? duration : 0, duration, watched, updatedAt: Date.now() };
          }
          return { progress };
        }),
    }),
    { name: "marquee.user.v1", storage: serverStorage() },
  ),
);
