import { create } from "zustand";
import { api, type Library } from "@/api";
import { artApi, type ArtEntry, type ArtIndex } from "@/api/artwork";
import { metaApi, type FactsIndex, type FileFacts, type MetaEntry, type MetaIndex } from "@/api/meta";
import type { Episode, MediaFile, Movie, Resolution, Series } from "@/types/media";

interface LibraryState {
  data: Library | null;
  error: string | null;
  loading: boolean;
  /** True once real file facts (size, resolution, length, subtitles) have been read. */
  factsReady: boolean;
  meta: MetaIndex;
  load: () => Promise<void>;
  /** Apply new artwork for one title without reloading the library. */
  setArt: (id: string, entry: ArtEntry) => void;
  /** Apply fetched metadata for one title. */
  setMeta: (id: string, entry: MetaEntry | null) => void;
  /** Replace the whole metadata index (after "Fetch all" / IMDb refresh). */
  reloadMeta: () => Promise<void>;
}

const resolutionOf = (w?: number, h?: number): Resolution | undefined => {
  if (!w || !h) return undefined;
  // Width-based, so letterboxed films (1920×800) still count as 1080p.
  if (w >= 3200 || h >= 2000) return "4K";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  return "SD";
};

const codecName = (v?: string) => (v ? v.replace(/^h264/, "H.264").replace(/^hevc/, "HEVC").replace(/^av1/, "AV1") : undefined);

function withFacts(f: MediaFile, facts: FactsIndex): MediaFile {
  const x: FileFacts | undefined = facts[f.path];
  if (!x || x.error) return f;
  return {
    ...f, realPath: x.file, sizeBytes: x.sizeBytes, resolution: resolutionOf(x.width, x.height), codec: codecName(x.video),
    durationSec: x.duration, subtitles: x.subtitles ?? [],
  };
}

/**
 * Episodes TMDB lists for a season on disk but that aren't on disk (e.g. Better Call Saul S5 has only
 * EP01) are added as "missing", so the season shows its real length.
 */
function withTmdbEpisodes(seriesId: string, season: number, eps: Episode[], md?: MetaEntry): Episode[] {
  const tm = md?.seasons?.[String(season)]?.episodes;
  if (!tm) return eps;
  const max = Math.max(eps.length, ...Object.keys(tm).map(Number).filter((n) => n > 0));
  if (max <= eps.length) return eps;
  const extra = Array.from({ length: max - eps.length }, (_, i): Episode => {
    const n = eps.length + i + 1;
    return { kind: "episode", id: `${seriesId}-s${season}e${n}`, seriesId, season, number: n, title: `Episode ${n}` };
  });
  return [...eps, ...extra];
}

const minutes = (sec?: number) => (sec ? Math.max(1, Math.round(sec / 60)) : undefined);
const isoOf = (ms?: number) => (ms ? new Date(ms).toISOString() : "");

/**
 * Build the visible library: folder facts (api) + real file facts + TMDB/IMDb metadata + artwork.
 * Nothing is invented: a field stays undefined until a real source supplies it.
 */
function compose(base: Library, art: ArtIndex, meta: MetaIndex, facts: FactsIndex): Library {
  const artOf = (id: string, hue: number) => ({ hue, poster: art[id]?.poster, backdrop: art[id]?.backdrop });

  const movies: Movie[] = base.movies.map((m) => {
    const md = meta[m.id];
    const file = withFacts(m.file, facts);
    return {
      ...m,
      title: md?.title ?? m.title,
      year: md?.year ?? m.year,
      runtime: minutes(file.durationSec) ?? md?.runtime,
      genres: md?.genres ?? [],
      ratings: { imdb: md?.imdb, tmdb: md?.tmdb },
      overview: md?.overview,
      tagline: md?.tagline,
      director: md?.director,
      cast: md?.cast ?? [],
      addedAt: isoOf(facts[m.file.path]?.mtime),
      art: artOf(m.id, m.art.hue),
      file,
    };
  });

  const series: Series[] = base.series.map((s) => {
    const md = meta[s.id];
    let newest = 0;
    const seasons = s.seasons.map((season) => ({
      ...season,
      episodes: withTmdbEpisodes(s.id, season.number, season.episodes, md).map((e): Episode => {
        const me = md?.seasons?.[String(e.season)]?.episodes?.[String(e.number)];
        const file = e.file ? withFacts(e.file, facts) : undefined;
        if (e.file) newest = Math.max(newest, facts[e.file.path]?.mtime ?? 0);
        return {
          ...e,
          title: me?.title ?? e.title,
          overview: me?.overview,
          airDate: me?.airDate,
          runtime: minutes(file?.durationSec) ?? me?.runtime ?? md?.episodeRuntime,
          file,
        };
      }),
    }));
    return {
      ...s,
      title: md?.title ?? s.title,
      year: md?.year ?? s.year,
      endYear: md?.endYear,
      genres: md?.genres ?? [],
      ratings: { imdb: md?.imdb, tmdb: md?.tmdb },
      overview: md?.overview,
      creator: md?.creator,
      cast: md?.cast ?? [],
      addedAt: isoOf(newest || undefined),
      art: artOf(s.id, s.art.hue),
      seasons,
    };
  });

  const collections = base.collections.map((c) => {
    const first = c.movieIds.map((id) => movies.find((m) => m.id === id)).find((m) => m?.art.backdrop || m?.art.poster);
    return { ...c, art: { hue: c.art.hue, poster: first?.art.poster, backdrop: first?.art.backdrop ?? first?.art.poster } };
  });
  return { movies, series, collections };
}

let base: Library | null = null;
let artIndex: ArtIndex = {};
let metaIndex: MetaIndex = {};
let factsIndex: FactsIndex = {};

const allPaths = (lib: Library) => [
  ...lib.movies.map((m) => m.file.path),
  ...lib.series.flatMap((s) => s.seasons.flatMap((se) => se.episodes.flatMap((e) => (e.file ? [e.file.path] : [])))),
];

/** Library catalog cache. Loaded once at startup; file facts arrive in the background. */
export const useLibrary = create<LibraryState>((set, get) => {
  const rebuild = () => { if (base) set({ data: compose(base, artIndex, metaIndex, factsIndex), meta: metaIndex }); };
  return {
    data: null,
    error: null,
    loading: false,
    factsReady: false,
    meta: {},
    load: async () => {
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        const [lib, art, meta] = await Promise.all([
          api.getLibrary(),
          artApi.index().catch(() => ({}) as ArtIndex),
          metaApi.index().catch(() => ({}) as MetaIndex),
        ]);
        base = lib; artIndex = art; metaIndex = meta;
        rebuild();
        set({ loading: false });
        // Real file facts: instant when cached, ~1 min the very first time (ffprobe on every file).
        metaApi.facts(allPaths(lib)).then((f) => { factsIndex = f; rebuild(); set({ factsReady: true }); }).catch(() => set({ factsReady: true }));
      } catch (e) {
        set({ error: e instanceof Error ? e.message : "Could not load your library.", loading: false });
      }
    },
    setArt: (id, entry) => { artIndex = { ...artIndex, [id]: entry }; rebuild(); },
    setMeta: (id, entry) => {
      metaIndex = { ...metaIndex };
      if (entry) metaIndex[id] = entry; else delete metaIndex[id];
      rebuild();
    },
    reloadMeta: async () => { metaIndex = await metaApi.index(); rebuild(); },
  };
});
