/**
 * Watching on the phone (in the phone's browser). The video streams from the PC over the home network through the
 * phone-only routes /api/remote/watch/* (by library id; server/lib/phone-watch.js), played with the same MSE player
 * as the watch-party guest. Progress and watch time go back through the PC window (/api/remote/progress), never to
 * the database directly. "Send to PC" hands the current position to the PC window and starts it there.
 */
import { AudioLines, Captions, Gauge, Loader2, Maximize, MonitorUp, Minimize, Pause, Play, RotateCcw, RotateCw, SkipForward, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseVtt, type Cue, type ProbeInfo } from "@/api/stream";
import { audioLabel, startAudio } from "@/components/WebPlayer";
import { cx } from "@/components/ui";
import { timecode } from "@/lib/format";
import { findEpisode } from "@/lib/library";
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
  if (status === 0) return "CiRoom isn't open on the PC, or this phone isn't on the same network any more.";
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
      const d = await r.json();
      return typeof d.start === "number" && d.start <= t + 0.01 ? d.start : t;
    } catch { return t; }
  },
  streamUrl: (_p, t, level = true, a = 0) => `/api/remote/watch/stream?id=${q(id)}&t=${t.toFixed(3)}${level ? "" : "&level=0"}${low ? "&q=low" : ""}${a ? `&a=${a}` : ""}`,
});

const post = (url: string, body: unknown, keepalive = false) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive }).then(
    async (r) => ({ ok: r.ok, status: r.status, error: ((await r.json().catch(() => ({}))) as { error?: string }).error }),
    () => ({ ok: false, status: 0, error: undefined as string | undefined }),
  );

export function PhonePlayer({ id: firstId, startAt, user, onClose, onLost }: { id: string; startAt: number; user: PhoneUser | null; onClose: () => void; onLost: () => void }) {
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
  const [cue, setCue] = useState("");
  const [subError, setSubError] = useState(false);
  const [full, setFull] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const mse = useRef<MseStream | null>(null);
  const cues = useRef<Cue[]>([]);
  const probeRef = useRef<PhoneProbe | null>(null);
  const idRef = useRef(curId);
  const startRef = useRef(startAt); // where the next (re)build starts
  const watched = useRef(0); // seconds really played since the last report
  const hideTimer = useRef<number>();
  const titleKey = useCallback((id: string) => (lib?.movies.some((m) => m.id === id) ? id : lib ? findEpisode(lib, id)?.series.id ?? id : id), [lib]);
  idRef.current = curId;

  const wake = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!video.current?.paused) setControls(false); }, 3000);
  }, []);
  const say = useCallback((m: string) => { setNote(m); window.setTimeout(() => setNote((n) => (n === m ? null : n)), 3500); }, []);

  /** Progress through the PC window. `final`: the last save of this moment (pause, close, hide), allowed to come sooner. */
  const report = useCallback(async (final = false) => {
    const v = video.current, p = probeRef.current;
    if (!v || !p || !p.duration) return true;
    const pos = Math.max(0, Math.min(v.currentTime, p.duration));
    const w = Math.min(120, Math.round(watched.current));
    if (pos < 1 && w === 0) return true;
    let r = await post("/api/remote/progress", { id: idRef.current, position: pos, duration: p.duration, watched: w, final }, true);
    if (!r.ok && r.status === 429 && final) { await new Promise((res) => setTimeout(res, 650)); r = await post("/api/remote/progress", { id: idRef.current, position: pos, duration: p.duration, watched: w, final }, true); }
    if (r.ok) watched.current = Math.max(0, watched.current - w);
    return r.ok;
  }, []);

  // ── Load the video (again when the episode or the quality changes) ──────────────────────────
  useEffect(() => {
    let alive = true;
    const v = video.current;
    if (!v) return;
    setLoading(true); setError(null); setEnded(false); setProbe(null); setCue(""); cues.current = [];
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
      const low = quality === "low";
      const mime = low ? lowStreamMime(p) : streamMime(p);
      if (!MseStream.supported(mime)) { setError("This browser can't play this video. Try Chrome."); setLoading(false); return; }
      probeRef.current = p; setProbe(p);
      const key = titleKey(curId);
      const aIdx = startAudio(p.audioTracks ?? [], user?.audioPrefs?.[key]);
      const sIdx = startSubtitle(p.subtitles, user?.subPrefs?.[key], user?.prefs);
      setAudio(aIdx); setSubs(sIdx);
      mse.current?.destroy();
      const m = new MseStream(v, "", p.duration, mime, true, aIdx, (msg) => setError(msg.replace(/ or use the full player\.?|Try the full player\.?/g, "").trim()), source(curId, low));
      mse.current = m;
      const at = Math.max(0, Math.min(startRef.current, Math.max(0, p.duration - 5)));
      await m.start(at);
      if (!alive) return;
      setLoading(false);
      v.play().catch(() => setNeedsTap(true));
    })();
    return () => { alive = false; mse.current?.destroy(); mse.current = null; };
    // user is read once per video: later changes (our own progress echoing back) must not rebuild the player
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, quality, reload]);

  // Subtitle cues for the chosen track.
  useEffect(() => {
    cues.current = []; setCue(""); setSubError(false);
    const p = probe;
    if (!p || subs < 0) return;
    const s = p.subtitles.find((x) => x.index === subs);
    let alive = true;
    fetch(`/api/remote/watch/subtitle.vtt?id=${q(curId)}&${s?.embedded ? `e=${s.stream}` : `i=${subs}`}`)
      .then(async (r) => { if (!r.ok) throw new Error(); const c = parseVtt(await r.text()); if (alive) { cues.current = c; if (!c.length) setSubError(true); } })
      .catch(() => { if (alive) setSubError(true); });
    return () => { alive = false; };
  }, [probe, subs, curId]);

  // Clock: current time, subtitle line, watch time.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let lastT = -1;
    const tick = window.setInterval(() => {
      const t = v.currentTime;
      setTime(t);
      const c = cues.current.find((x) => t >= x.start && t <= x.end);
      setCue(c?.text ?? "");
      if (!v.paused && !v.ended && v.readyState >= 3 && lastT >= 0 && t > lastT && t - lastT < 2) watched.current += 1;
      lastT = t;
    }, 1000);
    const fast = window.setInterval(() => { const t = v.currentTime; setTime(t); const c = cues.current.find((x) => t >= x.start && t <= x.end); setCue(c?.text ?? ""); }, 250);
    return () => { window.clearInterval(tick); window.clearInterval(fast); };
  }, []);

  // Progress: every 10 s while playing; on pause, close, hide.
  useEffect(() => {
    const t = window.setInterval(() => { if (!video.current?.paused) void report(false); }, 10_000);
    const hide = () => { if (document.visibilityState === "hidden") void report(true); };
    const gone = () => void report(true);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", gone);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", gone); };
  }, [report]);

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
      try { await (screen.orientation as ScreenOrientation & { lock: (o: string) => Promise<void> }).lock("landscape"); } catch { /* the phone may not allow it */ }
    } catch { say("This browser didn't allow fullscreen."); }
  };

  const duration = probe?.duration ?? 0;
  const shown = drag ?? time;
  const seekTo = (t: number) => { const to = Math.max(0, Math.min(duration - 0.5, t)); mse.current?.seek(to); setTime(to); wake(); };
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) void v.play().catch(() => setNeedsTap(true)); else v.pause(); wake(); };

  const close = async () => { video.current?.pause(); await report(true); onClose(); };
  const next = async () => {
    if (!probe?.nextId) return;
    video.current?.pause();
    await report(true);
    startRef.current = 0;
    setCurId(probe.nextId);
  };
  const sendToPc = async () => {
    video.current?.pause();
    const saved = await report(true);
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
  const pickAudio = (i: number) => { setAudio(i); setMenu(null); mse.current?.setAudio(i); };
  const pickQuality = (qv: Quality) => {
    setMenu(null);
    if (qv === quality) return;
    startRef.current = video.current?.currentTime ?? 0;
    saveQuality(qv); setQuality(qv); setReload((n) => n + 1);
  };

  const title = probe ? [probe.title, probe.subtitle].filter(Boolean).join(" · ") : "";
  const nearEnd = !!probe?.nextId && (ended || (duration > 0 && duration - time < 25));
  const tracks = probe?.audioTracks ?? [];

  return (
    <div ref={box} className="fixed inset-0 z-[60] select-none bg-black text-white" onPointerMove={wake}>
      <video
        ref={video} playsInline preload="auto" className="absolute inset-0 h-full w-full bg-black object-contain"
        onClick={() => { if (menu) setMenu(null); else if (controls && !paused) setControls(false); else wake(); }}
        onPlay={() => { setPaused(false); setNeedsTap(false); setEnded(false); wake(); }}
        onPause={() => { setPaused(true); setControls(true); if (!video.current?.ended) void report(true); }}
        onEnded={() => { setEnded(true); setControls(true); void report(true); }}
        onWaiting={() => mse.current?.onWaiting()}
      />

      {cue && <div dir="auto" className={cx("pointer-events-none absolute inset-x-4 text-center", controls ? "bottom-36" : "bottom-10")}><span className="whitespace-pre-line rounded bg-black/70 px-2 py-1 text-[clamp(15px,3.8vw,22px)] leading-snug">{cue}</span></div>}

      {(loading || (!error && !paused && video.current && video.current.readyState < 3)) && !error && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin" size={44} /></div>}

      {needsTap && !error && !loading && (
        <button onClick={toggle} className="absolute inset-0 flex items-center justify-center bg-black/50" aria-label="Play"><span className="flex h-20 w-20 items-center justify-center rounded-full bg-accent text-accent-ink"><Play size={34} fill="currentColor" className="ml-1" /></span></button>
      )}

      {error && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/85 px-8 text-center">
          <p className="max-w-xs text-[17px] leading-6">{error}</p>
          <div className="flex gap-3">
            <button onClick={() => { startRef.current = video.current?.currentTime ?? startRef.current; setReload((n) => n + 1); }} className="h-11 rounded-full bg-white/[.14] px-6 text-sm font-semibold">Try again</button>
            <button onClick={() => void close()} className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink">Back</button>
          </div>
        </div>
      )}

      {nearEnd && !error && (
        <button onClick={() => void next()} className={cx("absolute right-4 flex h-12 items-center gap-2 rounded-full bg-white px-5 text-[15px] font-bold text-black shadow-lift active:scale-95", controls ? "bottom-32" : "bottom-8")}>
          <SkipForward size={18} fill="currentColor" /> Next episode
        </button>
      )}

      {note && <div role="status" className="pointer-events-none absolute inset-x-6 top-20 mx-auto max-w-sm rounded-2xl bg-surface-3 px-4 py-3 text-center text-sm shadow-lift">{note}</div>}

      <div className={cx("absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/70 via-transparent to-black/80 transition-opacity duration-200 pointer-events-none", controls ? "opacity-100" : "invisible opacity-0")}>
        {/* top */}
        <div className="pointer-events-auto flex items-center gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))]">
          <button aria-label="Close" onClick={() => void close()} className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 active:scale-90"><X size={26} /></button>
          <div className="min-w-0 flex-1"><div className="truncate text-[16px] font-semibold">{title}</div>{quality === "low" && <div className="text-xs text-white/70">Low data (480p)</div>}</div>
          <button aria-label="Send to the PC" onClick={() => void sendToPc()} className="flex h-12 items-center gap-2 rounded-full bg-black/40 px-4 text-sm font-semibold active:scale-95"><MonitorUp size={20} /> <span className="hidden min-[400px]:inline">Send to PC</span></button>
        </div>
        {/* centre */}
        <div className="pointer-events-auto flex items-center justify-center gap-10">
          <button aria-label="Back 10 seconds" onClick={() => seekTo((video.current?.currentTime ?? 0) - 10)} className="relative flex h-16 w-16 items-center justify-center rounded-full bg-black/40 active:scale-90"><RotateCcw size={34} strokeWidth={1.8} /><small className="absolute text-[11px] font-bold">10</small></button>
          <button aria-label={paused ? "Play" : "Pause"} onClick={toggle} className="flex h-20 w-20 items-center justify-center rounded-full bg-accent text-accent-ink shadow-lift active:scale-95">{paused ? <Play size={34} fill="currentColor" className="ml-1" /> : <Pause size={34} fill="currentColor" />}</button>
          <button aria-label="Forward 10 seconds" onClick={() => seekTo((video.current?.currentTime ?? 0) + 10)} className="relative flex h-16 w-16 items-center justify-center rounded-full bg-black/40 active:scale-90"><RotateCw size={34} strokeWidth={1.8} /><small className="absolute text-[11px] font-bold">10</small></button>
        </div>
        {/* bottom */}
        <div className="pointer-events-auto px-5 pb-[max(14px,env(safe-area-inset-bottom))]">
          <input
            type="range" min={0} max={Math.max(1, Math.floor(duration))} step={1} value={Math.min(shown, duration || shown)} aria-label="Position" className="remote-range w-full"
            style={{ ["--p" as string]: `${duration ? (shown / duration) * 100 : 0}%` }}
            onChange={(e) => { setDrag(Number(e.target.value)); wake(); }}
            onPointerUp={() => { if (drag !== null) { seekTo(drag); setDrag(null); } }}
            onKeyUp={() => { if (drag !== null) { seekTo(drag); setDrag(null); } }}
          />
          <div className="mt-1 flex items-center justify-between text-xs tabular-nums text-white/80">
            <span>{timecode(shown)} / {timecode(duration)}</span>
            <div className="flex items-center gap-1">
              {probe && probe.subtitles.length > 0 && <Tool label="Subtitles" on={subs >= 0} onClick={() => setMenu("subs")}><Captions size={22} /></Tool>}
              {tracks.length > 1 && <Tool label="Audio" onClick={() => setMenu("audio")}><AudioLines size={22} /></Tool>}
              <Tool label="Quality" on={quality === "low"} onClick={() => setMenu("quality")}><Gauge size={22} /></Tool>
              <Tool label={full ? "Exit fullscreen" : "Fullscreen"} onClick={() => void toggleFull()}>{full ? <Minimize size={22} /> : <Maximize size={22} />}</Tool>
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <div className="absolute inset-0 z-10 flex items-end bg-black/50" onClick={() => setMenu(null)}>
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

const Heading = ({ children }: { children: string }) => <div className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-white/60">{children}</div>;
const Choice = ({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className={cx("mb-1.5 flex min-h-12 w-full items-center rounded-xl px-4 py-2 text-left text-[15px] font-medium", selected ? "bg-accent text-accent-ink" : "bg-white/[.07]")}>{children}</button>
);
const Tool = ({ label, on, onClick, children }: { label: string; on?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button aria-label={label} onClick={onClick} className={cx("flex h-11 w-11 items-center justify-center rounded-full active:scale-90", on ? "text-accent" : "text-white")}>{children}</button>
);
