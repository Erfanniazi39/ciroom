import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { MseStream, streamMime, type StreamSource } from "@/lib/mse";
import { streamApi, type ProbeInfo, type StreamMode } from "@/api/stream";
import { createClock, type Clock } from "./clock";

export interface EngineOptions {
  videoRef: RefObject<HTMLVideoElement>;
  /** The library path (PC) or "" (phone/guest: the source knows the video by its id). */
  path: string;
  /** Where chunks come from. Default: the PC's own API. */
  source?: StreamSource;
  /** The probe of the file. The engine (re)builds whenever this changes; null = nothing to play yet. */
  info: ProbeInfo | null;
  /** Override of the stream's MIME (the phone's low-data mode). */
  mime?: string;
  /** Where playback starts, read when the engine builds. */
  getStartAt: () => number;
  /** Volume levelling for the first build. */
  level: boolean;
  /** Audio stream for the first build. */
  audio: number;
  /** PC only: when MediaSource isn't available, play the plain fMP4 pipe (every jump restarts the stream). */
  allowPipe?: boolean;
  /** Called with the message of a stream that failed for good. */
  onError?: (message: string) => void;
  /** Called after an MSE stream has loaded its first position (the phone starts playing then). */
  onStarted?: () => void;
}

/**
 * Owns the `<video>` source: a chunked MediaSource stream (src/lib/mse.ts) when the browser supports it (instant jumps
 * inside what's loaded, exact landing elsewhere), else the plain stream URL. `offset` is the source time of the pipe stream's
 * time 0 (measured by the seek-point lookup; 0 for MediaSource, whose timeline IS the file's). `pending` is the seek in flight:
 * time updates are ignored until the new stream loads, and `seekSeq` drops replies from superseded clicks.
 * Switching audio or levelling rebuilds the MediaSource at the current spot (no frozen frame).
 */
export function usePlaybackEngine(o: EngineOptions) {
  const opts = useRef(o);
  opts.current = o;
  const source: StreamSource = o.source ?? streamApi;
  const startAt = o.getStartAt();

  const clockRef = useRef<Clock | null>(null);
  clockRef.current ??= createClock(startAt);
  const clock = clockRef.current;

  const [mode, setMode] = useState<"mse" | "pipe" | null>(null);
  const [offset, setOffset] = useState(startAt);
  const offsetRef = useRef(startAt);
  offsetRef.current = offset;
  const [streamT, setStreamT] = useState(startAt); // the `t` the pipe stream was requested with
  const [ready, setReady] = useState(false);
  const [streamMode, setStreamMode] = useState<StreamMode>("copy"); // `transcode` when the keyframe lookup failed: exact start
  const [levelKey, setLevelKey] = useState(o.level);
  const [audioIdx, setAudioIdx] = useState(o.audio);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);
  const seekSeq = useRef(0);
  const mseRef = useRef<MseStream | null>(null);

  const src = useMemo(() => (ready ? source.streamUrl(o.path, streamT, levelKey, audioIdx, streamMode) : undefined), [ready, o.path, streamT, levelKey, audioIdx, streamMode]); // eslint-disable-line react-hooks/exhaustive-deps -- `source` is stable per player

  /** Pipe mode: (re)start the stream so that playback lands exactly on `target`. */
  const restartAt = useCallback((target: number, alsoApply?: () => void) => {
    const seq = ++seekSeq.current;
    target = Math.round(target * 1000) / 1000; // same value in the seek-point lookup and the stream URL
    pending.current = target;
    opts.current.videoRef.current?.pause();
    setWaiting(true);
    void Promise.resolve(source.seekPoint(opts.current.path, target, audioIdx)).then((r) => {
      if (seq !== seekSeq.current) return; // a newer click won
      const { start, mode: m } = typeof r === "number" ? { start: r, mode: "copy" as StreamMode } : r;
      alsoApply?.(); // e.g. a new levelling setting, so the stream reloads once, at the right place
      clock.set({ bufferedEnd: start });
      setOffset(start);
      setStreamMode(m);
      setStreamT(target);
      setReady(true);
    });
  }, [audioIdx, clock]); // eslint-disable-line react-hooks/exhaustive-deps -- `source` is stable per player

  // (Re)build when the probe changes.
  useEffect(() => {
    const c = opts.current;
    const info = c.info;
    if (!info) return;
    const v = c.videoRef.current;
    const mime = c.mime ?? streamMime(info);
    if (v && MseStream.supported(mime)) {
      setMode("mse");
      setOffset(0); // the MediaSource timeline IS the file's timeline
      pending.current = null;
      let alive = true;
      const fail = (m: string) => { setError(m); c.onError?.(m); };
      const m = new MseStream(v, c.path, info.duration, mime, levelKey, audioIdx, fail, c.source);
      mseRef.current = m;
      void m.start(c.getStartAt()).then(() => { if (alive) c.onStarted?.(); });
      return () => { alive = false; m.destroy(); mseRef.current = null; };
    }
    if (!c.allowPipe) return;
    setMode("pipe");
    restartAt(c.getStartAt()); // resume position goes through the keyframe lookup
  }, [o.info]); // eslint-disable-line react-hooks/exhaustive-deps -- built once per probe; the first level/audio are read from state at that moment

  /** Jump to an absolute time: instant inside what's loaded (MSE), else the stream restarts there. */
  const seek = useCallback((target: number) => {
    if (mseRef.current) mseRef.current.seek(target);
    else restartAt(target);
  }, [restartAt]);

  /** From the start again (after the end). */
  const replay = useCallback((onBlocked: () => void) => {
    if (mseRef.current) { mseRef.current.seek(0); opts.current.videoRef.current?.play().catch(onBlocked); }
    else restartAt(0);
  }, [restartAt]);

  /** Another audio track: MSE reloads at the playhead; the pipe restarts at `at`. */
  const changeAudio = useCallback((i: number, at: number) => {
    if (mseRef.current) { setAudioIdx(i); mseRef.current.setAudio(i); }
    else restartAt(at, () => setAudioIdx(i));
  }, [restartAt]);

  /** Volume levelling on/off (the audio comes from the server, so the stream reloads where we are). */
  const changeLevel = useCallback((on: boolean, at: number) => {
    if (mseRef.current) { setLevelKey(on); mseRef.current.setLevel(on); }
    else restartAt(at, () => setLevelKey(on));
  }, [restartAt]);

  /** Keep the clock's loaded range in step with the video. */
  const updateBuffered = useCallback(() => {
    const v = opts.current.videoRef.current;
    if (!v) return;
    if (mseRef.current) {
      const r = mseRef.current.rangeAt(v.currentTime);
      if (r) clock.set({ bufStart: r[0], bufferedEnd: r[1] });
    } else if (v.buffered.length) {
      clock.set({ bufStart: offsetRef.current, bufferedEnd: offsetRef.current + v.buffered.end(v.buffered.length - 1) });
    }
  }, [clock]);

  return {
    mode, src, offset, offsetRef, pending, mseRef, clock, waiting, setWaiting, error, setError,
    audioIdx, setAudioIdx, levelKey,
    seek, replay, changeAudio, changeLevel, updateBuffered, restartAt,
  };
}
