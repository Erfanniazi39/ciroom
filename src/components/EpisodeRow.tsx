import { Check, Play } from "lucide-react";
import { remaining } from "@/lib/format";
import { daysAgo, daysUntil } from "@/lib/library";
import type { Episode, Progress, Series } from "@/types/media";
import { streamApi } from "@/api/stream";
import { StillArt } from "./Artwork";
import { MetaLine, ProgressBar, cx } from "./ui";

interface Props {
  series: Series;
  episode: Episode;
  progress?: Progress;
  isNext?: boolean;
  onPlay: () => void;
  onToggleWatched: () => void;
}

export function EpisodeRow({ series, episode, progress, isNext, onPlay, onToggleWatched }: Props) {
  const missing = !episode.file;
  const watched = !!progress?.watched;
  const ratio = progress && !watched ? progress.position / progress.duration : 0;
  // A missing episode that hasn't aired yet isn't "missing"; one that aired in the last 30 days is "new".
  const t = episode.airDate ? new Date(`${episode.airDate}T12:00:00`).getTime() : NaN;
  const upcoming = missing && t > Date.now();
  const isNew = missing && t <= Date.now() && Date.now() - t <= 30 * 86_400_000;

  return (
    <li className={cx("group/ep relative flex items-center gap-5 rounded-2xl p-3 transition-colors duration-200 hover:bg-white/[.04]", isNext && "bg-white/[.03]", missing && !isNew && "opacity-45")}>
      <span className="w-8 shrink-0 text-center font-display text-2xl font-semibold text-fg-subtle tabular-nums">{episode.number}</span>

      <button
        onClick={onPlay}
        disabled={missing}
        aria-label={`Play episode ${episode.number}: ${episode.title}`}
        className="relative w-[clamp(150px,16vw,220px)] shrink-0 overflow-hidden rounded-[10px] shadow-rest ring-1 ring-white/[.05]"
      >
        <StillArt art={series.art} variant={episode.number + episode.season * 5} src={episode.file ? streamApi.stillUrl(episode.file.path, episode.file.durationSec) : undefined}>
          <div className="absolute inset-0 bg-black/10 transition group-hover/ep:bg-black/40" />
          {!missing && (
            <span className="absolute inset-0 m-auto flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-white/20 text-white opacity-0 backdrop-blur-md transition duration-200 group-hover/ep:scale-100 group-hover/ep:opacity-100">
              <Play size={18} fill="currentColor" className="ml-0.5" />
            </span>
          )}
          {ratio > 0 && <ProgressBar value={ratio} className="absolute inset-x-2.5 bottom-2.5 h-[3px] bg-black/50" />}
        </StillArt>
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <h4 className="truncate text-[15px] font-semibold">{episode.title}</h4>
          {isNext && <span className="micro shrink-0 text-accent">{ratio > 0 ? "Resume" : "Up next"}</span>}
          {upcoming ? <span className="micro shrink-0 text-fg-muted">Airs in {daysUntil(episode)} day{daysUntil(episode) === 1 ? "" : "s"}</span>
            : isNew ? <span className="micro shrink-0 text-accent">New · aired {daysAgo(episode) === 0 ? "today" : `${daysAgo(episode)} d ago`}, not downloaded</span>
            : missing && <span className="micro shrink-0 text-danger">Missing</span>}
        </div>
        <MetaLine className="mt-0.5" items={[
          episode.runtime && `${episode.runtime}m`,
          ratio > 0 && progress && remaining(progress.position, progress.duration),
          episode.file?.resolution,
          episode.airDate && new Date(episode.airDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
        ]} />
        {episode.overview && <p className="mt-1.5 line-clamp-2 text-[14px] leading-6 text-fg-muted">{episode.overview}</p>}
      </div>

      <button
        onClick={onToggleWatched}
        disabled={missing}
        aria-label={watched ? "Mark as unwatched" : "Mark as watched"}
        title={watched ? "Mark as unwatched" : "Mark as watched"}
        className={cx(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 transition duration-200",
          watched ? "bg-success/15 text-success ring-success/30" : "text-fg-subtle opacity-0 ring-white/15 hover:text-fg group-hover/ep:opacity-100 focus-visible:opacity-100",
        )}
      >
        <Check size={16} strokeWidth={2.6} />
      </button>
    </li>
  );
}
