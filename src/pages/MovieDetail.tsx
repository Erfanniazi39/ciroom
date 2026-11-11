import { Check, ChevronDown, Clapperboard, FileVideo, Heart, ImagePlus, Play, Plus, RotateCcw, Subtitles } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArtworkDialog } from "@/components/ArtworkDialog";
import { DetailHero } from "@/components/DetailHero";
import { TrailerButton } from "@/components/Trailer";
import { PosterCard } from "@/components/PosterCard";
import { Row } from "@/components/Row";
import { EmptyState, NoDetails } from "@/components/States";
import { Badge, Button, IconButton, MetaLine, ProgressBar, cx, ratingItems } from "@/components/ui";
import { usePlay } from "@/hooks/usePlay";
import { bytes, remaining, runtime, timecode } from "@/lib/format";
import { durationOf, similarTo } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { useUser } from "@/store/user";

export default function MovieDetail() {
  const { id } = useParams();
  const lib = useLibrary((s) => s.data);
  const { progress, favorites, watchlist, toggleFavorite, toggleWatchlist, setWatched } = useUser();
  const play = usePlay();
  const [showFile, setShowFile] = useState(false);
  const [artOpen, setArtOpen] = useState(false);

  if (!lib) return <div className="h-screen" />;
  const movie = lib.movies.find((m) => m.id === id);
  if (!movie) {
    return <EmptyState className="pt-[20vh]" icon={Clapperboard} title="Movie not found" body="It may have been removed from your library." action={<Link to="/movies"><Button>Back to Movies</Button></Link>} />;
  }

  const p = progress[movie.id];
  const inProgress = p && !p.watched && p.position > 60;
  const fav = favorites.includes(movie.id);
  const listed = watchlist.includes(movie.id);
  const collection = movie.collectionId ? lib.collections.find((c) => c.id === movie.collectionId) : undefined;
  const siblings = collection ? collection.movieIds.map((mid) => lib.movies.find((m) => m.id === mid)!).filter((m) => m && m.id !== movie.id) : [];
  const similar = similarTo(movie, lib);
  const offline = movie.file.status !== "present";

  return (
    <div className="pb-24">
      <ArtworkDialog open={artOpen} onClose={() => setArtOpen(false)} id={movie.id} type="movie" title={movie.title} year={movie.year} art={movie.art} />
      <DetailHero art={movie.art} title={movie.title} year={movie.year}>
        {collection && (
          <Link to={`/collections/${collection.id}`} className="micro mb-3 inline-block text-accent hover:underline">{collection.name}</Link>
        )}
        <h1 className="h-display-l [text-wrap:balance]">{movie.title}</h1>
        {movie.tagline && <p className="mt-3 font-display text-lg italic text-fg/70">{movie.tagline}</p>}
        <MetaLine
          className="mt-4"
          items={[
            movie.year,
            runtime(movie.runtime),
            ...ratingItems(movie.ratings),
            movie.file.resolution && <Badge>{movie.file.resolution}</Badge>,
            p?.watched && <span className="flex items-center gap-1 text-success"><Check size={14} strokeWidth={3} /> Watched</span>,
          ]}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {movie.genres.map((g) => (
            <Link key={g} to={`/movies?genre=${encodeURIComponent(g)}`} className="rounded-full bg-white/[.07] px-3 py-1 text-[13px] text-fg-muted transition hover:bg-white/[.14] hover:text-fg">{g}</Link>
          ))}
        </div>

        {inProgress && (
          <div className="mt-6 flex max-w-sm items-center gap-3">
            <ProgressBar value={p.position / p.duration} className="flex-1" />
            <span className="meta whitespace-nowrap">{remaining(p.position, p.duration)}</span>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" disabled={offline} icon={<Play size={18} fill="currentColor" />} onClick={() => play(movie)}>
            {inProgress ? <>Resume <span className="font-medium tabular-nums opacity-60">{timecode(p.position)}</span></> : "Play"}
          </Button>
          {inProgress && <Button size="lg" icon={<RotateCcw size={17} />} onClick={() => play(movie, { fromStart: true })}>Start over</Button>}
          <TrailerButton id={movie.id} />
          <IconButton size="lg" label={fav ? "Remove from favorites" : "Add to favorites"} active={fav} onClick={() => toggleFavorite(movie.id)}>
            <Heart size={19} fill={fav ? "currentColor" : "none"} />
          </IconButton>
          <IconButton size="lg" label={listed ? "Remove from watchlist" : "Add to watchlist"} active={listed} onClick={() => toggleWatchlist(movie.id)}>
            {listed ? <Check size={19} /> : <Plus size={20} />}
          </IconButton>
          <IconButton size="lg" label={p?.watched ? "Mark as unwatched" : "Mark as watched"} active={!!p?.watched} onClick={() => setWatched([movie.id], !p?.watched, { [movie.id]: durationOf(movie) })}>
            <Check size={19} strokeWidth={p?.watched ? 3 : 2} />
          </IconButton>
          <IconButton size="lg" label="Change poster & background" onClick={() => setArtOpen(true)}>
            <ImagePlus size={19} />
          </IconButton>
        </div>

        {movie.overview
          ? <p className="mt-7 max-w-[640px] text-[16px] leading-7 text-fg/85">{movie.overview}</p>
          : <NoDetails />}

        <dl className="mt-6 grid max-w-[640px] grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[14px]">
          {movie.director && (<><dt className="text-fg-subtle">Director</dt><dd>{movie.director}</dd></>)}
          {movie.cast.length > 0 && (<><dt className="text-fg-subtle">Starring</dt><dd className="text-fg-muted">{movie.cast.join(", ")}</dd></>)}
        </dl>
      </DetailHero>

      {/* File info: collapsed by default; useful, but not the point of this page */}
      <section className="gutter-x mb-10">
        <button onClick={() => setShowFile((s) => !s)} className="meta inline-flex items-center gap-1.5 hover:text-fg" aria-expanded={showFile}>
          <FileVideo size={15} /> File details <ChevronDown size={15} className={cx("transition-transform", showFile && "rotate-180")} />
        </button>
        {showFile && (
          <div className="mt-3 max-w-3xl space-y-3 rounded-2xl bg-white/[.03] p-5 text-[13px] animate-rise">
            <div className="break-all font-mono text-fg-muted">{movie.file.realPath ?? movie.file.path}</div>
            <MetaLine items={[bytes(movie.file.sizeBytes), movie.file.resolution, movie.file.codec]} />
            {movie.file.subtitles.length > 0 ? (
              <ul className="space-y-1.5">
                {movie.file.subtitles.map((s) => (
                  <li key={s.name} className="flex items-center gap-2 text-fg-muted">
                    <Subtitles size={14} className="shrink-0 text-fg-subtle" />
                    <span className="truncate">{s.name}</span>
                    {s.language && <Badge>{s.language}</Badge>}
                    <Badge>{s.format}</Badge>
                    {s.sdh && <Badge>SDH</Badge>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fg-subtle">No external subtitles found. Embedded tracks will be listed in the player.</p>
            )}
          </div>
        )}
      </section>

      {siblings.length > 0 && collection && (
        <Row title={`More from ${collection.name.replace(/ Collection$/, "")}`} seeAll={`/collections/${collection.id}`}>
          {siblings.map((m) => <PosterCard key={m.id} title={m} />)}
        </Row>
      )}
      {similar.length > 0 && <Row title="More Like This">{similar.map((t) => <PosterCard key={t.id} title={t} />)}</Row>}
    </div>
  );
}
