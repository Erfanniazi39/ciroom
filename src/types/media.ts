/**
 * Domain types shared by the UI. These mirror the SQLite schema (docs/SPEC.md §5)
 * but are shaped for rendering: denormalised, with everything a screen needs.
 */

export type Resolution = "SD" | "720p" | "1080p" | "4K";

/** Artwork either comes from the local cache (real image) or is generated from `hue`. */
export interface Artwork {
  hue: number;
  poster?: string;
  backdrop?: string;
}

export interface SubtitleFile {
  name: string;
  language?: string;
  format: string;
  sdh?: boolean;
}

/**
 * A video on disk. `path` comes from the folder structure; everything else is read from the real file
 * by the dev bridge (/api/files/facts) and stays undefined until then. Nothing here is guessed.
 */
export interface MediaFile {
  path: string;
  realPath?: string;
  sizeBytes?: number;
  resolution?: Resolution;
  codec?: string;
  durationSec?: number;
  subtitles: SubtitleFile[];
  status: "present" | "missing" | "offline";
}

/** A rating with its source. Only real values: TMDB from the API, IMDb from IMDb's dataset. */
export interface Rating {
  value: number;
  votes: number;
}
export interface Ratings {
  imdb?: Rating;
  tmdb?: Rating;
}

/**
 * Metadata fields (year, runtime, genres, ratings, overview, tagline, people) come only from TMDB/IMDb
 * (src/api/meta.ts) or the real file. They're optional: the UI hides what isn't known yet.
 */
export interface Movie {
  kind: "movie";
  id: string;
  title: string;
  year?: number;
  runtime?: number; // minutes
  genres: string[];
  ratings: Ratings;
  overview?: string;
  tagline?: string;
  director?: string;
  cast: string[];
  addedAt: string; // ISO
  collectionId?: string;
  art: Artwork;
  file: MediaFile;
}

export interface Collection {
  id: string;
  name: string;
  movieIds: string[];
  art: Artwork;
}

export interface Episode {
  kind: "episode";
  id: string;
  seriesId: string;
  season: number;
  number: number;
  title: string; // "Episode N" until TMDB supplies the real title
  overview?: string;
  airDate?: string;
  runtime?: number; // minutes
  file?: MediaFile; // undefined → missing on disk
}

export interface Season {
  number: number;
  episodes: Episode[];
}

export interface Series {
  kind: "series";
  id: string;
  title: string;
  year?: number;
  endYear?: number;
  genres: string[];
  ratings: Ratings;
  overview?: string;
  creator?: string;
  cast: string[];
  addedAt: string;
  art: Artwork;
  seasons: Season[];
}

export type Title = Movie | Series;
export type Playable = Movie | Episode;

export interface Progress {
  position: number; // seconds
  duration: number; // seconds
  watched: boolean;
  updatedAt: number; // epoch ms
}

export interface LibraryRoot {
  id: string;
  path: string;
  kindHint: "movies" | "series" | "mixed";
  online: boolean;
  itemCount: number;
  lastScanAt?: string;
}

export type ReviewKind = "empty" | "unidentified" | "low_confidence" | "nested" | "misplaced" | "duplicate" | "missing" | "zipped_subtitle";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  path: string;
  detail: string;
  suggestion?: string;
}
