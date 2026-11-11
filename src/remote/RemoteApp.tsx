/**
 * CiRoom's phone remote: the page a phone opens on the home Wi-Fi (QR code in Settings on the PC).
 * It pairs once with a PIN, then shows what plays on the PC and controls it (dev/remote.js relays).
 * It never plays video itself (yet): the picture stays on the PC.
 */
import { Captions, Check, ChevronsRight, RotateCw, Maximize, Minimize, RotateCcw, ChevronLeft, Loader2, Pause, Play, Search, SkipForward, Square, Tv, Clapperboard, Volume1, Volume2, VolumeX, WifiOff, MonitorOff, X, Home as HomeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PosterArt, StillArt } from "@/components/Artwork";
import { cx } from "@/components/ui";
import { episodeCode, timecode, runtime as fmtRuntime } from "@/lib/format";
import { continueWatching, findEpisode, nextUp } from "@/lib/library";
import { useLibrary } from "@/store/library";
import type { Episode, Movie, Progress, Series } from "@/types/media";

interface Now {
  source: "page" | "mpv";
  id: string | null;
  title: string;
  subtitle: string | null;
  position: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  hasNext: boolean;
  /** Skip intro / credits available right now on the PC. */
  skip?: { kind: "intro" | "credits"; label: string } | null;
  subs: { id: number; label: string }[];
  subId: number;
  fullscreen?: boolean;
  subDelay?: number;
}
interface Live { online: boolean; now: Now | null; user: { progress: Record<string, Progress>; favorites: string[] } | null }

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; status: number }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, error: j.error, status: r.status };
  } catch {
    return { ok: false, error: "Can't reach the PC. Is the phone on the same Wi-Fi?", status: 0 };
  }
}

type Auth = "checking" | "off" | "unpaired" | "paired";

export default function RemoteApp() {
  const [auth, setAuth] = useState<Auth>("checking");
  const check = useCallback(async () => {
    try {
      const j = await (await fetch("/api/remote/me")).json();
      setAuth(!j.enabled ? "off" : j.paired ? "paired" : "unpaired");
    } catch { setAuth("off"); }
  }, []);
  useEffect(() => { void check(); }, [check]);

  return (
    <div className="mx-auto flex h-full max-w-[520px] flex-col bg-bg text-fg">
      {auth === "checking" && <Center><Loader2 className="animate-spin text-fg-subtle" /></Center>}
      {auth === "off" && (
        <Center>
          <MonitorOff size={40} className="text-fg-subtle" />
          <h1 className="mt-4 font-display text-2xl font-semibold">Remote is off</h1>
          <p className="meta mt-2 max-w-xs text-center">On the PC, open CiRoom → Settings → Phone remote and turn it on.</p>
          <button onClick={check} className="mt-6 h-11 rounded-full bg-white/[.1] px-6 text-sm font-semibold">Try again</button>
        </Center>
      )}
      {auth === "unpaired" && <Pair onDone={() => setAuth("paired")} />}
      {auth === "paired" && <Remote onLost={check} />}
    </div>
  );
}

const Center = ({ children }: { children: ReactNode }) => <div className="flex flex-1 flex-col items-center justify-center px-8">{children}</div>;

// ── Pairing ────────────────────────────────────────────────────────────────────────────────
function Pair({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState(() => new URLSearchParams(location.search).get("pair")?.replace(/\D/g, "").slice(0, 6) ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tried = useRef("");

  const submit = useCallback(async (p: string) => {
    if (busy || p.length !== 6) return;
    setBusy(true);
    setErr(null);
    const r = await post("/api/remote/pair", { pin: p });
    setBusy(false);
    if (r.ok) { history.replaceState(null, "", location.pathname); onDone(); } else { setErr(r.error ?? "Couldn't pair."); setPin(""); }
  }, [busy, onDone]);

  useEffect(() => { if (pin.length === 6 && tried.current !== pin) { tried.current = pin; void submit(pin); } }, [pin, submit]);

  return (
    <Center>
      <Logo />
      <h1 className="mt-6 font-display text-[28px] font-semibold leading-tight">Pair this phone</h1>
      <p className="meta mt-2 max-w-[280px] text-center">On the PC: Settings → Phone remote → <b className="text-fg">Pair a phone</b>. Scan the QR code, or type the 6-digit PIN.</p>
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="••••••"
        aria-label="PIN"
        className="mt-8 w-full max-w-[280px] rounded-2xl bg-white/[.06] py-4 text-center font-mono text-[34px] tracking-[0.35em] outline-none ring-1 ring-white/10 focus:ring-accent"
      />
      <div className="mt-3 h-5 text-sm text-danger" role="alert">{err}</div>
      <button disabled={pin.length !== 6 || busy} onClick={() => submit(pin)} className="mt-4 flex h-12 w-full max-w-[280px] items-center justify-center rounded-full bg-accent font-semibold text-accent-ink transition active:scale-[.97] disabled:opacity-40">
        {busy ? <Loader2 className="animate-spin" size={20} /> : "Pair"}
      </button>
    </Center>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2 text-accent">
      <Clapperboard size={26} strokeWidth={2.2} />
      <span className="font-display text-xl font-semibold text-fg">CiRoom</span>
    </div>
  );
}

// ── The remote ─────────────────────────────────────────────────────────────────────────────
function Remote({ onLost }: { onLost: () => void }) {
  const [live, setLive] = useState<Live>({ online: false, now: null, user: null });
  const [linked, setLinked] = useState(false);
  const [tab, setTab] = useState<"remote" | "library">("remote");
  const [toast, setToast] = useState<string | null>(null);
  const loadLib = useLibrary((s) => s.load);
  const lib = useLibrary((s) => s.data);

  useEffect(() => { loadLib(); }, [loadLib]);

  // Live link to the PC. EventSource reconnects by itself; a 401 (revoked) means: pair again.
  useEffect(() => {
    const es = new EventSource("/api/remote/events");
    es.onopen = () => setLinked(true);
    es.onmessage = (e) => { try { setLive(JSON.parse(e.data)); } catch { /* ignore */ } };
    es.onerror = () => { setLinked(false); fetch("/api/remote/me").then((r) => r.json()).then((j) => { if (!j.paired || !j.enabled) onLost(); }).catch(() => undefined); };
    return () => es.close();
  }, [onLost]);

  const say = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast((t) => (t === m ? null : t)), 3500); }, []);
  const send = useCallback(async (body: Record<string, unknown>) => {
    const r = await post("/api/remote/cmd", body);
    if (!r.ok) { say(r.error ?? "Didn't work"); if (r.status === 401 || r.status === 403) onLost(); }
    return r.ok;
  }, [say, onLost]);

  const play = useCallback(async (id: string, fromStart = false) => {
    if (await send({ cmd: "play", id, fromStart })) setTab("remote");
  }, [send]);

  const status = !linked ? { text: "Can't reach the PC", ok: false } : !live.online ? { text: "CiRoom is closed on the PC", ok: false } : { text: "Connected", ok: true };

  return (
    <>
      <header className="flex items-center justify-between px-5 pb-2 pt-[max(16px,env(safe-area-inset-top))]">
        <Logo />
        <span className={cx("flex items-center gap-1.5 rounded-full bg-white/[.06] px-3 py-1 text-xs font-medium", status.ok ? "text-fg-muted" : "text-danger")}>
          {status.ok ? <span className="h-2 w-2 rounded-full bg-success" /> : <WifiOff size={13} />}
          {status.text}
        </span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-6">
        {tab === "remote" ? <NowPanel live={live} lib={lib} send={send} play={play} online={status.ok} /> : <LibraryPanel lib={lib} progress={live.user?.progress ?? {}} play={play} online={status.ok} />}
      </main>

      {toast && <div role="status" className="pointer-events-none fixed inset-x-5 bottom-24 z-50 mx-auto max-w-[480px] rounded-2xl bg-surface-3 px-4 py-3 text-center text-sm shadow-lift">{toast}</div>}

      <nav className="grid grid-cols-2 border-t border-white/[.06] bg-bg pb-[env(safe-area-inset-bottom)]">
        {([["remote", "Remote", HomeIcon], ["library", "Library", Search]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("flex flex-col items-center gap-0.5 py-3 text-[11px] font-medium", tab === k ? "text-fg" : "text-fg-subtle")}>
            <Icon size={22} className={tab === k ? "text-accent" : ""} strokeWidth={tab === k ? 2.3 : 1.8} />
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}

type Send = (b: Record<string, unknown>) => Promise<boolean>;
type PlayFn = (id: string, fromStart?: boolean) => void;
type Lib = ReturnType<typeof useLibrary.getState>["data"];

/** A short-lived local override so a tap feels instant while the PC confirms. */
function useOptimistic(now: Now | null) {
  const [o, setO] = useState<Partial<Now> | null>(null);
  const timer = useRef<number>();
  const patch = (p: Partial<Now>) => { setO(p); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setO(null), 1500); };
  return { now: now && o ? { ...now, ...o } : now, patch };
}

function NowPanel({ live, lib, send, play, online }: { live: Live; lib: Lib; send: Send; play: PlayFn; online: boolean }) {
  const { now, patch } = useOptimistic(live.now);
  const [drag, setDrag] = useState<number | null>(null);

  if (!now) return <Idle live={live} lib={lib} play={play} online={online} />;

  // Artwork of what's playing (the library knows it by id).
  const movie = lib?.movies.find((m) => m.id === now.id);
  const ep = lib && !movie && now.id ? findEpisode(lib, now.id) : undefined;
  const art = movie?.art ?? ep?.series.art;
  const pos = drag ?? now.position;
  const vol = now.muted ? 0 : Math.min(100, now.volume);
  const VolIcon = vol === 0 ? VolumeX : vol < 50 ? Volume1 : Volume2;

  return (
    <div className="pt-2">
      {art ? (
        <StillArt art={art} className="w-full rounded-2xl shadow-lift">
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
          {now.source === "mpv" && <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold">Full player</span>}
        </StillArt>
      ) : null}
      <h1 className="mt-4 font-display text-[26px] font-semibold leading-tight">{now.title}</h1>
      {now.subtitle && <p className="meta mt-1 text-[15px]">{now.subtitle}</p>}

      {now.skip && (
        <button onClick={() => { patch({ skip: null }); void send({ cmd: "skip" }); }}
          className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-full bg-white text-[17px] font-bold text-black shadow-lift transition active:scale-[.98] animate-pop">
          {now.skip.kind === "intro" ? <ChevronsRight size={22} strokeWidth={2.6} /> : <SkipForward size={20} fill="currentColor" />} {now.skip.label}
        </button>
      )}

      <div className="mt-6">
        <input
          type="range" min={0} max={Math.max(1, Math.floor(now.duration))} step={1} value={Math.min(pos, now.duration || pos)}
          aria-label="Position"
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => { if (drag !== null) { patch({ position: drag }); void send({ cmd: "seekTo", value: drag }); setDrag(null); } }}
          onKeyUp={() => { if (drag !== null) { patch({ position: drag }); void send({ cmd: "seekTo", value: drag }); setDrag(null); } }}
          className="remote-range w-full"
          style={{ ["--p" as string]: `${now.duration ? (pos / now.duration) * 100 : 0}%` }}
        />
        <div className="meta mt-1 flex justify-between"><span>{timecode(pos)}</span><span>-{timecode(Math.max(0, now.duration - pos))}</span></div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-6">
        <Round label="Back 10 seconds" onClick={() => { patch({ position: Math.max(0, now.position - 10) }); void send({ cmd: "seekBy", value: -10 }); }}><RotateCcw size={34} strokeWidth={1.8} /><small>10</small></Round>
        <button
          aria-label={now.paused ? "Play" : "Pause"}
          onClick={() => { patch({ paused: !now.paused }); void send({ cmd: "toggle" }); }}
          className="flex h-20 w-20 items-center justify-center rounded-full bg-accent text-accent-ink shadow-lift transition active:scale-95"
        >
          {now.paused ? <Play size={34} fill="currentColor" className="ml-1" /> : <Pause size={34} fill="currentColor" />}
        </button>
        <Round label="Forward 10 seconds" onClick={() => { patch({ position: now.position + 10 }); void send({ cmd: "seekBy", value: 10 }); }}><RotateCw size={34} strokeWidth={1.8} /><small>10</small></Round>
      </div>

      <div className="mt-7 flex items-center gap-3 rounded-2xl bg-white/[.04] px-4 py-3">
        <button aria-label={now.muted ? "Unmute" : "Mute"} onClick={() => { patch({ muted: !now.muted }); void send({ cmd: "mute" }); }} className="text-fg-muted active:scale-90"><VolIcon size={24} /></button>
        <input
          type="range" min={0} max={100} step={1} value={vol} aria-label="Volume"
          onChange={(e) => { const v = Number(e.target.value); patch({ volume: v, muted: false }); void send({ cmd: "volume", value: v }); }}
          className="remote-range w-full" style={{ ["--p" as string]: `${vol}%` }}
        />
        <span className="meta w-9 text-right">{Math.round(vol)}</span>
      </div>

      {now.source === "page" && (
        <button onClick={() => { patch({ fullscreen: !now.fullscreen }); void send({ cmd: "fullscreen" }); }} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white/[.08] text-[15px] font-semibold active:scale-[.98]">
          {now.fullscreen ? <Minimize size={18} /> : <Maximize size={18} />} {now.fullscreen ? "Exit fullscreen" : "Fullscreen on the PC"}
        </button>
      )}

      {now.hasNext && (
        <button onClick={() => void send({ cmd: "next" })} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white/[.08] text-[15px] font-semibold active:scale-[.98]">
          <SkipForward size={18} /> Next episode
        </button>
      )}

      {now.subs.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-subtle"><Captions size={15} /> Subtitles</div>
          <div className="flex flex-wrap gap-2">
            {[{ id: -1, label: "Off" }, ...shortSubs(now.subs)].map((s) => (
              <button key={s.id} onClick={() => { patch({ subId: s.id }); void send({ cmd: "subtitle", value: s.id }); }}
                className={cx("max-w-full truncate rounded-full px-4 py-2 text-sm font-medium", now.subId === s.id ? "bg-accent text-accent-ink" : "bg-white/[.07]")}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {now.subs.length > 0 && now.subId >= 0 && <SubTiming delay={now.subDelay ?? 0} onChange={(v) => { patch({ subDelay: v }); void send({ cmd: "subDelay", value: v }); }} />}

      <button onClick={() => void send({ cmd: "stop" })} className="mx-auto mt-8 flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium text-fg-muted active:scale-95">
        <Square size={15} /> Close the player on the PC
      </button>
    </div>
  );
}

/** Subtitle timing: + shows the text later, − earlier (same sign as the PC players' sync). */
function SubTiming({ delay, onChange }: { delay: number; onChange: (v: number) => void }) {
  const round = (v: number) => Math.round(v * 10) / 10;
  const step = (d: number) => onChange(round(Math.max(-60, Math.min(60, delay + d))));
  const Btn = ({ d, label }: { d: number; label: string }) => (
    <button aria-label={`Subtitles ${d > 0 ? "later" : "earlier"} by ${Math.abs(d)} seconds`} onClick={() => step(d)} className="flex h-12 min-w-[3.25rem] flex-1 items-center justify-center rounded-xl bg-white/[.08] text-[13px] font-bold active:scale-95">{label}</button>
  );
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-subtle"><Captions size={15} /> Subtitle timing</span>
        <button aria-label="Reset subtitle timing" disabled={delay === 0} onClick={() => onChange(0)} className="flex items-center gap-1 text-xs font-medium text-fg-muted disabled:opacity-30"><RotateCcw size={13} /> Reset</button>
      </div>
      <div className="flex items-stretch gap-2">
        <Btn d={-1} label="−1" /><Btn d={-0.1} label="−0.1" />
        <div className="flex min-w-[4.5rem] flex-1 flex-col items-center justify-center rounded-xl bg-white/[.04] text-center">
          <span className="text-[17px] font-semibold tabular-nums">{delay > 0 ? "+" : delay < 0 ? "−" : ""}{Math.abs(delay).toFixed(1)}s</span>
        </div>
        <Btn d={0.1} label="+0.1" /><Btn d={1} label="+1" />
      </div>
      <p className="meta mt-2 text-[12px]">{delay === 0 ? "Words come too early? Tap +. Too late? Tap −." : delay > 0 ? "Subtitles appear later than the speech." : "Subtitles appear earlier than the speech."}</p>
    </div>
  );
}

/** "Hindi (SDH) · Inception.2010.BluRay.…" → "Hindi (SDH)"; identical names get " 1", " 2". */
function shortSubs(subs: { id: number; label: string }[]) {
  const base = subs.map((s) => s.label.split(" · ")[0].trim() || s.label);
  return subs.map((s, i) => {
    const same = base.filter((b) => b === base[i]).length;
    return { id: s.id, label: same > 1 ? `${base[i]} ${base.slice(0, i + 1).filter((b) => b === base[i]).length}` : base[i] };
  });
}

function Round({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button aria-label={label} onClick={onClick} className="relative flex h-16 w-16 flex-col items-center justify-center rounded-full bg-white/[.08] transition active:scale-90 [&>small]:absolute [&>small]:text-[11px] [&>small]:font-bold">
      {children}
    </button>
  );
}

function Idle({ live, lib, play, online }: { live: Live; lib: Lib; play: PlayFn; online: boolean }) {
  const items = useMemo(() => (lib && live.user ? continueWatching(lib, live.user.progress).slice(0, 8) : []), [lib, live.user]);
  return (
    <div className="pt-6">
      <div className="flex flex-col items-center rounded-3xl bg-white/[.04] px-6 py-10 text-center">
        <Tv size={38} className="text-fg-subtle" />
        <h1 className="mt-4 font-display text-2xl font-semibold">Nothing is playing</h1>
        <p className="meta mt-1.5">{online ? "Pick something below, or open the Library tab." : "Waiting for CiRoom on the PC…"}</p>
      </div>
      {items.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">Continue watching</h2>
          <div className="flex flex-col gap-3">
            {items.map((c) => {
              const id = c.episode?.id ?? c.title.id;
              return (
                <button key={c.key} disabled={!online} onClick={() => play(id)} className="flex items-center gap-3 rounded-2xl bg-white/[.04] p-2.5 text-left active:scale-[.98] disabled:opacity-50">
                  <StillArt art={c.title.art} className="w-32 shrink-0 rounded-xl" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold">{c.title.title}</div>
                    {c.episode && <div className="meta truncate">{episodeCode(c.episode.season, c.episode.number)} · {c.episode.title}</div>}
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[.12]"><div className="h-full bg-accent" style={{ width: `${Math.min(100, (c.progress.position / Math.max(1, c.progress.duration)) * 100)}%` }} /></div>
                    <div className="meta mt-1">{timecode(c.progress.position)} of {timecode(c.progress.duration)}</div>
                  </div>
                  <Play size={22} className="mr-1 shrink-0 text-accent" fill="currentColor" />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Library ────────────────────────────────────────────────────────────────────────────────
function LibraryPanel({ lib, progress, play, online }: { lib: Lib; progress: Record<string, Progress>; play: PlayFn; online: boolean }) {
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Movie | Series | null>(null);
  const list = useMemo(() => {
    const src: (Movie | Series)[] = (kind === "movie" ? lib?.movies : lib?.series) ?? [];
    const needle = q.trim().toLowerCase();
    return [...src].filter((t) => !needle || t.title.toLowerCase().includes(needle)).sort((a, b) => a.title.localeCompare(b.title));
  }, [lib, kind, q]);

  if (!lib) return <div className="flex justify-center pt-20"><Loader2 className="animate-spin text-fg-subtle" /></div>;
  if (open) return <Detail title={open} progress={progress} play={play} online={online} onBack={() => setOpen(null)} />;

  return (
    <div className="pt-2">
      <div className="sticky top-0 z-10 -mx-5 bg-bg px-5 pb-3 pt-1">
        <div className="relative">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library" aria-label="Search" className="h-12 w-full rounded-full bg-white/[.06] pl-11 pr-10 text-[15px] outline-none ring-1 ring-white/10 focus:ring-accent" />
          {q && <button aria-label="Clear" onClick={() => setQ("")} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-fg-subtle"><X size={18} /></button>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-white/[.06] p-1">
          {(["movie", "series"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={cx("h-9 rounded-full text-sm font-semibold", kind === k ? "bg-white/[.16]" : "text-fg-muted")}>{k === "movie" ? "Movies" : "Series"}</button>
          ))}
        </div>
      </div>
      {list.length === 0 ? <p className="meta pt-10 text-center">Nothing matches “{q}”.</p> : (
        <div className="grid grid-cols-3 gap-3 pt-1">
          {list.map((t) => (
            <button key={t.id} onClick={() => setOpen(t)} className="text-left active:scale-95">
              <PosterArt art={t.art} title={t.title} year={t.year} className="w-full rounded-poster" />
              <div className="mt-1.5 line-clamp-2 text-[12px] font-medium leading-4">{t.title}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ title, progress, play, online, onBack }: { title: Movie | Series; progress: Record<string, Progress>; play: PlayFn; online: boolean; onBack: () => void }) {
  const isMovie = title.kind === "movie";
  const seasons = isMovie ? [] : (title as Series).seasons.filter((s) => s.episodes.some((e) => e.file));
  const up = !isMovie ? nextUp(title as Series, progress) : null;
  const [season, setSeason] = useState(up?.episode.season ?? seasons[0]?.number ?? 1);
  const p = isMovie ? progress[title.id] : undefined;
  const resume = !!p && !p.watched && p.position > 30;

  return (
    <div className="pt-1">
      <button onClick={onBack} className="-ml-1 mb-3 flex items-center gap-1 py-2 text-sm font-medium text-fg-muted"><ChevronLeft size={20} /> Library</button>
      <div className="flex gap-4">
        <PosterArt art={title.art} title={title.title} year={title.year} showTitle={false} className="w-[34%] shrink-0 rounded-card shadow-rest" />
        <div className="min-w-0 pt-1">
          <h1 className="font-display text-[24px] font-semibold leading-tight">{title.title}</h1>
          <p className="meta mt-1.5">{[title.year, isMovie ? fmtRuntime((title as Movie).runtime) : `${seasons.length} season${seasons.length === 1 ? "" : "s"}`, title.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      {title.overview && <p className="mt-4 line-clamp-5 text-[14px] leading-6 text-fg-muted">{title.overview}</p>}

      {isMovie ? (
        <div className="mt-5 flex gap-3">
          <button disabled={!online} onClick={() => play(title.id)} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-accent font-semibold text-accent-ink active:scale-[.97] disabled:opacity-40">
            <Play size={18} fill="currentColor" /> {resume ? `Resume ${timecode(p!.position)}` : "Play on PC"}
          </button>
          {resume && <button disabled={!online} onClick={() => play(title.id, true)} className="h-12 rounded-full bg-white/[.08] px-5 text-sm font-semibold disabled:opacity-40">Start over</button>}
        </div>
      ) : (
        <>
          {up && (
            <button disabled={!online} onClick={() => play(up.episode.id)} className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent font-semibold text-accent-ink active:scale-[.97] disabled:opacity-40">
              <Play size={18} fill="currentColor" /> {up.mode === "start" ? "Start" : up.mode === "resume" ? "Resume" : "Next"} {episodeCode(up.episode.season, up.episode.number)}
            </button>
          )}
          <div className="-mx-5 mt-5 flex gap-2 overflow-x-auto px-5 pb-1">
            {seasons.map((s) => (
              <button key={s.number} onClick={() => setSeason(s.number)} className={cx("shrink-0 rounded-full px-4 py-2 text-sm font-semibold", season === s.number ? "bg-white text-bg" : "bg-white/[.08]")}>Season {s.number}</button>
            ))}
          </div>
          <ul className="mt-3 flex flex-col gap-2 pb-4">
            {(seasons.find((s) => s.number === season)?.episodes ?? []).map((e: Episode) => {
              const ep = progress[e.id];
              return (
                <li key={e.id}>
                  <button disabled={!online || !e.file} onClick={() => play(e.id)} className="flex w-full items-center gap-3 rounded-2xl bg-white/[.04] px-3 py-3 text-left active:scale-[.98] disabled:opacity-40">
                    <span className="w-8 shrink-0 text-center font-display text-lg font-semibold text-fg-muted">{e.number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{e.title}</span>
                      <span className="meta block">{e.file ? fmtRuntime(e.runtime) : "Not on disk"}</span>
                    </span>
                    {ep?.watched ? <Check size={18} className="shrink-0 text-accent" /> : e.file ? <Play size={18} className="shrink-0 text-fg-subtle" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
