import { Check, CircleAlert, ImageIcon, Loader2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { artApi } from "@/api/artwork";
import { useLibrary } from "@/store/library";
import type { Title } from "@/types/media";
import { ArtworkDialog, TmdbKeyForm } from "./ArtworkDialog";
import { Button, ProgressBar, cx } from "./ui";

interface Outcome {
  id: string;
  title: string;
  ok: boolean;
  note: string;
}

/**
 * Library → Artwork: connect TMDB once, then fetch posters/backgrounds for every title.
 * Low-confidence matches are skipped (not guessed) and listed for a manual fix.
 */
export function ArtworkSettings() {
  const lib = useLibrary((s) => s.data);
  const setArt = useLibrary((s) => s.setArt);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [changeKey, setChangeKey] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [fixing, setFixing] = useState<Title | null>(null);
  const cancel = useRef(false);

  useEffect(() => { artApi.settings().then((s) => setHasKey(s.hasTmdbKey)).catch(() => setHasKey(false)); }, []);

  const titles: Title[] = lib ? [...lib.movies, ...lib.series] : [];
  const withArt = titles.filter((t) => t.art.poster || t.art.backdrop).length;

  const fetchAll = async (replace: boolean) => {
    const todo = titles.filter((t) => replace || !(t.art.poster || t.art.backdrop));
    cancel.current = false;
    setRunning(true);
    setOutcomes([]);
    setProgress({ done: 0, total: todo.length, current: "" });
    for (let i = 0; i < todo.length && !cancel.current; i++) {
      const t = todo[i];
      setProgress({ done: i, total: todo.length, current: t.title });
      try {
        const r = await artApi.match(t.id, t.kind === "movie" ? "movie" : "tv", t.title, t.year);
        if (r.matched) {
          setArt(t.id, r.art);
          setOutcomes((o) => [...o, { id: t.id, title: t.title, ok: true, note: `${r.title}${r.year ? ` (${r.year})` : ""}` }]);
        } else {
          setOutcomes((o) => [...o, { id: t.id, title: t.title, ok: false, note: r.reason }]);
        }
      } catch (e) {
        setOutcomes((o) => [...o, { id: t.id, title: t.title, ok: false, note: e instanceof Error ? e.message : "Failed" }]);
        if (e instanceof Error && /API key/i.test(e.message)) break; // no point continuing
      }
    }
    setProgress((p) => ({ ...p, done: p.total, current: "" }));
    setRunning(false);
  };

  const failed = outcomes.filter((o) => !o.ok);
  const okCount = outcomes.length - failed.length;

  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold">Artwork</h2>
          <p className="meta mt-1">{lib ? `${withArt} of ${titles.length} titles have posters or backgrounds` : "…"}. Images are stored in CiRoom's own folder, never next to your media.</p>
        </div>
      </div>

      <div className="rounded-2xl bg-white/[.03] p-5">
        {hasKey === null ? (
          <div className="skeleton h-11 rounded-full" />
        ) : !hasKey || changeKey ? (
          <div className="max-w-xl">
            <div className="flex items-center gap-2 font-semibold"><ImageIcon size={17} /> Automatic artwork from TMDB</div>
            <p className="mt-1 text-[14px] text-fg-muted">Free. Sign up at The Movie Database, open <b className="text-fg">Settings → API</b>, and paste your API key here. Without a key you can still set artwork manually on any movie or series page.</p>
            <TmdbKeyForm compact onSaved={() => { setHasKey(true); setChangeKey(false); }} />
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-2 text-[14px] font-medium text-success"><Check size={16} /> TMDB connected</span>
              <button onClick={() => setChangeKey(true)} className="text-[13px] text-fg-subtle hover:text-fg">Change key</button>
              <div className="ml-auto flex gap-2">
                {running ? (
                  <Button onClick={() => (cancel.current = true)}>Stop</Button>
                ) : (
                  <>
                    {withArt > 0 && <Button variant="ghost" onClick={() => fetchAll(true)}>Refresh all</Button>}
                    <Button variant="primary" icon={<Wand2 size={16} />} onClick={() => fetchAll(false)} disabled={!lib || withArt === titles.length}>
                      {withArt === titles.length ? "All titles have artwork" : `Fetch artwork for ${titles.length - withArt} titles`}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {(running || outcomes.length > 0) && (
              <div className="mt-5 animate-rise">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="flex items-center gap-2 font-medium">
                    {running && <Loader2 size={14} className="animate-spin" />}
                    {running ? `Fetching ${progress.current}…` : `Done · ${okCount} updated${failed.length ? ` · ${failed.length} need a manual pick` : ""}`}
                  </span>
                  <span className="meta">{Math.min(progress.done + (running ? 0 : 0), progress.total)} / {progress.total}</span>
                </div>
                <ProgressBar value={progress.total ? progress.done / progress.total : 0} className="mt-2" />
                {failed.length > 0 && (
                  <ul className="mt-4 space-y-1.5">
                    {failed.map((o) => {
                      const t = titles.find((x) => x.id === o.id);
                      return (
                        <li key={o.id} className="flex items-center gap-3 rounded-xl bg-white/[.03] px-3 py-2">
                          <CircleAlert size={16} className="shrink-0 text-accent" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[14px] font-medium">{o.title}</div>
                            <div className="meta truncate text-[12px]">{o.note}</div>
                          </div>
                          {t && <Button onClick={() => setFixing(t)}>Choose…</Button>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!running && okCount > 0 && <p className={cx("mt-3 text-[13px] text-fg-subtle")}>Wrong picture? Open the title and use <b className="text-fg-muted">Change poster & background</b>.</p>}
              </div>
            )}
          </div>
        )}
      </div>

      {fixing && (
        <ArtworkDialog
          open
          onClose={() => setFixing(null)}
          id={fixing.id}
          type={fixing.kind === "movie" ? "movie" : "tv"}
          title={fixing.title}
          year={fixing.year}
          art={(lib && [...lib.movies, ...lib.series].find((x) => x.id === fixing.id)?.art) ?? fixing.art}
        />
      )}
    </section>
  );
}
