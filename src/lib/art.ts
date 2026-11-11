/**
 * Generated artwork used when no cached image exists (before TMDB, or offline).
 * Deterministic per title, so the same film always gets the same look.
 */
import type { CSSProperties } from "react";

export function hashHue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Layered radial "light" over a deep tinted base, like a lit theatre curtain. */
export function posterGradient(hue: number, variant = 0): CSSProperties {
  const h2 = (hue + 32 + variant * 17) % 360;
  const h3 = (hue + 330) % 360;
  return {
    backgroundColor: `hsl(${hue} 35% 10%)`,
    backgroundImage: [
      `radial-gradient(120% 70% at ${20 + (variant * 23) % 60}% 0%, hsl(${hue} 70% 55% / .55), transparent 60%)`,
      `radial-gradient(90% 60% at 100% 100%, hsl(${h2} 75% 45% / .45), transparent 60%)`,
      `radial-gradient(80% 50% at 0% 85%, hsl(${h3} 60% 30% / .5), transparent 70%)`,
      `linear-gradient(180deg, hsl(${hue} 30% 14%), hsl(${hue} 40% 6%))`,
    ].join(","),
  };
}

export function backdropGradient(hue: number): CSSProperties {
  const h2 = (hue + 40) % 360;
  return {
    backgroundColor: `hsl(${hue} 30% 9%)`,
    backgroundImage: [
      `radial-gradient(55% 85% at 75% 35%, hsl(${hue} 75% 52% / .9), transparent 70%)`,
      `radial-gradient(40% 60% at 98% 90%, hsl(${h2} 85% 55% / .6), transparent 70%)`,
      `radial-gradient(45% 60% at 50% 0%, hsl(${(hue + 320) % 360} 65% 45% / .45), transparent 70%)`,
      `linear-gradient(120deg, hsl(${hue} 30% 8%), hsl(${hue} 40% 18%))`,
    ].join(","),
  };
}

/** The tint used to blend page background with a title's artwork. */
export const tint = (hue: number, alpha = 0.35) => `hsl(${hue} 60% 30% / ${alpha})`;
