/**
 * Pure derivations over library data + user progress. No React, easy to unit-test,
 * and they move almost unchanged to SQL views in Stage 2 where it makes sense.
 */
import type { Library } from "@/api";
import type { Episode, Movie, Progress, Series, Title } from "@/types/media";

export type ProgressMap = Record<string, Progress>;

export const allEpisodes = (s: Series): Episode[] => s.seasons.flatMap((se) => se.episodes);

export function seriesProgress(s: Series, progress: ProgressMap) {
  const eps = allEpisodes(s).filter((e) => e.file);
  const watched = eps.filter((e) => progress[e.id]?.watched).length;
  return { watched, total: eps.length, ratio: eps.length ? watched / eps.length : 0 };
}

export type SeriesStatus = "not_started" | "in_progress" | "finished";
export function seriesStatus(s: Series, progress: ProgressMap): SeriesStatus {
  const { watched, total } = seriesProgress(s, progress);
  const touched = allEpisodes(s).some((e) => progress[e.id]?.position);
  if (total > 0 && watched === total) return "finished";
  return watched > 0 || touched ? "in_progress" : "not_started";
}

/**
 * The episode the primary button should play:
 * an in-progress episode, else the one after the most recently watched, else the first.
 */
export function nextUp(s: Series, progress: ProgressMap): { episode: Episode; mode: "start" | "resume" | "next" } | null {
  const eps = allEpisodes(s).filter((e) => e.file);
  if (!eps.length) return null;
  let latestIdx = -1;
  let latestAt = 0;
  eps.forEach((e, i) => {
    const p = progress[e.id];
    if (p && p.updatedAt > latestAt) {
      latestAt = p.updatedAt;
      latestIdx = i;
    }
  });
  if (latestIdx === -1) return { episode: eps[0], mode: "start" };
  const latest = eps[latestIdx];
  if (!progress[latest.id].watched) return { episode: latest, mode: "resume" };
  const after = eps.slice(latestIdx + 1).find((e) => !progress[e.id]?.watched);
  return after ? { episode: after, mode: "next" } : { episode: eps[0], mode: "start" };
}

export function nextEpisode(s: Series, episodeId: string): Episode | null {
  const eps = allEpisodes(s).filter((e) => e.file);
  const i = eps.findIndex((e) => e.id === episodeId);
  return i >= 0 && i < eps.length - 1 ? eps[i + 1] : null;
}

export interface ContinueItem {
  key: string;
  title: Title;
  episode?: Episode;
  progress: Progress;
}

/** In-progress movies and the next-up episode of each started series, most recent first. */
export function continueWatching(lib: Library, progress: ProgressMap): ContinueItem[] {
  const items: ContinueItem[] = [];
  for (const m of lib.movies) {
    const p = progress[m.id];
    if (p && !p.watched && p.position > 60) items.push({ key: m.id, title: m, progress: p });
  }
  for (const s of lib.series) {
    const up = nextUp(s, progress);
    if (!up || up.mode === "start") continue;
    const p = progress[up.episode.id];
    const lastTouched = Math.max(...allEpisodes(s).map((e) => progress[e.id]?.updatedAt ?? 0));
    items.push({
      key: up.episode.id,
      title: s,
      episode: up.episode,
      progress: p ?? { position: 0, duration: (up.episode.file?.durationSec ?? (up.episode.runtime ?? 0) * 60), watched: false, updatedAt: lastTouched },
    });
  }
  return items.sort((a, b) => b.progress.updatedAt - a.progress.updatedAt);
}

export const isWatched = (t: Title, progress: ProgressMap) =>
  t.kind === "movie" ? !!progress[t.id]?.watched : seriesStatus(t, progress) === "finished";

/** Simple, explainable recommendations (SPEC §3.2): genre overlap with what you love and watch. */
export function recommend(lib: Library, progress: ProgressMap, favorites: string[], limit = 15): Title[] {
  const all: Title[] = [...lib.movies, ...lib.series];
  const seeds = all.filter((t) => favorites.includes(t.id) || hasActivity(t, progress));
  const genreWeight = new Map<string, number>();
  for (const t of seeds) for (const g of t.genres) genreWeight.set(g, (genreWeight.get(g) ?? 0) + 1);
  const decade = (t: Title) => (t.year ? Math.floor(t.year / 10) : -1);
  const seedDecades = new Set(seeds.map(decade).filter((d) => d >= 0));
  return all
    .filter((t) => !seeds.includes(t) && !isWatched(t, progress))
    .map((t) => ({
      t,
      score: t.genres.reduce((acc, g) => acc + 2 * (genreWeight.get(g) ?? 0), 0) + (seedDecades.has(decade(t)) ? 1 : 0) + bestRating(t) / 10,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t);
}

function hasActivity(t: Title, progress: ProgressMap) {
  return t.kind === "movie" ? !!progress[t.id] : allEpisodes(t).some((e) => progress[e.id]);
}

export function similarTo(t: Title, lib: Library, limit = 12): Title[] {
  const all: Title[] = [...lib.movies, ...lib.series];
  return all
    .filter((x) => x.id !== t.id)
    .map((x) => ({ x, score: x.genres.filter((g) => t.genres.includes(g)).length * 2 + (x.kind === t.kind ? 1 : 0) }))
    .filter((r) => r.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.x);
}

export const byAddedDesc = <T extends { addedAt: string }>(a: T, b: T) => b.addedAt.localeCompare(a.addedAt);

export const sortTitle = (t: string) => t.replace(/^(the|a|an)\s+/i, "");

export function findTitle(lib: Library, id: string): Title | undefined {
  return lib.movies.find((m) => m.id === id) ?? lib.series.find((s) => s.id === id);
}

export function findEpisode(lib: Library, id: string): { series: Series; episode: Episode } | undefined {
  for (const s of lib.series) {
    const e = allEpisodes(s).find((x) => x.id === id);
    if (e) return { series: s, episode: e };
  }
  return undefined;
}

export const titleHref = (t: Title | Movie | Series) => (t.kind === "movie" ? `/movies/${t.id}` : `/series/${t.id}`);

/** The rating used for sorting: IMDb when known, else TMDB, else 0 (unknown sorts last). */
export const bestRating = (t: Title) => t.ratings.imdb?.value ?? t.ratings.tmdb?.value ?? 0;

/** Real length of a playable in seconds: from the file when read, else TMDB's runtime, else 0. */
export const durationOf = (p: { runtime?: number; file?: { durationSec?: number } }) => p.file?.durationSec ?? (p.runtime ?? 0) * 60;

const DAY = 86_400_000;
const airTime = (e: Episode) => (e.airDate ? new Date(`${e.airDate}T12:00:00`).getTime() : NaN);

/**
 * Episodes of a series that TMDB says have aired recently (default: last 30 days) but aren't on disk,
 * plus the next one still to come. Air dates come from TMDB (Library → Metadata → Refresh to update).
 */
export function newEpisodes(s: Series, now = Date.now(), withinDays = 30) {
  const eps = allEpisodes(s).filter((e) => !e.file && e.airDate);
  const aired = eps.filter((e) => { const t = airTime(e); return t <= now && now - t <= withinDays * DAY; }).sort((a, b) => airTime(b) - airTime(a));
  const upcoming = eps.filter((e) => airTime(e) > now).sort((a, b) => airTime(a) - airTime(b))[0];
  return { aired, upcoming };
}

export function daysAgo(e: Episode, now = Date.now()) {
  return Math.max(0, Math.round((now - airTime(e)) / DAY));
}
export function daysUntil(e: Episode, now = Date.now()) {
  return Math.max(0, Math.ceil((airTime(e) - now) / DAY));
}
