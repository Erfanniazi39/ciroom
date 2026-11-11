import { Clapperboard, CornerDownLeft, Search, Tv, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useLibrary } from "@/store/library";
import { episodeCode } from "@/lib/format";
import type { Artwork } from "@/types/media";
import { PosterArt } from "./Artwork";
import { cx } from "./ui";

interface ResultItem {
  key: string;
  group: "Movies" | "Series" | "Episodes";
  title: string;
  meta: string;
  href: string;
  art: Artwork;
  icon: LucideIcon;
}

/** Global Ctrl+K palette: grouped live results, full keyboard control. */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const lib = useLibrary((st) => st.data);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<ResultItem[]>(() => {
    if (!lib) return [];
    const r = api.searchSync(query, lib);
    const dot = (...p: (string | number | undefined | false)[]) => p.filter(Boolean).join(" · ");
    return [
      ...r.movies.map((m) => ({ key: m.id, group: "Movies" as const, title: m.title, meta: dot(m.year, m.genres.slice(0, 2).join(", ")), href: `/movies/${m.id}`, art: m.art, icon: Clapperboard })),
      ...r.series.map((s) => ({ key: s.id, group: "Series" as const, title: s.title, meta: dot(s.year, `${s.seasons.length} season${s.seasons.length > 1 ? "s" : ""}`), href: `/series/${s.id}`, art: s.art, icon: Tv })),
      ...r.episodes.map(({ episode: e, series: s }) => ({ key: e.id, group: "Episodes" as const, title: e.title, meta: `${s.title} · ${episodeCode(e.season, e.number)}`, href: `/series/${s.id}?season=${e.season}`, art: s.art, icon: Tv })),
    ];
  }, [query, lib]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const go = (item?: ResultItem) => {
    if (!item) return;
    navigate(item.href);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(items[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 px-4 pt-[12vh] animate-fade" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-[640px] overflow-hidden rounded-modal bg-surface-2/95 shadow-[0_40px_120px_-20px_rgb(0_0_0/.9)] ring-1 ring-white/[.08] backdrop-blur-xl animate-pop"
      >
        <div className="flex items-center gap-3 border-b border-white/[.06] px-5">
          <Search size={20} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search movies, series, episodes, years…"
            className="h-16 flex-1 bg-transparent text-[17px] outline-none placeholder:text-fg-subtle"
            aria-controls="search-results"
            aria-activedescendant={items[active] ? `sr-${items[active].key}` : undefined}
          />
          <kbd className="micro rounded bg-white/10 px-1.5 py-0.5 text-fg-subtle">Esc</kbd>
        </div>

        <div ref={listRef} id="search-results" role="listbox" className="max-h-[56vh] overflow-y-auto p-2">
          {!query.trim() && <p className="px-3 py-10 text-center text-fg-subtle">Try “breaking”, “2019”, or “pilot”.</p>}
          {query.trim() && items.length === 0 && (
            <p className="px-3 py-10 text-center text-fg-muted">
              Nothing in your library matches <span className="text-fg">“{query}”</span>.
            </p>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={`${item.group}-${item.key}`}>
                {header && <div className="micro px-3 pb-1.5 pt-3 text-fg-subtle">{header}</div>}
                <button
                  id={`sr-${item.key}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(item)}
                  className={cx("flex w-full items-center gap-3.5 rounded-xl px-3 py-2 text-left transition-colors", i === active ? "bg-white/[.08]" : "")}
                >
                  <PosterArt art={item.art} title="" showTitle={false} className="w-9 shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.title}</div>
                    <div className="meta truncate">{item.meta}</div>
                  </div>
                  {i === active && <CornerDownLeft size={16} className="text-fg-subtle" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
