import { CalendarClock, Check, CheckCheck, Heart, ImagePlus, Play, Plus, Tv } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArtworkDialog } from "@/components/ArtworkDialog";
import { DetailHero } from "@/components/DetailHero";
import { TrailerButton } from "@/components/Trailer";
import { EpisodeRow } from "@/components/EpisodeRow";
import { PosterCard } from "@/components/PosterCard";
import { Row } from "@/components/Row";
import { EmptyState, NoDetails } from "@/components/States";
import { Button, IconButton, MetaLine, ProgressBar, cx, ratingItems } from "@/components/ui";
import { usePlay } from "@/hooks/usePlay";
import { episodeCode, plural, years } from "@/lib/format";
import { daysAgo, daysUntil, durationOf, newEpisodes, nextUp, seriesProgress, similarTo } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { useUser } from "@/store/user";

export default function SeriesDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const lib = useLibrary((s) => s.data);
  const { progress, favorites, watchlist, toggleFavorite, toggleWatchlist, setWatched } = useUser();
  const play = usePlay();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [artOpen, setArtOpen] = useState(false);

  const show = lib?.series.find((s) => s.id === id);
  const up = show ? nextUp(show, progress) : null;
  const seasonParam = params.get("season");
  const seasonNo = seasonParam ? Number(seasonParam) : up?.episode.season ?? show?.seasons[0]?.number ?? 1;

  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [seasonNo]);

  if (!lib) return <div className="h-screen" />;
  if (!show) {
    return <EmptyState className="pt-[20vh]" icon={Tv} title="Series not found" body="It may have been removed from your library." action={<Link to="/series"><Button>Back to Series</Button></Link>} />;
  }

  const season = show.seasons.find((s) => s.number === seasonNo) ?? show.seasons[0];
  const sp = seriesProgress(show, progress);
  const fav = favorites.includes(show.id);
  const listed = watchlist.includes(show.id);
  const episodeCount = show.seasons.reduce((n, s) => n + s.episodes.length, 0);
  const seasonIds = season.episodes.filter((e) => e.file).map((e) => e.id);
  const seasonWatched = seasonIds.length > 0 && seasonIds.every((eid) => progress[eid]?.watched);
  const durations = Object.fromEntries(season.episodes.map((e) => [e.id, durationOf(e)]));

  const fresh = newEpisodes(show);
  const primaryLabel = !up ? "Play" : up.mode === "resume" ? "Resume" : up.mode === "next" ? "Play next" : "Play";

  return (
    <div className="pb-24">
      <ArtworkDialog open={artOpen} onClose={() => setArtOpen(false)} id={show.id} type="tv" title={show.title} year={show.year} art={show.art} seasons={show.seasons.map((s) => s.number)} />
      <DetailHero art={show.art} title={show.title} year={show.year}>
        <h1 className="h-display-l [text-wrap:balance]">{show.title}</h1>
        <MetaLine
          className="mt-4"
          items={[
            years(show.year, show.endYear),
            plural(show.seasons.length, "season"),
            plural(episodeCount, "episode"),
            ...ratingItems(show.ratings),
          ]}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {show.genres.map((g) => (
            <Link key={g} to={`/series?genre=${encodeURIComponent(g)}`} className="rounded-full bg-white/[.07] px-3 py-1 text-[13px] text-fg-muted transition hover:bg-white/[.14] hover:text-fg">{g}</Link>
          ))}
        </div>

        {(fresh.aired.length > 0 || fresh.upcoming) && (
          <div className="mt-5 flex max-w-xl items-start gap-3 rounded-2xl bg-accent/10 p-4 ring-1 ring-accent/30">
            <CalendarClock size={20} className="mt-0.5 shrink-0 text-accent" />
            <div className="text-[14px] leading-6">
              {fresh.aired.length > 0 && (
                <div><span className="font-semibold">{fresh.aired.length === 1 ? "A new episode is out" : `${fresh.aired.length} new episodes are out`}</span>
                  <span className="text-fg-muted"> · {episodeCode(fresh.aired[0].season, fresh.aired[0].number)} aired {daysAgo(fresh.aired[0]) === 0 ? "today" : `${daysAgo(fresh.aired[0])} day${daysAgo(fresh.aired[0]) === 1 ? "" : "s"} ago`}, not in your library yet</span></div>
              )}
              {fresh.upcoming && (
                <div className="text-fg-muted">Next: {episodeCode(fresh.upcoming.season, fresh.upcoming.number)} airs {new Date(fresh.upcoming.airDate!).toLocaleDateString(undefined, { month: "short", day: "numeric" })} (in {daysUntil(fresh.upcoming)} day{daysUntil(fresh.upcoming) === 1 ? "" : "s"})</div>
              )}
            </div>
          </div>
        )}

        <div className="mt-6 flex max-w-md items-center gap-3">
          <ProgressBar value={sp.ratio} className="flex-1" />
          <span className="meta whitespace-nowrap">{sp.watched} of {sp.total} watched</span>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" disabled={!up} icon={<Play size={18} fill="currentColor" />} onClick={() => up && play({ series: show, episode: up.episode })}>
            {primaryLabel}
            {up && <span className="font-medium opacity-60">{episodeCode(up.episode.season, up.episode.number)}</span>}
          </Button>
          <TrailerButton id={show.id} />
          <IconButton size="lg" label={fav ? "Remove from favorites" : "Add to favorites"} active={fav} onClick={() => toggleFavorite(show.id)}>
            <Heart size={19} fill={fav ? "currentColor" : "none"} />
          </IconButton>
          <IconButton size="lg" label={listed ? "Remove from watchlist" : "Add to watchlist"} active={listed} onClick={() => toggleWatchlist(show.id)}>
            {listed ? <Check size={19} /> : <Plus size={20} />}
          </IconButton>
          <IconButton size="lg" label="Change poster & background" onClick={() => setArtOpen(true)}>
            <ImagePlus size={19} />
          </IconButton>
        </div>

        {show.overview
          ? <p className="mt-7 max-w-[640px] text-[16px] leading-7 text-fg/85">{show.overview}</p>
          : <NoDetails />}
        {(show.creator || show.cast.length > 0) && (
          <dl className="mt-6 grid max-w-[640px] grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[14px]">
            {show.creator && (<><dt className="text-fg-subtle">Created by</dt><dd>{show.creator}</dd></>)}
            {show.cast.length > 0 && (<><dt className="text-fg-subtle">Starring</dt><dd className="text-fg-muted">{show.cast.join(", ")}</dd></>)}
          </dl>
        )}
      </DetailHero>

      {/* Seasons */}
      <section className="gutter-x">
        <div className="sticky top-0 z-20 -mx-[var(--gutter)] flex items-center gap-4 bg-bg px-[var(--gutter)] py-3 shadow-[0_12px_24px_-12px_rgb(0_0_0/.8)]">
          <div ref={tabsRef} role="tablist" aria-label="Seasons" className="no-scrollbar flex flex-1 gap-1 overflow-x-auto">
            {show.seasons.map((s) => {
              const ids = s.episodes.filter((e) => e.file).map((e) => e.id);
              const done = ids.length > 0 && ids.every((eid) => progress[eid]?.watched);
              return (
                <button
                  key={s.number}
                  role="tab"
                  aria-selected={s.number === season.number}
                  onClick={() => setParams({ season: String(s.number) }, { replace: true })}
                  className={cx(
                    "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium transition duration-200",
                    s.number === season.number ? "bg-fg text-bg" : "text-fg-muted hover:bg-white/[.06] hover:text-fg",
                  )}
                >
                  {s.number === 0 ? "Specials" : `Season ${s.number}`}
                  {done && <Check size={13} strokeWidth={3} className={s.number === season.number ? "text-bg/60" : "text-success"} />}
                </button>
              );
            })}
          </div>
          <Button
            variant="ghost"
            icon={<CheckCheck size={16} />}
            onClick={() => setWatched(seasonIds, !seasonWatched, durations)}
            className="shrink-0"
          >
            {seasonWatched ? "Mark season unwatched" : "Mark season watched"}
          </Button>
        </div>

        <ol key={season.number} className="mt-3 max-w-5xl space-y-1 animate-rise">
          {season.episodes.map((e) => (
            <EpisodeRow
              key={e.id}
              series={show}
              episode={e}
              progress={progress[e.id]}
              isNext={up?.episode.id === e.id && up.mode !== "start"}
              onPlay={() => play({ series: show, episode: e })}
              onToggleWatched={() => setWatched([e.id], !progress[e.id]?.watched, durations)}
            />
          ))}
        </ol>
      </section>

      <div className="mt-14">
        {(() => {
          const similar = similarTo(show, lib);
          return similar.length > 0 && <Row title="More Like This">{similar.map((t) => <PosterCard key={t.id} title={t} />)}</Row>;
        })()}
      </div>
    </div>
  );
}
