import { Clock, Flame, Trophy, Tv } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PosterArt } from "@/components/Artwork";
import { cx } from "@/components/ui";
import { allEpisodes, durationOf, findTitle, titleHref } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { dayKey, useUser } from "@/store/user";

const hm = (sec: number) => {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};

/** Days with at least a minute of real watching, counted back from today (yesterday keeps a streak alive). */
function streaks(log: Record<string, Record<string, number>>) {
  const active = new Set(Object.entries(log).filter(([, t]) => Object.values(t).reduce((a, b) => a + b, 0) >= 60).map(([d]) => d));
  const d = new Date();
  if (!active.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let current = 0;
  while (active.has(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }
  const days = [...active].sort();
  let longest = 0, run = 0, prev: Date | null = null;
  for (const k of days) {
    const cur = new Date(`${k}T12:00:00`);
    run = prev && Math.round((cur.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = cur;
  }
  return { current, longest };
}

export default function Stats() {
  const lib = useLibrary((s) => s.data);
  const { watchLog, progress } = useUser();

  const s = useMemo(() => {
    const total = (day: Record<string, number> | undefined) => (day ? Object.values(day).reduce((a, b) => a + b, 0) : 0);
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (13 - i));
      return { key: dayKey(d), label: d.toLocaleDateString(undefined, { weekday: "short" }), date: d, sec: total(watchLog[dayKey(d)]) };
    });
    const all = Object.values(watchLog).reduce((a, day) => a + total(day), 0);
    const week = days.slice(7).reduce((a, d) => a + d.sec, 0);
    const byTitle = new Map<string, number>();
    for (const day of Object.values(watchLog)) for (const [id, sec] of Object.entries(day)) byTitle.set(id, (byTitle.get(id) ?? 0) + sec);
    const top = [...byTitle].sort((a, b) => b[1] - a[1]).map(([id, sec]) => ({ t: lib ? findTitle(lib, id) : undefined, sec })).filter((x) => x.t).slice(0, 6);

    let moviesDone = 0, episodesDone = 0, seriesDone = 0, libSeconds = 0;
    if (lib) {
      for (const m of lib.movies) { if (progress[m.id]?.watched) moviesDone++; libSeconds += durationOf(m); }
      for (const sr of lib.series) {
        const eps = allEpisodes(sr).filter((e) => e.file);
        const done = eps.filter((e) => progress[e.id]?.watched).length;
        episodesDone += done;
        if (eps.length && done === eps.length) seriesDone++;
        libSeconds += eps.reduce((a, e) => a + durationOf(e), 0);
      }
    }
    return { days, all, week, top, max: Math.max(60, ...days.map((d) => d.sec)), ...streaks(watchLog), moviesDone, episodesDone, seriesDone, libSeconds };
  }, [lib, watchLog, progress]);

  const tiles = [
    { icon: Clock, label: "Watched this week", value: s.week ? hm(s.week) : "–", sub: s.all ? `${hm(s.all)} in total` : "Counted from the first minute you play" },
    { icon: Flame, label: "Current streak", value: `${s.current} day${s.current === 1 ? "" : "s"}`, sub: `Longest: ${s.longest} day${s.longest === 1 ? "" : "s"}` },
    { icon: Trophy, label: "Movies finished", value: String(s.moviesDone), sub: `of ${lib?.movies.length ?? 0} in your library` },
    { icon: Tv, label: "Episodes watched", value: String(s.episodesDone), sub: `${s.seriesDone} series finished` },
  ];

  return (
    <div className="gutter-x pb-24 pt-8">
      <h1 className="font-display text-[clamp(28px,3vw,44px)] font-semibold tracking-[-0.01em]">Your watching</h1>
      <p className="mt-1 max-w-2xl text-fg-muted">Time is counted while a video is really playing (paused time doesn't count). Both players count: the in-app player and the full (mpv) player.</p>

      <div className="mt-8 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-2xl bg-white/[.04] p-5 ring-1 ring-white/[.05]">
            <t.icon size={20} className="text-accent" />
            <div className="mt-3 font-display text-3xl font-semibold tabular-nums">{t.value}</div>
            <div className="mt-0.5 text-[14px] font-medium">{t.label}</div>
            <div className="meta mt-0.5 text-[13px]">{t.sub}</div>
          </div>
        ))}
      </div>

      <section className="mt-8 rounded-2xl bg-white/[.03] p-5">
        <h2 className="text-[15px] font-semibold">Last 14 days</h2>
        <div className="mt-5 flex h-44 items-end gap-2" role="img" aria-label="Minutes watched per day for the last 14 days">
          {s.days.map((d, i) => {
            const today = i === s.days.length - 1;
            return (
              <div key={d.key} className="group/bar flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${d.sec ? hm(d.sec) : "nothing"}`}>
                <span className="micro tabular-nums text-fg-subtle opacity-0 transition group-hover/bar:opacity-100">{d.sec ? hm(d.sec) : ""}</span>
                <div className={cx("w-full rounded-t-md transition", d.sec ? (today ? "bg-accent" : "bg-accent/60 group-hover/bar:bg-accent") : "bg-white/[.06]")} style={{ height: `${Math.max(d.sec ? 6 : 3, (d.sec / s.max) * 100)}%` }} />
                <span className={cx("micro", today ? "text-fg" : "text-fg-subtle")}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </section>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_320px]">
        <section>
          <h2 className="mb-3 text-[15px] font-semibold">Most watched</h2>
          {s.top.length === 0 ? (
            <p className="rounded-2xl bg-white/[.03] p-5 text-fg-muted">Nothing counted yet. Start a movie or episode and it will show up here.</p>
          ) : (
            <ol className="space-y-2">
              {s.top.map(({ t, sec }, i) => (
                <li key={t!.id}>
                  <Link to={titleHref(t!)} className="flex items-center gap-4 rounded-2xl bg-white/[.03] p-3 transition hover:bg-white/[.06]">
                    <span className="w-5 text-center font-display text-lg text-fg-subtle">{i + 1}</span>
                    <PosterArt art={t!.art} title={t!.title} showTitle={false} className="w-11 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{t!.title}</div>
                      <div className="meta text-[13px]">{t!.kind === "series" ? "Series" : "Movie"}</div>
                    </div>
                    <div className="font-semibold tabular-nums">{hm(sec)}</div>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="h-fit rounded-2xl bg-white/[.03] p-5">
          <h2 className="text-[15px] font-semibold">Your library</h2>
          <dl className="mt-3 space-y-2 text-[14px]">
            <div className="flex justify-between"><dt className="text-fg-muted">Movies</dt><dd className="tabular-nums">{lib?.movies.length ?? 0}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Series</dt><dd className="tabular-nums">{lib?.series.length ?? 0}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Episodes on disk</dt><dd className="tabular-nums">{lib?.series.reduce((n, sr) => n + allEpisodes(sr).filter((e) => e.file).length, 0) ?? 0}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Total length</dt><dd className="tabular-nums">{s.libSeconds ? `${Math.round(s.libSeconds / 3600)} h` : "–"}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
