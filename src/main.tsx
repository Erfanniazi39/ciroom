import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { isRemoteClient } from "./components/MobileNav";
import RemoteApp from "./remote/RemoteApp";
import "./index.css";
import { useUser } from "./store/user";
import { useSettings } from "./store/settings";
import { whenHydrated } from "./lib/serverStorage";

// Opened from another device (a phone on the Wi-Fi): show the phone remote, not the PC interface.
// HashRouter: works under Tauri's custom protocol without server-side rewrites.
// The PC interface waits for progress/settings to load from CiRoom's database (a few ms) before drawing.
const ready = isRemoteClient() ? Promise.resolve() : Promise.all([whenHydrated(useUser), whenHydrated(useSettings)]);
ready.then(() => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isRemoteClient() ? (
      <RemoteApp />
    ) : (
      <HashRouter>
        <App />
      </HashRouter>
    )}
  </StrictMode>,
));
