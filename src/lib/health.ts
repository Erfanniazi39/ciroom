/**
 * Library health: what's missing, duplicated, low quality or lacking subtitles.
 * Pure analysis of the composed library; it never touches files.
 */
import type { Library } from "@/api";
import type { Episode, MediaFile, Movie, ReviewItem, Series } from "@/types/media";
import { allEpisodes, newEpisodes } from "./library";

export interface HealthEntry {
  key: string;
  title: string; // what to show
  detail: string;
  href: string;
}

export interface HealthReport {
  missingEpisodes: HealthEntry[];
  newAired: HealthEntry[];
  duplicates: HealthEntry[];
  lowQuality: HealthEntry[];
  noSubtitles: HealthEntry[];
  noDetails: HealthEntry[];
  files: number;
  factsReady: boolean;
}

const code = (e: Episode) => `S${String(e.season).padStart(2, "0")}E${String(e.number).padStart(2, "0")}`;
const mbps = (f: MediaFile) => (f.sizeBytes && f.durationSec ? (f.sizeBytes * 8) / f.durationSec / 1e6 : undefined);

/** "Low quality": below 720p, or a bitrate so low (< 0.4 Mbps) that it is visibly blocky. Small 720p encodes at ~1 Mbps are normal here. */
function quality(f: MediaFile): string | null {
  if (f.resolution === "SD") return "Below 720p";
  const r = mbps(f);
  if (r !== undefined && r < 0.4) return `Very low bitrate (${r.toFixed(1)} Mbps)`;
  return null;
}

function runs(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function analyse(lib: Library, review: ReviewItem[], meta: Record<string, unknown>, factsReady: boolean): HealthReport {
  const missingEpisodes: HealthEntry[] = [];
  const newAired: HealthEntry[] = [];
  const lowQuality: HealthEntry[] = [];
  const noSubtitles: HealthEntry[] = [];
  const noDetails: HealthEntry[] = [];
  let files = 0;

  const seriesHref = (s: Series, season?: number) => `/series/${s.id}${season ? `?season=${season}` : ""}`;
  const movieHref = (m: Movie) => `/movies/${m.id}`;

  for (const s of lib.series) {
    if (!meta[s.id]) noDetails.push({ key: s.id, title: s.title, detail: "No details yet (Library → Metadata)", href: seriesHref(s) });
    const fresh = new Set(newEpisodes(s).aired.map((e) => e.id));
    for (const season of s.seasons) {
      const missing = season.episodes.filter((e) => !e.file && !fresh.has(e.id));
      if (missing.length) {
        missingEpisodes.push({
          key: `${s.id}-${season.number}`,
          title: `${s.title} · Season ${season.number}`,
          detail: `Episode${missing.length > 1 ? "s" : ""} ${runs(missing.map((e) => e.number))} not on disk (${missing.length} of ${season.episodes.length})`,
          href: seriesHref(s, season.number),
        });
      }
    }
    for (const e of newEpisodes(s).aired) {
      newAired.push({ key: e.id, title: `${s.title} · ${code(e)}${e.title.startsWith("Episode ") ? "" : ` · ${e.title}`}`, detail: `Aired ${e.airDate}, not in your library yet`, href: seriesHref(s, e.season) });
    }
    for (const e of allEpisodes(s)) {
      if (!e.file) continue;
      files++;
      const q = quality(e.file);
      const label = `${s.title} · ${code(e)}`;
      if (q) lowQuality.push({ key: e.id, title: label, detail: q, href: seriesHref(s, e.season) });
      if (factsReady && e.file.subtitles.length === 0) noSubtitles.push({ key: e.id, title: label, detail: "No subtitle file next to it", href: seriesHref(s, e.season) });
    }
  }

  for (const m of lib.movies) {
    files++;
    if (!meta[m.id]) noDetails.push({ key: m.id, title: m.title, detail: "No details yet (Library → Metadata)", href: movieHref(m) });
    const q = quality(m.file);
    if (q) lowQuality.push({ key: m.id, title: m.title, detail: q, href: movieHref(m) });
    if (factsReady && m.file.subtitles.length === 0) noSubtitles.push({ key: m.id, title: m.title, detail: "No subtitle file next to it", href: movieHref(m) });
  }

  const duplicates: HealthEntry[] = review
    .filter((r) => r.kind === "duplicate")
    .map((r) => ({ key: r.id, title: r.path.split("/").slice(-2).join(" / "), detail: r.detail, href: "/library" }));

  return { missingEpisodes, newAired, duplicates, lowQuality, noSubtitles, noDetails, files, factsReady };
}
