import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./ui";

/**
 * Small anchored popover. Opens above its trigger by default (the player bar sits at the
 * bottom of the window). Closes on outside click and Escape.
 */
export function Popover({
  trigger,
  label,
  children,
  side = "top",
  align = "center",
  className,
  active,
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold tabular-nums transition duration-200 active:scale-95",
          open ? "bg-white/[.16] text-fg" : active ? "text-accent hover:bg-white/[.08]" : "text-fg-muted hover:bg-white/[.08] hover:text-fg",
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={cx(
            "absolute z-[70] w-max min-w-[220px] max-w-[340px] rounded-2xl bg-surface-2/[.98] p-2 shadow-[0_24px_70px_-15px_rgb(0_0_0/.95)] ring-1 ring-white/[.09] backdrop-blur-xl animate-pop",
            side === "top" ? "bottom-full mb-3" : "top-full mt-3",
            align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className="micro px-3 pb-1.5 pt-2 text-fg-subtle">{children}</div>;
}

export function MenuItem({ selected, onClick, children, hint }: { selected?: boolean; onClick: () => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[14px] transition-colors",
        selected ? "bg-white/[.08] text-fg" : "text-fg-muted hover:bg-white/[.05] hover:text-fg",
      )}
    >
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", selected ? "bg-accent" : "bg-transparent")} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{hint}</span>}
    </button>
  );
}
