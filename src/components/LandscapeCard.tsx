import { Play } from "lucide-react";
import { Link } from "react-router-dom";
import { episodeCode, remaining } from "@/lib/format";
import type { ContinueItem } from "@/lib/library";
import { usePlay } from "@/hooks/usePlay";
import type { Series } from "@/types/media";
import { StillArt } from "./Artwork";
import { ProgressBar } from "./ui";

/** Continue Watching card: click the art to resume instantly, the text to open details. */
export function ContinueCard({ item }: { item: ContinueItem }) {
  const play = usePlay();
  const { title, episode, progress } = item;
  const ratio = progress.duration ? progress.position / progress.duration : 0;
  const resume = () => (episode ? play({ series: title as Series, episode }) : title.kind === "movie" && play(title));
  const href = title.kind === "movie" ? `/movies/${title.id}` : `/series/${title.id}?season=${episode?.season ?? 1}`;

  return (
    <div className="group/card w-[calc(var(--poster-w)*1.75)] shrink-0">
      <button
        onClick={resume}
        aria-label={`Resume ${title.title}`}
        className="relative block w-full overflow-hidden rounded-card text-left shadow-rest ring-1 ring-white/[.04] transition duration-[220ms] ease-out hover:-translate-y-1 hover:shadow-lift hover:ring-white/[.14]"
      >
        <StillArt art={title.art} variant={episode ? episode.number + episode.season * 3 : 0}>
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
          <div className="absolute left-4 top-3 font-display text-lg font-semibold leading-tight text-white/90 [text-shadow:0_2px_10px_rgb(0_0_0/.5)]">
            {title.title}
          </div>
          <span className="absolute inset-0 m-auto flex h-12 w-12 scale-90 items-center justify-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur-md transition duration-[220ms] group-hover/card:scale-100 group-hover/card:opacity-100">
            <Play size={20} fill="currentColor" className="ml-0.5" />
          </span>
          <ProgressBar value={ratio} className="absolute inset-x-4 bottom-3 h-[3px] bg-white/25" />
        </StillArt>
      </button>
      <Link to={href} className="mt-2.5 block px-0.5">
        <div className="truncate text-[14px] font-semibold leading-5 hover:underline">
          {episode ? `${episodeCode(episode.season, episode.number)} · ${episode.title}` : title.title}
        </div>
        <div className="meta">{progress.position > 0 ? remaining(progress.position, progress.duration) : "Up next"}</div>
      </Link>
    </div>
  );
}
