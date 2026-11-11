import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { tint } from "@/lib/art";
import type { Artwork } from "@/types/media";
import { BackdropArt, PosterArt } from "./Artwork";

/**
 * Shared cinematic header for movie, series and collection pages:
 * full-bleed backdrop melting into the page, poster on the left, content on the right.
 */
export function DetailHero({ art, title, year, children }: { art: Artwork; title: string; year?: number; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <section className="relative isolate">
      <BackdropArt art={art} className="absolute inset-x-0 top-0 -z-10 h-[min(78vh,820px)]">
        <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/55 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-bg via-bg/80 to-transparent" />
      </BackdropArt>
      {/* Faint tint carries the title's color further down the page */}
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-20 h-[120vh]" style={{ background: `radial-gradient(80% 60% at 70% 0%, ${tint(art.hue, 0.25)}, transparent 70%)` }} />

      <div className="gutter-x pt-8">
        <button onClick={() => navigate(-1)} className="meta -ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition hover:bg-white/[.06] hover:text-fg">
          <ArrowLeft size={16} /> Back
        </button>
      </div>

      <div className="gutter-x flex items-end gap-10 pb-10 pt-[clamp(80px,16vh,200px)] animate-rise">
        <PosterArt art={art} title={title} year={year} className="hidden w-[clamp(200px,17vw,280px)] shrink-0 rounded-[10px] shadow-[0_40px_80px_-30px_rgb(0_0_0/.9)] ring-1 ring-white/10 md:block" />
        <div className="min-w-0 max-w-[760px] flex-1">{children}</div>
      </div>
    </section>
  );
}
