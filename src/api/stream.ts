/**
 * In-page playback client (dev bridge `dev/stream.js` today; Tauri commands in Stage 3).
 */
export interface ProbeInfo {
  /** HDR source (PQ/HLG): the page player shows it without tone mapping, so the full player looks better. */
  hdr?: boolean;
  duration: number;
  width: number;
  height: number;
  video: string | null;
  audio: string | null;
  copyVideo: boolean;
  copyAudio: boolean;
  /** `language`: from the file name or detected from the text ("Persian", "English"…), null when unknown. */
  subtitles: { index: number; name: string; label: string; format: string; language?: string | null; /** built into the video: fetched by `stream` */ embedded?: boolean; stream?: number }[];
  /** Volume levelling boost for this file in dB (+ = quiet file boosted). */
  levelGainDb?: number;
  /** Codec of the streamed video (for MediaSource). */
  codecs?: { video: string };
  hasAudio?: boolean;
  /** Every audio stream in the file (`index` = position among the audio streams, for `&a=`). Shown when there are 2+. */
  audioTracks?: { index: number; language: string | null; title: string | null; codec: string; channels: number }[];
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const q = (path: string) => encodeURIComponent(path);

/** Skip intro / skip credits for a video (found by comparing the season's episodes; see dev/intro.js). */
export interface Markers {
  status: "ready" | "pending" | "none";
  intro?: { start: number; end: number } | null;
  credits?: number | null;
}

export const streamApi = {
  markers: async (path: string): Promise<Markers> => {
    try {
      const r = await fetch(`/api/markers?path=${q(path)}`);
      return r.ok ? await r.json() : { status: "none" };
    } catch {
      return { status: "none" };
    }
  },
  probe: async (path: string): Promise<ProbeInfo> => {
    const r = await fetch(`/api/probe?path=${q(path)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Could not read this video file.");
    return data;
  },
  streamUrl: (path: string, t: number, level = true, audio = 0) =>
    `/api/stream?path=${q(path)}&t=${t.toFixed(3)}${level ? "" : "&level=0"}${audio ? `&a=${audio}` : ""}`,
  /** Where a stream requested at `t` really starts (the keyframe before t for stream-copied files). */
  seekPoint: async (path: string, t: number, audio = 0): Promise<number> => {
    try {
      const r = await fetch(`/api/seekpoint?path=${q(path)}&t=${t.toFixed(3)}${audio ? `&a=${audio}` : ""}`);
      const d = await r.json();
      return typeof d.start === "number" && d.start <= t + 0.01 ? d.start : t;
    } catch {
      return t;
    }
  },
  /** A representative frame for an episode/movie card (≈30% in, past intros). */
  stillUrl: (path: string, durationSec?: number) => `/api/thumb?path=${q(path)}&t=${Math.round((durationSec || 1200) * 0.3)}`,
  thumbUrl: (path: string, t: number) => `/api/thumb?path=${q(path)}&t=${Math.max(0, Math.round(t))}`,
  subtitles: async (path: string, sub: { index: number; embedded?: boolean; stream?: number }): Promise<Cue[]> => {
    const r = await fetch(`/api/subtitle.vtt?path=${q(path)}&${sub.embedded ? `e=${sub.stream}` : `i=${sub.index}`}`);
    if (!r.ok) throw new Error("subtitle");
    return parseVtt(await r.text());
  },
};

function toSeconds(ts: string): number {
  const parts = ts.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/** Minimal WebVTT parser: absolute times, tags stripped (keeps line breaks). */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const text = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
    if (text) cues.push({ start: toSeconds(a), end: toSeconds(b.trim().split(/\s/)[0]), text });
  }
  return cues.sort((x, y) => x.start - y.start);
}
