import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { SearchContext } from "@/api/subsearch";
import { openInFullPlayer } from "@/hooks/usePlay";
import { episodeCode } from "@/lib/format";
import { durationOf, findEpisode, nextEpisode } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { usePlayback } from "@/store/playback";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import type { Episode, Movie, Series } from "@/types/media";
import { isRemoteClient } from "./MobileNav";
import { WebPlayer } from "./WebPlayer";

export const WATCH_SLOT_ID = "watch-slot";

/**
 * Renders the in-page player once, above the routes. On /watch/<id> it sits exactly over the watch
 * page's slot; anywhere else it shrinks into a corner window (the mini player).
 */
export function PlayerHost() {
  const session = usePlayback((s) => s.session);
  const close = usePlayback((s) => s.close);
  const open = usePlayback((s) => s.open);
  const markFailed = usePlayback((s) => s.markFailed);
  const failed = usePlayback((s) => !!s.session && s.session.key === s.failedKey);
  const lib = useLibrary((s) => s.data);
  const miniAllowed = useSettings((s) => s.miniPlayer);
  const mpvActive = usePlayer((s) => !!s.current);
  const location = useLocation();
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const meta = useLibrary((s) => s.meta);

  const onWatch = !!session && location.pathname === `/watch/${session.id}`;
  const onAnyWatch = location.pathname.startsWith("/watch/");

  // Leaving the watch page: keep playing as a mini player, or stop if the user turned that off.
  // A player that failed is never kept: the next Play starts over.
  useEffect(() => {
    if (session && !onAnyWatch && (!miniAllowed || failed)) close();
  }, [session, onAnyWatch, miniAllowed, failed, close]);

  const item = useMemo(() => {
    if (!lib || !session) return null;
    const movie = lib.movies.find((m) => m.id === session.id);
    if (movie) return { movie, ep: undefined };
    const ep = findEpisode(lib, session.id);
    return ep ? { movie: undefined, ep } : null;
  }, [lib, session]);

  // What the online subtitle search looks for: IMDb id when known (exact), else the title and year.
  const find = useMemo<SearchContext | undefined>(() => {
    if (!item) return undefined;
    if (item.movie) {
      const m = meta[item.movie.id];
      return { type: "movie", imdbId: m?.imdbId, tmdbId: m?.tmdbId, query: m?.title ?? item.movie.title, year: item.movie.year };
    }
    const { series, episode } = item.ep!;
    const m = meta[series.id];
    return { type: "tv", imdbId: m?.imdbId, tmdbId: m?.tmdbId, season: episode.season, episode: episode.number, query: m?.title ?? series.title, year: series.year };
  }, [item, meta]);

  // The id isn't in the library anymore (removed by a rescan).
  useEffect(() => { if (lib && session && !item) close(); }, [lib, session, item, close]);

  // On the watch page, follow the slot's rectangle (it moves with scrolling and resizing): event-driven, see schedule() below.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !session) return;
    if (!onWatch) {
      box.style.cssText = "";
      return;
    }
    let raf = 0;
    /** Measure once per frame at most, after whatever changed (resize, scroll, fullscreen, mode): no loop running every frame. */
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; follow(); }); };
    // `f` corrects for page zoom (TV mode): coordinates read from the slot and applied to a fixed box can differ
    // by the zoom factor depending on the engine, so measure where the box really lands and adjust.
    // Nothing is written (and no layout is forced) on frames where the slot didn't move.
    let f = 1;
    let cf = 1; // same idea for the covering box
    let last = "";
    const follow = () => {
      if (document.fullscreenElement === box) {
        // Real fullscreen belongs to this box (it outlives episode changes, so it survives them): let the UA fill the screen.
        if (last !== "fs") { last = "fs"; box.style.cssText = "visibility:visible"; }
        return;
      }
      if (usePlayback.getState().cover) {
        // "Fullscreen" inside the app window: cover everything (rescaled like the slot box when TV mode zooms the page).
        const sig = `cover|${cf}|${window.innerWidth}|${window.innerHeight}`;
        if (sig !== last) {
          last = sig;
          box.style.cssText = `left:0;top:0;width:${100 * cf}vw;height:${100 * cf}vh;z-index:70;visibility:visible`;
          const landed = box.getBoundingClientRect();
          if (landed.width > 0 && Math.abs(landed.width / window.innerWidth - 1) > 0.01) cf = cf / (landed.width / window.innerWidth);
          schedule(); // once more: the zoom correction above changes how the box lands
        }
        return;
      }
      const slot = document.getElementById(WATCH_SLOT_ID);
      if (slot !== observed) { ro.disconnect(); observed = slot; if (slot) ro.observe(slot); }
      if (slot) {
        const r = slot.getBoundingClientRect();
        const sig = `${r.left}|${r.top}|${r.width}|${r.height}|${f}`;
        if (sig !== last) {
          last = sig;
          box.style.cssText = `left:${r.left * f}px;top:${r.top * f}px;width:${r.width * f}px;height:${r.height * f}px;visibility:visible`;
          const landed = box.getBoundingClientRect();
          if (r.width > 0 && landed.width > 0 && Math.abs(landed.width / r.width - 1) > 0.01) { f = f / (landed.width / r.width); schedule(); }
        }
      } else if (last !== "hidden") {
        last = "hidden";
        box.style.visibility = "hidden";
      }
    };
    // What can move or resize the slot: its own size, the window, scrolling anywhere (capture: inner scrollers too),
    // fullscreen, and the "cover" mode. The slow timer is only a safety net for layout shifts that fire none of these
    // (content above the slot growing, sidebar animations): 4 cheap checks a second instead of 60.
    const ro = new ResizeObserver(schedule);
    let observed: HTMLElement | null = null;
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("fullscreenchange", schedule);
    const unsub = usePlayback.subscribe((s, p) => { if (s.cover !== p.cover) schedule(); });
    const safety = window.setInterval(schedule, 250);
    follow();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
      document.removeEventListener("fullscreenchange", schedule);
      unsub();
      window.clearInterval(safety);
    };
  }, [onWatch, session]);

  // Leaving the watch page ends the in-window fullscreen (the mini player takes over).
  useEffect(() => { if (!onAnyWatch) usePlayback.getState().setCover(false); }, [onAnyWatch]);

  if (!session || !item) return null;

  const { movie, ep } = item;
  const file = movie ? movie.file : ep!.episode.file;
  if (!file) return null;
  const next = ep ? nextEpisode(ep.series, ep.episode.id) : null;
  const titleId = movie ? movie.id : ep!.series.id;
  const fullTitle = movie
    ? (movie.year ? `${movie.title} (${movie.year})` : movie.title)
    : `${ep!.series.title} · ${episodeCode(ep!.episode.season, ep!.episode.number)} · ${ep!.episode.title}`;
  const playable = (movie ?? ep!) as Movie | { series: Series; episode: Episode };

  const goNext = next
    ? () => {
        open(next.id, 0);
        if (onAnyWatch) navigate(`/watch/${next.id}?t=0`, { replace: true });
      }
    : undefined;

  const openFull = (pos: number, duration: number) => openInFullPlayer(session.id, playable, pos, duration);

  return (
    <div
      ref={boxRef}
      data-player-host
      className={
        onWatch
          ? "fixed z-30 invisible"
          : `fixed bottom-20 right-4 z-[45] aspect-video w-[min(400px,44vw)] animate-pop md:right-6 ${mpvActive ? "md:bottom-36" : "md:bottom-6"}`
      }
    >
      <WebPlayer
        key={`${session.id}-${session.key}`}
        id={session.id}
        titleId={titleId}
        path={file.path}
        title={fullTitle}
        startAt={session.startAt}
        fallbackDuration={durationOf(movie ?? ep!.episode)}
        next={next && goNext ? { label: `${episodeCode(next.season, next.number)} · ${next.title}`, onPlay: goNext } : undefined}
        onOpenFull={isRemoteClient() ? undefined : openFull}
        mini={!onWatch}
        onExpand={() => navigate(`/watch/${session.id}`)}
        onClose={close}
        onFailed={() => markFailed(session.key)}
        find={find}
      />
    </div>
  );
}
