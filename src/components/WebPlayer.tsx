import {
  ArrowLeft, Captions, ChevronsRight, Loader2, Maximize, Minimize, MonitorPlay, Pause, Play, RotateCcw,
  RotateCw, Settings, SkipForward, X, Maximize2,
} from "lucide-react";
import { registerWebController } from "@/store/webControl";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Markers, streamApi, type ProbeInfo } from "@/api/stream";
import { timecode } from "@/lib/format";
import { SubtitleFinder } from "./SubtitleFinder";
import { audioLabel, startAudio } from "@/player/audio";
import { CtrlButton, EndScreen, Volume } from "@/player/PlayerControls";
import { SettingsPanel, type MenuPage } from "@/player/PlayerMenus";
import { PlayerClock, SeekBar } from "@/player/SeekBar";
export { audioLabel, startAudio };
import type { SearchContext } from "@/api/subsearch";
import { usePlayback } from "@/store/playback";
import { isElsewhere, takeBack } from "@/lib/oneScreen";
import { pickSubtitle, startSubtitle, subPrefFor, useSettings } from "@/store/settings";
import { useUser } from "@/store/user";
import { usePlaybackEngine } from "@/player/usePlaybackEngine";
import { useProgressSaver } from "@/player/useProgressSaver";
import { useActiveCue, useCues } from "@/player/useSubtitles";
import { cx } from "./ui";
import { inDesktopShell } from "@/lib/windowFullscreen";
import { reportServerTrouble } from "@/lib/serverHealth";

const SUB_SCALE = { S: 0.8, M: 1, L: 1.3, XL: 1.7 } as const;
const HIDE_MS = 2500;

export interface WebPlayerProps {
  id: string; // playable id (movie or episode): progress + subtitle delay are stored under it
  titleId?: string; // movie id or series id: watch time is counted under it (Stats)
  /** Mini player: a small corner window with minimal controls (the watch page is elsewhere). */
  mini?: boolean;
  onExpand?: () => void; // mini: back to the watch page
  onClose?: () => void; // mini: stop and dismiss
  find?: SearchContext; // what to search online for (omitted → no "Find subtitles")
  path: string; // library path of the video
  title: string;
  startAt: number;
  fallbackDuration: number; // seconds, from metadata (until the probe answers)
  next?: { label: string; onPlay: () => void };
  onOpenFull?: (position: number, duration: number) => void; // omitted on phones (mpv runs on the PC)
}

/**
 * The watch page's in-page player. The browser can't play .mkv, so the dev bridge streams
 * fragmented MP4 from ffmpeg (copy for H.264/AAC, transcode otherwise). Every seek-bar
 * jump restarts the stream (the pipe isn't seekable) at the keyframe before the target; `offset` is measured.
 */
export function WebPlayer({ id, titleId, path, title, startAt, fallbackDuration, next, onOpenFull, mini = false, onExpand, onClose, find }: WebPlayerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const savePosition = useUser((s) => s.savePosition);
  const volumePref = useUser((s) => s.volume);
  const pageVolume = Math.min(volumePref, 100); // the page player stops at 100; only mpv goes up to 130
  const setVolumePref = useUser((s) => s.setVolume);
  const subDelay = useUser((s) => s.subDelays[id] ?? 0);
  const setSubDelay = useUser((s) => s.setSubDelay);
  const addWatchTime = useUser((s) => s.addWatchTime);
  const prefKey = titleId ?? id; // subtitle choice is remembered per series (or movie)
  const { autoplayNext, upNextSeconds } = useSettings();

  const [info, setInfo] = useState<ProbeInfo | null>(null);
  const [lateGain, setLateGain] = useState<number | undefined>(undefined); // measured after the first probe
  const [subList, setSubList] = useState<ProbeInfo["subtitles"]>([]);
  const [finder, setFinder] = useState(false);
  const [time, setTime] = useState(startAt); // absolute current time, whole seconds only: for the up-next card, skip buttons and such (the clock and seek bar read the clock store)
  const [playing, setPlaying] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const muted = useSettings((s) => s.muted);
  const speed = useSettings((s) => s.playbackSpeed);
  const subStyle = useSettings((s) => s.subtitleStyle);
  const setMuted = (m: boolean | ((m: boolean) => boolean)) => useSettings.getState().set({ muted: typeof m === "function" ? m(useSettings.getState().muted) : m });
  const setSpeed = (v: number) => useSettings.getState().set({ playbackSpeed: v });
  const [realFs, setFullscreen] = useState(false); // the browser's real fullscreen
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<null | MenuPage>(null);
  const [subIndex, setSubIndex] = useState(-1);
  const [ended, setEnded] = useState(false);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const hideTimer = useRef<number>();
  const timeRef = useRef(startAt);
  // Should the video be playing? True at the start and after any play; false once the user (or the party host) pauses.
  // A seek fires `canplay` again, and that must not un-pause a paused video.
  const wantPlay = useRef(true);
  useEffect(() => { wantPlay.current = true; }, [path]); // a new file starts playing

  const duration = info?.duration || fallbackDuration;
  const levelling = useUser((s) => s.levelling);
  const setLevelling = useUser((s) => s.setLevelling);
  // The playback engine owns the <video> source (MediaSource or the plain stream) and the seek bookkeeping: src/player/usePlaybackEngine.ts.
  // All times shown are offset + currentTime, so the bar, clock and subtitles match the picture.
  const engine = usePlaybackEngine({ videoRef, path, info, getStartAt: () => startAt, level: levelling, audio: 0, allowPipe: true });
  const { mode, src, offset, offsetRef, pending, mseRef, clock, waiting, setWaiting, error, setError, audioIdx, setAudioIdx } = engine;

  // ── File info (duration, subtitles) ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    streamApi.probe(path).then(
      (p) => { if (!alive) return; setAudioIdx(startAudio(p.audioTracks ?? [], useUser.getState().audioPrefs[prefKey])); setInfo(p); setSubList(p.subtitles); setSubIndex(startSubtitle(p.subtitles, useUser.getState().subPrefs[prefKey])); },
      (e) => alive && setError(e instanceof Error ? e.message : "Could not read this video."),
    );
    return () => { alive = false; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // The loudness is measured in the background after the first play: ask once more after ~10 s to show the number.
  useEffect(() => {
    setLateGain(undefined);
    if (!info || info.levelGainDb !== undefined) return;
    const t = setTimeout(() => { streamApi.probe(path).then((p) => setLateGain(p.levelGainDb), () => {}); }, 10_000);
    return () => clearTimeout(t);
  }, [info, path]);

  // A subtitle picked by the user (menu, C key, button, phone, "Use" in the finder) is remembered for the
  // whole series, so the next episodes open with the same language. Automatic picks are not remembered.
  const subListRef = useRef(subList);
  subListRef.current = subList;
  const chooseSub = useCallback((index: number, list = subListRef.current) => {
    setSubIndex(index);
    const pref = subPrefFor(list, index);
    if (pref) useUser.getState().setSubPref(prefKey, pref);
  }, [prefKey]);
  const subIndexRef = useRef(subIndex);
  subIndexRef.current = subIndex;
  /** C key / CC button: off → the remembered language (else the Settings order, else the first file); on → off. */
  const toggleSubs = useCallback(() => {
    const list = subListRef.current;
    if (subIndexRef.current >= 0) return chooseSub(-1);
    const pref = useUser.getState().subPrefs[prefKey];
    const on = pref && !pref.off ? startSubtitle(list, pref) : pickSubtitle(list, useSettings.getState().subtitleLanguages, true);
    chooseSub(on >= 0 ? on : list[0]?.index ?? -1);
  }, [prefKey, chooseSub]);

  const { cues, error: subError } = useCues(
    subIndex < 0 ? null : () => streamApi.subtitles(path, subListRef.current.find((s) => s.index === subIndex) ?? { index: subIndex }),
    [path, subIndex],
  );

  // ── Video element wiring ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.min(volumePref, 100) / 100;
  }, [volumePref]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, src]);

  // Subtitles found online appear without restarting the stream: re-read the list and (optionally) select the new one.
  const refreshSubs = useCallback(async (select?: string) => {
    const p = await streamApi.probe(path);
    setSubList(p.subtitles);
    const hit = select ? p.subtitles.find((s) => s.name === select) : undefined;
    if (hit) chooseSub(hit.index, p.subtitles);
    else setSubIndex(startSubtitle(p.subtitles, useUser.getState().subPrefs[prefKey]));
  }, [path, prefKey, chooseSub]);

  // The watch page's "Find subtitles" button.
  const finderRequest = usePlayback((s) => s.finderRequest);
  const lastRequest = useRef(finderRequest);
  useEffect(() => {
    if (finderRequest !== lastRequest.current) { lastRequest.current = finderRequest; if (find && !mini) setFinder(true); }
  }, [finderRequest, find, mini]);

  const playingRef = useRef(false);
  playingRef.current = playing;
  const { save: saveNow } = useProgressSaver({
    startAt, resetKey: id, saveOnUnmount: true,
    getPosition: () => timeRef.current,
    isPlaying: () => playingRef.current,
    blocked: () => isElsewhere(id), // a phone has this title: our older position must not rewind its progress
    save: (pos) => { if (duration > 0) savePosition(id, pos, duration); else return false; },
  });
  const save = useCallback(() => { void saveNow(); }, [saveNow]);

  // Real watch time for Stats: whole seconds while the video is actually playing, flushed every 15 s and on leave.
  const watched = useRef(0);
  useEffect(() => {
    const flush = () => { if (watched.current > 0) { addWatchTime(titleId ?? id, watched.current); watched.current = 0; } };
    const t = window.setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused && !v.ended && v.readyState >= 3) watched.current += 1;
      if (watched.current >= 15) flush();
    }, 1000);
    return () => { window.clearInterval(t); flush(); };
  }, [id, titleId, addWatchTime]);

  const updateBuffered = engine.updateBuffered;

  const onTimeUpdate = () => {
    const v = videoRef.current!;
    if (pending.current !== null) return; // a seek is in flight: keep showing its target time
    const t = offset + v.currentTime;
    timeRef.current = t;
    clock.set({ time: t });
    setTime(Math.floor(t));
    updateBuffered();
  };

  const cueText = useActiveCue(videoRef, cues, offset, subDelay);

  // ── Controls visibility ───────────────────────────────────────────────────────────────────
  const poke = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControls(false), HIDE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const showControls = controls || !playing || !!menu || ended || needsGesture;

  // Up next: a card in the last seconds (like a streaming service), then the next episode starts by itself.
  const remaining = duration - time;
  const autoNext = !!next && autoplayNext && !upNextDismissed;
  const showUpNext = autoNext && !mini && !ended && duration > 0 && remaining > 0 && remaining <= upNextSeconds && !waiting;
  useEffect(() => { if (remaining > upNextSeconds + 5) setUpNextDismissed(false); }, [remaining, upNextSeconds]); // seeked back: allow again

  // Skip intro / skip credits: markers come from the background analysis (dev/intro.js). While a season is
  // still being analysed the answer is "pending" (and that season moves to the front), so ask again later.
  const [markers, setMarkers] = useState<Markers | null>(null);
  useEffect(() => {
    let alive = true, t = 0;
    setMarkers(null);
    const load = () => streamApi.markers(path).then((m) => {
      if (!alive) return;
      setMarkers(m);
      if (m.status === "pending") t = window.setTimeout(load, 20_000);
    });
    load();
    return () => { alive = false; window.clearTimeout(t); };
  }, [path]);
  const skip: { kind: "intro" | "credits"; label: string } | null = (() => {
    if (!markers || markers.status !== "ready" || ended || duration <= 0) return null;
    const m = markers;
    if (m.intro && time >= m.intro.start && time < m.intro.end - 1) return { kind: "intro", label: "Skip intro" };
    if (m.credits && time >= m.credits && remaining > 2 && !showUpNext) return { kind: "credits", label: next ? "Next episode" : "Skip credits" };
    return null;
  })();
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const doSkip = useCallback(() => {
    const k = skipRef.current, m = markers;
    if (!k || !m) return;
    if (k.kind === "intro" && m.intro) seekRef.current(m.intro.end);
    else if (next) next.onPlay();
    else seekRef.current(Math.max(0, duration - 0.5));
  }, [markers, next, duration]);

  // ── Actions ───────────────────────────────────────────────────────────────────────────────
  function replay() {
    setEnded(false);
    engine.replay(() => setNeedsGesture(true));
  }

  // Playing again after a phone had this title: continue from the phone's position.
  const [toast, setToast] = useState<string | null>(null);
  const resumeFromPhone = () => {
    const to = takeBack(id, timeRef.current);
    if (to === null) return;
    wantPlay.current = true;
    seekRef.current(to);
    setToast(`Continued from your phone at ${timecode(to)}`);
    window.setTimeout(() => setToast(null), 3000);
  };
  const resumeRef = useRef(resumeFromPhone);
  resumeRef.current = resumeFromPhone;
  const elsewhere = usePlayback((s) => s.elsewhere);
  const onPhone = !mini && elsewhere?.id === id;

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (ended) { replay(); return; }
    if (v.paused) resumeRef.current();
    if (v.paused) v.play().then(() => setNeedsGesture(false)).catch(() => setNeedsGesture(true));
    else { wantPlay.current = false; v.pause(); save(); }
  }, [ended, save]); // eslint-disable-line react-hooks/exhaustive-deps -- replay() is re-created every render; it only reads refs and state set below

  const seek = useCallback((abs: number) => {
    const target = Math.max(0, Math.min(abs, Math.max(0, duration - 1)));
    setEnded(false);
    timeRef.current = target;
    clock.set({ time: target });
    setTime(Math.floor(target));
    engine.seek(target); // instant when loaded (MSE), exact either way; the pipe restarts its stream
  }, [duration, engine.seek, clock]); // eslint-disable-line react-hooks/exhaustive-deps -- `engine` itself is a new object every render
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // Fullscreen goes on the player host (PlayerHost's box), not on this component's root: the root is replaced
  // whenever the episode changes, which used to drop fullscreen (and the next episode came back small).
  const hostEl = useCallback(() => wrapRef.current?.closest<HTMLElement>("[data-player-host]") ?? wrapRef.current, []);
  const cover = usePlayback((s) => s.cover); // "fullscreen" inside the app window (see store/playback.ts)
  const fullscreen = realFs || cover;
  const toggleFullscreen = useCallback(() => {
    const on = !(usePlayback.getState().cover || document.fullscreenElement);
    usePlayback.getState().setCover(on); // always works (also from the phone); in the desktop app the window follows it (useWindowFullscreen)
    if (on && !inDesktopShell()) hostEl()?.requestFullscreen().catch(() => {}); // browsers: real screen fullscreen too (needs a real click/key). Never in the desktop app: crashes the AppImage's WebKit
    else if (document.fullscreenElement) document.exitFullscreen();
  }, [hostEl]);

  useEffect(() => {
    let wasReal = false;
    const onFs = () => {
      const real = !!document.fullscreenElement && document.fullscreenElement === hostEl();
      setFullscreen(real);
      if (wasReal && !real) usePlayback.getState().setCover(false); // left real fullscreen (Esc): leave the in-window one too
      wasReal = real;
    };
    onFs(); // a new episode mounts while the host is already fullscreen
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [hostEl]);

  const setVolume = (v: number) => { setVolumePref(v); if (v > 0) setMuted(false); };

  // The one way to the full player (control-bar button, error screen, watch page): save, then start mpv where we are.
  const openFull = () => {
    if (!onOpenFull) return;
    videoRef.current?.pause();
    save();
    onOpenFull(timeRef.current, duration);
  };

  // Phone remote: expose this player's state and controls (latest closures through a ref; registered once).
  const remoteRef = useRef<ReturnType<typeof makeRemote>>();
  const makeRemote = () => ({
    getState: () => ({
      paused: videoRef.current ? videoRef.current.paused || ended : true,
      // Exact video time (timeupdate, which feeds timeRef, only fires ~4×/s); a seek in flight shows its target.
      position: videoRef.current && pending.current === null ? offsetRef.current + videoRef.current.currentTime : timeRef.current,
      duration, volume: pageVolume, muted, hasNext: !!next, fullscreen, subDelay,
      subs: subList.map((s) => ({ id: s.index, label: s.label || s.name })), subId: subIndex,
      path, waiting: waiting || pending.current !== null, rate: speed, ended,
      skip: skipRef.current,
    }),
    toggle: togglePlay,
    play: () => { const v = videoRef.current; if (v && v.paused) { if (ended) replay(); else { resumeRef.current(); v.play().then(() => setNeedsGesture(false)).catch(() => setNeedsGesture(true)); } } },
    pause: () => { const v = videoRef.current; wantPlay.current = false; if (v && !v.paused) { v.pause(); save(); } },
    seekTo: seek,
    setVolume,
    toggleMute: () => setMuted((m) => !m),
    next: () => next?.onPlay(),
    setSub: (i: number) => chooseSub(i),
    toggleFullscreen,
    setSubDelay: (v: number) => setSubDelay(id, Math.round(v * 10) / 10),
    skip: doSkip,
    openFull,
  });
  remoteRef.current = makeRemote();
  useEffect(() => {
    registerWebController({
      getState: () => remoteRef.current!.getState(),
      toggle: () => remoteRef.current!.toggle(),
      play: () => remoteRef.current!.play(),
      pause: () => remoteRef.current!.pause(),
      seekTo: (t) => remoteRef.current!.seekTo(t),
      setVolume: (v) => remoteRef.current!.setVolume(v),
      toggleMute: () => remoteRef.current!.toggleMute(),
      next: () => remoteRef.current!.next(),
      setSub: (i) => remoteRef.current!.setSub(i),
      toggleFullscreen: () => remoteRef.current!.toggleFullscreen(),
      setSubDelay: (v) => remoteRef.current!.setSubDelay(v),
      skip: () => remoteRef.current!.skip(),
      openFull: () => remoteRef.current!.openFull(),
    });
    return () => registerWebController(null);
  }, []);

  // Keyboard (YouTube-like) unless typing in a field.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    if (mini) return;
    keyRef.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const handled = true;
      if (k === " " || k === "k") togglePlay();
      else if (k === "arrowleft" || k === "j") seek(timeRef.current - 10);
      else if (k === "arrowright" || k === "l") seek(timeRef.current + 10);
      else if (k === "arrowup") setVolume(Math.min(100, pageVolume + 5));
      else if (k === "arrowdown") setVolume(Math.max(0, pageVolume - 5));
      else if (k === "f") toggleFullscreen();
      else if (k === "m") setMuted((m) => !m);
      else if (k === "c") { if (subList.length) toggleSubs(); else if (find) setFinder(true); }
      else if (k === "s" && skipRef.current) doSkip();
      else if (k === "z") setSubDelay(id, Math.round((subDelay - 0.1) * 10) / 10);
      else if (k === "x") setSubDelay(id, Math.round((subDelay + 0.1) * 10) / 10);
      else if (k === "escape" && (menu || finder)) { if (finder) setFinder(false); else setMenu(null); }
      else if (k === "escape" && cover) toggleFullscreen();
      else return;
      if (handled) { e.preventDefault(); poke(); }
    };
  });
  // One listener for the life of the player; it calls the newest handler (which sees the current state) via the ref.
  useEffect(() => {
    if (mini) return;
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mini]);

  // ── Render ────────────────────────────────────────────────────────────────────────────────
  return (
    <div
      ref={wrapRef}
      onMouseMove={poke}
      onTouchStart={poke}
      onMouseLeave={() => playing && setControls(false)}
      onContextMenu={(e) => { e.preventDefault(); if (!mini) { setMenu((m) => (m ? null : "main")); poke(); } }}
      className={cx(
        "group/player relative isolate w-full select-none overflow-hidden bg-black",
        fullscreen ? "h-screen" : mini ? "h-full rounded-xl shadow-[0_24px_60px_-12px_rgb(0_0_0/.95)] ring-1 ring-white/20" : "aspect-video rounded-2xl shadow-[0_40px_100px_-30px_rgb(0_0_0/.9)] ring-1 ring-white/[.06]",
        !showControls && "cursor-none",
      )}
    >
      <video
        ref={videoRef}
        key={mode === "pipe" ? src : "mse"}
        src={mode === "pipe" ? src : undefined}
        autoPlay
        playsInline
        muted={muted}
        className="absolute inset-0 h-full w-full object-contain"
        onClick={() => { if (menu) setMenu(null); else togglePlay(); }}
        onDoubleClick={toggleFullscreen}
        onLoadedMetadata={() => { pending.current = null; }}
        onLoadedData={() => { const v = videoRef.current; if (v) { v.playbackRate = speed; v.volume = Math.min(volumePref, 100) / 100; } }}
        onPlay={() => { if (isElsewhere(id)) resumeRef.current(); wantPlay.current = true; setPlaying(true); setNeedsGesture(false); poke(); }}
        onPause={() => setPlaying(false)}
        onWaiting={() => { setWaiting(true); mseRef.current?.onWaiting(); }}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => { setWaiting(false); if (wantPlay.current) videoRef.current?.play().catch(() => setNeedsGesture(true)); }}
        onTimeUpdate={onTimeUpdate}
        onProgress={updateBuffered}
        onEnded={() => {
          setPlaying(false);
          if (duration > 0) savePosition(id, duration, duration);
          if (autoNext) next!.onPlay(); // the card counted down to this moment
          else setEnded(true);
        }}
        onError={() => { reportServerTrouble(); setError("This video couldn't be streamed. Try the full player."); }}
      />

      {/* Subtitles, lifted above the controls when they're visible */}
      {cueText && (
        <div className={cx("pointer-events-none absolute inset-x-0 flex justify-center px-[8%] transition-[bottom] duration-200", mini ? "bottom-3" : showControls ? "bottom-[110px]" : "bottom-[6%]")}>
          <span
            dir="auto"
            className={cx("whitespace-pre-line text-center font-semibold leading-snug", subStyle.color === "yellow" ? "text-yellow-300" : "text-white", subStyle.background === "box" && "rounded-lg bg-black/70 px-3 py-0.5 [box-decoration-break:clone]")}
            style={{ fontSize: `calc(${mini ? "13px" : fullscreen ? "clamp(26px,2.6vw,48px)" : "clamp(15px,1.7vw,28px)"} * ${SUB_SCALE[subStyle.size]})`, textShadow: subStyle.background === "shadow" ? "0 0 4px #000,0 2px 6px #000,0 0 2px #000" : subStyle.background === "none" ? "0 0 2px #000" : "none" }}
          >
            {cueText}
          </span>
        </div>
      )}

      {/* One screen at a time: a phone is playing this title */}
      {onPhone && !error && (
        <div className="absolute inset-x-0 top-4 z-20 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-full bg-[#141419]/95 py-2 pl-5 pr-2 text-[14px] font-semibold text-white shadow-[0_18px_50px_-12px_rgb(0_0_0/.9)] ring-1 ring-white/10">
            Playing on your phone
            <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="rounded-full bg-violet-500 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-400">Continue here</button>
          </div>
        </div>
      )}
      {toast && !mini && <div role="status" className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center"><span className="rounded-full bg-[#141419]/95 px-5 py-2 text-[14px] font-semibold text-white ring-1 ring-white/10">{toast}</span></div>}

      {/* Loading / errors / big play */}
      {waiting && !error && !needsGesture && !ended && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 size={44} className="animate-spin text-white/80" /></div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 p-6 text-center">
          <p className="max-w-md text-white/90">{error}</p>
          {onOpenFull && <button onClick={openFull} className="rounded-full bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-400">Open in full player</button>}
        </div>
      )}
      {!playing && !waiting && !error && !ended && !mini && (
        <button onClick={togglePlay} aria-label="Play" className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-violet-500/95 text-white shadow-[0_0_0_10px_rgb(0_0_0/.25)] transition hover:scale-105 hover:bg-violet-400">
          <Play size={34} fill="currentColor" className="ml-1" />
        </button>
      )}
      {ended && <EndScreen next={next} onReplay={replay} mini={mini} onClose={onClose} />}
      {skip && !mini && (
        <button
          onClick={(e) => { e.stopPropagation(); doSkip(); }}
          title={`${skip.label} (S)`}
          className={cx(
            "absolute right-[3%] z-10 flex items-center gap-2 rounded-full bg-white/95 px-5 py-3 text-[15px] font-bold text-black shadow-[0_18px_50px_-12px_rgb(0_0_0/.9)] ring-1 ring-black/10 animate-pop transition-[bottom,background-color] duration-200 hover:bg-white",
            showControls ? "bottom-[112px]" : "bottom-[8%]",
          )}
        >
          {skip.kind === "intro" ? <ChevronsRight size={19} strokeWidth={2.6} /> : <SkipForward size={18} fill="currentColor" />} {skip.label}
        </button>
      )}
      {showUpNext && (
        <div className={cx("absolute right-[3%] z-10 w-[min(360px,80%)] rounded-2xl bg-[#141419]/95 p-4 shadow-[0_24px_70px_-15px_rgb(0_0_0/.95)] ring-1 ring-white/10 animate-pop transition-[bottom] duration-200", showControls ? "bottom-[112px]" : "bottom-[8%]")}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-violet-300">Up next · playing in {Math.ceil(remaining)}s</div>
              <div className="mt-1 line-clamp-2 text-[15px] font-semibold leading-5 text-white">{next!.label}</div>
            </div>
            <button onClick={() => setUpNextDismissed(true)} aria-label="Cancel auto-play" title="Cancel auto-play" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"><X size={17} /></button>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-violet-500 transition-[width] duration-1000 ease-linear" style={{ width: `${(1 - remaining / upNextSeconds) * 100}%` }} /></div>
          <button onClick={next!.onPlay} className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-violet-500 py-2.5 text-[14px] font-semibold text-white hover:bg-violet-400"><Play size={16} fill="currentColor" /> Play now</button>
        </div>
      )}

      {mini && (
        <div className="group/mini absolute inset-0">
          <div className={cx("absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/70 transition-opacity duration-200", showControls ? "opacity-100" : "opacity-0")} />
          <div className={cx("absolute inset-x-2 top-2 flex items-center gap-1 transition-opacity duration-200", showControls ? "opacity-100" : "pointer-events-none opacity-0")}>
            <span className="min-w-0 flex-1 truncate px-1 text-[12px] font-semibold text-white">{title}</span>
            <button onClick={() => { save(); onExpand?.(); }} aria-label="Back to the watch page" title="Back to the watch page" className="flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/20"><Maximize2 size={16} /></button>
            <button onClick={() => { save(); onClose?.(); }} aria-label="Close mini player" title="Close" className="flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/20"><X size={17} /></button>
          </div>
          <div className={cx("absolute inset-x-3 bottom-2 flex items-center gap-2 transition-opacity duration-200", showControls ? "opacity-100" : "pointer-events-none opacity-0")}>
            <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white hover:bg-violet-400">
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
            </button>
            {next && <button onClick={next.onPlay} aria-label={`Next: ${next.label}`} title={`Next: ${next.label}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/20"><SkipForward size={16} /></button>}
            <div className="min-w-0 flex-1"><SeekBar clock={clock} path={path} duration={duration} onSeek={seek} compact /></div>
          </div>
        </div>
      )}

      {/* Top gradient + title (fullscreen) */}
      <div className={cx("pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300", showControls && fullscreen ? "opacity-100" : "opacity-0")} />
      {fullscreen && !mini && (
        <div className={cx("absolute left-6 right-6 top-5 flex items-center gap-3 transition-opacity duration-300", showControls ? "opacity-100" : "pointer-events-none opacity-0")}>
          <CtrlButton label="Exit fullscreen" onClick={toggleFullscreen}><ArrowLeft size={22} /></CtrlButton>
          <span className="truncate text-lg font-semibold text-white">{title}</span>
        </div>
      )}

      {/* Bottom controls */}
      <div className={cx("absolute inset-x-0 bottom-0 transition-opacity duration-300", mini ? "hidden" : showControls ? "opacity-100" : "pointer-events-none opacity-0")}>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />
        <div className="relative px-[4%] pb-3">
          <SeekBar clock={clock} path={path} duration={duration} onSeek={seek} />
          <div className="mt-1 flex items-center gap-1.5">
            <button onClick={togglePlay} aria-label={playing ? "Pause (K)" : "Play (K)"} title={playing ? "Pause (K)" : "Play (K)"}
              className="mr-1 flex h-11 w-11 items-center justify-center rounded-full bg-violet-500 text-white transition hover:scale-105 hover:bg-violet-400 active:scale-95">
              {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
            </button>
            <CtrlButton label="Back 10 s (←)" onClick={() => seek(timeRef.current - 10)}><RotateCcw size={20} /></CtrlButton>
            <CtrlButton label="Forward 10 s (→)" onClick={() => seek(timeRef.current + 10)}><RotateCw size={20} /></CtrlButton>
            {next && <CtrlButton label={`Next: ${next.label}`} onClick={next.onPlay}><SkipForward size={20} /></CtrlButton>}
            <Volume volume={pageVolume} muted={muted} onVolume={setVolume} onMute={() => setMuted((m) => !m)} />
            <PlayerClock clock={clock} duration={duration} />

            <div className="ml-auto flex items-center gap-1">
              {speed !== 1 && <span className="mr-1 rounded-full bg-violet-500/25 px-2 py-0.5 text-[12px] font-bold text-violet-200">{speed}×</span>}
              <CtrlButton label={subIndex >= 0 ? "Subtitles on (C)" : "Subtitles off (C)"} active={subIndex >= 0}
                onClick={() => { if (subList.length) toggleSubs(); else if (find) setFinder(true); }} disabled={!subList.length && !find}>
                <Captions size={21} />
              </CtrlButton>
              <CtrlButton label="Settings (right-click)" active={!!menu} onClick={() => setMenu((m) => (m ? null : "main"))}><Settings size={20} className={cx("transition-transform duration-300", menu && "rotate-45")} /></CtrlButton>
              {onOpenFull && <CtrlButton label={info?.hdr ? "HDR video: looks best in the full player (mpv)" : "Open in full player (mpv)"} active={!!info?.hdr} onClick={openFull}><MonitorPlay size={20} /></CtrlButton>}
              <CtrlButton label={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}</CtrlButton>
            </div>
          </div>
        </div>
      </div>

      {finder && !mini && find && (
        <SubtitleFinder
          path={path}
          ctx={find}
          onClose={() => setFinder(false)}
          onAdded={(file) => void refreshSubs(file)}
          onChanged={() => void refreshSubs()}
        />
      )}

      {menu && !mini && (
        <SettingsPanel
          page={menu}
          setPage={setMenu}
          subtitles={subList}
          audioTracks={info?.audioTracks ?? []}
          audioIndex={audioIdx}
          setAudioIndex={(i) => {
            // Audio comes from the server: restart the stream where we are with the chosen track, and remember it.
            const t = info?.audioTracks?.find((a) => a.index === i);
            if (t?.language) useUser.getState().setAudioPref(prefKey, t.language);
            engine.changeAudio(i, timeRef.current);
          }}
          subError={subError}
          onFind={find ? () => { setMenu(null); setFinder(true); } : undefined}
          subIndex={subIndex}
          setSubIndex={(i) => chooseSub(i)}
          rememberNote={titleId && titleId !== id ? "Your choice is used for every episode of this series." : "Your choice is remembered for this title."}
          delay={subDelay}
          setDelay={(d) => setSubDelay(id, Math.round(d * 10) / 10)}
          speed={speed}
          setSpeed={setSpeed}
          levelling={levelling}
          levelGainDb={info?.levelGainDb ?? lateGain}
          setLevelling={(on) => {
            // Audio changes server-side, so restart the stream where we are with the new setting.
            setLevelling(on);
            engine.changeLevel(on, timeRef.current);
          }}
        />
      )}
    </div>
  );
}

