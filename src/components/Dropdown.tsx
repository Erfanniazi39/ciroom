import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

interface Option<T> {
  value: T;
  label: string;
}

/**
 * Pill-style dropdown (single or multi select). Native <select> looks like admin
 * software on Linux, so this is a small custom popover with keyboard support.
 */
export function Dropdown<T extends string>({
  label,
  options,
  value,
  onChange,
  multiple,
  align = "left",
}: {
  label: string;
  options: Option<T>[];
  value: T[];
  onChange: (v: T[]) => void;
  multiple?: boolean;
  align?: "left" | "right";
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

  const selectedLabels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const summary = multiple
    ? selectedLabels.length === 0 ? label : selectedLabels.length === 1 ? selectedLabels[0] : `${label} · ${selectedLabels.length}`
    : selectedLabels[0] ?? label;
  const active = multiple && selectedLabels.length > 0;

  const pick = (v: T) => {
    if (!multiple) { onChange([v]); setOpen(false); return; }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cx(
          "inline-flex h-9 items-center gap-1.5 rounded-full pl-3.5 pr-2.5 text-[13px] font-medium transition duration-200",
          active ? "bg-fg text-bg" : "bg-white/[.06] text-fg-muted hover:bg-white/[.12] hover:text-fg",
        )}
      >
        {summary}
        <ChevronDown size={15} className={cx("transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-multiselectable={multiple}
          className={cx(
            "absolute top-full z-30 mt-2 max-h-80 min-w-[200px] overflow-y-auto rounded-xl bg-surface-2 p-1.5 shadow-[0_20px_60px_-15px_rgb(0_0_0/.9)] ring-1 ring-white/[.08] animate-pop",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {multiple && value.length > 0 && (
            <li>
              <button onClick={() => onChange([])} className="meta w-full rounded-lg px-3 py-2 text-left hover:bg-white/[.06] hover:text-fg">Clear</button>
            </li>
          )}
          {options.map((o) => {
            const sel = value.includes(o.value);
            return (
              <li key={o.value}>
                <button
                  role="option"
                  aria-selected={sel}
                  onClick={() => pick(o.value)}
                  className={cx("flex w-full items-center justify-between gap-6 rounded-lg px-3 py-2 text-left text-[14px] transition-colors hover:bg-white/[.06]", sel ? "text-fg" : "text-fg-muted")}
                >
                  {o.label}
                  {sel && <Check size={15} className="text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
