import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./ui";

/**
 * Horizontal content row. Native scroll (trackpad/shift-wheel friendly) with snap,
 * edge fades, and arrow buttons that appear on hover only when there's more to see.
 */
export function Row({ title, subtitle, seeAll, children, className }: { title: string; subtitle?: string; seeAll?: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });

  return (
    <section className={cx("group/row relative animate-rise", className)}>
      <header className="gutter-x mb-3 flex items-baseline gap-3">
        <h2 className="text-[20px] font-semibold leading-7 tracking-[-0.01em]">{title}</h2>
        {subtitle && <span className="meta">{subtitle}</span>}
        {seeAll && (
          <Link to={seeAll} className="meta ml-auto opacity-0 transition hover:text-fg group-hover/row:opacity-100 focus-visible:opacity-100">
            See all
          </Link>
        )}
      </header>
      <div className="relative">
        <div
          ref={ref}
          onScroll={measure}
          className="no-scrollbar flex snap-x snap-mandatory scroll-px-[var(--gutter)] gap-4 overflow-x-auto overflow-y-visible px-[var(--gutter)] pb-8 pt-4 [&>*]:snap-start"
        >
          {children}
        </div>
        <EdgeButton side="left" hidden={edges.start} onClick={() => page(-1)} />
        <EdgeButton side="right" hidden={edges.end} onClick={() => page(1)} />
      </div>
    </section>
  );
}

function EdgeButton({ side, hidden, onClick }: { side: "left" | "right"; hidden: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <div
      className={cx(
        "pointer-events-none absolute bottom-8 top-4 flex w-[var(--gutter)] items-center justify-center from-bg to-transparent transition-opacity duration-200",
        side === "left" ? "left-0 bg-gradient-to-r" : "right-0 bg-gradient-to-l",
        hidden ? "opacity-0" : "opacity-100",
      )}
    >
      <button
        tabIndex={-1}
        aria-label={side === "left" ? "Scroll left" : "Scroll right"}
        onClick={onClick}
        className={cx(
          "flex h-11 w-11 items-center justify-center rounded-full bg-surface-3/90 text-fg shadow-lift transition duration-200 hover:scale-110 hover:bg-fg hover:text-bg",
          hidden ? "pointer-events-none" : "pointer-events-auto opacity-0 group-hover/row:opacity-100",
        )}
      >
        <Icon size={22} />
      </button>
    </div>
  );
}
