import {
  ArrowLeft, AudioLines, Captions, Check, ChevronRight, ChevronsRight, Gauge, Loader2, Maximize, Minimize, MonitorPlay, Pause, Play, RotateCcw,
  RotateCw, Search, Settings, SkipForward, Timer, Volume1, Volume2, VolumeX, X, Maximize2,
} from "lucide-react";
import { registerWebController } from "@/store/webControl";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { MseStream, streamMime } from "@/lib/mse";
import { type Markers, streamApi, type Cue, type ProbeInfo } from "@/api/stream";
import { timecode } from "@/lib/format";
import { SubtitleFinder } from "./SubtitleFinder";
import type { SearchContext } from "@/api/subsearch";
import { usePlayback } from "@/store/playback";
import { pickSubtitle, startSubtitle, subPrefFor, useSettings } from "@/store/settings";
import { useUser } from "@/store/user";
import { cx } from "./ui";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
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
  onOpenFull?: (position: number) => void; // omitted on phones (mpv runs on the PC)
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
  const setVolumePref = useUser((s) => s.setVolume);
  const subDelay = useUser((s) => s.subDelays[id] ?? 0);
  const setSubDelay = useUser((s) => s.setSubDelay);
  const addWatchTime = useUser((s) => s.addWatchTime);
  const prefKey = titleId ?? id; // subtitle choice is remembered per series (or movie)
  const { autoplayNext, upNextSeconds } = useSettings();

  const [info, setInfo] = useState<ProbeInfo | null>(null);
  const [subList, setSubList] = useState<ProbeInfo["subtitles"]>([]);
  const [finder, setFinder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(startAt); // source time of the current stream's time 0 (measured)
  const [streamT, setStreamT] = useState(startAt); // the `t` the current stream was requested with
  const [time, setTime] = useState(startAt); // absolute current time
  const [bufferedEnd, setBufferedEnd] = useState(startAt);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [realFs, setFullscreen] = useState(false); // the browser's real fullscreen
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<null | "main" | "subs" | "delay" | "speed">(null);
  const [subIndex, setSubIndex] = useState(-1);
  const [cues, setCues] = useState<Cue[]>([]);
  const [cueText, setCueText] = useState("");
  const [ended, setEnded] = useState(false);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const hideTimer = useRef<number>();
  const lastSaved = useRef(startAt);
  const timeRef = useRef(startAt);

  const duration = info?.duration || fallbackDuration;
  // `offset` is the source time of the current stream's time 0, measured by /api/seekpoint: stream copy can only
  // start on a keyframe, up to ~10 s before the click. All times shown are offset + currentTime, so the bar,
  // clock and subtitles match the picture. `pending` blocks stale time updates until the new stream loads;
  // `seekSeq` drops replies from superseded clicks.
  const [ready, setReady] = useState(false);
  const offsetRef = useRef(startAt);
  offsetRef.current = offset;
  const pending = useRef<number | null>(null);
  const seekSeq = useRef(0);
  const levelling = useUser((s) => s.levelling);
  const setLevelling = useUser((s) => s.setLevelling);
  const [levelKey, setLevelKey] = useState(levelling); // the levelling setting the current stream uses
  const src = useMemo(() => (ready ? streamApi.streamUrl(path, streamT, levelKey) : undefined), [ready, path, streamT, levelKey]);

  /** (Re)start the stream so that playback lands exactly on `target`. */
  const restartAt = useCallback((target: number, alsoApply?: () => void) => {
    const seq = ++seekSeq.current;
    target = Math.round(target * 1000) / 1000; // same value in /api/seekpoint and /api/stream
    pending.current = target;
    videoRef.current?.pause();
    setWaiting(true);
    streamApi.seekPoint(path, target).then((start) => {
      if (seq !== seekSeq.current) return; // a newer click won
      alsoApply?.(); // e.g. a new levelling setting, so the stream reloads once, at the right place
      setBufferedEnd(start);
      setOffset(start);
      setStreamT(target);
      setReady(true);
    });
  }, [path, ready]);

  // Playback engine: chunked (MediaSource, src/lib/mse.ts) when supported: instant jumps inside what's
  // loaded, exact landing elsewhere. Otherwise the plain fMP4 pipe above (every jump restarts the stream).
  const mseRef = useRef<MseStream | null>(null);
  const [mode, setMode] = useState<"mse" | "pipe" | null>(null);
  const [bufStart, setBufStart] = useState(startAt);
  useEffect(() => {
    if (!info) return;
    const v = videoRef.current;
    const mime = streamMime(info);
    if (v && MseStream.supported(mime)) {
      setMode("mse");
      setOffset(0); // the MediaSource timeline IS the file's timeline
      pending.current = null;
      const m = new MseStream(v, path, info.duration, mime, levelKey, setError);
      mseRef.current = m;
      void m.start(startAt);
      return () => { m.destroy(); mseRef.current = null; };
    }
    setMode("pipe");
    restartAt(startAt); // resume position goes through the keyframe lookup
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── File info (duration, subtitles) ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    streamApi.probe(path).then(
      (p) => { if (!alive) return; setInfo(p); setSubList(p.subtitles); setSubIndex(startSubtitle(p.subtitles, useUser.getState().subPrefs[prefKey])); },
      (e) => alive && setError(e instanceof Error ? e.message : "Could not read this video."),
    );
    return () => { alive = false; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (subIndex < 0) { setCues([]); return; }
    let alive = true;
    streamApi.subtitles(path, subIndex).then((c) => alive && setCues(c));
    return () => { alive = false; };
  }, [path, subIndex]);

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

  const save = useCallback(() => {
    if (duration > 0) savePosition(id, timeRef.current, duration);
    lastSaved.current = timeRef.current;
  }, [id, duration, savePosition]);

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

  // Save on leave.
  useEffect(() => () => { if (timeRef.current > 1) save(); }, [save]);

  const updateBuffered = () => {
    const v = videoRef.current;
    if (!v) return;
    if (mseRef.current) {
      const r = mseRef.current.rangeAt(v.currentTime);
      if (r) { setBufStart(r[0]); setBufferedEnd(r[1]); }
    } else if (v.buffered.length) {
      setBufStart(offset);
      setBufferedEnd(offset + v.buffered.end(v.buffered.length - 1));
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current!;
    if (pending.current !== null) return; // a seek is in flight: keep showing its target time
    const t = offset + v.currentTime;
    timeRef.current = t;
    setTime(t);
    updateBuffered();
    if (Math.abs(t - lastSaved.current) >= 10) save();
  };

  // Subtitle cue at the current time (with per-title sync offset), checked every frame.
  useEffect(() => {
    if (!cues.length) { setCueText(""); return; }
    let raf = 0;
    let last = "";
    const loop = () => {
      const v = videoRef.current;
      if (v) {
        const t = offset + v.currentTime - subDelay;
        let txt = "";
        for (const c of cues) { if (c.start > t) break; if (t < c.end) { txt = c.text; break; } }
        if (txt !== last) { last = txt; setCueText(txt); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cues, offset, subDelay]);

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
    if (mseRef.current) { mseRef.current.seek(0); videoRef.current?.play().catch(() => setNeedsGesture(true)); }
    else restartAt(0);
  }

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (ended) { replay(); return; }
    if (v.paused) v.play().then(() => setNeedsGesture(false)).catch(() => setNeedsGesture(true));
    else { v.pause(); save(); }
  }, [ended, save]);

  const seek = useCallback((abs: number) => {
    const target = Math.max(0, Math.min(abs, Math.max(0, duration - 1)));
    setEnded(false);
    timeRef.current = target;
    setTime(target);
    if (mseRef.current) mseRef.current.seek(target); // instant when loaded, exact either way
    else restartAt(target); // pipe mode: not seekable, so restart the stream
  }, [duration, restartAt]);
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // Fullscreen goes on the player host (PlayerHost's box), not on this component's root: the root is replaced
  // whenever the episode changes, which used to drop fullscreen (and the next episode came back small).
  const hostEl = useCallback(() => wrapRef.current?.closest<HTMLElement>("[data-player-host]") ?? wrapRef.current, []);
  const cover = usePlayback((s) => s.cover); // "fullscreen" inside the app window (see store/playback.ts)
  const fullscreen = realFs || cover;
  const toggleFullscreen = useCallback(() => {
    const on = !(usePlayback.getState().cover || document.fullscreenElement);
    usePlayback.getState().setCover(on); // always works (also from the phone)
    if (on) hostEl()?.requestFullscreen().catch(() => {}); // real screen fullscreen too, when the browser allows it (needs a real click/key)
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

  // Phone remote: expose this player's state and controls (latest closures through a ref; registered once).
  const remoteRef = useRef<ReturnType<typeof makeRemote>>();
  const makeRemote = () => ({
    getState: () => ({
      paused: videoRef.current ? videoRef.current.paused || ended : true,
      // Exact video time (timeupdate, which feeds timeRef, only fires ~4×/s); a seek in flight shows its target.
      position: videoRef.current && pending.current === null ? offsetRef.current + videoRef.current.currentTime : timeRef.current,
      duration, volume: volumePref, muted, hasNext: !!next, fullscreen, subDelay,
      subs: subList.map((s) => ({ id: s.index, label: s.label || s.name })), subId: subIndex,
      path, waiting: waiting || pending.current !== null, rate: speed, ended,
      skip: skipRef.current,
    }),
    toggle: togglePlay,
    play: () => { const v = videoRef.current; if (v && v.paused) { if (ended) replay(); else v.play().then(() => setNeedsGesture(false)).catch(() => setNeedsGesture(true)); } },
    pause: () => { const v = videoRef.current; if (v && !v.paused) { v.pause(); save(); } },
    seekTo: seek,
    setVolume,
    toggleMute: () => setMuted((m) => !m),
    next: () => next?.onPlay(),
    setSub: (i: number) => chooseSub(i),
    toggleFullscreen,
    setSubDelay: (v: number) => setSubDelay(id, Math.round(v * 10) / 10),
    skip: doSkip,
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
    });
    return () => registerWebController(null);
  }, []);

  // Keyboard (YouTube-like) unless typing in a field.
  useEffect(() => {
    if (mini) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const handled = true;
      if (k === " " || k === "k") togglePlay();
      else if (k === "arrowleft" || k === "j") seek(timeRef.current - 10);
      else if (k === "arrowright" || k === "l") seek(timeRef.current + 10);
      else if (k === "arrowup") setVolume(Math.min(130, volumePref + 5));
      else if (k === "arrowdown") setVolume(Math.max(0, volumePref - 5));
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
        onPlay={() => { setPlaying(true); setNeedsGesture(false); poke(); }}
        onPause={() => setPlaying(false)}
        onWaiting={() => { setWaiting(true); mseRef.current?.onWaiting(); }}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => { setWaiting(false); videoRef.current?.play().catch(() => setNeedsGesture(true)); }}
        onTimeUpdate={onTimeUpdate}
        onProgress={updateBuffered}
        onEnded={() => {
          setPlaying(false);
          if (duration > 0) savePosition(id, duration, duration);
          if (autoNext) next!.onPlay(); // the card counted down to this moment
          else setEnded(true);
        }}
        onError={() => setError("This video couldn't be streamed. Try the full player.")}
      />

      {/* Subtitles, lifted above the controls when they're visible */}
      {cueText && (
        <div className={cx("pointer-events-none absolute inset-x-0 flex justify-center px-[8%] transition-[bottom] duration-200", mini ? "bottom-3" : showControls ? "bottom-[110px]" : "bottom-[6%]")}>
          <span
            dir="auto"
            className="whitespace-pre-line text-center font-semibold leading-snug text-white [text-shadow:0_0_4px_#000,0_2px_6px_#000,0_0_2px_#000]"
            style={{ fontSize: mini ? "13px" : fullscreen ? "clamp(26px,2.6vw,48px)" : "clamp(15px,1.7vw,28px)" }}
          >
            {cueText}
          </span>
        </div>
      )}

      {/* Loading / errors / big play */}
      {waiting && !error && !needsGesture && !ended && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 size={44} className="animate-spin text-white/80" /></div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 p-6 text-center">
          <p className="max-w-md text-white/90">{error}</p>
          {onOpenFull && <button onClick={() => onOpenFull(timeRef.current)} className="rounded-full bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-400">Open in full player</button>}
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
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-violet-500 transition-[width] duration-300 ease-linear" style={{ width: `${(1 - remaining / upNextSeconds) * 100}%` }} /></div>
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
            <div className="min-w-0 flex-1"><SeekBar path={path} time={time} duration={duration} offset={bufStart} bufferedEnd={bufferedEnd} onSeek={seek} compact /></div>
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
          <SeekBar path={path} time={time} duration={duration} offset={bufStart} bufferedEnd={bufferedEnd} onSeek={seek} />
          <div className="mt-1 flex items-center gap-1.5">
            <button onClick={togglePlay} aria-label={playing ? "Pause (K)" : "Play (K)"} title={playing ? "Pause (K)" : "Play (K)"}
              className="mr-1 flex h-11 w-11 items-center justify-center rounded-full bg-violet-500 text-white transition hover:scale-105 hover:bg-violet-400 active:scale-95">
              {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
            </button>
            <CtrlButton label="Back 10 s (←)" onClick={() => seek(time - 10)}><RotateCcw size={20} /></CtrlButton>
            <CtrlButton label="Forward 10 s (→)" onClick={() => seek(time + 10)}><RotateCw size={20} /></CtrlButton>
            {next && <CtrlButton label={`Next: ${next.label}`} onClick={next.onPlay}><SkipForward size={20} /></CtrlButton>}
            <Volume volume={volumePref} muted={muted} onVolume={setVolume} onMute={() => setMuted((m) => !m)} />
            <span className="ml-2 text-[13px] font-semibold tabular-nums text-white/90">{timecode(time)} <span className="text-white/50">/ {timecode(duration)}</span></span>

            <div className="ml-auto flex items-center gap-1">
              {speed !== 1 && <span className="mr-1 rounded-full bg-violet-500/25 px-2 py-0.5 text-[12px] font-bold text-violet-200">{speed}×</span>}
              <CtrlButton label={subIndex >= 0 ? "Subtitles on (C)" : "Subtitles off (C)"} active={subIndex >= 0}
                onClick={() => { if (subList.length) toggleSubs(); else if (find) setFinder(true); }} disabled={!subList.length && !find}>
                <Captions size={21} />
              </CtrlButton>
              <CtrlButton label="Settings (right-click)" active={!!menu} onClick={() => setMenu((m) => (m ? null : "main"))}><Settings size={20} className={cx("transition-transform duration-300", menu && "rotate-45")} /></CtrlButton>
              {onOpenFull && <CtrlButton label="Open in full player (mpv)" onClick={() => { videoRef.current?.pause(); save(); onOpenFull(timeRef.current); }}><MonitorPlay size={20} /></CtrlButton>}
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
          onFind={find ? () => { setMenu(null); setFinder(true); } : undefined}
          subIndex={subIndex}
          setSubIndex={(i) => chooseSub(i)}
          rememberNote={titleId && titleId !== id ? "Your choice is used for every episode of this series." : "Your choice is remembered for this title."}
          delay={subDelay}
          setDelay={(d) => setSubDelay(id, Math.round(d * 10) / 10)}
          speed={speed}
          setSpeed={setSpeed}
          levelling={levelling}
          levelGainDb={info?.levelGainDb}
          setLevelling={(on) => {
            // Audio changes server-side, so restart the stream where we are with the new setting.
            setLevelling(on);
            if (mseRef.current) { setLevelKey(on); mseRef.current.setLevel(on); }
            else restartAt(timeRef.current, () => setLevelKey(on));
          }}
        />
      )}
    </div>
  );
}

/** Seek bar: played (violet), buffered, hover fill + thumbnail preview, round handle, click/drag. */
function SeekBar({ path, time, duration, offset, bufferedEnd, onSeek, compact }: { path: string; time: number; duration: number; offset: number; bufferedEnd: number; onSeek: (t: number) => void; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const frac = drag ?? (duration ? Math.min(1, time / duration) : 0);
  const at = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const hoverT = hover !== null ? hover * duration : 0;
  const thumbT = Math.floor(hoverT / 5) * 5;
  const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      tabIndex={-1}
      onPointerMove={(e) => { setHover(at(e)); if (drag !== null) setDrag(at(e)); }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(at(e)); }}
      onPointerUp={(e) => { if (drag !== null) onSeek(at(e) * duration); setDrag(null); }}
      className="group/seek relative flex h-6 cursor-pointer touch-none items-center"
    >
      <div className="relative h-[3px] w-full rounded-full bg-white/25 transition-[height] duration-150 group-hover/seek:h-[6px]">
        {duration > 0 && bufferedEnd > offset && (
          <div className="absolute inset-y-0 rounded-full bg-violet-200/45" style={{ left: pct(offset / duration), width: pct((bufferedEnd - offset) / duration) }} />
        )}
        {hover !== null && hover > frac && <div className="absolute inset-y-0 left-0 rounded-full bg-white/35" style={{ width: pct(hover) }} />}
        <div className="absolute inset-y-0 left-0 rounded-full bg-violet-500" style={{ width: pct(frac) }} />
      </div>
      <div
        className={cx("absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgb(139_92_246/.45)] transition-transform duration-150", drag !== null ? "scale-125" : "group-hover/seek:scale-110")}
        style={{ left: pct(frac) }}
      />
      {hover !== null && duration > 0 && !compact && (
        <div className="pointer-events-none absolute bottom-full mb-3 flex -translate-x-1/2 flex-col items-center gap-1.5" style={{ left: `clamp(84px, ${hover * 100}%, calc(100% - 84px))` }}>
          <div className="overflow-hidden rounded-lg bg-black ring-2 ring-violet-500/90 shadow-lift">
            <img src={streamApi.thumbUrl(path, thumbT)} alt="" className="block h-[90px] w-[160px] object-cover" />
          </div>
          <span className="rounded-md bg-black/80 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-white">{timecode(hoverT)}</span>
        </div>
      )}
    </div>
  );
}

function CtrlButton({ label, onClick, children, active, disabled }: { label: string; onClick: () => void; children: ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cx(
        "relative flex h-10 w-10 items-center justify-center rounded-full text-white transition hover:bg-white/15 active:scale-95 disabled:opacity-35 disabled:hover:bg-transparent",
        active && "text-violet-300 after:absolute after:bottom-1 after:h-[2px] after:w-4 after:rounded-full after:bg-violet-400",
      )}
    >
      {children}
    </button>
  );
}

function Volume({ volume, muted, onVolume, onMute }: { volume: number; muted: boolean; onVolume: (v: number) => void; onMute: () => void }) {
  const Icon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const pct = muted ? 0 : Math.min(volume, 100);
  return (
    <div className="group/vol flex items-center">
      <CtrlButton label={muted ? "Unmute (M)" : "Mute (M)"} onClick={onMute}><Icon size={20} /></CtrlButton>
      <input
        type="range" min={0} max={100} value={pct} aria-label="Volume"
        onChange={(e) => onVolume(Number(e.target.value))}
        className="h-1 w-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 group-hover/vol:ml-1 group-hover/vol:w-24 group-hover/vol:opacity-100 focus-visible:w-24 focus-visible:opacity-100 accent-violet-500"
        style={{ background: `linear-gradient(to right, rgb(139 92 246) ${pct}%, rgb(255 255 255 / .25) ${pct}%)` }}
      />
    </div>
  );
}

function SettingsPanel(p: {
  page: "main" | "subs" | "delay" | "speed";
  setPage: (pg: null | "main" | "subs" | "delay" | "speed") => void;
  subtitles: ProbeInfo["subtitles"];
  onFind?: () => void;
  subIndex: number;
  setSubIndex: (i: number) => void;
  rememberNote?: string;
  delay: number;
  setDelay: (d: number) => void;
  speed: number;
  setSpeed: (s: number) => void;
  levelling: boolean;
  levelGainDb?: number;
  setLevelling: (on: boolean) => void;
}) {
  const fmtDelay = (d: number) => (Math.abs(d) < 0.05 ? "0.0 s" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} s`);
  const subLabel = p.subIndex >= 0 ? p.subtitles[p.subIndex]?.label ?? "On" : "Off";
  const Row = ({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: string; onClick: () => void }) => (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-white transition hover:bg-white/10">
      <span className="text-white/70">{icon}</span>
      <span className="flex-1 font-semibold">{label}</span>
      <span className="max-w-[150px] truncate text-[13px] text-white/55">{value}</span>
      <ChevronRight size={16} className="text-white/45" />
    </button>
  );
  const Option = ({ selected, label, onClick }: { selected: boolean; label: string; onClick: () => void }) => (
    <button onClick={onClick} className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition hover:bg-white/10", selected ? "font-semibold text-white" : "text-white/80")}>
      <span className="w-4">{selected && <Check size={16} className="text-violet-400" />}</span>
      <span className="truncate">{label}</span>
    </button>
  );
  const Header = ({ title }: { title: string }) => (
    <div className="mb-1 flex items-center gap-2 border-b border-white/10 px-1 pb-2">
      {p.page !== "main" && <button onClick={() => p.setPage("main")} aria-label="Back" className="flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/10"><ArrowLeft size={18} /></button>}
      <span className="flex-1 px-2 text-[15px] font-semibold text-white">{title}</span>
      <button onClick={() => p.setPage(null)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"><X size={17} /></button>
    </div>
  );

  return (
    <div onClick={(e) => e.stopPropagation()} className="absolute bottom-[86px] right-[4%] z-10 w-[min(340px,86%)] rounded-2xl bg-[#141419]/95 p-2 shadow-[0_24px_70px_-15px_rgb(0_0_0/.95)] ring-1 ring-white/10 backdrop-blur-xl animate-pop">
      {p.page === "main" && (
        <>
          <Header title="Settings" />
          <Row icon={<Captions size={18} />} label="Subtitles" value={subLabel} onClick={() => p.setPage("subs")} />
          <Row icon={<Timer size={18} />} label="Subtitle timing" value={fmtDelay(p.delay)} onClick={() => p.setPage("delay")} />
          <Row icon={<Gauge size={18} />} label="Playback speed" value={p.speed === 1 ? "Normal" : `${p.speed}×`} onClick={() => p.setPage("speed")} />
          <button onClick={() => p.setLevelling(!p.levelling)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-white transition hover:bg-white/10"
            title="Boosts quiet videos to a normal loudness, with a limiter so loud moments don't distort">
            <span className="text-white/70"><AudioLines size={18} /></span>
            <span className="flex-1 font-semibold">Volume levelling</span>
            <span className="text-[13px] text-white/55">
              {p.levelling ? (p.levelGainDb !== undefined && Math.abs(p.levelGainDb) >= 1 ? `On · ${p.levelGainDb > 0 ? "+" : ""}${p.levelGainDb.toFixed(0)} dB` : "On") : "Off"}
            </span>
            <span className={cx("relative h-5 w-9 rounded-full transition", p.levelling ? "bg-violet-500" : "bg-white/20")}>
              <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", p.levelling ? "left-[18px]" : "left-0.5")} />
            </span>
          </button>
        </>
      )}
      {p.page === "subs" && (
        <>
          <Header title="Subtitles" />
          <Option selected={p.subIndex < 0} label="Off" onClick={() => p.setSubIndex(-1)} />
          {p.subtitles.map((s) => <Option key={s.index} selected={p.subIndex === s.index} label={s.label} onClick={() => p.setSubIndex(s.index)} />)}
          {p.subtitles.length > 0 && p.rememberNote && <p className="px-3 pb-1 pt-2 text-[12px] text-white/45">{p.rememberNote}</p>}
          {p.subtitles.length === 0 && <p className="px-3 py-2 text-[13px] text-white/55">No subtitle files next to this video. Built-in tracks are available in the full player.</p>}
          {p.onFind && <button onClick={p.onFind} className="mt-1 flex w-full items-center gap-3 rounded-xl border-t border-white/10 px-3 py-2.5 text-left text-[14px] font-semibold text-violet-300 transition hover:bg-white/10"><Search size={16} /> Find subtitles online…</button>}
        </>
      )}
      {p.page === "delay" && (
        <>
          <Header title="Subtitle timing" />
          <div className={cx("py-3 text-center text-3xl font-bold tabular-nums", Math.abs(p.delay) >= 0.05 ? "text-violet-300" : "text-white")}>{fmtDelay(p.delay)}</div>
          <div className="grid grid-cols-4 gap-2 px-1">
            {[-0.5, -0.1, 0.1, 0.5].map((d) => (
              <button key={d} onClick={() => p.setDelay(p.delay + d)} className="h-10 rounded-xl bg-white/10 text-[14px] font-semibold tabular-nums text-white transition hover:bg-white/20 active:scale-95">
                {d > 0 ? "+" : "−"}{Math.abs(d)}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between px-2 pb-1 pt-3 text-[12px] text-white/55">
            <span>Too early → + · too late → − · Z / X keys</span>
            {Math.abs(p.delay) >= 0.05 && <button onClick={() => p.setDelay(0)} className="font-semibold text-white hover:text-violet-300">Reset</button>}
          </div>
        </>
      )}
      {p.page === "speed" && (
        <>
          <Header title="Playback speed" />
          {SPEEDS.map((s) => <Option key={s} selected={Math.abs(p.speed - s) < 0.01} label={s === 1 ? "Normal" : `${s}×`} onClick={() => p.setSpeed(s)} />)}
        </>
      )}
    </div>
  );
}

function EndScreen({ next, onReplay, mini, onClose }: { next?: { label: string; onPlay: () => void }; onReplay: () => void; mini?: boolean; onClose?: () => void }) {
  // Only reached when auto-play is off or was cancelled: offer the choice, never start by itself.
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 p-4 text-center animate-fade">
      {!mini && next && <div className="text-[13px] font-semibold uppercase tracking-[0.08em] text-violet-300">Up next</div>}
      {!mini && next && <div className="max-w-lg text-2xl font-semibold text-white">{next.label}</div>}
      <div className="flex flex-wrap justify-center gap-2.5">
        {next && <button onClick={next.onPlay} className={cx("flex items-center gap-2 rounded-full bg-violet-500 font-semibold text-white hover:bg-violet-400", mini ? "px-3.5 py-2 text-[13px]" : "px-6 py-3")}><Play size={mini ? 14 : 18} fill="currentColor" /> {mini ? "Next" : "Play now"}</button>}
        <button onClick={onReplay} className={cx("flex items-center gap-2 rounded-full font-semibold text-white", next ? "bg-white/15 hover:bg-white/25" : "bg-violet-500 hover:bg-violet-400", mini ? "px-3.5 py-2 text-[13px]" : "px-6 py-3")}><RotateCcw size={mini ? 14 : 18} /> Watch again</button>
        {mini && <button onClick={onClose} className="rounded-full bg-white/15 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-white/25">Close</button>}
      </div>
    </div>
  );
}
