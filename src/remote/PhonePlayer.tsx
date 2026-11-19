/**
 * Watching on the phone (in the phone's browser). The video streams from the PC over the home network through the
 * phone-only routes /api/remote/watch/* (by library id; server/lib/phone-watch.js), played with the same MSE player
 * as the watch-party guest. Progress and watch time go back through the PC window (/api/remote/progress), never to
 * the database directly. "Send to PC" hands the current position to the PC window and starts it there.
 */
import { AudioLines, Captions, Gauge, Loader2, Maximize, MonitorUp, Minimize, Pause, Play, RectangleHorizontal, RectangleVertical, RotateCcw, RotateCw, SkipForward, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSeekPoint, parseVtt, type ProbeInfo } from "@/api/stream";
import { audioLabel, startAudio } from "@/components/WebPlayer";
import { cx } from "@/components/ui";
import { usePlaybackEngine } from "@/player/usePlaybackEngine";
import { useProgressSaver } from "@/player/useProgressSaver";
import { useActiveCue, useCues } from "@/player/useSubtitles";
import { findEpisode } from "@/lib/library";
import { episodeCode, timecode } from "@/lib/format";
import { lowStreamMime, MseStream, streamMime, type StreamSource } from "@/lib/mse";
import { useLibrary } from "@/store/library";
import { startSubtitle, subPrefFor } from "@/store/settings";
import type { SubPref } from "@/store/user";

export interface PhoneUser {
  progress: Record<string, { position: number; duration: number; watched: boolean }>;
  subPrefs?: Record<string, SubPref>;
  audioPrefs?: Record<string, string>;
  prefs?: { subtitleLanguages: string; subtitlesDefault: boolean };
}
type PhoneProbe = ProbeInfo & { id: string; title: string; subtitle: string | null; nextId: string | null };
type Quality = "orig" | "low";
type Menu = null | "subs" | "audio" | "quality";

const QUALITY_KEY = "ciroom.phone.quality";
const readQuality = (): Quality => { try { return localStorage.getItem(QUALITY_KEY) === "low" ? "low" : "orig"; } catch { return "orig"; } };
const saveQuality = (q: Quality) => { try { localStorage.setItem(QUALITY_KEY, q); } catch { /* private mode: not remembered */ } };

/** What a failed request means, in plain words. */
function explain(status: number, fallback?: string): string {
  if (status === 0) return "Can't reach CiRoom on the PC. It may be closed, or phones are turned off on this network (trust it in CiRoom's Settings on the PC).";
  if (status === 401) return "This phone isn't paired any more. Pair it again from CiRoom's Settings on the PC.";
  if (status === 403) return "Phones are turned off on this network. Trust it in CiRoom's Settings on the PC.";
  if (status === 404) return "This video isn't available.";
  if (status === 429) return "Too many videos are open on this phone. Close one and try again.";
  return fallback || "Couldn't open the video.";
}

const q = (id: string) => encodeURIComponent(id);
const source = (id: string, low: boolean): StreamSource => ({
  seekPoint: async (_p, t, a = 0) => {
    try {
      const r = await fetch(`/api/remote/watch/seekpoint?id=${q(id)}&t=${t.toFixed(3)}${low ? "&q=low" : ""}${a ? `&a=${a}` : ""}`);
      return parseSeekPoint(await r.json(), t);
    } catch { return { start: t, mode: "transcode" }; }
  },
  streamUrl: (_p, t, level = true, a = 0, mode) => `/api/remote/watch/stream?id=${q(id)}&t=${t.toFixed(3)}${level ? "" : "&level=0"}${low ? "&q=low" : ""}${a ? `&a=${a}` : ""}${mode === "transcode" ? "&mode=transcode" : ""}`,
});

const LOCK_KEY = "ciroom.phone.portraitlock";
const HINT_KEY = "ciroom.phone.fshint";
const readFlag = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const saveFlag = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? "1" : "0"); } catch { /* private mode: not remembered */ } };
type Orientable = { lock?: (o: string) => Promise<void> };

/** Follows a CSS media query (the phone's orientation) live. */
function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/** Height of an element, kept up to date (so the subtitle can sit exactly above the controls, on any phone). */
function useHeight(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  // Runs after every render on purpose: the height must follow any layout change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  });
  return [ref, h];
}

const post = (url: string, body: unknown, keepalive = false) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive }).then(
    async (r) => ({ ok: r.ok, status: r.status, error: ((await r.json().catch(() => ({}))) as { error?: string }).error }),
    () => ({ ok: false, status: 0, error: undefined as string | undefined }),
  );

/** What the PC says it is playing (from /api/remote/events). */
export interface PcNow { id: string | null; paused: boolean; position: number }

export function PhonePlayer({ id: firstId, startAt, user, pc, onClose, onLost }: { id: string; startAt: number; user: PhoneUser | null; pc: PcNow | null; onClose: () => void; onLost: () => void }) {
  const lib = useLibrary((s) => s.data);
  const [curId, setCurId] = useState(firstId);
  const [reload, setReload] = useState(0); // bumps to rebuild the player at the current spot (quality change)
  const [quality, setQuality] = useState<Quality>(readQuality);
  const [probe, setProbe] = useState<PhoneProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [subs, setSubs] = useState(-1);
  const [audio, setAudio] = useState(0);
  const [full, setFull] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [takenByPc, setTakenByPc] = useState(false); // the PC started this video: this phone paused and offers "Continue here"

  const portrait = useMediaQuery("(orientation: portrait)");
  const [portraitLock, setPortraitLock] = useState(() => readFlag(LOCK_KEY)); // full screen stays portrait
  const [lockOk, setLockOk] = useState(() => typeof (screen.orientation as Orientable | undefined)?.lock === "function");
  const [hint, setHint] = useState(false);
  const [stageRef, stageH] = useHeight();
  const [topRef, topH] = useHeight();
  const [barRef, barH] = useHeight();
  const [cueRef, cueH] = useHeight();

  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const probeRef = useRef<PhoneProbe | null>(null);
  const idRef = useRef(curId);
  const startRef = useRef(startAt); // where the next (re)build starts
  const watched = useRef(0); // seconds really played since the last report
  const hideTimer = useRef<number>();
  const titleKey = useCallback((id: string) => (lib?.movies.some((m) => m.id === id) ? id : lib ? findEpisode(lib, id)?.series.id ?? id : id), [lib]);
  idRef.current = curId;
  const pcRef = useRef(pc);
  pcRef.current = pc;
  const pcAt = useRef(Date.now()); // when the PC's position was last heard (it keeps moving while the PC plays)
  const elsewhere = useRef(false); // while true this phone must not save progress (the PC has the newer position)

  const wake = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!video.current?.paused) setControls(false); }, 3000);
  }, []);
  const say = useCallback((m: string) => { setNote(m); window.setTimeout(() => setNote((n) => (n === m ? null : n)), 3500); }, []);

  /** Progress through the PC window. `final`: the last save of this moment (pause, close, hide), allowed to come sooner. */
  const { save: report, markSaved } = useProgressSaver({
    startAt, resetKey: curId, saveOnHide: true,
    getPosition: () => { const v = video.current, p = probeRef.current; return v && p ? Math.max(0, Math.min(v.currentTime, p.duration)) : 0; },
    isPlaying: () => !!video.current && !video.current.paused,
    blocked: () => elsewhere.current,
    hasPending: () => Math.round(watched.current) > 0,
    save: async (pos, final) => {
      const p = probeRef.current;
      if (!p || !p.duration) return true;
      const w = Math.min(120, Math.round(watched.current));
      if (pos < 1 && w === 0) return true;
      const body = { id: idRef.current, position: pos, duration: p.duration, watched: w, final };
      let r = await post("/api/remote/progress", body, true);
      if (!r.ok && r.status === 429 && final) { await new Promise((res) => setTimeout(res, 650)); r = await post("/api/remote/progress", body, true); }
      if (r.ok) watched.current = Math.max(0, watched.current - w);
      return r.ok;
    },
  });

  /** One screen at a time: tell the PC whether this phone is playing (it pauses its own player when the phone starts). */
  const sendState = useCallback((playing: boolean, keepalive = false) => {
    const v = video.current, p = probeRef.current;
    if (!v || !p) return;
    void post("/api/remote/state", { id: idRef.current, position: Math.max(0, Math.min(v.currentTime, p.duration || v.currentTime)), playing }, keepalive);
  }, []);

  // ── Load the probe (again when the episode or the quality changes); the engine builds the stream from it ──
  const low = quality === "low";
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setEnded(false); setProbe(null);
    (async () => {
      let res: Response;
      try { res = await fetch(`/api/remote/watch/probe?id=${q(curId)}`); } catch { if (alive) { setError(explain(0)); setLoading(false); } return; }
      if (!alive) return;
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (res.status === 401) onLost();
        setError(explain(res.status, (d as { error?: string }).error)); setLoading(false);
        return;
      }
      const p = (await res.json()) as PhoneProbe;
      if (!alive) return;
      const mime = low ? lowStreamMime(p) : streamMime(p);
      if (!MseStream.supported(mime)) { setError("This browser can't play this video. Try Chrome."); setLoading(false); return; }
      probeRef.current = p;
      const key = titleKey(curId);
      const aIdx = startAudio(p.audioTracks ?? [], user?.audioPrefs?.[key]);
      const sIdx = startSubtitle(p.subtitles, user?.subPrefs?.[key], user?.prefs);
      setAudio(aIdx); engine.setAudioIdx(aIdx); setSubs(sIdx);
      markSaved(Math.max(0, Math.min(startRef.current, Math.max(0, p.duration - 5))));
      setProbe(p);
    })();
    return () => { alive = false; };
    // user is read once per video: later changes (our own progress echoing back) must not rebuild the player
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, quality, reload]);

  const engine = usePlaybackEngine({
    videoRef: video, path: "", info: probe, mime: probe ? (low ? lowStreamMime(probe) : streamMime(probe)) : undefined,
    source: useMemo(() => source(curId, low), [curId, low]),
    getStartAt: () => (probeRef.current ? Math.max(0, Math.min(startRef.current, Math.max(0, probeRef.current.duration - 5))) : 0),
    level: true, audio: 0,
    onError: (msg) => {
      const text = msg.replace(/ or use the full player\.?|Try the full player\.?/g, "").trim();
      // A stream that dies because phones were switched off (another network) deserves the real reason.
      fetch("/api/remote/me").then((r) => setError(r.status === 403 ? explain(403) : text), () => setError(text));
    },
    onStarted: () => { setLoading(false); void video.current?.play().catch(() => setNeedsTap(true)); },
  });

  // Subtitle cues for the chosen track.
  const subFile = probe && subs >= 0 ? probe.subtitles.find((x) => x.index === subs) : undefined;
  const { cues, error: subError } = useCues(
    probe && subs >= 0
      ? async () => {
          const r = await fetch(`/api/remote/watch/subtitle.vtt?id=${q(curId)}&${subFile?.embedded ? `e=${subFile.stream}` : `i=${subs}`}`);
          if (!r.ok) throw new Error();
          return parseVtt(await r.text());
        }
      : null,
    [probe, subs, curId],
    true,
  );
  const cue = useActiveCue(video, cues, 0, 0);

  // Clock: current time, subtitle line, watch time.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let lastT = -1;
    const tick = window.setInterval(() => {
      const t = v.currentTime;
      setTime(t);
      if (!v.paused && !v.ended && v.readyState >= 3 && lastT >= 0 && t > lastT && t - lastT < 2) watched.current += 1;
      lastT = t;
    }, 1000);
    const fast = window.setInterval(() => { const t = v.currentTime; setTime(t); }, 250);
    return () => { window.clearInterval(tick); window.clearInterval(fast); };
  }, []);

  // Is the PC still reachable? (The video keeps playing from what is loaded, so tell the user why it will stop.)
  useEffect(() => {
    let misses = 0;
    const t = window.setInterval(async () => {
      try {
        const r = await fetch("/api/remote/me");
        misses = r.status === 403 ? 2 : 0;
        if (r.status === 403) setError(explain(403));
      } catch { if (++misses >= 2) setError(explain(0)); }
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  // Playing state every 5 s while playing; on close or hide the PC is told this phone stopped. (Progress itself: useProgressSaver.)
  useEffect(() => {
    const beat = window.setInterval(() => { if (video.current && !video.current.paused) sendState(true); }, 5_000);
    const gone = () => sendState(false, true);
    window.addEventListener("pagehide", gone);
    return () => { window.clearInterval(beat); window.removeEventListener("pagehide", gone); };
  }, [sendState]);

  // The PC started playing this video (its play button, Space, Send to PC…): this phone has the older position, playing or
  // paused. Pause if playing, stop saving, and offer "Continue here". Edge only (paused → playing), so they can't ping-pong.
  const pcPlaying = !!pc && pc.id === curId && !pc.paused;
  const pcWasPlaying = useRef(pcPlaying); // already playing when this player opened: not an edge (opening it here takes over)
  useEffect(() => { pcAt.current = Date.now(); }, [pc?.position, pc?.paused, pc?.id]);
  useEffect(() => {
    const was = pcWasPlaying.current;
    pcWasPlaying.current = pcPlaying;
    if (!pcPlaying || was) return;
    const v = video.current;
    if (v && !v.paused) {
      void report(true); // the last save of this phone (the PC continues from here), then no more saves
      v.pause();
      sendState(false);
    }
    elsewhere.current = true;
    setTakenByPc(true); setControls(true);
  }, [pcPlaying, report, sendState]);
  useEffect(() => { elsewhere.current = false; setTakenByPc(false); }, [curId]);

  // Fullscreen state, and landscape while in it (Android Chrome allows the lock only in fullscreen).
  useEffect(() => {
    const on = () => {
      const f = document.fullscreenElement === box.current;
      setFull(f);
      if (!f) { try { screen.orientation.unlock(); } catch { /* not supported */ } }
    };
    document.addEventListener("fullscreenchange", on);
    return () => { document.removeEventListener("fullscreenchange", on); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); };
  }, []);
  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      await box.current?.requestFullscreen();
      try { await (screen.orientation as Orientable).lock?.(readFlag(LOCK_KEY) ? "portrait" : "landscape"); } catch { /* the phone may not allow it */ }
    } catch { say("This browser didn't allow fullscreen."); }
  };
  /** In full screen: switch between landscape and portrait. The choice is remembered. */
  const toggleLock = async () => {
    const to = !portraitLock;
    try { await (screen.orientation as Orientable).lock?.(to ? "portrait" : "landscape"); setPortraitLock(to); saveFlag(LOCK_KEY, to); }
    catch { setLockOk(false); } // this phone/browser can't lock: hide the button
  };

  // Rotated to landscape while not in full screen: the player fills the screen; a browser can't go full screen by itself, so hint once.
  useEffect(() => {
    if (portrait || full || readFlag(HINT_KEY)) { setHint(false); return; }
    saveFlag(HINT_KEY, true); setHint(true);
    const t = window.setTimeout(() => setHint(false), 3000);
    return () => window.clearTimeout(t);
  }, [portrait, full]);

  const duration = probe?.duration ?? 0;
  const shown = drag ?? time;
  const seekTo = (t: number) => { const to = Math.max(0, Math.min(duration - 0.5, t)); engine.mseRef.current?.seek(to); setTime(to); wake(); };
  /** "Continue here": take the PC's live position (if it shows this video), then play. Playing pauses the PC. */
  const continueHere = () => {
    const v = video.current;
    if (!v) return;
    const p = pcRef.current;
    elsewhere.current = false; setTakenByPc(false);
    if (p && p.id === idRef.current && Number.isFinite(p.position)) {
      const there = p.position + (p.paused ? 0 : Math.max(0, (Date.now() - pcAt.current) / 1000));
      if (Math.abs(there - v.currentTime) > 2) { seekTo(there); markSaved(there); }
    }
    void v.play().catch(() => setNeedsTap(true));
    wake();
  };
  const toggle = () => { const v = video.current; if (!v) return; if (elsewhere.current) { continueHere(); return; } if (v.paused) void v.play().catch(() => setNeedsTap(true)); else v.pause(); wake(); };

  const close = async () => { video.current?.pause(); await report(true); sendState(false, true); onClose(); };
  /** Play another episode on the phone (Next episode, the up-next card, the season list). A different id, so the PC isn't touched. */
  const goTo = async (id: string) => {
    video.current?.pause();
    await report(true);
    sendState(false, true);
    startRef.current = 0;
    setCurId(id);
  };
  const sendToPc = async () => {
    video.current?.pause();
    const saved = await report(true);
    sendState(false, true);
    if (!saved) { say(explain(0)); return; }
    const r = await post("/api/remote/cmd", { cmd: "play", id: curId });
    if (!r.ok) { say(r.status === 409 ? "CiRoom isn't open on the PC." : explain(r.status, r.error)); void video.current?.play().catch(() => undefined); return; }
    onClose();
  };
  const pickSub = (i: number) => {
    setSubs(i); setMenu(null);
    const pref = subPrefFor(probe?.subtitles ?? [], i);
    if (pref) void post("/api/remote/cmd", { cmd: "subPref", id: curId, pref });
  };
  const pickAudio = (i: number) => { setAudio(i); setMenu(null); engine.mseRef.current?.setAudio(i); };
  const pickQuality = (qv: Quality) => {
    setMenu(null);
    if (qv === quality) return;
    startRef.current = video.current?.currentTime ?? 0;
    saveQuality(qv); setQuality(qv); setReload((n) => n + 1);
  };

  const title = probe ? [probe.title, probe.subtitle].filter(Boolean).join(" · ") : "";
  const nearEnd = !!probe?.nextId && (ended || (duration > 0 && duration - time < 25));
  const tracks = probe?.audioTracks ?? [];

  const compact = portrait && !full; // portrait page: video on top, details below
  const season = lib && !lib.movies.some((m) => m.id === curId) ? findEpisode(lib, curId) : undefined;
  const seasonEps = season ? (season.series.seasons.find((x) => x.number === season.episode.season)?.episodes ?? []).filter((e) => e.file) : [];
  const upNext = probe?.nextId && lib ? findEpisode(lib, probe.nextId) : undefined;

  // The subtitle's bottom edge sits just above the control bar while the controls show (measured, not guessed).
  const cueBottom = controls ? barH + 8 : compact ? 10 : 28;
  const centreY = topH + (stageH - topH - barH) / 2; // the ±10/play row is centred between the top bar and the bottom bar
  const cueTop = stageH - cueBottom - cueH;
  // Short screens: if the subtitle would reach the ±10 buttons, drop those (the play button stays).
  const hideSide = !compact && !!cue && controls && cueH > 0 && cueTop < centreY + 32 + 4;
  // The small portrait video has no free middle: with a subtitle showing, the button row moves up into the space above it.
  const lift = compact && !!cue && controls && cueH > 0 ? Math.max(4, cueTop / 2 - 28) : null;

  const tools = (
    <>
      {probe && probe.subtitles.length > 0 && <Tool label="Subtitles" on={subs >= 0} onClick={() => setMenu("subs")}><Captions size={22} /></Tool>}
      {tracks.length > 1 && <Tool label="Audio" onClick={() => setMenu("audio")}><AudioLines size={22} /></Tool>}
      <Tool label="Quality" on={quality === "low"} onClick={() => setMenu("quality")}><Gauge size={22} /></Tool>
    </>
  );

  return (
    <div ref={box} className={cx("fixed inset-0 z-[60] select-none text-white", compact ? "overflow-y-auto overflow-x-hidden bg-bg text-fg" : "overflow-hidden bg-black")} onPointerMove={wake}>
      {/* The stage keeps the same <video> in both layouts (rotating must not restart the stream). */}
      <div className={cx(compact ? "sticky top-0 z-10 aspect-video w-full bg-black pt-[env(safe-area-inset-top)]" : "absolute inset-0")} style={compact ? { boxSizing: "content-box" } : undefined}>
      <div ref={stageRef} className="absolute inset-0 overflow-hidden" style={compact ? { top: "env(safe-area-inset-top)" } : undefined}>
      <video
        ref={video} playsInline preload="auto" className="absolute inset-0 h-full w-full bg-black object-contain"
        onClick={() => { if (menu) setMenu(null); else if (controls && !paused) setControls(false); else wake(); }}
        onPlay={() => { setPaused(false); setNeedsTap(false); setEnded(false); wake(); sendState(true); }}
        onPause={() => { setPaused(true); setControls(true); if (!video.current?.ended) void report(true); sendState(false); }}
        onEnded={() => { setEnded(true); setControls(true); void report(true); }}
        onWaiting={() => engine.mseRef.current?.onWaiting()}
      />

      {cue && <div ref={cueRef} dir="auto" className="pointer-events-none absolute inset-x-3 text-center transition-[bottom] duration-200" style={{ bottom: cueBottom }}><span className={cx("mx-auto line-clamp-2 w-fit max-w-full whitespace-pre-line rounded bg-black/70 px-2 py-1 leading-snug", compact ? "text-[clamp(13px,3.6vw,18px)]" : "text-[clamp(15px,3.8vw,22px)]")}>{cue}</span></div>}

      {(loading || (!error && !paused && video.current && video.current.readyState < 3)) && !error && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin" size={compact ? 32 : 44} /></div>}

      {needsTap && !error && !loading && (
        <button onClick={toggle} className="absolute inset-0 flex items-center justify-center bg-black/50" aria-label="Play"><span className="flex h-20 w-20 items-center justify-center rounded-full bg-accent text-accent-ink"><Play size={34} fill="currentColor" className="ml-1" /></span></button>
      )}

      {error && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-black/85 px-6 text-center">
          <p className={cx("max-w-xs leading-6", compact ? "text-[14px] leading-5" : "text-[17px]")}>{error}</p>
          <div className="flex gap-3">
            <button onClick={() => { startRef.current = video.current?.currentTime ?? startRef.current; setReload((n) => n + 1); }} className="h-11 rounded-full bg-white/[.14] px-6 text-sm font-semibold">Try again</button>
            <button onClick={() => void close()} className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink">Back</button>
          </div>
        </div>
      )}

      {nearEnd && !error && (
        <button onClick={() => void goTo(probe!.nextId!)} className={cx("absolute right-3 flex items-center gap-2 rounded-full bg-white font-bold text-black shadow-lift active:scale-95", compact ? "h-9 px-4 text-[13px]" : "h-12 px-5 text-[15px]", controls ? (compact ? "bottom-14" : "bottom-32") : "bottom-6")}>
          <SkipForward size={compact ? 15 : 18} fill="currentColor" /> Next episode
        </button>
      )}

      {takenByPc && !error && (
        <div role="status" onClick={continueHere} className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 bg-black/80 px-8 text-center">
          <MonitorUp size={compact ? 28 : 40} />
          <p className={cx("font-semibold", compact ? "text-[16px]" : "text-[19px]")}>Playing on PC</p>
          <button onClick={(e) => { e.stopPropagation(); continueHere(); }} className="h-11 rounded-full bg-accent px-7 text-[15px] font-semibold text-accent-ink active:scale-95">Continue here</button>
        </div>
      )}

      {hint && !compact && !full && <div className="pointer-events-none absolute inset-x-6 top-16 mx-auto max-w-xs rounded-2xl bg-surface-3 px-4 py-2 text-center text-sm shadow-lift">Tap <Maximize size={14} className="inline" /> for full screen</div>}

      <div className={cx("absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/70 via-transparent to-black/80 transition-opacity duration-200 pointer-events-none", controls ? "opacity-100" : "invisible opacity-0")}>
        {/* top */}
        <div ref={topRef} className={cx("pointer-events-auto flex items-center gap-3", compact ? "px-2 pt-2" : "px-4 pt-[max(12px,env(safe-area-inset-top))]")}>
          <button aria-label="Close" onClick={() => void close()} className={cx("flex items-center justify-center rounded-full bg-black/40 active:scale-90", compact ? "h-10 w-10" : "h-12 w-12")}><X size={compact ? 22 : 26} /></button>
          {!compact && <div className="min-w-0 flex-1"><div className="truncate text-[16px] font-semibold">{title}</div>{quality === "low" && <div className="text-xs text-white/70">Low data (480p)</div>}</div>}
          {compact && <div className="flex-1" />}
          {!compact && <button aria-label="Send to the PC" onClick={() => void sendToPc()} className="flex h-12 items-center gap-2 rounded-full bg-black/40 px-4 text-sm font-semibold active:scale-95"><MonitorUp size={20} /> <span className="hidden min-[400px]:inline">Send to PC</span></button>}
        </div>
        {/* centre */}
        <div className={cx("pointer-events-auto flex items-center justify-center", compact ? "gap-8" : "gap-10", lift !== null && "absolute inset-x-0")} style={lift !== null ? { top: lift } : undefined}>
          {!hideSide && <button aria-label="Back 10 seconds" onClick={() => seekTo((video.current?.currentTime ?? 0) - 10)} className={cx("relative flex items-center justify-center rounded-full bg-black/40 active:scale-90", compact ? "h-12 w-12" : "h-16 w-16")}><RotateCcw size={compact ? 26 : 34} strokeWidth={1.8} /><small className="absolute text-[10px] font-bold">10</small></button>}
          <button aria-label={paused ? "Play" : "Pause"} onClick={toggle} className={cx("flex items-center justify-center rounded-full bg-accent text-accent-ink shadow-lift active:scale-95", compact ? "h-14 w-14" : "h-20 w-20")}>{paused ? <Play size={compact ? 26 : 34} fill="currentColor" className="ml-1" /> : <Pause size={compact ? 26 : 34} fill="currentColor" />}</button>
          {!hideSide && <button aria-label="Forward 10 seconds" onClick={() => seekTo((video.current?.currentTime ?? 0) + 10)} className={cx("relative flex items-center justify-center rounded-full bg-black/40 active:scale-90", compact ? "h-12 w-12" : "h-16 w-16")}><RotateCw size={compact ? 26 : 34} strokeWidth={1.8} /><small className="absolute text-[10px] font-bold">10</small></button>}
        </div>
        {/* bottom */}
        <div ref={barRef} className={cx("pointer-events-auto", compact ? "px-3 pb-1" : "px-5 pb-[max(14px,env(safe-area-inset-bottom))]")}>
          <input
            type="range" min={0} max={Math.max(1, Math.floor(duration))} step={1} value={Math.min(shown, duration || shown)} aria-label="Position" className="remote-range w-full"
            style={{ ["--p" as string]: `${duration ? (shown / duration) * 100 : 0}%` }}
            onChange={(e) => { setDrag(Number(e.target.value)); wake(); }}
            onPointerUp={() => { if (drag !== null) { seekTo(drag); setDrag(null); } }}
            onKeyUp={() => { if (drag !== null) { seekTo(drag); setDrag(null); } }}
          />
          <div className="flex items-center justify-between text-xs tabular-nums text-white/80">
            <span>{timecode(shown)} / {timecode(duration)}</span>
            <div className="flex items-center gap-1">
              {!compact && tools}
              {full && lockOk && <Tool label={portraitLock ? "Landscape full screen" : "Portrait full screen"} on={portraitLock} onClick={toggleLock}>{portraitLock ? <RectangleVertical size={22} /> : <RectangleHorizontal size={22} />}</Tool>}
              <Tool label={full ? "Exit fullscreen" : "Fullscreen"} onClick={() => void toggleFull()}>{full ? <Minimize size={22} /> : <Maximize size={22} />}</Tool>
            </div>
          </div>
        </div>
      </div>
      </div>
      </div>

      {note && <div role="status" className="pointer-events-none fixed inset-x-6 top-20 z-20 mx-auto max-w-sm rounded-2xl bg-surface-3 px-4 py-3 text-center text-sm text-fg shadow-lift">{note}</div>}

      {compact && (
        <div className="px-5 pb-[max(28px,env(safe-area-inset-bottom))] pt-4">
          <h1 className="font-display text-[22px] font-semibold leading-tight">{probe?.title ?? ""}</h1>
          {probe?.subtitle && <p className="meta mt-1 text-[15px]">{probe.subtitle}</p>}
          {quality === "low" && <p className="meta mt-1 text-xs">Low data (480p)</p>}
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            {probe && probe.subtitles.length > 0 && <Big icon={<Captions size={20} />} on={subs >= 0} onClick={() => setMenu("subs")}>Subtitles</Big>}
            {tracks.length > 1 && <Big icon={<AudioLines size={20} />} onClick={() => setMenu("audio")}>Audio</Big>}
            <Big icon={<Gauge size={20} />} on={quality === "low"} onClick={() => setMenu("quality")}>Quality</Big>
            <Big icon={<MonitorUp size={20} />} onClick={() => void sendToPc()}>Send to PC</Big>
          </div>
          {upNext && (
            <div className="mt-5">
              <div className="mb-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Up next</div>
              <button onClick={() => void goTo(upNext.episode.id)} className="flex w-full items-center gap-3 rounded-2xl bg-white/[.07] p-3 text-left active:scale-[.99]">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink"><Play size={20} fill="currentColor" className="ml-0.5" /></span>
                <span className="min-w-0"><span className="block truncate text-[15px] font-semibold">{upNext.episode.title}</span><span className="meta block text-[13px]">{episodeCode(upNext.episode.season, upNext.episode.number)}</span></span>
              </button>
            </div>
          )}
          {season && seasonEps.length > 1 && (
            <div className="mt-5">
              <div className="mb-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Season {season.episode.season}</div>
              {seasonEps.map((e) => (
                <button key={e.id} onClick={() => e.id !== curId && void goTo(e.id)} className={cx("mb-1.5 flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px]", e.id === curId ? "bg-accent text-accent-ink" : "bg-white/[.05]")}>
                  <span className="w-8 shrink-0 text-[13px] font-semibold tabular-nums opacity-70">{e.number}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                  {e.id === curId && <span className="text-xs font-semibold">Playing</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {menu && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/50 text-white" onClick={() => setMenu(null)}>
          <div className="max-h-[70%] w-full overflow-y-auto rounded-t-3xl bg-surface-2 p-4 pb-[max(16px,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            {menu === "subs" && (
              <>
                <Heading>Subtitles</Heading>
                <Choice selected={subs < 0} onClick={() => pickSub(-1)}>Off</Choice>
                {(probe?.subtitles ?? []).map((s) => <Choice key={`${s.embedded ? "e" : "f"}${s.index}`} selected={subs === s.index} onClick={() => pickSub(s.index)}>{s.label || `Subtitle ${s.index + 1}`}</Choice>)}
                {subError && subs >= 0 && <p className="mt-2 text-sm text-danger">This subtitle couldn't be read. Try another one.</p>}
                <p className="mt-3 text-xs text-white/60">Your choice is used for every episode of this series, on the PC too.</p>
              </>
            )}
            {menu === "audio" && (
              <>
                <Heading>Audio</Heading>
                {tracks.map((a) => <Choice key={a.index} selected={audio === a.index} onClick={() => pickAudio(a.index)}>{audioLabel(a)}</Choice>)}
              </>
            )}
            {menu === "quality" && (
              <>
                <Heading>Quality</Heading>
                <Choice selected={quality === "orig"} onClick={() => pickQuality("orig")}>Original</Choice>
                <Choice selected={quality === "low"} onClick={() => pickQuality("low")}>Low data (480p)</Choice>
                <p className="mt-3 text-xs text-white/60">Low data uses less of your connection but makes the PC work harder.</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const Big = ({ icon, on, onClick, children }: { icon: React.ReactNode; on?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className={cx("flex h-14 items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold active:scale-[.98]", on ? "bg-accent text-accent-ink" : "bg-white/[.08]")}>{icon}{children}</button>
);
const Heading = ({ children }: { children: string }) => <div className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-white/60">{children}</div>;
const Choice = ({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className={cx("mb-1.5 flex min-h-12 w-full items-center rounded-xl px-4 py-2 text-left text-[15px] font-medium", selected ? "bg-accent text-accent-ink" : "bg-white/[.07]")}>{children}</button>
);
const Tool = ({ label, on, onClick, children }: { label: string; on?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button aria-label={label} onClick={onClick} className={cx("flex h-11 w-11 items-center justify-center rounded-full active:scale-90", on ? "text-accent" : "text-white")}>{children}</button>
);
