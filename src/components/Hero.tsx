import { Heart, Info, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlay } from "@/hooks/usePlay";
import { episodeCode, remaining, runtime, years } from "@/lib/format";
import { nextUp, titleHref } from "@/lib/library";
import { useUser } from "@/store/user";
import type { Title } from "@/types/media";
import { BackdropArt } from "./Artwork";
import { Badge, Button, IconButton, MetaLine, cx, ratingItems } from "./ui";

const ROTATE_MS = 9000;

/** Cinematic home banner: crossfading backdrops, pauses on hover, smart primary action. */
export function Hero({ items }: { items: Title[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || items.length < 2) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % items.length), ROTATE_MS);
    return () => clearTimeout(t);
  }, [index, paused, items.length]);

  if (!items.length) return null;
  const item = items[index];

  return (
    <section className="relative h-[min(72vh,760px)] min-h-[460px] overflow-hidden" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      {items.map((t, i) => (
        <BackdropArt
          key={t.id}
          art={t.art}
          className={cx("absolute inset-0 transition-[opacity,transform] duration-[900ms] ease-in-out", i === index ? "scale-100 opacity-100" : "scale-[1.03] opacity-0")}
        >
          {!t.art.backdrop && <HeroWordmark title={t.title} />}
        </BackdropArt>
      ))}
      {/* Legibility scrims: left for text, bottom to melt into the page */}
      <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/45 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-bg via-bg/60 to-transparent" />

      <div key={item.id} className="gutter-x absolute bottom-[14%] left-0 w-full max-w-[min(680px,60vw)] animate-rise">
        <div className="mb-4 flex items-center gap-2">
          <Badge className="!bg-accent/15 !text-accent">{item.kind === "movie" ? "Film" : "Series"}</Badge>
          <span className="meta">{item.genres.slice(0, 3).join(" · ")}</span>
        </div>
        <h1 className="h-display-xl [text-wrap:balance]">{item.title}</h1>
        <MetaLine
          className="mt-4"
          items={[
            item.kind === "movie" ? item.year : years(item.year, item.endYear),
            item.kind === "movie" ? runtime(item.runtime) : `${item.seasons.length} season${item.seasons.length > 1 ? "s" : ""}`,
            ...ratingItems(item.ratings),
            item.kind === "movie" && item.file.resolution && <Badge>{item.file.resolution}</Badge>,
          ]}
        />
        {item.overview && <p className="mt-4 line-clamp-3 max-w-[560px] text-[16px] leading-7 text-fg/80">{item.overview}</p>}
        <HeroActions item={item} />
      </div>

      {items.length > 1 && (
        <div className="gutter-x absolute bottom-[14%] right-0 flex gap-2" role="tablist" aria-label="Featured">
          {items.map((t, i) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={i === index}
              aria-label={t.title}
              onClick={() => setIndex(i)}
              className="group/dot relative h-1 overflow-hidden rounded-full bg-white/20 transition-[width] duration-300"
              style={{ width: i === index ? 36 : 14 }}
            >
              {i === index && (
                <span
                  className="absolute inset-y-0 left-0 bg-fg"
                  style={{ animation: paused ? "none" : `heroFill ${ROTATE_MS}ms linear forwards`, width: paused ? "100%" : undefined }}
                />
              )}
            </button>
          ))}
          <style>{`@keyframes heroFill { from { width: 0 } to { width: 100% } }`}</style>
        </div>
      )}
    </section>
  );
}

function HeroActions({ item }: { item: Title }) {
  const play = usePlay();
  const navigate = useNavigate();
  const progress = useUser((s) => s.progress);
  const favorites = useUser((s) => s.favorites);
  const toggleFavorite = useUser((s) => s.toggleFavorite);
  const fav = favorites.includes(item.id);

  let label = "Play";
  let sub: string | null = null;
  let onPlay = () => {};
  if (item.kind === "movie") {
    const p = progress[item.id];
    if (p && !p.watched && p.position > 60) { label = "Resume"; sub = remaining(p.position, p.duration); }
    onPlay = () => play(item);
  } else {
    const up = nextUp(item, progress);
    if (up) {
      label = up.mode === "resume" ? "Resume" : "Play";
      sub = episodeCode(up.episode.season, up.episode.number);
      onPlay = () => play({ series: item, episode: up.episode });
    }
  }

  return (
    <div className="mt-7 flex items-center gap-3">
      <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" />} onClick={onPlay}>
        {label}
        {sub && <span className="font-medium opacity-60">{sub}</span>}
      </Button>
      <Button size="lg" icon={<Info size={18} />} onClick={() => navigate(titleHref(item))}>More info</Button>
      <IconButton label={fav ? "Remove from favorites" : "Add to favorites"} active={fav} size="lg" onClick={() => toggleFavorite(item.id)}>
        <Heart size={19} fill={fav ? "currentColor" : "none"} />
      </IconButton>
    </div>
  );
}

/**
 * Generated backdrops have no imagery, so we set a huge, faint title as a typographic
 * "key art" layer on the right. Replaced by the real backdrop once metadata exists.
 */
function HeroWordmark({ title }: { title: string }) {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-[-4%] flex w-[62%] items-center justify-end overflow-hidden" aria-hidden>
      <span className="select-none text-right font-display font-semibold leading-[.85] tracking-[-0.04em] text-white/[.12] [font-size:clamp(90px,13vw,240px)] [text-wrap:balance]">
        {title}
      </span>
    </div>
  );
}
