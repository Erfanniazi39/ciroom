/** Online subtitle search client (dev bridge `dev/subtitle-search.js` today; Rust commands later). */
export interface SubtitleResult {
  url: string;
  release: string;
  language: string; // code, e.g. "FA"
  author: string;
  hearingImpaired: boolean;
  fullSeason: boolean;
  score: number; // 0..1, how much the release name looks like the video file
}

export interface SearchContext {
  type: "movie" | "tv";
  imdbId?: string;
  tmdbId?: number;
  season?: number;
  episode?: number;
  query: string;
  year?: number;
}

export class SubSearchError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(url, init); } catch { throw new SubSearchError("The CiRoom service isn't running."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new SubSearchError(d.error || `Request failed (${r.status})`, d.code);
  return d as T;
}
const post = <T,>(url: string, body: unknown) => call<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const subSearchApi = {
  config: () => call<{ hasKey: boolean }>("/api/subsearch/config"),
  setKey: (key: string) => post<{ hasKey: boolean }>("/api/subsearch/key", { key }),
  search: (path: string, ctx: SearchContext, languages: string[]) =>
    post<{ results: SubtitleResult[]; videoName: string }>("/api/subsearch/search", { path, ...ctx, languages }),
  download: (path: string, r: SubtitleResult, ctx: SearchContext) =>
    post<{ file: string }>("/api/subsearch/download", { path, url: r.url, language: r.language, release: r.release, season: ctx.season, episode: ctx.episode }),
  downloaded: (path: string) => call<{ files: string[] }>(`/api/subsearch/downloaded?path=${encodeURIComponent(path)}`),
  remove: (path: string, file: string) => post<{ files: string[] }>("/api/subsearch/remove", { path, file }),
};
