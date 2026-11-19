import { useLibrary } from "@/store/library";

/** Packaged-app smoke test (scripts/smoke-appimage.sh): only runs when the server was started with CIROOM_SMOKE=1. */
export async function runSmoke() {
  try { if (!(await fetch("/api/smoke")).ok) return; } catch { return; }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report = (ok: boolean, t: number, why = "") =>
    fetch("/api/smoke", { method: "POST", body: JSON.stringify({ ok, t, why }) }).catch(() => {});
  const until = async <T,>(get: () => T | undefined | null, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = get(); if (v) return v; }
  };
  const movie = await until(() => useLibrary.getState().data?.movies[0], 60000);
  if (!movie) return report(false, 0, "no movie in the library");
  location.hash = `#/watch/${movie.id}`;
  const video = await until(() => { const v = document.querySelector("video"); if (v) v.muted = true; return v; }, 30000);
  if (!video) return report(false, 0, "the player never appeared");
  await sleep(8000);
  const t = video.currentTime;
  report(t > 4 && !video.error, t, video.error ? `video error ${video.error.code}` : t > 4 ? "" : `stuck at ${t.toFixed(1)}s`);
}
