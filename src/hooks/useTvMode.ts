import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSettings } from "@/store/settings";

/** Turn TV mode on/off. Fullscreen needs a user gesture, so this is called from a click or a shortcut. */
export function setTvMode(on: boolean) {
  useSettings.getState().set({ tvMode: on });
  try {
    if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  } catch { /* fullscreen is optional */ }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [role="tab"], [role="switch"], [role="radio"], [tabindex]:not([tabindex="-1"])';

const RAIL_PX = 80;

type Dir = "left" | "right" | "up" | "down";

function usable(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.pointerEvents !== "none";
}

/** The nearest focusable element in a direction (with a strict pass for "same row/column" first). */
function pick(from: DOMRect, scope: ParentNode, current: Element | null, dir: Dir): HTMLElement | null {
  const horizontal = dir === "left" || dir === "right";
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best: { el: HTMLElement; score: number } | null = null;
  for (const strict of [true, false]) {
    for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (el === current || !usable(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= RAIL_PX && !el.closest("nav")) continue; // scrolled away behind the side rail
      const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      const ahead = dir === "right" ? dx > 4 : dir === "left" ? dx < -4 : dir === "down" ? dy > 4 : dy < -4;
      if (!ahead) continue;
      const overlap = horizontal
        ? Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top)
        : Math.min(from.right, r.right) - Math.max(from.left, r.left);
      const size = horizontal ? Math.min(from.height, r.height) : Math.min(from.width, r.width);
      if (strict && overlap < size * 0.3) continue;
      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
      const score = primary + secondary * (strict ? 1 : 3);
      if (!best || score < best.score) best = { el, score };
    }
    if (best) break;
  }
  return best?.el ?? null;
}

function focusEl(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
}

/**
 * Couch mode: arrow keys move focus to the nearest control, Enter activates it, Esc/Backspace goes back.
 * On the watch page the arrows stay with the player (seek, volume) until focus has been moved onto the page.
 */
export function useTvMode() {
  const tv = useSettings((s) => s.tvMode);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    document.documentElement.classList.toggle("tv-mode", tv);
    return () => document.documentElement.classList.remove("tv-mode");
  }, [tv]);

  // Put focus somewhere sensible after each page change.
  useEffect(() => {
    if (!tv || pathname.startsWith("/watch/")) return;
    const t = window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && document.contains(a) && a.closest("main")) return;
      const first = document.querySelector<HTMLElement>("main [data-autofocus], main a[href], main button:not([disabled])");
      if (first) first.focus({ preventScroll: true });
    }, 450);
    return () => window.clearTimeout(t);
  }, [tv, pathname]);

  useEffect(() => {
    if (!tv) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const active = document.activeElement as HTMLElement | null;
      const typing = !!active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && (active as HTMLInputElement).type === "text") || active.isContentEditable);
      const onWatch = pathname.startsWith("/watch/");
      const inPage = !!active && active !== document.body && !!active.closest("main");

      if (e.key === "Escape" && onWatch && inPage) { active!.blur(); e.preventDefault(); return; }
      if ((e.key === "Backspace" || (e.key === "Escape" && !onWatch)) && !typing) {
        if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return; // dialogs close themselves on Esc
        if (pathname !== "/") { e.preventDefault(); navigate(-1); }
        return;
      }
      const dir: Dir | null = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : null;
      if (!dir || typing) return;
      if (onWatch && !inPage) return; // the player owns the arrows
      // Sliders and selects use the arrows themselves.
      if (active && (active.getAttribute("type") === "range" || active.tagName === "SELECT")) return;

      const inNav = !!active && !!active.closest("nav");
      if (inNav && dir === "left") { e.preventDefault(); e.stopImmediatePropagation(); return; } // nothing left of the rail
      const dialog = document.querySelector<HTMLElement>('[role="dialog"], [aria-modal="true"]');
      // In the rail, up/down stay in the rail; right goes into the page.
      const scope: ParentNode = dialog ?? (inNav && dir !== "right" ? active!.closest("nav")! : inNav ? document.querySelector("main")! : document);
      let from: DOMRect;
      if (active && active !== document.body && scope.contains?.(active) !== false && usable(active)) from = active.getBoundingClientRect();
      else {
        const first = (scope as ParentNode).querySelector<HTMLElement>("main [data-autofocus], main a[href], main button:not([disabled])") ?? (scope as ParentNode).querySelector<HTMLElement>(FOCUSABLE);
        if (first) { focusEl(first); e.preventDefault(); e.stopImmediatePropagation(); }
        return;
      }
      const next = pick(from, scope, active, dir);
      e.preventDefault();
      e.stopImmediatePropagation();
      if (next) focusEl(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tv, pathname, navigate]);
}
