import { Layers, Play } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { DetailHero } from "@/components/DetailHero";
import { PosterCard } from "@/components/PosterCard";
import { EmptyState } from "@/components/States";
import { Button, MetaLine } from "@/components/ui";
import { usePlay } from "@/hooks/usePlay";
import { plural, runtime } from "@/lib/format";
import { useLibrary } from "@/store/library";
import { useUser } from "@/store/user";

export default function CollectionDetail() {
  const { id } = useParams();
  const lib = useLibrary((s) => s.data);
  const progress = useUser((s) => s.progress);
  const play = usePlay();

  if (!lib) return <div className="h-screen" />;
  const collection = lib.collections.find((c) => c.id === id);
  if (!collection) return <EmptyState className="pt-[20vh]" icon={Layers} title="Collection not found" action={<Link to="/movies"><Button>Back to Movies</Button></Link>} />;

  const films = collection.movieIds.map((mid) => lib.movies.find((m) => m.id === mid)!).filter(Boolean).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  const total = films.every((m) => m.runtime) ? films.reduce((n, m) => n + (m.runtime ?? 0), 0) : undefined;
  const watched = films.filter((m) => progress[m.id]?.watched).length;
  const next = films.find((m) => !progress[m.id]?.watched) ?? films[0];

  return (
    <div className="pb-24">
      <DetailHero art={collection.art} title={collection.name}>
        <div className="micro mb-3 text-accent">Collection</div>
        <h1 className="h-display-l [text-wrap:balance]">{collection.name}</h1>
        <MetaLine className="mt-4" items={[plural(films.length, "film"), runtime(total), films.length > 1 && films[0].year && films[films.length - 1].year && `${films[0].year}–${films[films.length - 1].year}`, `${watched} watched`]} />
        {next && (
          <div className="mt-7">
            <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" />} onClick={() => play(next)}>
              {watched ? "Continue" : "Start"} with {next.title}
            </Button>
          </div>
        )}
      </DetailHero>

      <section className="gutter-x">
        <h2 className="mb-4 text-[20px] font-semibold">In release order</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(clamp(150px,12vw,200px),1fr))] gap-x-4 gap-y-7">
          {films.map((m) => <PosterCard key={m.id} title={m} fluid />)}
        </div>
      </section>
    </div>
  );
}
