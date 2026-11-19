import { Play, RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

export function CtrlButton({ label, onClick, children, active, disabled }: { label: string; onClick: () => void; children: ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cx(
        "relative flex h-10 w-10 items-center justify-center rounded-full text-white transition hover:bg-white/15 active:scale-95 disabled:opacity-35 disabled:hover:bg-transparent",
        active && "text-violet-300 after:absolute after:bottom-1 after:h-[2px] after:w-4 after:rounded-full after:bg-violet-400",
      )}
    >
      {children}
    </button>
  );
}

export function Volume({ volume, muted, onVolume, onMute }: { volume: number; muted: boolean; onVolume: (v: number) => void; onMute: () => void }) {
  const Icon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const pct = muted ? 0 : Math.min(volume, 100);
  return (
    <div className="group/vol flex items-center">
      <CtrlButton label={muted ? "Unmute (M)" : "Mute (M)"} onClick={onMute}><Icon size={20} /></CtrlButton>
      <input
        type="range" min={0} max={100} value={pct} aria-label="Volume"
        onChange={(e) => onVolume(Number(e.target.value))}
        className="h-1 w-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 group-hover/vol:ml-1 group-hover/vol:w-24 group-hover/vol:opacity-100 focus-visible:w-24 focus-visible:opacity-100 accent-violet-500"
        style={{ background: `linear-gradient(to right, rgb(139 92 246) ${pct}%, rgb(255 255 255 / .25) ${pct}%)` }}
      />
    </div>
  );
}

export function EndScreen({ next, onReplay, mini, onClose }: { next?: { label: string; onPlay: () => void }; onReplay: () => void; mini?: boolean; onClose?: () => void }) {
  // Only reached when auto-play is off or was cancelled: offer the choice, never start by itself.
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 p-4 text-center animate-fade">
      {!mini && next && <div className="text-[13px] font-semibold uppercase tracking-[0.08em] text-violet-300">Up next</div>}
      {!mini && next && <div className="max-w-lg text-2xl font-semibold text-white">{next.label}</div>}
      <div className="flex flex-wrap justify-center gap-2.5">
        {next && <button onClick={next.onPlay} className={cx("flex items-center gap-2 rounded-full bg-violet-500 font-semibold text-white hover:bg-violet-400", mini ? "px-3.5 py-2 text-[13px]" : "px-6 py-3")}><Play size={mini ? 14 : 18} fill="currentColor" /> {mini ? "Next" : "Play now"}</button>}
        <button onClick={onReplay} className={cx("flex items-center gap-2 rounded-full font-semibold text-white", next ? "bg-white/15 hover:bg-white/25" : "bg-violet-500 hover:bg-violet-400", mini ? "px-3.5 py-2 text-[13px]" : "px-6 py-3")}><RotateCcw size={mini ? 14 : 18} /> Watch again</button>
        {mini && <button onClick={onClose} className="rounded-full bg-white/15 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-white/25">Close</button>}
      </div>
    </div>
  );
}
