/**
 * The page player's remote-control handle. <WebPlayer> registers it while mounted; the phone-remote link
 * (src/lib/remoteLink.ts) reads its state and sends it commands. Plain module state: it changes every
 * second and nothing in the UI renders from it.
 */
export interface WebPlayerState {
  paused: boolean;
  position: number;
  duration: number;
  volume: number; // 0–130
  muted: boolean;
  hasNext: boolean;
  subs: { id: number; label: string }[];
  subId: number; // -1 = off
  fullscreen: boolean;
  subDelay: number; // seconds, + = later
  /** Watch party: the library path of the video, whether it's stalled loading, its speed, and whether it ended. */
  path: string;
  waiting: boolean;
  rate: number;
  ended: boolean;
  /** Skip intro / credits available right now (the phone shows the same button). */
  skip: { kind: "intro" | "credits"; label: string } | null;
}

export interface WebController {
  getState: () => WebPlayerState;
  toggle: () => void;
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  next: () => void;
  setSub: (id: number) => void;
  toggleFullscreen: () => void;
  setSubDelay: (seconds: number) => void;
  skip: () => void;
}

let current: WebController | null = null;
export const registerWebController = (c: WebController | null) => { current = c; };
export const getWebController = () => current;
