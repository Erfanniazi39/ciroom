/**
 * The only door between the UI and the library. Backed by the dev bridge's folder scanner
 * (dev/scanner.js) today; the standalone app answers the same calls from Rust.
 * Scanning happens only on request (Library → Scan now) or once when no saved scan exists.
 */
import type { Collection, Episode, LibraryRoot, Movie, ReviewItem, Series } from "@/types/media";

interface ScanFile extends Library {
  roots: LibraryRoot[];
  review: ReviewItem[];
  scannedAt: string;
}
export interface ScanChanges {
  added: string[];
  removed: string[];
  newEpisodes: number;
  ms: number;
}

let last: ScanFile | null = null;
async function get(url: string, init?: RequestInit) {
  let r: Response;
  try { r = await fetch(url, init); } catch { throw new Error("The CiRoom service isn't running."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}
const loadSaved = async (): Promise<ScanFile> => (last ??= await get("/api/library"));

export interface Library {
  movies: Movie[];
  series: Series[];
  collections: Collection[];
}

export interface SearchResults {
  movies: Movie[];
  series: Series[];
  episodes: { episode: Episode; series: Series }[];
}

const normalize = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export const api = {
  /** The saved scan (folder facts only: ids, folder titles/years, files, seasons). */
  getLibrary: async (): Promise<Library> => {
    const { movies, series, collections } = await loadSaved();
    return { movies, series, collections };
  },

  /** Synchronous search for the palette over the composed library (real titles). Stage 2: an FTS5 query. */
  searchSync(query: string, lib: Library, limit = 5): SearchResults {
    const { movies, series } = lib;
    const q = normalize(query.trim());
    if (!q) return { movies: [], series: [], episodes: [] };
    const hit = (title: string, year?: number) => normalize(title).includes(q) || (year !== undefined && String(year).startsWith(q));
    const episodes: SearchResults["episodes"] = [];
    for (const s of series) {
      for (const season of s.seasons) {
        for (const e of season.episodes) {
          if (!/^Episode \d+$/.test(e.title) && normalize(e.title).includes(q)) episodes.push({ episode: e, series: s });
        }
      }
    }
    return {
      movies: movies.filter((m) => hit(m.title, m.year)).slice(0, limit),
      series: series.filter((s) => hit(s.title, s.year)).slice(0, limit),
      episodes: episodes.slice(0, limit),
    };
  },

  listRoots: async (): Promise<LibraryRoot[]> => (await loadSaved()).roots,
  listReviewItems: async (): Promise<ReviewItem[]> => (await loadSaved()).review,
  scannedAt: async (): Promise<string> => (await loadSaved()).scannedAt,

  /** Re-read the folders now (read-only). Returns what changed since the previous scan. */
  async scan(): Promise<ScanChanges> {
    const d = await get("/api/library/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const { changes, ...lib } = d;
    last = lib;
    return changes;
  },
};
