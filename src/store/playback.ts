/**
 * The in-page player session. The player lives in <PlayerHost> (App level), not in the watch page,
 * so the same video keeps playing, with no reload, when you leave the watch page and it turns into
 * the mini player. The watch page only opens a session and provides the slot where the video shows.
 */
import { create } from "zustand";

interface Session {
  id: string; // playable id (movie or episode)
  startAt: number;
  key: number; // changes → the player remounts (new video, or "Watch again after the full player")
}

interface PlaybackState {
  session: Session | null;
  /** The `key` of the session that hit a playback error (its player shows the message for good): never kept, never re-used. */
  failedKey: number | null;
  markFailed: (key: number) => void;
  /** Playable id currently open in the full player (mpv); its watch page shows a placeholder and resumes after. */
  handedOff: string | null;
  /** Bumped by the watch page's "Find subtitles" button; the player opens its finder when it changes. */
  finderRequest: number;
  /** "Fullscreen" without the browser API (which needs a real click, so a phone can't trigger it): the player fills the app window. Survives episode changes. */
  cover: boolean;
  setCover: (on: boolean) => void;
  /** One screen at a time: this title was taken over by a phone (the PC paused; it must not save its old position). `at` = when. */
  elsewhere: { id: string; at: number } | null;
  /** What phones report, by title id (newest, with the server's time). */
  phoneNow: Record<string, { position: number; playing: boolean; at: number }>;
  requestFinder: () => void;
  /** Stop the in-page player and mark this id as playing in the full player. */
  handOff: (id: string) => void;
  clearHandoff: () => void;
  open: (id: string, startAt: number) => void;
  close: () => void;
}

let counter = 0;

export const usePlayback = create<PlaybackState>((set, get) => ({
  session: null,
  failedKey: null,
  markFailed: (key) => { if (get().session?.key === key) set({ failedKey: key }); },
  handedOff: null,
  finderRequest: 0,
  cover: false,
  elsewhere: null,
  phoneNow: {},
  setCover: (on) => set({ cover: on }),
  requestFinder: () => set((s) => ({ finderRequest: s.finderRequest + 1 })),
  handOff: (id) => set({ session: null, handedOff: id, cover: false, elsewhere: null }),
  clearHandoff: () => set({ handedOff: null }),
  open: (id, startAt) => {
    const { session, failedKey } = get();
    if (session?.id === id && session.key !== failedKey) return; // already playing this one (e.g. coming back from the mini player)
    set({ session: { id, startAt, key: ++counter }, elsewhere: null });
  },
  close: () => set({ session: null, cover: false }),
}));
