import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { streamApi } from "@/api/stream";
import { timecode } from "@/lib/format";
import { cx } from "@/components/ui";
import { type Clock, useClock } from "./clock";

/** "12:34 / 45:00": re-renders with the clock store, not with the player. */
export function PlayerClock({ clock, duration }: { clock: Clock; duration: number }) {
  const { time } = useClock(clock);
  return <span className="ml-2 text-[13px] font-semibold tabular-nums text-white/90">{timecode(time)} <span className="text-white/50">/ {timecode(duration)}</span></span>;
}

/** Seek bar: played (violet), buffered, hover fill + thumbnail preview, round handle, click/drag. */
export function SeekBar({ clock, path, duration, onSeek, compact }: { clock: Clock; path: string; duration: number; onSeek: (t: number) => void; compact?: boolean }) {
  const { time, bufStart: offset, bufferedEnd } = useClock(clock);
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const frac = drag ?? (duration ? Math.min(1, time / duration) : 0);
  const at = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const hoverT = hover !== null ? hover * duration : 0;
  const thumbT = Math.floor(hoverT / 5) * 5;
  const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      tabIndex={-1}
      onPointerMove={(e) => { setHover(at(e)); if (drag !== null) setDrag(at(e)); }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(at(e)); }}
      onPointerUp={(e) => { if (drag !== null) onSeek(at(e) * duration); setDrag(null); }}
      className="group/seek relative flex h-6 cursor-pointer touch-none items-center"
    >
      <div className="relative h-[3px] w-full rounded-full bg-white/25 transition-[height] duration-150 group-hover/seek:h-[6px]">
        {duration > 0 && bufferedEnd > offset && (
          <div className="absolute inset-y-0 rounded-full bg-violet-200/45" style={{ left: pct(offset / duration), width: pct((bufferedEnd - offset) / duration) }} />
        )}
        {hover !== null && hover > frac && <div className="absolute inset-y-0 left-0 rounded-full bg-white/35" style={{ width: pct(hover) }} />}
        <div className="absolute inset-y-0 left-0 rounded-full bg-violet-500" style={{ width: pct(frac) }} />
      </div>
      <div
        className={cx("absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgb(139_92_246/.45)] transition-transform duration-150", drag !== null ? "scale-125" : "group-hover/seek:scale-110")}
        style={{ left: pct(frac) }}
      />
      {hover !== null && duration > 0 && !compact && (
        <div className="pointer-events-none absolute bottom-full mb-3 flex -translate-x-1/2 flex-col items-center gap-1.5" style={{ left: `clamp(84px, ${hover * 100}%, calc(100% - 84px))` }}>
          <div className="overflow-hidden rounded-lg bg-black ring-2 ring-violet-500/90 shadow-lift">
            <img src={streamApi.thumbUrl(path, thumbT)} alt="" className="block h-[90px] w-[160px] object-cover" />
          </div>
          <span className="rounded-md bg-black/80 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-white">{timecode(hoverT)}</span>
        </div>
      )}
    </div>
  );
}

