/**
 * Fullscreen in the desktop app = the app WINDOW goes fullscreen (Tauri), and the page fills it with its own
 * "cover" mode. The browser Fullscreen API (`element.requestFullscreen()`) is NOT used there: the WebKitGTK
 * bundled in the Linux AppImage (built on Ubuntu 22.04) aborts the whole app when a page enters it (seen on
 * 0.2.4: exit 134 inside libwebkit2gtk, on Wayland and X11 alike). Browsers and the phone keep the web API.
 */
import { useEffect } from "react";
import { usePlayback } from "@/store/playback";
import { useSettings } from "@/store/settings";

/** True inside CiRoom's desktop window (not a browser, not the Android app). */
export const inDesktopShell = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !/Android/i.test(navigator.userAgent);

async function setWindowFullscreen(on: boolean) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch (e) {
    console.warn("[ciroom] window fullscreen failed", e);
  }
}

/** Keeps the desktop window fullscreen while the player covers the window or TV mode is on. Mounted once (App). */
export function useWindowFullscreen() {
  useEffect(() => {
    if (!inDesktopShell()) return;
    const wanted = () => usePlayback.getState().cover || useSettings.getState().tvMode;
    let applied = wanted(); // only react to changes: a saved TV mode doesn't force fullscreen at start (as before)
    const sync = () => {
      const w = wanted();
      if (w === applied) return;
      applied = w;
      void setWindowFullscreen(w);
    };
    const a = usePlayback.subscribe(sync);
    const b = useSettings.subscribe(sync);
    return () => { a(); b(); };
  }, []);
}
