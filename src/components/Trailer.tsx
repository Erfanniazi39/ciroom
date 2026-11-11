/**
 * Trailers (TMDB → YouTube). The button appears only when TMDB lists a trailer for the title.
 *
 * It opens the trailer in the system web browser. An in-app YouTube player was tried (session 6) and
 * YouTube answers "Sign in to confirm you're not a bot" to the app's webview and to yt-dlp through this
 * PC's connection, while the user's own browser can sign in. Anything playing in CiRoom is paused first.
 */
import { useEffect, useState } from "react";
import { ExternalLink, Film } from "lucide-react";
import { metaApi, type Trailer } from "@/api/meta";
import { getWebController } from "@/store/webControl";
import { usePlayer } from "@/store/player";
import { Button } from "./ui";

const cache = new Map<string, Trailer | null>();

export function TrailerButton({ id }: { id: string }) {
  const [trailer, setTrailer] = useState<Trailer | null | undefined>(cache.get(id));
  const [state, setState] = useState<"idle" | "opening" | "opened" | "error">("idle");

  useEffect(() => {
    setState("idle");
    if (cache.has(id)) { setTrailer(cache.get(id)); return; }
    let alive = true;
    metaApi.trailer(id).then(
      (t) => { cache.set(id, t); if (alive) setTrailer(t); },
      () => alive && setTrailer(null), // no TMDB key / offline: no button (not cached, retried next visit)
    );
    return () => { alive = false; };
  }, [id]);

  if (!trailer) return null;

  const open = async () => {
    getWebController()?.pause(); // don't play two soundtracks at once
    const mpv = usePlayer.getState();
    if (mpv.current && !mpv.current.paused) mpv.togglePause();
    setState("opening");
    try {
      await metaApi.openTrailer(trailer.key);
      setState("opened");
      window.setTimeout(() => setState("idle"), 4000);
    } catch {
      setState("error");
    }
  };

  return (
    <Button size="lg" icon={<Film size={18} />} onClick={open} title={`${trailer.name}: opens in your web browser (YouTube)`}>
      {state === "opened" ? "Opened in browser" : state === "error" ? "Couldn't open browser" : "Trailer"}
      <ExternalLink size={14} className="opacity-50" />
    </Button>
  );
}
