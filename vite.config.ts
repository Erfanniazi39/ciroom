import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error: plain JS dev plugin (no Node type package installed)
import { mpvBridge } from "./server/lib/mpv-bridge.js";

declare const process: { env: Record<string, string | undefined> }; // no Node type package installed

// decodeURIComponent: the project path contains spaces ("Movies & Series").
const here = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

// Port is fixed (1420; the test version uses 1430) so Tauri's devUrl can point at it.
export default defineConfig({
  plugins: [react(), mpvBridge(here("..").replace(/\/$/, ""))],
  resolve: { alias: { "@": here("./src") } },
  // Listens on the home network so a phone can reach the remote page, but server/lib/remote.js refuses every other
  // device until the user turns "Phone remote" on in Settings (and then only paired phones may call the API).
  // The firewall (ufw) still has to allow the port for the phone to get through.
  server: { port: Number(process.env.CIROOM_PORT) || 1420, strictPort: true, host: "0.0.0.0" },
  // The test version (npm run dev-app) shows an orange DEV badge.
  define: { __CIROOM_DEV__: JSON.stringify(process.env.CIROOM_DEV === "1") },
  clearScreen: false,
});
