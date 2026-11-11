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
  /** Playable id currently open in the full player (mpv); its watch page shows a placeholder and resumes after. */
  handedOff: string | null;
  /** Bumped by the watch page's "Find subtitles" button; the player opens its finder when it changes. */
  finderRequest: number;
  /** "Fullscreen" without the browser API (which needs a real click, so a phone can't trigger it): the player fills the app window. Survives episode changes. */
  cover: boolean;
  setCover: (on: boolean) => void;
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
  handedOff: null,
  finderRequest: 0,
  cover: false,
  setCover: (on) => set({ cover: on }),
  requestFinder: () => set((s) => ({ finderRequest: s.finderRequest + 1 })),
  handOff: (id) => set({ session: null, handedOff: id, cover: false }),
  clearHandoff: () => set({ handedOff: null }),
  open: (id, startAt) => {
    if (get().session?.id === id) return; // already playing this one (e.g. coming back from the mini player)
    set({ session: { id, startAt, key: ++counter } });
  },
  close: () => set({ session: null, cover: false }),
}));
