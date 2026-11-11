import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLibrary } from "@/store/library";
import type { PlayRequest } from "@/store/player";
import { durationOf, findEpisode, nextEpisode } from "@/lib/library";
import { episodeCode } from "@/lib/format";
import type { Episode, Movie, Series } from "@/types/media";

/** Builds the request the Rust player will receive in Stage 3 (file, resume point, next episode). */
export function buildRequest(item: Movie | { series: Series; episode: Episode }, startAt: number): PlayRequest {
  if ("kind" in item) {
    return { id: item.id, titleId: item.id, title: item.year ? `${item.title} (${item.year})` : item.title, subtitle: undefined, hue: item.art.hue, backdrop: item.art.backdrop, duration: durationOf(item), startAt, href: `/movies/${item.id}`, path: item.file.path };
  }
  const { series, episode } = item;
  const next = nextEpisode(series, episode.id);
  return {
    id: episode.id,
    titleId: series.id,
    title: series.title,
    subtitle: `${episodeCode(episode.season, episode.number)} · ${episode.title}`,
    hue: series.art.hue,
    backdrop: series.art.backdrop,
    duration: durationOf(episode),
    startAt,
    href: `/series/${series.id}?season=${episode.season}`,
    path: episode.file?.path,
    nextId: next?.id,
  };
}

/**
 * Returns `play(item, { fromStart })`: opens the watch page (video in the page, details around it).
 * The page resumes from saved progress unless `fromStart`. The fullscreen mpv player is offered there.
 */
export function usePlay() {
  const navigate = useNavigate();
  return useCallback(
    (item: Movie | { series: Series; episode: Episode }, opts: { fromStart?: boolean } = {}) => {
      const id = "kind" in item ? item.id : item.episode.id;
      navigate(`/watch/${id}${opts.fromStart ? "?t=0" : ""}`);
    },
    [navigate],
  );
}

export function resolveEpisode(id: string) {
  const lib = useLibrary.getState().data;
  return lib ? findEpisode(lib, id) : undefined;
}
