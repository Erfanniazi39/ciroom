/**
 * App settings (Settings page). Persisted in localStorage like the rest of the user state;
 * moves to SQLite later. Volume levelling lives in the user store (both players share it).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { serverStorage } from "@/lib/serverStorage";
import type { SubPref } from "./user";

export interface SettingsState {
  /** Play the next episode automatically when one ends. */
  autoplayNext: boolean;
  /** The "Up next" card appears this many seconds before the end. */
  upNextSeconds: number;
  /** Keep a video playing in a small corner window when you leave the watch page. */
  miniPlayer: boolean;
  /** Couch mode: bigger interface, arrow-key navigation, big focus outlines. */
  tvMode: boolean;
  /** Turn subtitles on automatically when a video has subtitle files. */
  subtitlesDefault: boolean;
  /** Preferred subtitle languages in order, e.g. "English, Persian" (matched against subtitle names). */
  subtitleLanguages: string;
  /** Languages the online subtitle search looks for (codes, in order). */
  subtitleSearchLanguages: string[];
  set: (patch: Partial<Omit<SettingsState, "set">>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      autoplayNext: true,
      upNextSeconds: 15,
      miniPlayer: true,
      tvMode: false,
      subtitlesDefault: true,
      subtitleLanguages: "",
      subtitleSearchLanguages: ["FA", "EN"],
      set: (patch) => set(patch),
    }),
    { name: "ciroom.settings.v1", storage: serverStorage() },
  ),
);

type SubLike = { index: number; label: string; name?: string; language?: string | null };

/** Index of the subtitle to turn on by default, or -1 for none. */
export function pickSubtitle(subs: SubLike[], prefs: string, enabled: boolean): number {
  if (!enabled || !subs.length) return -1;
  for (const want of prefs.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const hit = subs.find((s) => s.language?.toLowerCase().startsWith(want) || s.label.toLowerCase().includes(want));
    if (hit) return hit.index;
  }
  return subs[0].index;
}

/**
 * The subtitle to start with: the choice remembered for this series/movie first (same language, or off),
 * then the Settings language order. A remembered language the episode doesn't have falls back to the defaults.
 */
export function startSubtitle(subs: SubLike[], pref: SubPref | undefined): number {
  const { subtitleLanguages, subtitlesDefault } = useSettings.getState();
  if (pref?.off) return -1;
  if (pref && subs.length) {
    const byName = subs.find((s) => s.name === pref.name);
    if (byName && (!pref.language || byName.language === pref.language)) return byName.index;
    const byLang = pref.language ? subs.find((s) => s.language === pref.language) : undefined;
    if (byLang) return byLang.index;
  }
  return pickSubtitle(subs, subtitleLanguages, subtitlesDefault || !!pref);
}

/** What to remember when the user picks subtitle `index` (-1 = off). */
export function subPrefFor(subs: SubLike[], index: number): SubPref | null {
  if (index < 0) return { off: true };
  const s = subs.find((x) => x.index === index);
  return s ? { language: s.language ?? null, name: s.name ?? s.label } : null;
}
