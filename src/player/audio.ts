import type { ProbeInfo } from "@/api/stream";

export type AudioTrack = NonNullable<ProbeInfo["audioTracks"]>[number];

/** Which audio stream to start with: the saved language for this title, else English (like mpv), else the first. */
export function startAudio(tracks: AudioTrack[], pref: string | undefined): number {
  const by = (codes: string[]) => tracks.find((t) => t.language && codes.includes(t.language))?.index;
  return (pref ? by([pref.toLowerCase()]) : undefined) ?? by(["en", "eng"]) ?? 0;
}

export function audioLabel(t: AudioTrack | undefined): string {
  if (!t) return "Default";
  let lang: string | null = null;
  if (t.language) { try { lang = new Intl.DisplayNames(undefined, { type: "language" }).of(t.language) ?? t.language; } catch { lang = t.language; } }
  const ch = t.channels === 6 ? "5.1" : t.channels === 8 ? "7.1" : t.channels === 1 ? "mono" : t.channels === 2 ? "stereo" : "";
  const name = t.title || lang || `Track ${t.index + 1}`;
  const extra = [t.codec.toUpperCase(), ch].filter(Boolean).join(" ");
  return t.title && lang && !t.title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} · ${t.title}` : extra ? `${name} · ${extra}` : name;
}

