/** "2h 28m"; empty when unknown (MetaLine drops empty items). */
export function runtime(minutes?: number): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function timecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function remaining(position: number, duration: number): string {
  const left = Math.max(0, Math.round((duration - position) / 60));
  if (left < 1) return "Almost done";
  return left >= 60 ? `${runtime(left)} left` : `${left} min left`;
}

export const episodeCode = (season: number, episode: number) => `S${season}:E${episode}`;

export function years(start?: number, end?: number): string {
  if (!start) return "";
  if (end === undefined) return `${start}–`;
  return end === start ? String(start) : `${start}–${end}`;
}

export function bytes(n?: number): string {
  if (!n) return "";
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

export function relativeDate(iso: string | number): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < day * 2) return "yesterday";
  if (diff < day * 30) return `${Math.round(diff / day)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 2888117 → "2.9M", 40694 → "41K". */
export function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
