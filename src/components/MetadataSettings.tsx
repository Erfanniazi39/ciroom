import { Check, CircleAlert, FileText, Loader2, RefreshCw, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { metaApi } from "@/api/meta";
import { relativeDate } from "@/lib/format";
import { useLibrary } from "@/store/library";
import type { Title } from "@/types/media";
import { ArtworkDialog } from "./ArtworkDialog";
import { Button, ProgressBar, cx } from "./ui";

interface Outcome {
  id: string;
  ok: boolean;
  note: string;
}

/**
 * Library → Metadata: real details from TMDB (title, year, runtime, genres, description, director/creator,
 * cast, TMDB rating, episode titles) and real IMDb ratings from IMDb's free daily dataset.
 * Each title's TMDB match is listed with how it was found, so a wrong one can be fixed.
 */
export function MetadataSettings() {
  const lib = useLibrary((s) => s.data);
  const meta = useLibrary((s) => s.meta);
  const setMeta = useLibrary((s) => s.setMeta);
  const reloadMeta = useLibrary((s) => s.reloadMeta);
  const [running, setRunning] = useState<null | "fetch" | "imdb">(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [imdbNote, setImdbNote] = useState<string | null>(null);
  const [fixing, setFixing] = useState<Title | null>(null);
  const cancel = useRef(false);

  // Match against the FOLDER title (the composed title may already be TMDB's).
  const [base, setBase] = useState<Awaited<ReturnType<typeof api.getLibrary>> | null>(null);
  useEffect(() => { api.getLibrary().then(setBase); }, []);

  const titles: Title[] = lib ? [...lib.movies, ...lib.series] : [];
  const withMeta = titles.filter((t) => meta[t.id]).length;
  const withImdb = titles.filter((t) => meta[t.id]?.imdb).length;

  const requestFor = (t: Title) => {
    const b = base ? [...base.movies, ...base.series].find((x) => x.id === t.id) : undefined;
    return {
      id: t.id, type: t.kind === "movie" ? ("movie" as const) : ("tv" as const), query: b?.title ?? t.title, year: b?.year,
      seasons: t.kind === "series" ? t.seasons.map((s) => s.number) : undefined,
    };
  };

  const fetchAll = async (refresh: boolean) => {
    const todo = titles.filter((t) => refresh || !meta[t.id]);
    cancel.current = false;
    setRunning("fetch");
    setOutcomes([]);
    setImdbNote(null);
    setProgress({ done: 0, total: todo.length, current: "" });
    for (let i = 0; i < todo.length && !cancel.current; i++) {
      const t = todo[i];
      setProgress({ done: i, total: todo.length, current: t.title });
      try {
        const m = await metaApi.fetch(requestFor(t));
        setMeta(t.id, m);
        setOutcomes((o) => [...o, { id: t.id, ok: true, note: m.matchedTitle }]);
      } catch (e) {
        setOutcomes((o) => [...o, { id: t.id, ok: false, note: e instanceof Error ? e.message : "Failed" }]);
        if (e instanceof Error && /API key/i.test(e.message)) break;
      }
    }
    setProgress((p) => ({ ...p, done: p.total, current: "" }));
    if (!cancel.current) await refreshImdb(true);
    setRunning(null);
  };

  const refreshImdb = async (chained = false) => {
    setRunning("imdb");
    setImdbNote(null);
    try {
      const r = await metaApi.imdb();
      await reloadMeta();
      setImdbNote(`IMDb ratings: ${r.updated} titles updated (dataset from ${relativeDate(r.datasetDate)})${r.missing.length ? ` · ${r.missing.length} without an IMDb rating` : ""}.`);
    } catch (e) {
      setImdbNote(e instanceof Error ? `IMDb ratings failed: ${e.message}` : "IMDb ratings failed");
    } finally {
      if (!chained) setRunning(null);
    }
  };

  const failed = outcomes.filter((o) => !o.ok);
  const matchList = titles.filter((t) => meta[t.id]);

  return (
    <section className="mt-12">
      <div className="mb-4">
        <h2 className="text-[20px] font-semibold">Metadata</h2>
        <p className="meta mt-1">
          {lib ? `${withMeta} of ${titles.length} titles have details · ${withImdb} with IMDb ratings` : "…"}. Details come from TMDB, ratings from TMDB and IMDb. Stored in CiRoom's own folder.
        </p>
      </div>

      <div className="rounded-2xl bg-white/[.03] p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-[14px] font-medium"><FileText size={16} className="text-fg-muted" /> Titles, descriptions, people, episode titles, ratings</span>
          <div className="ml-auto flex gap-2">
            {running ? (
              running === "fetch" ? <Button onClick={() => (cancel.current = true)}>Stop</Button> : <Button disabled icon={<Loader2 size={15} className="animate-spin" />}>Reading IMDb ratings…</Button>
            ) : (
              <>
                {withMeta > 0 && <Button variant="ghost" icon={<Star size={15} />} onClick={() => refreshImdb()}>Update IMDb ratings</Button>}
                {withMeta > 0 && <Button variant="ghost" icon={<RefreshCw size={15} />} onClick={() => fetchAll(true)}>Refresh all</Button>}
                {withMeta < titles.length && (
                  <Button variant="primary" onClick={() => fetchAll(false)} disabled={!lib || !base}>
                    Fetch details for {titles.length - withMeta} titles
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {(running === "fetch" || outcomes.length > 0) && (
          <div className="mt-5 animate-rise">
            <div className="flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 font-medium">
                {running === "fetch" && <Loader2 size={14} className="animate-spin" />}
                {running === "fetch" ? `Fetching ${progress.current}…` : `Done · ${outcomes.length - failed.length} updated${failed.length ? ` · ${failed.length} failed` : ""}`}
              </span>
              <span className="meta">{progress.done} / {progress.total}</span>
            </div>
            <ProgressBar value={progress.total ? progress.done / progress.total : 0} className="mt-2" />
          </div>
        )}
        {imdbNote && <p className={cx("mt-3 text-[13px]", imdbNote.includes("failed") ? "text-danger" : "text-fg-muted")}>{imdbNote}</p>}

        {failed.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {failed.map((o) => {
              const t = titles.find((x) => x.id === o.id);
              return (
                <li key={o.id} className="flex items-center gap-3 rounded-xl bg-danger/[.06] px-3 py-2">
                  <CircleAlert size={16} className="shrink-0 text-danger" />
                  <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{t?.title ?? o.id}</div><div className="meta truncate text-[12px]">{o.note}</div></div>
                  {t && <Button onClick={() => setFixing(t)}>Choose…</Button>}
                </li>
              );
            })}
          </ul>
        )}

        {matchList.length > 0 && (
          <details className="group mt-5">
            <summary className="meta cursor-pointer select-none hover:text-fg">Check matches ({matchList.length})</summary>
            <ul className="mt-3 grid gap-1.5 md:grid-cols-2">
              {matchList.map((t) => {
                const m = meta[t.id];
                const unsure = m.matchedBy === "search" && m.confidence < 0.8;
                return (
                  <li key={t.id} className="flex items-center gap-3 rounded-xl bg-white/[.03] px-3 py-2">
                    {unsure ? <CircleAlert size={15} className="shrink-0 text-accent" /> : <Check size={15} className="shrink-0 text-success" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium">{m.matchedTitle}</div>
                      <div className="meta truncate text-[12px]">
                        {{ artwork: "Matched with the artwork", search: `Found by search · ${Math.round(m.confidence * 100)}% sure`, manual: "Chosen by you" }[m.matchedBy]}
                        {m.imdb ? ` · IMDb ${m.imdb.value.toFixed(1)}` : ""}
                      </div>
                    </div>
                    <Button variant="ghost" onClick={() => setFixing(t)}>Fix match</Button>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>

      {fixing && (
        <ArtworkDialog
          open
          mode="match"
          onClose={() => setFixing(null)}
          id={fixing.id}
          type={fixing.kind === "movie" ? "movie" : "tv"}
          title={requestFor(fixing).query}
          year={requestFor(fixing).year}
          seasons={requestFor(fixing).seasons}
          art={fixing.art}
        />
      )}
    </section>
  );
}
