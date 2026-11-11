import { Heart, Search, SearchX, Shuffle, X } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Dropdown } from "@/components/Dropdown";
import { CollectionCard, PosterCard } from "@/components/PosterCard";
import { Row } from "@/components/Row";
import { EmptyState, PosterSkeletonGrid } from "@/components/States";
import { Button, Chip, IconButton, Segmented } from "@/components/ui";
import { bestRating, isWatched, seriesStatus, sortTitle, titleHref } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { useUser } from "@/store/user";
import type { Resolution, Title } from "@/types/media";

type Kind = "movie" | "series";
type Status = "all" | "unwatched" | "in_progress" | "watched";
type Sort = "added" | "title" | "year_desc" | "year_asc" | "rating";

const SORTS: { value: Sort; label: string }[] = [
  { value: "added", label: "Recently added" },
  { value: "title", label: "Title A–Z" },
  { value: "year_desc", label: "Newest first" },
  { value: "year_asc", label: "Oldest first" },
  { value: "rating", label: "Highest rated" },
];

const RESOLUTIONS: Resolution[] = ["4K", "1080p", "720p", "SD"];

/**
 * Movies and Series libraries share one screen; filters live in the URL so
 * Back from a detail page returns to exactly the same view.
 */
export default function Browse({ kind }: { kind: Kind }) {
  const lib = useLibrary((s) => s.data);
  const progress = useUser((s) => s.progress);
  const favorites = useUser((s) => s.favorites);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = params.get("q") ?? "";
  const genres = params.getAll("genre");
  const decade = params.get("decade") ?? "";
  const status = (params.get("status") as Status) ?? "all";
  const resolutions = params.getAll("res") as Resolution[];
  const favOnly = params.get("fav") === "1";
  const sort = (params.get("sort") as Sort) ?? "added";

  const update = (patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v) next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const items: Title[] = useMemo(() => (lib ? (kind === "movie" ? lib.movies : lib.series) : []), [lib, kind]);
  const allGenres = useMemo(() => [...new Set(items.flatMap((t) => t.genres))].sort(), [items]);
  const decades = useMemo(() => [...new Set(items.flatMap((t) => (t.year ? [Math.floor(t.year / 10) * 10] : [])))].sort((a, b) => b - a), [items]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = items.filter((t) => {
      if (needle && !t.title.toLowerCase().includes(needle) && !String(t.year ?? "").startsWith(needle)) return false;
      if (genres.length && !genres.some((g) => t.genres.includes(g))) return false;
      if (decade && (!t.year || Math.floor(t.year / 10) * 10 !== Number(decade))) return false;
      if (favOnly && !favorites.includes(t.id)) return false;
      if (resolutions.length && (t.kind !== "movie" || !t.file.resolution || !resolutions.includes(t.file.resolution))) return false;
      if (status !== "all") {
        const s = t.kind === "movie"
          ? progress[t.id]?.watched ? "watched" : progress[t.id]?.position ? "in_progress" : "unwatched"
          : ({ finished: "watched", in_progress: "in_progress", not_started: "unwatched" } as const)[seriesStatus(t, progress)];
        if (s !== status) return false;
      }
      return true;
    });
    const cmp: Record<Sort, (a: Title, b: Title) => number> = {
      added: (a, b) => b.addedAt.localeCompare(a.addedAt),
      title: (a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)),
      year_desc: (a, b) => (b.year ?? 0) - (a.year ?? 0),
      year_asc: (a, b) => (a.year ?? 9999) - (b.year ?? 9999),
      rating: (a, b) => bestRating(b) - bestRating(a),
    };
    return list.sort(cmp[sort]);
  }, [items, q, genres, decade, favOnly, resolutions, status, sort, progress, favorites]);

  const filtering = !!(q || genres.length || decade || status !== "all" || resolutions.length || favOnly);
  const label = kind === "movie" ? "Movies" : "Series";

  const surprise = () => {
    const pool = filtered.filter((t) => !isWatched(t, progress));
    const pick = (pool.length ? pool : filtered)[Math.floor(Math.random() * (pool.length || filtered.length))];
    if (pick) navigate(titleHref(pick));
  };

  return (
    <div className="pb-24 pt-10">
      <header className="gutter-x flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h-display-l">{label}</h1>
          <p className="meta mt-2">{lib ? `${items.length} ${kind === "movie" ? "films" : "shows"} in your library` : "Loading…"}</p>
        </div>
        <Button variant="ghost" icon={<Shuffle size={16} />} onClick={surprise} disabled={!filtered.length}>Surprise me</Button>
      </header>

      {/* Sticky filter bar */}
      <div className="gutter-x sticky top-0 z-20 mt-6 flex flex-wrap items-center gap-2 bg-bg/85 py-3 backdrop-blur-md">
        <label className="flex h-9 w-[min(280px,100%)] items-center gap-2 rounded-full bg-white/[.06] px-3.5 transition focus-within:bg-white/[.1] focus-within:ring-1 focus-within:ring-white/20">
          <Search size={15} className="text-fg-subtle" />
          <input
            value={q}
            onChange={(e) => update({ q: e.target.value || null })}
            placeholder={`Search ${label.toLowerCase()}`}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-subtle"
          />
          {q && <button aria-label="Clear search" onClick={() => update({ q: null })}><X size={14} className="text-fg-subtle hover:text-fg" /></button>}
        </label>
        <Dropdown label="Genre" multiple options={allGenres.map((g) => ({ value: g, label: g }))} value={genres} onChange={(v) => update({ genre: v })} />
        <Dropdown
          label="Year"
          options={[{ value: "", label: "Any year" }, ...decades.map((d) => ({ value: String(d), label: `${d}s` }))]}
          value={[decade]}
          onChange={([v]) => update({ decade: v || null })}
        />
        {kind === "movie" && (
          <Dropdown label="Quality" multiple options={RESOLUTIONS.map((r) => ({ value: r, label: r }))} value={resolutions} onChange={(v) => update({ res: v })} />
        )}
        <Segmented
          label="Watch status"
          value={status}
          onChange={(v) => update({ status: v === "all" ? null : v })}
          options={[
            { value: "all", label: "All" },
            { value: "unwatched", label: kind === "movie" ? "Unwatched" : "New" },
            { value: "in_progress", label: "In progress" },
            { value: "watched", label: kind === "movie" ? "Watched" : "Finished" },
          ]}
        />
        <IconButton label="Favorites only" size="sm" active={favOnly} onClick={() => update({ fav: favOnly ? null : "1" })} className="!h-9 !w-9">
          <Heart size={15} fill={favOnly ? "currentColor" : "none"} />
        </IconButton>
        <div className="ml-auto flex items-center gap-2">
          {filtering && <Chip onClick={() => setParams(new URLSearchParams(sort !== "added" ? { sort } : {}), { replace: true })}>Clear filters</Chip>}
          <Dropdown label="Sort" align="right" options={SORTS} value={[sort]} onChange={([v]) => update({ sort: v === "added" ? null : v })} />
        </div>
      </div>

      {kind === "movie" && !filtering && lib && lib.collections.length > 0 && (
        <Row title="Collections" className="mt-6">
          {lib.collections.map((c) => <CollectionCard key={c.id} collection={c} count={c.movieIds.length} />)}
        </Row>
      )}

      <div className="gutter-x mt-6 [--grid-min:clamp(140px,11vw,190px)]">
        {!lib ? (
          <PosterSkeletonGrid />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={`No ${label.toLowerCase()} match these filters`}
            body="Try removing a filter or searching for something else."
            action={<Button onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>}
          />
        ) : (
          <>
            {filtering && <p className="meta mb-4">{filtered.length} result{filtered.length === 1 ? "" : "s"}</p>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(var(--grid-min),1fr))] gap-x-4 gap-y-7">
              {filtered.map((t) => <PosterCard key={t.id} title={t} fluid />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
