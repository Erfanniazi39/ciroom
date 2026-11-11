/**
 * Now-playing session. Mirrors mpv's state via the dev bridge (dev/mpv-bridge.js);
 * in Stage 3 the same calls become Tauri commands backed by the Rust player module.
 */
import { create } from "zustand";
import { useUser } from "./user";

export interface PlayRequest {
  id: string;
  /** Movie id or series id: watch time (Stats) and per-series preferences are kept under it. */
  titleId?: string;
  title: string;
  subtitle?: string;
  hue: number;
  backdrop?: string;
  duration: number; // seconds (metadata; replaced by mpv's real duration once known)
  startAt: number; // seconds
  href: string; // detail page
  path?: string; // file to play
  nextId?: string; // next episode, if any
}

export interface Track {
  id: number;
  title: string | null;
  lang: string | null;
  codec: string | null;
  external: boolean;
  selected: boolean;
  label: string | null;
  /** "Persian", "English"… (external subtitles: detected from the text; built-in tracks: from the tag), or null. */
  language?: string | null;
}

export interface PlayerSnapshot {
  running: boolean;
  ended: boolean;
  nextRequested?: boolean; // user pressed N inside mpv

  position: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  subDelay: number;
  sid: number | null;
  aid: number | null;
  subtitles: Track[];
  audio: Track[];
}

type Live = Omit<PlayerSnapshot, "running" | "ended" | "nextRequested">;
type Settable = "pause" | "volume" | "mute" | "speed" | "sub-delay" | "sid" | "aid";

interface PlayerState {
  current: (PlayRequest & Live) | null;
  upNext: PlayRequest | null;
  error: string | null;
  play: (req: PlayRequest) => Promise<void>;
  togglePause: () => void;
  seek: (position: number) => void;
  seekBy: (seconds: number) => void;
  set: (name: Settable, value: number | boolean | string) => void;
  stop: () => void;
  sync: (s: PlayerSnapshot) => void;
  setUpNext: (req: PlayRequest | null) => void;
  clearError: () => void;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);

export async function fetchSnapshot(): Promise<PlayerSnapshot | null> {
  try {
    const r = await fetch("/api/player");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * After a local change (pause, volume…) ignore that field in polled snapshots briefly,
 * so a snapshot taken before mpv applied the change can't make the control flicker back.
 */
const locks = new Map<keyof Live, number>();
const lock = (k: keyof Live) => locks.set(k, Date.now() + 800);
const locked = (k: keyof Live) => (locks.get(k) ?? 0) > Date.now();

const PROP_TO_FIELD: Record<Settable, keyof Live> = { pause: "paused", volume: "volume", mute: "muted", speed: "speed", "sub-delay": "subDelay", sid: "sid", aid: "aid" };

export const usePlayer = create<PlayerState>((set, get) => ({
  current: null,
  upNext: null,
  error: null,

  play: async (req) => {
    set({ upNext: null, error: null });
    if (!req.path) {
      set({ error: "This item has no video file on disk." });
      return;
    }
    const { subDelays, volume, levelling, subPrefs, audioPrefs } = useUser.getState();
    const subDelay = subDelays[req.id] ?? 0;
    const prefKey = req.titleId ?? req.id;
    try {
      const r = await fetch("/api/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: req.path, startAt: req.startAt, subDelay, volume, title: req.subtitle ? `${req.title} · ${req.subtitle}` : req.title, hasNext: !!req.nextId, level: levelling, subPref: subPrefs[prefKey] ?? null, audioLang: audioPrefs[prefKey] ?? null }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "mpv could not start.");
      set({
        current: {
          ...req, position: req.startAt, paused: false, volume, muted: false, speed: 1, subDelay,
          sid: null, aid: null, subtitles: [], audio: [],
        },
      });
    } catch (e) {
      set({ current: null, error: e instanceof Error ? e.message : "mpv could not start." });
    }
  },

  togglePause: () => {
    const c = get().current;
    if (!c) return;
    lock("paused");
    post("/api/player/cmd", { cmd: "set", name: "pause", value: !c.paused });
    set({ current: { ...c, paused: !c.paused } });
  },

  seek: (position) => {
    const c = get().current;
    if (!c) return;
    lock("position");
    post("/api/player/cmd", { cmd: "seek", value: position });
    set({ current: { ...c, position } });
  },

  seekBy: (seconds) => {
    const c = get().current;
    if (!c) return;
    get().seek(Math.max(0, Math.min(c.position + seconds, c.duration || Infinity)));
  },

  set: (name, value) => {
    const c = get().current;
    if (!c) return;
    const field = PROP_TO_FIELD[name];
    lock(field);
    post("/api/player/cmd", { cmd: "set", name, value });
    set({ current: { ...c, [field]: value } });
    // Remember per-user preferences.
    if (name === "sub-delay") useUser.getState().setSubDelay(c.id, Number(value));
    if (name === "volume") useUser.getState().setVolume(Number(value));
  },

  stop: () => {
    if (get().current) post("/api/player/cmd", { cmd: "stop" });
    set({ current: null, upNext: null });
  },

  sync: (snap) =>
    set((s) => {
      if (!s.current) return s;
      const next = { ...s.current };
      const live = next as Live;
      const take = <K extends keyof Live>(k: K, v: Live[K]) => { if (!locked(k)) live[k] = v; };
      take("position", snap.position);
      take("paused", snap.paused);
      take("volume", snap.volume);
      take("muted", snap.muted);
      take("speed", snap.speed);
      take("subDelay", snap.subDelay);
      take("sid", snap.sid);
      take("aid", snap.aid);
      next.subtitles = snap.subtitles;
      next.audio = snap.audio;
      if (snap.duration > 0) next.duration = snap.duration;
      return { current: next };
    }),

  setUpNext: (req) => set({ upNext: req }),
  clearError: () => set({ error: null }),
}));
