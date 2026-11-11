import { useState } from "react";
import { backdropGradient, posterGradient } from "@/lib/art";
import type { Artwork as Art } from "@/types/media";
import { cx } from "./ui";

/** Callers may position art absolutely; only default to `relative` when they don't (grain needs a positioned box). */
const pos = (className?: string) => (className && /(^|\s)!?absolute(\s|$)/.test(className) ? "" : "relative");

/**
 * Poster: real image if we have one, otherwise generated art with the title set
 * in the display face. The fallback is designed to look intentional, never broken.
 */
export function PosterArt({ art, title, year, className, showTitle = true }: { art: Art; title: string; year?: number; className?: string; showTitle?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const useImage = art.poster && failed !== art.poster;
  return (
    <div className={cx("isolate aspect-[2/3] overflow-hidden bg-surface-2", !useImage && "grain", pos(className), className)} style={useImage ? undefined : posterGradient(art.hue, title.length)}>
      {useImage ? (
        <img src={art.poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(art.poster!)} className="absolute inset-0 h-full w-full object-cover animate-fade" />
      ) : (
        showTitle && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-[9%]">
            <span className="h-px w-6 bg-white/50" />
            <span className="font-display text-[clamp(15px,1.25vw,21px)] font-semibold leading-[1.08] tracking-[-0.01em] text-white [text-wrap:balance] [text-shadow:0_2px_12px_rgb(0_0_0/.4)]">
              {title}
            </span>
            {year && <span className="text-[11px] font-medium tracking-[0.12em] text-white/60">{year}</span>}
          </div>
        )
      )}
    </div>
  );
}

export function BackdropArt({ art, className, children }: { art: Art; className?: string; children?: React.ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  const useImage = art.backdrop && failed !== art.backdrop;
  return (
    <div className={cx("isolate overflow-hidden", !useImage && "grain", pos(className), className)} style={useImage ? { backgroundColor: "rgb(var(--bg))" } : backdropGradient(art.hue)}>
      {useImage && <img src={art.backdrop} alt="" decoding="async" onError={() => setFailed(art.backdrop!)} className="absolute inset-0 h-full w-full object-cover object-[center_20%] animate-fade" />}
      {children}
    </div>
  );
}

/**
 * 16:9 still for episodes and continue-watching cards. Uses the title's backdrop when
 * available; `variant` shifts framing/tint so sibling episodes don't look identical.
 */
export function StillArt({ art, variant = 0, src, className, children }: { art: Art; variant?: number; src?: string; className?: string; children?: React.ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  const own = src && failed !== src ? src : null; // a real frame of this episode, when available
  const img = own ?? (art.backdrop && failed !== art.backdrop ? art.backdrop : null);
  return (
    <div className={cx("isolate aspect-video overflow-hidden bg-surface-2", !img && "grain", pos(className), className)} style={img ? undefined : posterGradient((art.hue + variant * 7) % 360, variant)}>
      {img && (
        <img
          src={img}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(img)}
          className="absolute inset-0 h-full w-full object-cover"
          style={variant && !own ? { objectPosition: `${(variant * 37) % 100}% ${(variant * 53) % 100}%`, transform: "scale(1.25)" } : undefined}
        />
      )}
      {children}
    </div>
  );
}
