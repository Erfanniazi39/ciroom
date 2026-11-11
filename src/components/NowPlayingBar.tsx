import {
  AlertTriangle, AudioLines, Captions, Gauge, MonitorPlay, Pause, Play, RotateCcw, RotateCw,
  SkipForward, Square, Volume1, Volume2, VolumeX, X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Link } from "react-router-dom";
import { buildRequest, resolveEpisode } from "@/hooks/usePlay";
import { timecode } from "@/lib/format";
import { fetchSnapshot, usePlayer, type Track } from "@/store/player";
import { isCompleted, useUser } from "@/store/user";
import { StillArt } from "./Artwork";
import { MenuItem, MenuTitle, Popover } from "./Popover";
import { Button, IconButton, cx } from "./ui";

const UP_NEXT_SECONDS = 10;
const POLL_MS = 500;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Now-playing bar, shown while mpv plays in its own window (SPEC §6).
 * Full transport + subtitle/audio/speed/volume controls, all mirrored live from mpv.
 */
export function NowPlayingBar() {
  const { current, upNext, error, play, sync, setUpNext, clearError } = usePlayer();
  const savePosition = useUser((s) => s.savePosition);
  const lastSaved = useRef(0);
  const sawRunning = useRef(false);
  // Watch time for Stats (mpv sessions): seconds while mpv is really playing (not paused, position moving).
  const watched = useRef(0);
  const lastPos = useRef<number | null>(null);
  // Subtitle/audio track seen last poll: a change after start (mpv menu, keys, this bar) is remembered per series.
  const lastTracks = useRef<{ sid: number | null; aid: number | null } | null>(null);
  const trackPolls = useRef(0);

  // Mirror mpv state; persist progress; detect window close / end of file.
  useEffect(() => {
    if (!current || upNext) return;
    lastSaved.current = current.startAt;
    sawRunning.current = false;
    lastPos.current = null;
    lastTracks.current = null;
    trackPolls.current = 0;
    const titleId = current.titleId ?? current.id;
    const flush = () => { if (watched.current > 0) { useUser.getState().addWatchTime(titleId, watched.current); watched.current = 0; } };
    const t = setInterval(async () => {
      const snap = await fetchSnapshot();
      const cur = usePlayer.getState().current;
      if (!snap || !cur || cur.id !== current.id) return;

      if (snap.running) {
        sawRunning.current = true;
        sync(snap);
        // Count real playing time: unpaused and the position actually advanced (not stuck loading).
        const moved = lastPos.current !== null && snap.position > lastPos.current && snap.position - lastPos.current < 5;
        if (!snap.paused && moved) watched.current += POLL_MS / 1000;
        lastPos.current = snap.position;
        if (watched.current >= 15) flush();
        // Wait ~1.5 s after the tracks appear so mpv's own start-up selection isn't mistaken for a choice.
        if ((snap.subtitles.length || snap.audio.length) && ++trackPolls.current >= 3) {
          const prev = lastTracks.current;
          if (prev && prev.sid !== snap.sid) {
            const t = snap.subtitles.find((x) => x.id === snap.sid);
            if (snap.sid === null) useUser.getState().setSubPref(titleId, { off: true });
            else if (t) useUser.getState().setSubPref(titleId, { language: t.language ?? null, name: t.label ?? t.title ?? "" });
          }
          if (prev && prev.aid !== snap.aid) {
            const a = snap.audio.find((x) => x.id === snap.aid);
            if (a?.lang) useUser.getState().setAudioPref(titleId, a.lang);
          }
          lastTracks.current = { sid: snap.sid, aid: snap.aid };
        }
        // N pressed inside mpv → next episode.
        if (snap.nextRequested && cur.nextId) {
          const n = resolveEpisode(cur.nextId);
          if (n) { savePosition(cur.id, snap.position, snap.duration || cur.duration); usePlayer.getState().play(buildRequest(n, 0)); return; }
        }
        // Sub delay may also be changed inside mpv (z / x keys): remember it for this title.
        const saved = useUser.getState().subDelays[cur.id] ?? 0;
        if (Math.abs(saved - snap.subDelay) > 0.001) useUser.getState().setSubDelay(cur.id, snap.subDelay);
        const dur = snap.duration || cur.duration;
        if (Math.abs(snap.position - lastSaved.current) >= 10) {
          savePosition(cur.id, snap.position, dur);
          lastSaved.current = snap.position;
        }
        return;
      }
      if (!sawRunning.current) return; // mpv still starting
      flush();
      const dur = snap.duration || cur.duration;
      const pos = snap.ended ? dur : snap.position;
      savePosition(cur.id, pos, dur);
      const next = (snap.ended || isCompleted(pos, dur)) && cur.nextId ? resolveEpisode(cur.nextId) : undefined;
      if (next) setUpNext(buildRequest(next, 0));
      else usePlayer.setState({ current: null });
    }, POLL_MS);
    return () => { clearInterval(t); flush(); };
  }, [current?.id, upNext, sync, savePosition, setUpNext]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 7000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  if (error && !current) {
    return (
      <Shell>
        <div className="flex items-center gap-3 p-4">
          <AlertTriangle size={18} className="shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Couldn't start playback</div>
            <div className="meta truncate">{error}</div>
          </div>
          <IconButton label="Dismiss" onClick={clearError}><X size={18} /></IconButton>
        </div>
      </Shell>
    );
  }
  if (!current) return null;

  return (
    <Shell backdrop={current.backdrop}>
      {upNext ? (
        <UpNext req={upNext} onPlay={() => play(upNext)} onCancel={() => usePlayer.setState({ current: null, upNext: null })} />
      ) : (
        <Transport />
      )}
    </Shell>
  );
}

function Transport() {
  const c = usePlayer((s) => s.current)!;
  const { togglePause, seek, seekBy, set, stop, play } = usePlayer();
  const savePosition = useUser((s) => s.savePosition);

  const onStop = () => {
    savePosition(c.id, c.position, c.duration);
    stop();
  };
  const next = () => {
    const n = c.nextId ? resolveEpisode(c.nextId) : undefined;
    if (n) { savePosition(c.id, c.position, c.duration); play(buildRequest(n, 0)); }
  };

  return (
    <div className="px-4 pb-3 pt-2">
      <SeekBar position={c.position} duration={c.duration} onSeek={seek} />

      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4">
        {/* Now playing */}
        <div className="flex min-w-0 items-center gap-3">
          <Link to={c.href} className="w-[88px] shrink-0 overflow-hidden rounded-lg ring-1 ring-white/10" title="Open details">
            <StillArt art={{ hue: c.hue, backdrop: c.backdrop }} />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
              <MonitorPlay size={12} /> {c.paused ? "Paused" : "Playing"} in mpv
            </div>
            <div className="truncate text-[15px] font-semibold leading-6">{c.title}</div>
            {c.subtitle && <div className="meta truncate">{c.subtitle}</div>}
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1.5">
          <IconButton label="Back 10 seconds" onClick={() => seekBy(-10)} className="!bg-transparent hover:!bg-white/[.08]">
            <RotateCcw size={19} />
            <span className="sr-only">10</span>
          </IconButton>
          <button
            onClick={togglePause}
            aria-label={c.paused ? "Play" : "Pause"}
            title={c.paused ? "Play" : "Pause"}
            className="group/pp relative mx-1 flex h-14 w-14 items-center justify-center rounded-full bg-fg text-bg shadow-[0_10px_30px_-8px_rgb(255_255_255/.35)] transition duration-200 hover:scale-105 active:scale-95"
          >
            <Pause size={22} fill="currentColor" className={cx("absolute transition duration-200", c.paused ? "scale-50 opacity-0" : "scale-100 opacity-100")} />
            <Play size={22} fill="currentColor" className={cx("absolute ml-1 transition duration-200", c.paused ? "scale-100 opacity-100" : "scale-50 opacity-0")} />
          </button>
          <IconButton label="Forward 10 seconds" onClick={() => seekBy(10)} className="!bg-transparent hover:!bg-white/[.08]">
            <RotateCw size={19} />
          </IconButton>
          {c.nextId && (
            <IconButton label="Next episode" onClick={next} className="!bg-transparent hover:!bg-white/[.08]">
              <SkipForward size={19} />
            </IconButton>
          )}
        </div>

        {/* Options */}
        <div className="flex items-center justify-end gap-0.5">
          <SubtitleMenu tracks={c.subtitles} sid={c.sid} delay={c.subDelay} onTrack={(id) => set("sid", id ?? "no")} onDelay={(v) => set("sub-delay", v)} />
          {c.audio.length > 1 && <AudioMenu tracks={c.audio} aid={c.aid} onTrack={(id) => set("aid", id)} />}
          <SpeedMenu speed={c.speed} onSpeed={(v) => set("speed", v)} />
          <VolumeControl volume={c.volume} muted={c.muted} onVolume={(v) => { set("volume", v); if (c.muted && v > 0) set("mute", false); }} onMute={() => set("mute", !c.muted)} />
          <IconButton label="Stop and save position" onClick={onStop} className="ml-1 !bg-transparent hover:!bg-danger/20 hover:!text-danger">
            <Square size={15} fill="currentColor" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/** Scrubber: grows on hover, shows a time tooltip, supports click and drag. */
function SeekBar({ position, duration, onSeek }: { position: number; duration: number; onSeek: (s: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null); // 0–1
  const [drag, setDrag] = useState<number | null>(null);
  const ratio = drag ?? (duration ? position / duration : 0);

  const at = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  return (
    <div className="flex items-center gap-3">
      <span className="meta w-[52px] text-right text-[12px]">{timecode(drag !== null ? drag * duration : position)}</span>
      <div
        ref={ref}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${timecode(position)} of ${timecode(duration)}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") onSeek(Math.min(duration, position + 10));
          if (e.key === "ArrowLeft") onSeek(Math.max(0, position - 10));
        }}
        onPointerMove={(e) => { setHover(at(e)); if (drag !== null) setDrag(at(e)); }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(at(e)); }}
        onPointerUp={(e) => { if (drag !== null) onSeek(at(e) * duration); setDrag(null); }}
        className="group/seek relative flex h-5 flex-1 cursor-pointer touch-none items-center"
      >
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/[.14] transition-[height] duration-150 group-hover/seek:h-1.5">
          {hover !== null && <div className="absolute inset-y-0 left-0 bg-white/[.18]" style={{ width: `${hover * 100}%` }} />}
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
        </div>
        <div
          className={cx("absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-fg shadow-[0_0_0_4px_rgb(var(--accent)/.25)] transition-transform duration-150", drag !== null ? "scale-100" : "scale-0 group-hover/seek:scale-100")}
          style={{ left: `${ratio * 100}%` }}
        />
        {hover !== null && duration > 0 && (
          <div className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md bg-black/85 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-white" style={{ left: `${hover * 100}%` }}>
            {timecode(hover * duration)}
          </div>
        )}
      </div>
      <span className="meta w-[52px] text-[12px]">−{timecode(Math.max(0, duration - (drag !== null ? drag * duration : position)))}</span>
    </div>
  );
}

const CODECS: Record<string, string> = {
  subrip: "SRT", ass: "ASS", ssa: "SSA", webvtt: "VTT", mov_text: "Text", hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub", dvb_subtitle: "DVB",
  aac: "AAC", ac3: "Dolby", eac3: "Dolby+", dts: "DTS", truehd: "TrueHD", flac: "FLAC", opus: "Opus", mp3: "MP3", vorbis: "Vorbis",
};
const codecName = (c: string | null) => (c ? CODECS[c.toLowerCase()] ?? c.toUpperCase() : undefined);

const trackName = (t: Track, i: number) =>
  t.title || t.label || (t.lang ? langName(t.lang) : null) || `Track ${i + 1}`;

function langName(code: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function SubtitleMenu({ tracks, sid, delay, onTrack, onDelay }: { tracks: Track[]; sid: number | null; delay: number; onTrack: (id: number | null) => void; onDelay: (v: number) => void }) {
  const step = (d: number) => onDelay(Math.round((delay + d) * 10) / 10);
  const fmt = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} s`;
  return (
    <Popover label="Subtitles" active={sid !== null} align="end" trigger={<><Captions size={19} />{delay !== 0 && <span className="text-[11px]">{fmt(delay)}</span>}</>}>
      {() => (
        <div className="w-[300px]">
          <MenuTitle>Subtitles</MenuTitle>
          <div className="max-h-56 overflow-y-auto">
            <MenuItem selected={sid === null} onClick={() => onTrack(null)}>Off</MenuItem>
            {tracks.map((t, i) => (
              <MenuItem key={t.id} selected={t.id === sid} onClick={() => onTrack(t.id)} hint={t.external ? "File" : `Built-in${codecName(t.codec) ? ` · ${codecName(t.codec)}` : ""}`}>
                {trackName(t, i)}
              </MenuItem>
            ))}
            {tracks.length === 0 && <p className="px-3 py-2 text-[13px] text-fg-subtle">No subtitles found for this video.</p>}
          </div>

          <div className="mx-1 my-2 h-px bg-white/[.07]" />
          <MenuTitle>Sync</MenuTitle>
          <div className="flex items-center gap-1 px-2 pb-1">
            <StepButton onClick={() => step(-0.5)} label="Subtitles 0.5 s earlier">−0.5</StepButton>
            <StepButton onClick={() => step(-0.1)} label="Subtitles 0.1 s earlier">−0.1</StepButton>
            <div className={cx("flex-1 text-center text-[15px] font-semibold tabular-nums", delay !== 0 ? "text-accent" : "text-fg")}>{fmt(delay)}</div>
            <StepButton onClick={() => step(0.1)} label="Subtitles 0.1 s later">+0.1</StepButton>
            <StepButton onClick={() => step(0.5)} label="Subtitles 0.5 s later">+0.5</StepButton>
          </div>
          <div className="flex items-center justify-between px-3 pb-2 pt-1">
            <span className="text-[12px] leading-4 text-fg-subtle">Text too early → <b className="text-fg-muted">+</b> · too late → <b className="text-fg-muted">−</b><br />Remembered for this title.</span>
            {delay !== 0 && <button onClick={() => onDelay(0)} className="text-[12px] font-semibold text-fg-muted hover:text-fg">Reset</button>}
          </div>
        </div>
      )}
    </Popover>
  );
}

function StepButton({ onClick, label, children }: { onClick: () => void; label: string; children: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="h-9 w-12 rounded-lg bg-white/[.06] text-[13px] font-semibold tabular-nums text-fg-muted transition hover:bg-white/[.12] hover:text-fg active:scale-95">
      {children}
    </button>
  );
}

function AudioMenu({ tracks, aid, onTrack }: { tracks: Track[]; aid: number | null; onTrack: (id: number) => void }) {
  return (
    <Popover label="Audio track" align="end" trigger={<AudioLines size={19} />}>
      {(close) => (
        <div className="w-[260px]">
          <MenuTitle>Audio</MenuTitle>
          {tracks.map((t, i) => (
            <MenuItem key={t.id} selected={t.id === aid} onClick={() => { onTrack(t.id); close(); }} hint={codecName(t.codec)}>
              {trackName(t, i)}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

function SpeedMenu({ speed, onSpeed }: { speed: number; onSpeed: (v: number) => void }) {
  const label = `${Number(speed.toFixed(2))}×`;
  return (
    <Popover label="Playback speed" align="end" active={speed !== 1} trigger={speed === 1 ? <Gauge size={19} /> : <span>{label}</span>}>
      {(close) => (
        <div className="w-[180px]">
          <MenuTitle>Speed</MenuTitle>
          {SPEEDS.map((s) => (
            <MenuItem key={s} selected={Math.abs(s - speed) < 0.01} onClick={() => { onSpeed(s); close(); }}>
              {s === 1 ? "Normal" : `${s}×`}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

function VolumeControl({ volume, muted, onVolume, onMute }: { volume: number; muted: boolean; onVolume: (v: number) => void; onMute: () => void }) {
  const Icon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const pct = muted ? 0 : Math.min(volume, 130) / 130;
  return (
    <div className="group/vol flex items-center">
      <IconButton label={muted ? "Unmute" : "Mute"} onClick={onMute} className="!bg-transparent hover:!bg-white/[.08]">
        <Icon size={19} className={muted ? "text-fg-subtle" : ""} />
      </IconButton>
      <input
        type="range"
        min={0}
        max={130}
        step={1}
        value={muted ? 0 : volume}
        onChange={(e) => onVolume(Number(e.target.value))}
        aria-label="Volume"
        title={`Volume ${Math.round(volume)}%`}
        className="h-1 w-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 group-hover/vol:mr-2 group-hover/vol:w-24 group-hover/vol:opacity-100 focus-visible:mr-2 focus-visible:w-24 focus-visible:opacity-100 accent-[rgb(var(--fg))]"
        style={{ background: `linear-gradient(to right, rgb(var(--fg)) ${pct * 100}%, rgb(255 255 255 / .16) ${pct * 100}%)` }}
      />
    </div>
  );
}

function Shell({ children, backdrop }: { children: React.ReactNode; backdrop?: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pl-[calc(var(--rail)+16px)]">
      <div className="pointer-events-auto relative w-full max-w-[1040px] rounded-[20px] bg-surface-2/[.92] shadow-[0_30px_90px_-20px_rgb(0_0_0/.95)] ring-1 ring-white/[.08] backdrop-blur-xl animate-pop">
        {backdrop && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[20px]" aria-hidden>
            <img src={backdrop} alt="" className="h-full w-full scale-125 object-cover opacity-[.14] blur-2xl" />
          </div>
        )}
        <div className="relative">{children}</div>
      </div>
    </div>
  );
}

function UpNext({ req, onPlay, onCancel }: { req: { title: string; subtitle?: string; hue: number; backdrop?: string }; onPlay: () => void; onCancel: () => void }) {
  const [left, setLeft] = useState(UP_NEXT_SECONDS);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  useEffect(() => {
    if (left <= 0) { onPlayRef.current(); return; }
    const t = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  return (
    <div className="relative flex items-center gap-4 p-3 pr-4">
      <div className="w-36 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10">
        <StillArt art={{ hue: req.hue, backdrop: req.backdrop }} variant={3} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="micro text-accent">Up next in {left}s</div>
        <div className="truncate text-[15px] font-semibold">{req.subtitle}</div>
        <div className="meta truncate">{req.title}</div>
      </div>
      <Button variant="primary" icon={<Play size={16} fill="currentColor" />} onClick={onPlay}>Play now</Button>
      <IconButton label="Cancel autoplay" onClick={onCancel}><X size={18} /></IconButton>
      <div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-[20px] bg-white/10">
        <div className="h-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${(1 - left / UP_NEXT_SECONDS) * 100}%` }} />
      </div>
    </div>
  );
}
