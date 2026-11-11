import { ArrowLeft, Captions, Check, Heart, Info, MonitorPlay, Plus, Tv } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PosterArt, StillArt } from "@/components/Artwork";
import { EmptyState, NoDetails } from "@/components/States";
import { Badge, Button, IconButton, MetaLine, ProgressBar, cx, ratingItems } from "@/components/ui";
import { WATCH_SLOT_ID } from "@/components/PlayerHost";
import { isRemoteClient } from "@/components/MobileNav";
import { streamApi } from "@/api/stream";
import { usePlayback } from "@/store/playback";
import { buildRequest } from "@/hooks/usePlay";
import { episodeCode, remaining, runtime } from "@/lib/format";
import { durationOf, findEpisode, similarTo } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { usePlayer } from "@/store/player";
import { useUser } from "@/store/user";
import type { Episode, Movie, Series, Title } from "@/types/media";

/**
 * Watch page (YouTube-like layout, CiRoom look): the video plays in the page,
 * with details below and "up next" on the side. Fullscreen and the full mpv player are one click away.
 */
export default function Watch() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const lib = useLibrary((s) => s.data);
  const { progress, favorites, watchlist, toggleFavorite, toggleWatchlist, setWatched } = useUser(
    useShallow((s) => ({ progress: s.progress, favorites: s.favorites, watchlist: s.watchlist, toggleFavorite: s.toggleFavorite, toggleWatchlist: s.toggleWatchlist, setWatched: s.setWatched })),
  ); // not the whole store: watch-time saves every 15 s shouldn't re-render this page
  const playFull = usePlayer((s) => s.play);
  const fullCurrent = usePlayer((s) => s.current);
  const stopFull = usePlayer((s) => s.stop);
  const handedOff = usePlayback((s) => s.handedOff === id);
  const remote = isRemoteClient(); // on a phone: no mpv handoff (mpv would open on the PC)

  const movie = lib?.movies.find((m) => m.id === id);
  const ep = lib && !movie ? findEpisode(lib, id) : undefined;

  // Start position: explicit ?t=, else saved progress (unless finished), else the beginning.
  const startRef = useRef<number | null>(null);
  const startFor = useRef(id);
  if (startFor.current !== id) { startFor.current = id; startRef.current = null; } // switched title/episode
  if (startRef.current === null && (movie || ep)) {
    const t = params.get("t");
    const p = useUser.getState().progress[id];
    startRef.current = t !== null ? Number(t) || 0 : p && !p.watched && p.position > 30 ? p.position : 0;
  }

  // Arriving at the page with a stale handoff (mpv was closed while we were elsewhere): start fresh.
  useEffect(() => {
    if (usePlayback.getState().handedOff === id && usePlayer.getState().current?.id !== id) usePlayback.getState().clearHandoff();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Returning from the full player: continue in the page from where mpv stopped.
  const wasFull = useRef(false);
  useEffect(() => {
    const playingThis = fullCurrent?.id === id;
    if (wasFull.current && !playingThis && handedOff) {
      startRef.current = useUser.getState().progress[id]?.position ?? startRef.current;
      usePlayback.getState().clearHandoff();
    }
    wasFull.current = playingThis;
  }, [fullCurrent?.id, id, handedOff]);

  // The player itself lives in <PlayerHost>; this page opens the session and provides the slot it shows in.
  const hasFile = !!(movie ? movie.file : ep?.episode.file);
  useEffect(() => {
    if (!hasFile || handedOff) return;
    usePlayback.getState().open(id, startRef.current ?? 0);
  }, [id, hasFile, handedOff]);

  if (!lib) return <div className="h-screen" />;
  if (!movie && !ep) {
    return <EmptyState className="pt-[20vh]" icon={Tv} title="Nothing to play" body="This title isn't in your library anymore." action={<Button onClick={() => navigate("/")}>Go home</Button>} />;
  }

  const file = movie ? movie.file : ep!.episode.file;
  const title: Title = movie ?? ep!.series;
  const playable = movie ?? ep!;
  const durationFallback = durationOf(movie ?? ep!.episode);
  const p = progress[id];
  const fav = favorites.includes(title.id);
  const listed = watchlist.includes(title.id);

  const openFull = (pos: number) => {
    usePlayback.getState().handOff(id);
    playFull(buildRequest(playable as Movie | { series: Series; episode: Episode }, pos));
  };

  return (
    <div className="pb-24 pt-6">
      <div className="gutter-x mb-4 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="meta -ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition hover:bg-white/[.06] hover:text-fg">
          <ArrowLeft size={16} /> Back
        </button>
      </div>

      <div className="gutter-x grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Main column */}
        <div className="min-w-0">
          {!file ? (
            <div className="flex aspect-video items-center justify-center rounded-2xl bg-surface-1 text-fg-muted ring-1 ring-white/[.06]">This episode's video file is missing.</div>
          ) : handedOff ? (
            <div className="relative flex aspect-video flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl bg-black ring-1 ring-white/[.06]">
              <StillArt art={title.art} className="absolute inset-0 !aspect-auto opacity-30" />
              <MonitorPlay size={40} className="relative text-violet-300" />
              <div className="relative text-lg font-semibold">Playing in the full player</div>
              <Button className="relative" onClick={() => stopFull()}>Return to this page</Button>
            </div>
          ) : (
            <div id={WATCH_SLOT_ID} className="aspect-video w-full rounded-2xl bg-black ring-1 ring-white/[.06]" />
          )}

          {/* Details */}
          <div className="mt-6 animate-rise">
            {ep && (
              <Link to={`/series/${ep.series.id}?season=${ep.episode.season}`} className="text-[14px] font-semibold text-violet-300 hover:underline">
                {ep.series.title} · Season {ep.episode.season}
              </Link>
            )}
            <h1 className="mt-1 font-display text-[clamp(26px,2.6vw,40px)] font-semibold leading-tight tracking-[-0.01em] [text-wrap:balance]">
              {movie ? movie.title : `${episodeCode(ep!.episode.season, ep!.episode.number)} · ${ep!.episode.title}`}
            </h1>
            <MetaLine
              className="mt-2"
              items={movie
                ? [movie.year, runtime(movie.runtime), ...ratingItems(movie.ratings), movie.file.resolution && <Badge>{movie.file.resolution}</Badge>, ...movie.genres.slice(0, 3)]
                : [ep!.episode.runtime && `${ep!.episode.runtime}m`, file?.resolution && <Badge>{file.resolution}</Badge>,
                   ep!.episode.airDate && new Date(ep!.episode.airDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
                   ...ep!.series.genres.slice(0, 3)]}
            />

            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <IconButton label={fav ? "Remove from favorites" : "Add to favorites"} active={fav} onClick={() => toggleFavorite(title.id)}><Heart size={18} fill={fav ? "currentColor" : "none"} /></IconButton>
              <IconButton label={listed ? "Remove from watchlist" : "Add to watchlist"} active={listed} onClick={() => toggleWatchlist(title.id)}>{listed ? <Check size={18} /> : <Plus size={19} />}</IconButton>
              <IconButton label={p?.watched ? "Mark as unwatched" : "Mark as watched"} active={!!p?.watched} onClick={() => setWatched([id], !p?.watched, { [id]: durationFallback })}><Check size={18} strokeWidth={p?.watched ? 3 : 2} /></IconButton>
              {file && !handedOff && !remote && (
                <Button icon={<MonitorPlay size={17} />} onClick={() => openFull(useUser.getState().progress[id]?.position ?? startRef.current ?? 0)}>Full player</Button>
              )}
              {file && !handedOff && (
                <Button icon={<Captions size={17} />} onClick={() => { document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" }); usePlayback.getState().requestFinder(); }}>Find subtitles</Button>
              )}
              <Link to={movie ? `/movies/${movie.id}` : `/series/${ep!.series.id}?season=${ep!.episode.season}`}>
                <Button variant="ghost" icon={<Info size={17} />} tabIndex={-1}>{movie ? "Movie details" : "Series page"}</Button>
              </Link>
            </div>

            <div className="mt-6 max-w-[820px] rounded-2xl bg-white/[.03] p-5">
              {(movie ? movie.overview : ep!.episode.overview ?? ep!.series.overview)
                ? <p className="text-[15px] leading-7 text-fg/85">{movie ? movie.overview : ep!.episode.overview ?? ep!.series.overview}</p>
                : <NoDetails className="!mt-0" />}
              <dl className="mt-4 grid grid-cols-[110px_1fr] gap-x-4 gap-y-1.5 text-[14px]">
                {movie?.director && (<><dt className="text-fg-subtle">Director</dt><dd>{movie.director}</dd></>)}
                {!movie && ep!.series.creator && (<><dt className="text-fg-subtle">Created by</dt><dd>{ep!.series.creator}</dd></>)}
                {title.cast.length > 0 && (<><dt className="text-fg-subtle">Starring</dt><dd className="text-fg-muted">{title.cast.join(", ")}</dd></>)}
              </dl>
            </div>
          </div>
        </div>

        {/* Side column */}
        <aside className="min-w-0">
          {ep ? <EpisodeList series={ep.series} currentId={id} /> : <MovieSide movie={movie!} />}
        </aside>
      </div>
    </div>
  );
}

function EpisodeList({ series, currentId }: { series: Series; currentId: string }) {
  const progress = useUser((s) => s.progress);
  const current = series.seasons.flatMap((s) => s.episodes).find((e) => e.id === currentId);
  const [season, setSeason] = useState(current?.season ?? series.seasons[0]?.number ?? 1);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => { if (current) setSeason(current.season); }, [current]);
  // Scroll only inside the list. scrollIntoView would also scroll the page and push the video off-screen
  // when the list sits below the player (narrow windows / 125% text scaling).
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[data-current="true"]');
    if (!list || !el) return;
    const top = el.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - (list.clientHeight - el.offsetHeight) / 2;
    }
  }, [season, currentId]);
  const eps = series.seasons.find((s) => s.number === season)?.episodes ?? [];

  return (
    <div className="rounded-2xl bg-white/[.03] p-3 xl:sticky xl:top-4">
      <div className="flex items-center gap-3 px-2 pb-3 pt-1">
        <PosterArt art={series.art} title={series.title} showTitle={false} className="w-10 shrink-0 rounded-md" />
        <div className="min-w-0">
          <div className="truncate font-semibold">{series.title}</div>
          <div className="meta">{series.seasons.length} season{series.seasons.length > 1 ? "s" : ""}</div>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap gap-1 px-1">
        {series.seasons.map((s) => (
          <button key={s.number} onClick={() => setSeason(s.number)}
            className={cx("h-8 shrink-0 rounded-full px-3 text-[13px] font-medium transition", s.number === season ? "bg-fg text-bg" : "text-fg-muted hover:bg-white/[.06] hover:text-fg")}>
            Season {s.number}
          </button>
        ))}
      </div>
      <ol ref={listRef} className="max-h-[calc(100vh-260px)] space-y-1 overflow-y-auto pr-1">
        {eps.map((e) => {
          const isCur = e.id === currentId;
          const pr = progress[e.id];
          const ratio = pr && !pr.watched ? pr.position / pr.duration : 0;
          const body = (
            <>
              <div className="relative w-[132px] shrink-0 overflow-hidden rounded-lg ring-1 ring-white/[.06]">
                <StillArt art={series.art} variant={e.number + e.season * 5} src={e.file ? streamApi.stillUrl(e.file.path, e.file.durationSec) : undefined} />
                {isCur && <div className="absolute inset-0 flex items-center justify-center bg-black/55"><NowPlayingBars /></div>}
                {ratio > 0 && <ProgressBar value={ratio} className="absolute inset-x-1.5 bottom-1.5 h-[3px] bg-black/50" />}
                {pr?.watched && !isCur && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-success"><Check size={12} strokeWidth={3} /></span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className={cx("line-clamp-2 text-[14px] font-semibold leading-5", isCur && "text-violet-300")}>{e.number}. {e.title}</div>
                <div className="meta mt-0.5 text-[12px]">{!e.file ? "Missing" : isCur ? "Now playing" : ratio > 0 && pr ? remaining(pr.position, pr.duration) : e.runtime ? `${e.runtime}m` : ""}</div>
              </div>
            </>
          );
          return (
            <li key={e.id} data-current={isCur}>
              {e.file && !isCur ? (
                <Link to={`/watch/${e.id}`} replace className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-white/[.05]">{body}</Link>
              ) : (
                <div className={cx("flex items-center gap-3 rounded-xl p-2", isCur ? "bg-violet-500/10 ring-1 ring-violet-500/30" : "opacity-45")}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MovieSide({ movie }: { movie: Movie }) {
  const lib = useLibrary((s) => s.data)!;
  const collection = movie.collectionId ? lib.collections.find((c) => c.id === movie.collectionId) : undefined;
  const siblings = collection ? collection.movieIds.map((m) => lib.movies.find((x) => x.id === m)!).filter((m) => m && m.id !== movie.id) : [];
  const similar = similarTo(movie, lib, 10).filter((t) => !siblings.includes(t as Movie));
  return (
    <div className="space-y-6 xl:sticky xl:top-4">
      {siblings.length > 0 && collection && <SideList title={`More from ${collection.name.replace(/ Collection$/, "")}`} items={siblings} />}
      {similar.length > 0 && <SideList title="More like this" items={similar} />}
    </div>
  );
}

function SideList({ title, items }: { title: string; items: Title[] }) {
  return (
    <section className="rounded-2xl bg-white/[.03] p-3">
      <h2 className="px-2 pb-2 pt-1 text-[15px] font-semibold">{title}</h2>
      <ul className="space-y-1">
        {items.map((t) => (
          <li key={t.id}>
            <Link to={t.kind === "movie" ? `/watch/${t.id}` : `/series/${t.id}`} className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-white/[.05]">
              <div className="relative w-[132px] shrink-0 overflow-hidden rounded-lg ring-1 ring-white/[.06]">
                <StillArt art={t.art} />
                {t.kind === "series" && <span className="micro absolute bottom-1 right-1 rounded bg-black/70 px-1 text-white">Series</span>}
              </div>
              <div className="min-w-0">
                <div className="line-clamp-2 text-[14px] font-semibold leading-5">{t.title}</div>
                <div className="meta mt-0.5 text-[12px]">{[t.year, t.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NowPlayingBars() {
  return (
    <span className="flex h-4 items-end gap-[3px]" aria-label="Now playing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-[3px] rounded-full bg-violet-300" style={{ height: "100%", animation: `npbar 900ms ${i * 150}ms ease-in-out infinite alternate` }} />
      ))}
      <style>{`@keyframes npbar { from { transform: scaleY(.3) } to { transform: scaleY(1) } } [aria-label="Now playing"] span { transform-origin: bottom }`}</style>
    </span>
  );
}
