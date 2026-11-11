import { FolderPlus } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Hero } from "@/components/Hero";
import { ContinueCard } from "@/components/LandscapeCard";
import { PosterCard } from "@/components/PosterCard";
import { Row } from "@/components/Row";
import { EmptyState, HeroSkeleton, PosterSkeletonRow } from "@/components/States";
import { Button } from "@/components/ui";
import { byAddedDesc, continueWatching, findEpisode, findTitle, newEpisodes, recommend } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { useUser } from "@/store/user";
import type { Title } from "@/types/media";

export default function Home() {
  const lib = useLibrary((s) => s.data);
  const { progress, favorites, history } = useUser();
  const navigate = useNavigate();

  const rows = useMemo(() => {
    if (!lib) return null;
    const cont = continueWatching(lib, progress);
    const all: Title[] = [...lib.movies, ...lib.series].sort(byAddedDesc);
    const favs = favorites.map((id) => findTitle(lib, id)).filter((t): t is Title => !!t);

    // Watch again: titles whose most recent session finished, de-duplicated by title.
    const seen = new Set<string>();
    const watchAgain: Title[] = [];
    for (const h of history) {
      if (!progress[h.id]?.watched) continue;
      const t = findTitle(lib, h.id) ?? findEpisode(lib, h.id)?.series;
      if (t && !seen.has(t.id)) { seen.add(t.id); watchAgain.push(t); }
    }

    // Featured: what you're in the middle of first, then the newest arrivals.
    const featured: Title[] = [];
    for (const c of cont) if (!featured.includes(c.title)) featured.push(c.title);
    for (const t of all) if (featured.length < 5 && !featured.includes(t)) featured.push(t);

    const fresh = lib.series.filter((s) => newEpisodes(s).aired.length > 0);

    return {
      fresh,
      featured: featured.slice(0, 5),
      cont,
      recent: all.slice(0, 15),
      recommended: recommend(lib, progress, favorites),
      favs,
      recentMovies: [...lib.movies].sort(byAddedDesc),
      recentSeries: [...lib.series].sort(byAddedDesc),
      watchAgain,
    };
  }, [lib, progress, favorites, history]);

  if (!rows) {
    return (
      <>
        <HeroSkeleton />
        <div className="-mt-16 relative"><PosterSkeletonRow landscape count={5} /><PosterSkeletonRow /></div>
      </>
    );
  }

  if (!lib!.movies.length && !lib!.series.length) {
    return (
      <EmptyState
        className="pt-[20vh]"
        icon={FolderPlus}
        title="Your library is empty"
        body="Point CiRoom at the folders where you keep your movies and series. Your files are never moved or changed."
        action={<Button variant="primary" size="lg" onClick={() => navigate("/library")}>Add a folder</Button>}
      />
    );
  }

  return (
    <div className="pb-24">
      <Hero items={rows.featured} />
      <div className="relative -mt-[6vh] space-y-2">
        {rows.cont.length > 0 && (
          <Row title="Continue Watching">
            {rows.cont.map((c) => <ContinueCard key={c.key} item={c} />)}
          </Row>
        )}
        {rows.fresh.length > 0 && (
          <Row title="New Episodes Out" subtitle="Aired recently and not in your library yet">
            {rows.fresh.map((t) => <PosterCard key={t.id} title={t} />)}
          </Row>
        )}
        <Row title="Recently Added">{rows.recent.map((t) => <PosterCard key={t.id} title={t} />)}</Row>
        {rows.recommended.length > 0 && (
          <Row title="Recommended for You" subtitle="Based on what you watch and love">
            {rows.recommended.map((t) => <PosterCard key={t.id} title={t} />)}
          </Row>
        )}
        {rows.favs.length > 0 && (
          <Row title="Favorites" seeAll="/my-list">{rows.favs.map((t) => <PosterCard key={t.id} title={t} />)}</Row>
        )}
        <Row title="New Movies" seeAll="/movies">{rows.recentMovies.map((t) => <PosterCard key={t.id} title={t} />)}</Row>
        <Row title="New Series" seeAll="/series">{rows.recentSeries.map((t) => <PosterCard key={t.id} title={t} />)}</Row>
        {rows.watchAgain.length > 0 && (
          <Row title="Watch Again">{rows.watchAgain.map((t) => <PosterCard key={t.id} title={t} />)}</Row>
        )}
      </div>
    </div>
  );
}
