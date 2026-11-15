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
import { useSettings } from "@/store/settings";
import { useUser, type SubPref } from "@/store/user";
import { getWebController } from "@/store/webControl";

interface Cmd { cmd: string; value?: number; id?: string; fromStart?: boolean; pref?: SubPref; position?: number; duration?: number; watched?: number; at?: number }

/** Movie id, or the series id of an episode: what watch time and subtitle choices are kept under. Null for an unknown id. */
function titleIdOf(id: string): string | null {
  const lib = useLibrary.getState().data;
  if (!lib) return null;
  if (lib.movies.some((m) => m.id === id)) return id;
  return findEpisode(lib, id)?.series.id ?? null;
}

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
        case "progress": {
          // Watched on the phone: the phone never writes to the database itself (this window owns it).
          if (!c.id || !Number.isFinite(c.position) || !Number.isFinite(c.duration)) break;
          const title = titleIdOf(c.id);
          if (!title) break;
          const u = useUser.getState();
          // A late save from the phone must never rewind something the PC saved after the phone's report.
          if (!((u.progress[c.id]?.updatedAt ?? 0) > (c.at ?? Date.now()))) u.savePosition(c.id, c.position!, c.duration!);
          // One live report is at most 120 s; a hand-over of what was watched while this window was closed can add up to 12 h.
          if (Number.isFinite(c.watched) && c.watched! > 0 && c.watched! <= 43200) u.addWatchTime(title, c.watched!);
          break;
        }
        case "subPref": {
          const title = c.id ? titleIdOf(c.id) : null;
          const p = c.pref;
          if (title && p && (p.off === true || (typeof p.name === "string" && (p.language === null || typeof p.language === "string")))) useUser.getState().setSubPref(title, p);
          break;
        }
        case "stop":
          usePlayback.getState().close();
          if (location.hash.startsWith("#/watch/")) navigate("/");
          break;
        case "play": {
          if (!c.id) break;
          const lib = useLibrary.getState().data;
          if (!lib || !(lib.movies.some((m) => m.id === c.id) || findEpisode(lib, c.id))) break;
          if (usePlayer.getState().current) usePlayer.getState().stop();
          // Already on this video (e.g. paused by "Continue on phone", then "Send to PC"): the route doesn't change, so
          // jump to the position the phone just saved and carry on instead of staying where the PC had paused.
          if (!c.fromStart && ctl && usePlayback.getState().session?.id === c.id) {
            const saved = useUser.getState().progress[c.id];
            if (saved && saved.position > 1) ctl.seekTo(saved.position); // the phone just saved it (even on an already-watched episode)
            if (ctl.getState().paused) ctl.toggle();
            break;
          }
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
      const user = JSON.stringify({ progress: u.progress, favorites: u.favorites, subPrefs: u.subPrefs, audioPrefs: u.audioPrefs, prefs: { subtitleLanguages: useSettings.getState().subtitleLanguages, subtitlesDefault: useSettings.getState().subtitlesDefault } });
      if (user !== lastUser) { lastUser = user; body.user = JSON.parse(user); }
      fetch("/api/remote/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    }
    report();
    const t = window.setInterval(report, 1000);
    return () => { alive = false; es.close(); window.clearInterval(t); };
  }, [navigate]);
}
