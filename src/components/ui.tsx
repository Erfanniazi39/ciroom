import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { compactCount } from "@/lib/format";
import type { Rating, Ratings } from "@/types/media";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type Variant = "primary" | "secondary" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 shadow-[0_10px_30px_-10px_rgb(var(--accent)/.55)]",
  secondary: "bg-white/[.12] text-fg hover:bg-white/[.2] backdrop-blur-md",
  ghost: "text-fg-muted hover:text-fg hover:bg-white/[.06]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "lg";
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 rounded-full font-semibold transition duration-200 ease-out active:scale-[.97] disabled:pointer-events-none disabled:opacity-40",
        size === "lg" ? "h-12 px-6 text-[15px]" : "h-10 px-4 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: "sm" | "md" | "lg";
}

export function IconButton({ label, active, size = "md", className, children, ...rest }: IconButtonProps) {
  const dim = size === "lg" ? "h-12 w-12" : size === "sm" ? "h-8 w-8" : "h-10 w-10";
  return (
    <button
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full transition duration-200 ease-out active:scale-95",
        dim,
        active ? "bg-white/[.16] text-accent" : "bg-white/[.08] text-fg hover:bg-white/[.16]",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "light" }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={cx("h-1 overflow-hidden rounded-full bg-white/[.16]", className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width] duration-500 ease-out", tone === "accent" ? "bg-accent" : "bg-fg")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("micro inline-flex items-center rounded-[5px] bg-white/[.1] px-1.5 py-0.5 text-fg-muted", className)}>{children}</span>;
}

export function Chip({ active, children, onClick }: { active?: boolean; children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition duration-200",
        active ? "bg-fg text-bg" : "bg-white/[.06] text-fg-muted hover:bg-white/[.12] hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-white/[.06] p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 rounded-full px-3 text-[13px] font-medium transition duration-200",
            value === o.value ? "bg-white/[.14] text-fg shadow-rest" : "text-fg-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Separator dot for meta lines: "2010 · 2h 28m · ★ 8.4". */
export function MetaLine({ items, className }: { items: (ReactNode | false | undefined | null)[]; className?: string }) {
  const parts = items.filter(Boolean);
  return (
    <div className={cx("meta flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-fg-subtle" aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/**
 * Real ratings with their source ("IMDb 8.8", "TMDB 8.4"), as MetaLine items. Empty when none are known,
 * so nothing invented ever shows. Hover shows the vote count.
 */
export function ratingItems(r: Ratings | undefined): ReactNode[] {
  const chip = (label: string, v: Rating) => (
    <span key={label} className="flex items-center gap-1" title={`${label}: ${v.value.toFixed(1)} from ${compactCount(v.votes)} votes`}>
      <span className="rounded-[4px] bg-white/[.1] px-1 py-px text-[10px] font-bold leading-4 text-fg-muted">{label}</span>
      <span className="font-semibold text-fg">{v.value.toFixed(1)}</span>
    </span>
  );
  return [r?.imdb && chip("IMDb", r.imdb), r?.tmdb && chip("TMDB", r.tmdb)].filter(Boolean) as ReactNode[];
}
