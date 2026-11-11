import { AlertTriangle, HeartPulse, CheckCircle2, Copy, FileArchive, FileQuestion, FolderOpen, FolderPlus, FolderTree, HardDrive, RefreshCw, Trash2, Wand2, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { artApi } from "@/api/artwork";
import { metaApi } from "@/api/meta";
import { ArtworkSettings } from "@/components/ArtworkSettings";
import { MetadataSettings } from "@/components/MetadataSettings";
import { EmptyState } from "@/components/States";
import { Badge, Button, IconButton, Segmented, cx } from "@/components/ui";
import { relativeDate } from "@/lib/format";
import { useLibrary } from "@/store/library";
import type { LibraryRoot, ReviewItem, ReviewKind } from "@/types/media";

const KIND_META: Record<ReviewKind, { label: string; icon: LucideIcon; tone: string }> = {
  empty: { label: "No video yet", icon: FolderTree, tone: "text-fg-muted" },
  unidentified: { label: "Unknown episode", icon: FileQuestion, tone: "text-danger" },
  low_confidence: { label: "Check match", icon: Wand2, tone: "text-accent" },
  nested: { label: "Nested series", icon: FolderTree, tone: "text-accent" },
  misplaced: { label: "File name doesn't match folder", icon: FolderTree, tone: "text-accent" },
  duplicate: { label: "Duplicate", icon: Copy, tone: "text-fg-muted" },
  missing: { label: "Missing file", icon: AlertTriangle, tone: "text-danger" },
  zipped_subtitle: { label: "Zipped subtitle", icon: FileArchive, tone: "text-fg-muted" },
};

type Tab = "identify" | "missing" | "other";
const TAB_KINDS: Record<Tab, ReviewKind[]> = {
  identify: ["empty", "unidentified", "low_confidence", "nested", "misplaced"],
  missing: ["missing", "duplicate"],
  other: ["zipped_subtitle"],
};

/** Library management: sources, scanning, and the "Needs attention" queue. Read-only on media, always. */
export default function LibraryPage() {
  const lib = useLibrary((s) => s.data);
  const reload = useLibrary((s) => s.load);
  const [roots, setRoots] = useState<LibraryRoot[] | null>(null);
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const [scan, setScan] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<Tab>("identify");

  useEffect(() => {
    api.listRoots().then(setRoots);
    api.listReviewItems().then(setReview);
  }, []);

  /** Re-read the folders (read-only), then reload the library. Only runs when you press the button. */
  const startScan = async () => {
    setScan(true);
    setLastResult(null);
    try {
      const c = await api.scan();
      const parts = [
        c.added.length && `${c.added.length} new: ${c.added.join(", ")}`,
        c.newEpisodes > 0 && `${c.newEpisodes} new episode${c.newEpisodes === 1 ? "" : "s"}`,
        c.removed.length && `${c.removed.length} gone: ${c.removed.join(", ")}`,
      ].filter(Boolean);
      const summary = `Scan complete${parts.length ? ` · ${parts.join(" · ")}` : " · no changes"}`;
      setLastResult({ ok: true, text: summary });
      api.listRoots().then(setRoots);
      api.listReviewItems().then(setReview);
      await reload();
      // New titles: fetch their real details + poster/background right away (TMDB), so they show up complete.
      const st = useLibrary.getState();
      const base = await api.getLibrary();
      const fresh = [...base.movies, ...base.series].filter((t) => !st.meta[t.id]);
      for (const [i, t] of fresh.entries()) {
        setLastResult({ ok: true, text: `${summary} · fetching details ${i + 1}/${fresh.length}: ${t.title}…` });
        try {
          const type = t.kind === "movie" ? "movie" : "tv";
          const m = await metaApi.fetch({ id: t.id, type, query: t.title, year: t.year, seasons: t.kind === "series" ? t.seasons.map((x) => x.number) : undefined });
          st.setMeta(t.id, m);
          const lib = useLibrary.getState().data;
          const shown = lib && [...lib.movies, ...lib.series].find((x) => x.id === t.id);
          if (shown && !shown.art.poster) st.setArt(t.id, await artApi.apply(t.id, type, m.tmdbId));
        } catch { /* listed in Metadata → Fetch details; the user can retry or fix the match there */ }
      }
      if (fresh.length) {
        setLastResult({ ok: true, text: `${summary} · adding IMDb ratings…` });
        try { await metaApi.imdb(); await useLibrary.getState().reloadMeta(); } catch { /* ratings can be updated from Metadata later */ }
        setLastResult({ ok: true, text: `${summary} · details, ratings and artwork fetched` });
      }
    } catch (e) {
      setLastResult({ ok: false, text: e instanceof Error ? e.message : "Scan failed" });
    } finally {
      setScan(false);
    }
  };

  const resolve = (id: string) => setReview((r) => r?.filter((x) => x.id !== id) ?? r);

  const episodes = lib?.series.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.filter((e) => e.file).length, 0), 0) ?? 0;
  const openItems = review?.filter((r) => TAB_KINDS[tab].includes(r.kind)) ?? [];

  return (
    <div className="gutter-x max-w-[1200px] pb-24 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h-display-l">Library</h1>
          <p className="meta mt-2">CiRoom only reads your folders. It never moves, renames or deletes media files.</p>
        </div>
        <div className="flex gap-2">
          <Link to="/health"><Button icon={<HeartPulse size={16} />} tabIndex={-1}>Library health</Button></Link>
          <Button icon={<FolderPlus size={16} />} title="Opens a folder picker in the desktop app (Stage 2)">Add folder</Button>
          <Button variant="primary" icon={<RefreshCw size={16} className={scan ? "animate-spin" : ""} />} onClick={startScan} disabled={!!scan}>
            {scan ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      </header>

      {/* Stats */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Movies" value={lib?.movies.length} />
        <Stat label="Series" value={lib?.series.length} />
        <Stat label="Episodes" value={lib ? episodes : undefined} />
        <Stat label="Need attention" value={review?.length} accent />
      </div>

      {/* Scan progress */}
      {(scan || lastResult) && (
        <div className="mt-6 rounded-2xl bg-white/[.03] p-5 animate-rise">
          {scan ? (
            <div className="flex items-center gap-2 text-[14px] font-medium"><RefreshCw size={16} className="animate-spin" /> Reading your folders…</div>
          ) : (
            <div className={cx("flex items-start gap-2 text-[14px]", lastResult?.ok ? "text-success" : "text-danger")}><CheckCircle2 size={16} className="mt-0.5 shrink-0" /> {lastResult?.text}</div>
          )}
        </div>
      )}

      {/* Sources */}
      <section className="mt-12">
        <h2 className="mb-4 text-[20px] font-semibold">Folders</h2>
        <ul className="divide-y divide-white/[.05] overflow-hidden rounded-2xl bg-white/[.03]">
          {!roots && [0, 1].map((i) => <li key={i} className="p-5"><div className="skeleton h-10 rounded-lg" /></li>)}
          {roots?.length === 0 && (
            <li><EmptyState icon={FolderOpen} title="No folders yet" body="Add the folders that contain your Movies and Series." /></li>
          )}
          {roots?.map((r) => (
            <li key={r.id} className="group/root flex items-center gap-4 p-5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[.06] text-fg-muted"><HardDrive size={20} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.path.split("/").pop()}</span>
                  <Badge>{r.kindHint}</Badge>
                  <span className={cx("flex items-center gap-1 text-[12px] font-medium", r.online ? "text-success" : "text-danger")}>
                    <span className={cx("h-1.5 w-1.5 rounded-full", r.online ? "bg-success" : "bg-danger")} />
                    {r.online ? "Online" : "Offline"}
                  </span>
                </div>
                <div className="meta mt-0.5 truncate font-mono text-[12px]">{r.path}</div>
              </div>
              <div className="meta hidden text-right sm:block">
                <div>{r.itemCount} items</div>
                {r.lastScanAt && <div className="text-fg-subtle">Scanned {relativeDate(r.lastScanAt)}</div>}
              </div>
              <IconButton label="Remove folder from library (files are not touched)" size="sm" className="opacity-0 group-hover/root:opacity-100 focus-visible:opacity-100">
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      </section>

      <MetadataSettings />
      <ArtworkSettings />

      {/* Needs attention */}
      <section className="mt-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[20px] font-semibold">Needs attention</h2>
          <Segmented
            label="Review category"
            value={tab}
            onChange={setTab}
            options={[
              { value: "identify", label: `Identify · ${count(review, "identify")}` },
              { value: "missing", label: `Missing & duplicates · ${count(review, "missing")}` },
              { value: "other", label: `Other · ${count(review, "other")}` },
            ]}
          />
        </div>
        {review && openItems.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="All clear" body="Nothing in this category needs your attention." />
        ) : (
          <ul className="space-y-2">
            {openItems.map((item) => {
              const meta = KIND_META[item.kind];
              const Icon = meta.icon;
              return (
                <li key={item.id} className="flex items-start gap-4 rounded-2xl bg-white/[.03] p-4 transition-colors hover:bg-white/[.05]">
                  <Icon size={18} className={cx("mt-0.5 shrink-0", meta.tone)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cx("micro", meta.tone)}>{meta.label}</span>
                    </div>
                    <div className="mt-1 break-all font-mono text-[13px] text-fg">{item.path}</div>
                    <p className="meta mt-1">{item.detail}</p>
                    {item.suggestion && <p className="mt-1.5 text-[13px] text-fg-muted">Suggested: <span className="text-fg">{item.suggestion}</span></p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {item.suggestion && <Button variant="primary" onClick={() => resolve(item.id)}>Accept</Button>}
                    <Button variant="ghost" title="Hide this note. It comes back on the next scan if the folder hasn't changed." onClick={() => resolve(item.id)}>Hide</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

const count = (items: ReviewItem[] | null, tab: Tab) => items?.filter((r) => TAB_KINDS[tab].includes(r.kind)).length ?? 0;

function Stat({ label, value, accent }: { label: string; value?: number; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-white/[.03] p-5">
      <div className="meta">{label}</div>
      {value === undefined ? (
        <div className="skeleton mt-2 h-9 w-16 rounded-md" />
      ) : (
        <div className={cx("mt-1 font-display text-[36px] font-semibold leading-tight tabular-nums", accent && value > 0 && "text-accent")}>{value}</div>
      )}
    </div>
  );
}
