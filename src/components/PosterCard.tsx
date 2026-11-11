import { Check, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { useUser } from "@/store/user";
import { newEpisodes, seriesProgress, titleHref } from "@/lib/library";
import type { Collection, Title } from "@/types/media";
import { BackdropArt, PosterArt } from "./Artwork";
import { ProgressBar, cx } from "./ui";

/**
 * The workhorse card. Hover: lift + scale, artwork brightens, details slide up.
 * Progress, watched and series counts are shown without adding chrome at rest.
 */
export function PosterCard({ title, className, fluid }: { title: Title; className?: string; fluid?: boolean }) {
  const progress = useUser((s) => s.progress);
  let ratio = 0;
  let watched = false;
  let badge: string | null = null;
  let fresh = 0;
  if (title.kind === "movie") {
    const p = progress[title.id];
    watched = !!p?.watched;
    ratio = p && !p.watched ? p.position / p.duration : 0;
  } else {
    const sp = seriesProgress(title, progress);
    watched = sp.total > 0 && sp.watched === sp.total;
    ratio = watched ? 0 : sp.ratio;
    if (sp.watched > 0 && !watched) badge = `${sp.watched}/${sp.total}`;
    fresh = newEpisodes(title).aired.length;
  }

  return (
    <Link
      to={titleHref(title)}
      className={cx("group/card relative block shrink-0 outline-none", fluid ? "w-full" : "w-[var(--poster-w)]", className)}
      aria-label={title.year ? `${title.title} (${title.year})` : title.title}
    >
      <div className="relative overflow-hidden rounded-poster shadow-rest ring-1 ring-white/[.04] transition duration-[220ms] ease-out group-hover/card:-translate-y-1 group-hover/card:scale-[1.04] group-hover/card:shadow-lift group-hover/card:ring-white/[.14] group-focus-visible/card:ring-2 group-focus-visible/card:ring-accent">
        <PosterArt art={title.art} title={title.title} year={title.year} />

        {/* Hover reveal */}
        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/30 to-transparent p-3 opacity-0 transition duration-[220ms] group-hover/card:opacity-100 group-focus-visible/card:opacity-100">
          <div className="translate-y-2 transition duration-[220ms] ease-out group-hover/card:translate-y-0">
            <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-accent text-accent-ink shadow-lg">
              <Play size={16} fill="currentColor" className="ml-0.5" />
            </span>
            <div className="text-[13px] font-semibold leading-tight text-white">{title.title}</div>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-white/70 tabular-nums">
              {title.year && <span>{title.year}</span>}
              {(title.ratings.imdb || title.ratings.tmdb) && (
                <span className="flex items-center gap-1">
                  <span className="text-[10px] font-semibold text-white/55">{title.ratings.imdb ? "IMDb" : "TMDB"}</span>
                  {(title.ratings.imdb ?? title.ratings.tmdb)!.value.toFixed(1)}
                </span>
              )}
              {title.kind === "series" && <span>{title.seasons.length} {title.seasons.length === 1 ? "season" : "seasons"}</span>}
            </div>
          </div>
        </div>

        {watched && (
          <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-success backdrop-blur" title="Watched">
            <Check size={14} strokeWidth={3} />
          </span>
        )}
        {badge && <span className="micro absolute right-2 top-2 rounded-md bg-black/65 px-1.5 py-0.5 text-white backdrop-blur">{badge}</span>}
        {fresh > 0 && <span className="micro absolute left-2 top-2 rounded-md bg-accent px-1.5 py-0.5 text-accent-ink shadow-lg" title={`${fresh} new episode${fresh > 1 ? "s" : ""} aired, not in your library yet`}>New episode</span>}
        {ratio > 0 && <ProgressBar value={ratio} className="absolute inset-x-2 bottom-2 h-[3px] bg-black/50 group-hover/card:opacity-0" />}
      </div>
    </Link>
  );
}

export function CollectionCard({ collection, count }: { collection: Collection; count: number }) {
  return (
    <Link to={`/collections/${collection.id}`} className="group/card relative block w-[calc(var(--poster-w)*1.6)] shrink-0 outline-none">
      <div className="relative flex aspect-[16/10] items-end overflow-hidden rounded-card shadow-rest ring-1 ring-white/[.04] transition duration-[220ms] ease-out group-hover/card:-translate-y-1 group-hover/card:shadow-lift group-hover/card:ring-white/[.14]">
        <BackdropArt art={collection.art} className="absolute inset-0" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        <div className="relative p-4">
          <div className="micro text-white/60">Collection · {count} {count === 1 ? "film" : "films"}</div>
          <div className="font-display text-xl font-semibold leading-tight text-white">{collection.name.replace(/ Collection$/, "")}</div>
        </div>
      </div>
    </Link>
  );
}
