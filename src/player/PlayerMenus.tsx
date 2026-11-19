import { ArrowLeft, AudioLines, Captions, Check, ChevronRight, Gauge, Search, Timer, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ProbeInfo } from "@/api/stream";
import { cx } from "@/components/ui";
import { useSettings, type SubtitleStyle } from "@/store/settings";
import { audioLabel } from "./audio";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export type MenuPage = "main" | "subs" | "audio" | "delay" | "speed";

/** Size, colour and background of the subtitle line (saved in Settings, used by the page player and the mini player). */
function SubtitleLook() {
  const st = useSettings((s) => s.subtitleStyle);
  const set = (patch: Partial<SubtitleStyle>) => useSettings.getState().set({ subtitleStyle: { ...st, ...patch } });
  const Chip = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => (
    <button onClick={onClick} aria-pressed={on} className={cx("rounded-full px-3 py-1 text-[13px] font-semibold transition", on ? "bg-violet-500 text-white" : "bg-white/10 text-white/75 hover:bg-white/15")}>{label}</button>
  );
  return (
    <div className="mt-1 space-y-2 border-t border-white/10 px-3 py-2.5">
      <div className="flex items-center gap-1.5"><span className="w-[72px] text-[12px] text-white/50">Size</span>{(["S", "M", "L", "XL"] as const).map((v) => <Chip key={v} on={st.size === v} label={v} onClick={() => set({ size: v })} />)}</div>
      <div className="flex items-center gap-1.5"><span className="w-[72px] text-[12px] text-white/50">Background</span>{([["none", "None"], ["shadow", "Shadow"], ["box", "Box"]] as const).map(([v, l]) => <Chip key={v} on={st.background === v} label={l} onClick={() => set({ background: v })} />)}</div>
      <div className="flex items-center gap-1.5"><span className="w-[72px] text-[12px] text-white/50">Colour</span>{([["white", "White"], ["yellow", "Yellow"]] as const).map(([v, l]) => <Chip key={v} on={st.color === v} label={l} onClick={() => set({ color: v })} />)}</div>
    </div>
  );
}

export function SettingsPanel(p: {
  page: MenuPage;
  setPage: (pg: null | MenuPage) => void;
  subtitles: ProbeInfo["subtitles"];
  audioTracks: NonNullable<ProbeInfo["audioTracks"]>;
  audioIndex: number;
  setAudioIndex: (i: number) => void;
  subError?: boolean;
  onFind?: () => void;
  subIndex: number;
  setSubIndex: (i: number) => void;
  rememberNote?: string;
  delay: number;
  setDelay: (d: number) => void;
  speed: number;
  setSpeed: (s: number) => void;
  levelling: boolean;
  levelGainDb?: number;
  setLevelling: (on: boolean) => void;
}) {
  const fmtDelay = (d: number) => (Math.abs(d) < 0.05 ? "0.0 s" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} s`);
  const subLabel = p.subIndex >= 0 ? p.subtitles[p.subIndex]?.label ?? "On" : "Off";
  const Row = ({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: string; onClick: () => void }) => (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-white transition hover:bg-white/10">
      <span className="text-white/70">{icon}</span>
      <span className="flex-1 font-semibold">{label}</span>
      <span className="max-w-[150px] truncate text-[13px] text-white/55">{value}</span>
      <ChevronRight size={16} className="text-white/45" />
    </button>
  );
  const Option = ({ selected, label, onClick }: { selected: boolean; label: string; onClick: () => void }) => (
    <button onClick={onClick} className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition hover:bg-white/10", selected ? "font-semibold text-white" : "text-white/80")}>
      <span className="w-4">{selected && <Check size={16} className="text-violet-400" />}</span>
      <span className="truncate">{label}</span>
    </button>
  );
  const Header = ({ title }: { title: string }) => (
    <div className="mb-1 flex items-center gap-2 border-b border-white/10 px-1 pb-2">
      {p.page !== "main" && <button onClick={() => p.setPage("main")} aria-label="Back" className="flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/10"><ArrowLeft size={18} /></button>}
      <span className="flex-1 px-2 text-[15px] font-semibold text-white">{title}</span>
      <button onClick={() => p.setPage(null)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"><X size={17} /></button>
    </div>
  );

  return (
    <div onClick={(e) => e.stopPropagation()} className="absolute bottom-[86px] right-[4%] z-10 w-[min(340px,86%)] rounded-2xl bg-[#141419]/95 p-2 shadow-[0_24px_70px_-15px_rgb(0_0_0/.95)] ring-1 ring-white/10 backdrop-blur-xl animate-pop">
      {p.page === "main" && (
        <>
          <Header title="Settings" />
          <Row icon={<Captions size={18} />} label="Subtitles" value={subLabel} onClick={() => p.setPage("subs")} />
          {p.audioTracks.length > 1 && <Row icon={<AudioLines size={18} />} label="Audio" value={audioLabel(p.audioTracks[p.audioIndex] ?? p.audioTracks[0])} onClick={() => p.setPage("audio")} />}
          <Row icon={<Timer size={18} />} label="Subtitle timing" value={fmtDelay(p.delay)} onClick={() => p.setPage("delay")} />
          <Row icon={<Gauge size={18} />} label="Playback speed" value={p.speed === 1 ? "Normal" : `${p.speed}×`} onClick={() => p.setPage("speed")} />
          <button onClick={() => p.setLevelling(!p.levelling)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-white transition hover:bg-white/10"
            title="Boosts quiet videos to a normal loudness, with a limiter so loud moments don't distort">
            <span className="text-white/70"><AudioLines size={18} /></span>
            <span className="flex-1 font-semibold">Volume levelling</span>
            <span className="text-[13px] text-white/55">
              {p.levelling ? (p.levelGainDb !== undefined && Math.abs(p.levelGainDb) >= 1 ? `On · ${p.levelGainDb > 0 ? "+" : ""}${p.levelGainDb.toFixed(0)} dB` : p.levelGainDb === undefined ? "On · measuring…" : "On") : "Off"}
            </span>
            <span className={cx("relative h-5 w-9 rounded-full transition", p.levelling ? "bg-violet-500" : "bg-white/20")}>
              <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", p.levelling ? "left-[18px]" : "left-0.5")} />
            </span>
          </button>
        </>
      )}
      {p.page === "subs" && (
        <>
          <Header title="Subtitles" />
          <Option selected={p.subIndex < 0} label="Off" onClick={() => p.setSubIndex(-1)} />
          {p.subtitles.map((s) => <Option key={s.index} selected={p.subIndex === s.index} label={s.label} onClick={() => p.setSubIndex(s.index)} />)}
          {p.subError && p.subIndex >= 0 && <p className="px-3 py-2 text-[13px] font-semibold text-amber-300">This subtitle couldn't be read. Try another one.</p>}
          <SubtitleLook />
          {p.subtitles.length > 0 && p.rememberNote && <p className="px-3 pb-1 pt-2 text-[12px] text-white/45">{p.rememberNote}</p>}
          {p.subtitles.length === 0 && <p className="px-3 py-2 text-[13px] text-white/55">No text subtitles for this video. Picture subtitles (DVD/Blu-ray) are available in the full player.</p>}
          {p.onFind && <button onClick={p.onFind} className="mt-1 flex w-full items-center gap-3 rounded-xl border-t border-white/10 px-3 py-2.5 text-left text-[14px] font-semibold text-violet-300 transition hover:bg-white/10"><Search size={16} /> Find subtitles online…</button>}
        </>
      )}
      {p.page === "audio" && (
        <>
          <Header title="Audio" />
          {p.audioTracks.map((a) => <Option key={a.index} selected={p.audioIndex === a.index} label={audioLabel(a)} onClick={() => p.setAudioIndex(a.index)} />)}
          <p className="px-3 pb-1 pt-2 text-[12px] text-white/45">The video restarts at the same spot with the new track.</p>
        </>
      )}
      {p.page === "delay" && (
        <>
          <Header title="Subtitle timing" />
          <div className={cx("py-3 text-center text-3xl font-bold tabular-nums", Math.abs(p.delay) >= 0.05 ? "text-violet-300" : "text-white")}>{fmtDelay(p.delay)}</div>
          <div className="grid grid-cols-4 gap-2 px-1">
            {[-0.5, -0.1, 0.1, 0.5].map((d) => (
              <button key={d} onClick={() => p.setDelay(p.delay + d)} className="h-10 rounded-xl bg-white/10 text-[14px] font-semibold tabular-nums text-white transition hover:bg-white/20 active:scale-95">
                {d > 0 ? "+" : "−"}{Math.abs(d)}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between px-2 pb-1 pt-3 text-[12px] text-white/55">
            <span>Too early → + · too late → − · Z / X keys</span>
            {Math.abs(p.delay) >= 0.05 && <button onClick={() => p.setDelay(0)} className="font-semibold text-white hover:text-violet-300">Reset</button>}
          </div>
        </>
      )}
      {p.page === "speed" && (
        <>
          <Header title="Playback speed" />
          {SPEEDS.map((s) => <Option key={s} selected={Math.abs(p.speed - s) < 0.01} label={s === 1 ? "Normal" : `${s}×`} onClick={() => p.setSpeed(s)} />)}
        </>
      )}
    </div>
  );
}

