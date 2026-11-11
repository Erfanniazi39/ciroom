import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, ChevronDown, Copy, FileQuestion, Film, Languages, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { cx } from "@/components/ui";
import { analyse, type HealthEntry } from "@/lib/health";
import { useLibrary } from "@/store/library";
import type { ReviewItem } from "@/types/media";

interface Group {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  tone: string;
  items: HealthEntry[];
  pending?: boolean;
}

/** What needs attention in the library. Read-only: nothing here changes a file. */
export default function Health() {
  const navigate = useNavigate();
  const lib = useLibrary((s) => s.data);
  const meta = useLibrary((s) => s.meta);
  const factsReady = useLibrary((s) => s.factsReady);
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api.listReviewItems().then(setReview).catch(() => setReview([])); }, []);

  const report = useMemo(() => (lib && review ? analyse(lib, review, meta, factsReady) : null), [lib, review, meta, factsReady]);

  const groups: Group[] = report
    ? [
        { id: "new", label: "New episodes aired", hint: "TMDB says these aired in the last 30 days and aren't on disk yet.", icon: CalendarClock, tone: "text-accent", items: report.newAired },
        { id: "missing", label: "Missing episodes", hint: "Gaps in seasons you have: TMDB lists them but there is no video.", icon: AlertTriangle, tone: "text-danger", items: report.missingEpisodes },
        { id: "dup", label: "Duplicates", hint: "The same video is in the folder twice. CiRoom plays the best copy; delete the other yourself if you like.", icon: Copy, tone: "text-fg-muted", items: report.duplicates },
        { id: "low", label: "Low quality", hint: "Below 720p, or so heavily compressed (under 0.4 Mbps) that it looks blocky.", icon: Film, tone: "text-fg-muted", items: report.lowQuality, pending: !factsReady },
        { id: "subs", label: "No subtitles", hint: "No subtitle file sits next to the video (built-in subtitles aren't counted).", icon: Languages, tone: "text-fg-muted", items: report.noSubtitles, pending: !factsReady },
        { id: "details", label: "No details", hint: "Titles without TMDB details. Fix in Library → Metadata.", icon: FileQuestion, tone: "text-fg-muted", items: report.noDetails },
      ]
    : [];
  const issues = groups.filter((g) => g.id !== "new").reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="gutter-x pb-24 pt-8">
      <button onClick={() => navigate(-1)} className="meta -ml-2 mb-4 inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition hover:bg-white/[.06] hover:text-fg">
        <ArrowLeft size={16} /> Back
      </button>
      <h1 className="font-display text-[clamp(28px,3vw,44px)] font-semibold tracking-[-0.01em]">Library health</h1>
      <p className="mt-1 max-w-2xl text-fg-muted">What's missing, duplicated or low quality in your collection. CiRoom only reads your files, so nothing here changes them.</p>

      {!report ? (
        <div className="mt-10 text-fg-muted">Checking your library…</div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setOpen(open === g.id ? null : g.id)}
                className={cx("rounded-2xl bg-white/[.04] p-4 text-left ring-1 ring-white/[.05] transition hover:bg-white/[.07]", open === g.id && "bg-white/[.09] ring-accent/60")}
              >
                <g.icon size={20} className={g.items.length ? g.tone : "text-fg-subtle"} />
                <div className="mt-3 font-display text-3xl font-semibold tabular-nums">{g.pending ? "…" : g.items.length}</div>
                <div className="meta mt-0.5 text-[13px]">{g.label}</div>
              </button>
            ))}
          </div>

          {issues === 0 && report.newAired.length === 0 && (
            <div className="mt-8 flex items-center gap-3 rounded-2xl bg-white/[.04] p-5 text-fg-muted"><CheckCircle2 className="text-success" /> Everything looks good: {report.files} videos checked.</div>
          )}

          <div className="mt-8 space-y-3">
            {groups.filter((g) => g.items.length > 0 || g.pending).map((g) => (
              <section key={g.id} className="rounded-2xl bg-white/[.03]">
                <button onClick={() => setOpen(open === g.id ? null : g.id)} className="flex w-full items-center gap-3 p-4 text-left">
                  <g.icon size={20} className={g.tone} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{g.label} <span className="meta ml-1 tabular-nums">{g.pending ? "checking files…" : g.items.length}</span></div>
                    <div className="meta text-[13px]">{g.hint}</div>
                  </div>
                  <ChevronDown size={18} className={cx("text-fg-subtle transition", open === g.id && "rotate-180")} />
                </button>
                {open === g.id && (
                  <ul className="divide-y divide-white/[.05] border-t border-white/[.05] px-2 pb-2 pt-1">
                    {g.items.map((it) => (
                      <li key={it.key}>
                        <Link to={it.href} className="flex items-baseline gap-4 rounded-xl px-3 py-2.5 transition hover:bg-white/[.05]">
                          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{it.title}</span>
                          <span className="meta shrink-0 text-[13px]">{it.detail}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
