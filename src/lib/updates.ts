/**
 * In-app updates (installed app only). New versions are published on CiRoom's GitHub releases page and
 * signed; the app only installs an update whose signature matches the key built into it.
 * Checks quietly a minute after start and every 6 hours; Settings → Updates checks on demand.
 */
import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

type Status = "idle" | "checking" | "none" | "available" | "downloading" | "restarting" | "error";

interface UpdateState {
  status: Status;
  version: string | null; // the new version
  notes: string;
  progress: number; // 0..1 while downloading
  error: string | null;
  checkedAt: number | null;
}

/** The installed app (not the test version, not `npm run desktop`, not a browser or phone). */
export const canUpdate = () => !import.meta.env.DEV && !__CIROOM_DEV__ && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const useUpdates = create<UpdateState>(() => ({ status: "idle", version: null, notes: "", progress: 0, error: null, checkedAt: null }));

let pending: Update | null = null;

export async function checkForUpdate(quiet = false) {
  if (!canUpdate()) return;
  const s = useUpdates.getState().status;
  if (s === "checking" || s === "downloading" || s === "restarting") return;
  useUpdates.setState({ status: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check({ timeout: 30_000 });
    pending = u;
    useUpdates.setState(u
      ? { status: "available", version: u.version, notes: u.body ?? "", checkedAt: Date.now() }
      : { status: "none", checkedAt: Date.now() });
  } catch (e) {
    // A quiet background check that fails (offline, GitHub unreachable) just tries again later.
    useUpdates.setState(quiet ? { status: "idle" } : { status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export async function installUpdate() {
  if (!pending) return;
  useUpdates.setState({ status: "downloading", progress: 0, error: null });
  try {
    let total = 0, got = 0;
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") { got += ev.data.chunkLength; if (total) useUpdates.setState({ progress: got / total }); }
    });
    useUpdates.setState({ status: "restarting", progress: 1 });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useUpdates.setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Background checks (call once at start). */
export function startUpdateChecks() {
  if (!canUpdate()) return;
  window.setTimeout(() => checkForUpdate(true), 60_000);
  window.setInterval(() => checkForUpdate(true), 6 * 3600_000);
}

/** The running version (installed app), or null. */
export async function appVersion(): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try { const { getVersion } = await import("@tauri-apps/api/app"); return await getVersion(); } catch { return null; }
}
