import { Bookmark, Heart } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PosterCard } from "@/components/PosterCard";
import { EmptyState, PosterSkeletonGrid } from "@/components/States";
import { Button, Segmented } from "@/components/ui";
import { findTitle } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { useUser } from "@/store/user";
import type { Title } from "@/types/media";

export default function MyList() {
  const lib = useLibrary((s) => s.data);
  const { favorites, watchlist } = useUser();
  const [tab, setTab] = useState<"favorites" | "watchlist">("favorites");

  const ids = tab === "favorites" ? favorites : watchlist;
  const items = lib ? ids.map((id) => findTitle(lib, id)).filter((t): t is Title => !!t) : [];

  return (
    <div className="gutter-x pb-24 pt-10">
      <h1 className="h-display-l">My List</h1>
      <div className="mt-6">
        <Segmented
          label="List"
          value={tab}
          onChange={setTab}
          options={[
            { value: "favorites", label: `Favorites · ${favorites.length}` },
            { value: "watchlist", label: `Watchlist · ${watchlist.length}` },
          ]}
        />
      </div>
      <div className="mt-8">
        {!lib ? (
          <PosterSkeletonGrid count={6} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={tab === "favorites" ? Heart : Bookmark}
            title={tab === "favorites" ? "No favorites yet" : "Your watchlist is empty"}
            body={tab === "favorites" ? "Tap the heart on any movie or series to keep it here." : "Use + on a title to save it for later."}
            action={<Link to="/movies"><Button>Browse movies</Button></Link>}
          />
        ) : (
          <div key={tab} className="grid grid-cols-[repeat(auto-fill,minmax(clamp(140px,11vw,190px),1fr))] gap-x-4 gap-y-7 animate-rise">
            {items.map((t) => <PosterCard key={t.id} title={t} fluid />)}
          </div>
        )}
      </div>
    </div>
  );
}
