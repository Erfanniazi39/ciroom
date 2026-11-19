// @ts-check
/**
 * Title matching against TMDB, in one place: the metadata fetch and the artwork matcher both use `bestMatch`, with one
 * score and one confidence threshold. Below MATCH_MIN nothing is saved: the title is listed for a manual choice instead.
 */

/** Lower-case, no accents/punctuation, "&" = "and", no leading article. */
export function norm(/** @type {string} */ s) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
}
/** Token-overlap similarity, 0–1. Good enough for titles. */
export function similarity(/** @type {string} */ a, /** @type {string} */ b) {
  const A = new Set(norm(a).split(" ")), B = new Set(norm(b).split(" "));
  if (norm(a) === norm(b)) return 1;
  const inter = [...A].filter((x) => B.has(x)).length;
  return (2 * inter) / (A.size + B.size || 1);
}

/** The one confidence threshold: a best guess scoring less than this is not saved. */
export const MATCH_MIN = 0.6;

/**
 * @typedef {{ tmdbId: number, title: string, year: number | null, poster?: string | null }} Candidate
 * @typedef {{ matched: true, best: Candidate & { score: number }, score: number, candidates: (Candidate & { score: number })[] }
 *         | { matched: false, reason: string, best?: Candidate & { score: number }, candidates: (Candidate & { score: number })[] }} MatchResult
 */

/**
 * Score = title similarity × 0.75 + year (exact +0.25, ±1 year +0.12, unknown year +0.1) − 0.01 per rank
 * (TMDB's own order ≈ popularity, a tiebreak).
 * @param {(type: "movie" | "tv", query: string, year?: number) => Promise<any[]>} search returns [{ tmdbId, title, year, poster? }]
 * @returns {Promise<MatchResult>}
 */
export async function bestMatch(search, /** @type {"movie"|"tv"} */ type, /** @type {string} */ query, /** @type {number=} */ year) {
  const results = (await search(type, query, year)) ?? [];
  const ranked = results.slice(0, 10).map((r, i) => {
    const y = r.year ?? null;
    const yearScore = year && y ? (y === year ? 0.25 : Math.abs(y - year) <= 1 ? 0.12 : 0) : 0.1;
    return { tmdbId: r.tmdbId, title: r.title, year: y, poster: r.poster ?? null, score: Number((similarity(query, r.title) * 0.75 + yearScore - i * 0.01).toFixed(3)) };
  }).sort((a, b) => b.score - a.score);
  const candidates = ranked.slice(0, 5);
  const best = ranked[0];
  if (!best) return { matched: false, reason: "TMDB has no results", candidates: [] };
  if (best.score < MATCH_MIN) return { matched: false, reason: `Best guess “${best.title}${best.year ? ` (${best.year})` : ""}” was not confident enough`, best, candidates };
  return { matched: true, best, score: best.score, candidates };
}
