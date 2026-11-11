/**
 * Real metadata (TMDB + IMDb) and real file facts. Talks to the dev bridge today (dev/metadata.js,
 * dev/stream.js); becomes Tauri commands with the same shapes in the standalone app.
 */
import type { Rating } from "@/types/media";

export interface MetaEpisode {
  title?: string;
  overview?: string;
  airDate?: string;
  runtime?: number;
  tmdb?: Rating;
}

export interface MetaEntry {
  type: "movie" | "tv";
  tmdbId: number;
  imdbId?: string;
  title: string;
  year?: number;
  endYear?: number;
  runtime?: number;
  episodeRuntime?: number;
  genres: string[];
  overview?: string;
  tagline?: string;
  director?: string;
  creator?: string;
  cast: string[];
  tmdb?: Rating;
  imdb?: Rating;
  seasons?: Record<string, { name?: string; error?: string; episodes?: Record<string, MetaEpisode> }>;
  matchedBy: "artwork" | "search" | "manual";
  confidence: number;
  matchedTitle: string;
  locked: boolean;
  fetchedAt: string;
  /** Best YouTube trailer from TMDB (null = TMDB has none), fetched lazily for older entries. */
  trailer?: Trailer | null;
}
export interface Trailer {
  key: string;
  name: string;
  site: "YouTube";
}
export type MetaIndex = Record<string, MetaEntry>;

export interface FileFacts {
  file?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  video?: string;
  audio?: string;
  duration?: number;
  mtime?: number;
  subtitles?: { name: string; language?: string; sdh?: boolean; format: string }[];
  error?: string;
}
export type FactsIndex = Record<string, FileFacts>;

async function call<T>(url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("The CiRoom service isn't running.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data as T;
}

export const metaApi = {
  index: () => call<MetaIndex>("/api/meta"),
  fetch: (req: { id: string; type: "movie" | "tv"; query: string; year?: number; seasons?: number[]; tmdbId?: number }) => call<MetaEntry>("/api/meta/fetch", req),
  imdb: () => call<{ updated: number; missing: string[]; datasetDate: string }>("/api/meta/imdb", {}),
  reset: (id: string) => call<object>("/api/meta/reset", { id }),
  trailer: (id: string) => call<{ trailer: Trailer | null }>("/api/meta/trailer", { id }).then((r) => r.trailer),
  /** Opens a trailer in the system's web browser (this PC only). */
  openTrailer: (key: string) => call<object>("/api/open-trailer", { key }),
  facts: (paths: string[]) => call<FactsIndex>("/api/files/facts", { paths }),
};
