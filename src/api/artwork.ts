/**
 * Artwork + TMDB client. Talks to the dev bridge today (dev/artwork-store.js);
 * becomes Tauri commands in Stage 4 with the same signatures.
 */
export type ArtKind = "poster" | "backdrop";
export type TmdbType = "movie" | "tv";

export interface ArtEntry {
  poster?: string;
  backdrop?: string;
  source?: "tmdb" | "manual";
  tmdbId?: number;
}
export type ArtIndex = Record<string, ArtEntry>;

export interface TmdbCandidate {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  poster: string | null;
  hasBackdrop: boolean;
}

export type MatchResult = { matched: true; title: string; year: number | null; score: number; art: ArtEntry } | { matched: false; reason: string };

async function call<T>(url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("The CiRoom service isn't running. Start it with npm run dev.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data as T;
}

export const artApi = {
  index: () => call<ArtIndex>("/api/art"),
  fromUrl: (id: string, kind: ArtKind, url: string) => call<ArtEntry>("/api/art/url", { id, kind, url }),
  fromFile: async (id: string, kind: ArtKind, file: File) => {
    if (file.size > 15 * 1024 * 1024) throw new Error("Image is larger than 15 MB");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error("Could not read that file"));
      fr.readAsDataURL(file);
    });
    return call<ArtEntry>("/api/art/upload", { id, kind, dataUrl });
  },
  reset: (id: string, kind?: ArtKind) => call<ArtEntry>("/api/art/reset", { id, kind }),
  settings: () => call<{ hasTmdbKey: boolean }>("/api/settings"),
  saveTmdbKey: (tmdbKey: string) => call<{ hasTmdbKey: boolean }>("/api/settings", { tmdbKey }),
  search: (type: TmdbType, query: string, year?: number) => call<TmdbCandidate[]>("/api/tmdb/search", { type, query, year }),
  apply: (id: string, type: TmdbType, tmdbId: number) => call<ArtEntry>("/api/tmdb/apply", { id, type, tmdbId }),
  match: (id: string, type: TmdbType, title: string, year?: number) => call<MatchResult>("/api/tmdb/match", { id, type, title, year }),
};
