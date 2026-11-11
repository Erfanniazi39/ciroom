/**
 * The PC window's side of the phone remote (dev/remote.js relays between the two):
 *  - reports what is playing (page player or the full player) and the user's progress, about once a second;
 *  - receives the phone's commands and applies them to the page player (mpv commands are handled by the bridge itself).
 * Runs only in this PC's own window, never in a browser opened from another device.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isRemoteClient } from "@/components/MobileNav";
import { episodeCode } from "@/lib/format";
import { findEpisode } from "@/lib/library";
import { useLibrary } from "@/store/library";
import { usePlayback } from "@/store/playback";
import { usePlayer } from "@/store/player";
import { useUser } from "@/store/user";
import { getWebController } from "@/store/webControl";

interface Cmd { cmd: string; value?: number; id?: string; fromStart?: boolean }

export function meta() {
  const full = usePlayer.getState().current;
  if (full) return { id: full.id, title: full.title, subtitle: full.subtitle ?? null };
  const id = usePlayback.getState().session?.id;
  const lib = useLibrary.getState().data;
  if (!id || !lib) return null;
  const movie = lib.movies.find((m) => m.id === id);
  if (movie) return { id, title: movie.year ? `${movie.title} (${movie.year})` : movie.title, subtitle: null };
  const ep = findEpisode(lib, id);
  return ep ? { id, title: ep.series.title, subtitle: `${episodeCode(ep.episode.season, ep.episode.number)} · ${ep.episode.title}` } : null;
}

export function useRemoteLink() {
  const navigate = useNavigate();
  useEffect(() => {
    if (isRemoteClient()) return;
    let alive = true;

    // ── Commands from the phone ────────────────────────────────────────────────────────
    const es = new EventSource("/api/remote/commands");
    es.onmessage = (ev) => {
      let c: Cmd;
      try { c = JSON.parse(ev.data); } catch { return; }
      const ctl = getWebController();
      switch (c.cmd) {
        case "toggle": ctl?.toggle(); break;
        case "seekBy": if (ctl && Number.isFinite(c.value)) ctl.seekTo(ctl.getState().position + c.value!); break;
        case "seekTo": if (ctl && Number.isFinite(c.value)) ctl.seekTo(c.value!); break;
        case "volume": if (ctl && Number.isFinite(c.value)) ctl.setVolume(Math.max(0, Math.min(130, c.value!))); break;
        case "mute": ctl?.toggleMute(); break;
        case "next": ctl?.next(); break;
        case "fullscreen": ctl?.toggleFullscreen(); break;
        case "subDelay": if (ctl && Number.isFinite(c.value)) ctl.setSubDelay(c.value!); break;
        case "subtitle": if (ctl && Number.isFinite(c.value)) ctl.setSub(c.value!); break;
        case "skip": ctl?.skip(); break;
        case "stop":
          usePlayback.getState().close();
          if (location.hash.startsWith("#/watch/")) navigate("/");
          break;
        case "play": {
          if (!c.id) break;
          const lib = useLibrary.getState().data;
          if (!lib || !(lib.movies.some((m) => m.id === c.id) || findEpisode(lib, c.id))) break;
          if (usePlayer.getState().current) usePlayer.getState().stop();
          navigate(`/watch/${c.id}${c.fromStart ? "?t=0" : ""}`);
          break;
        }
      }
      window.setTimeout(report, 150); // tell the phone the result right away
    };

    // ── Reports to the phone ───────────────────────────────────────────────────────────
    let lastUser = "";
    function report() {
      if (!alive) return;
      const ctl = getWebController();
      const m = meta();
      const body: Record<string, unknown> = { now: { meta: m, page: ctl && usePlayback.getState().session ? ctl.getState() : null } };
      const u = useUser.getState();
      const user = JSON.stringify({ progress: u.progress, favorites: u.favorites });
      if (user !== lastUser) { lastUser = user; body.user = JSON.parse(user); }
      fetch("/api/remote/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    }
    report();
    const t = window.setInterval(report, 1000);
    return () => { alive = false; es.close(); window.clearInterval(t); };
  }, [navigate]);
}
