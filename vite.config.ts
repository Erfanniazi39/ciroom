import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error: plain JS dev plugin (no Node type package installed)
import { mpvBridge } from "./dev/mpv-bridge.js";

// decodeURIComponent: the project path contains spaces ("Movies & Series").
const here = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

// Port is fixed so Tauri's devUrl can point at it.
export default defineConfig({
  plugins: [react(), mpvBridge(here("..").replace(/\/$/, ""))],
  resolve: { alias: { "@": here("./src") } },
  // Listens on the home network so a phone can reach the remote page, but dev/remote.js refuses every other
  // device until the user turns "Phone remote" on in Settings (and then only paired phones may call the API).
  // The firewall (ufw) still has to allow the port for the phone to get through.
  server: { port: 1420, strictPort: true, host: "0.0.0.0" },
  clearScreen: false,
});
