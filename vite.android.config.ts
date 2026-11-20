import { defineConfig } from "vite";

// decodeURIComponent: the project path contains spaces ("Movies & Series").
const here = (p: string) => decodeURIComponent(new URL(p, import.meta.url).pathname);

// The Android app's bundled Connect page: its own small entry, so the desktop dist/ stays exactly as it was.
// Tauri's Android build (src-tauri/tauri.android.conf.json) packs dist-android/ into the APK.
export default defineConfig({
  root: here("./android-app"),
  base: "./",
  resolve: { alias: { "@": here("./src") } },
  build: { outDir: here("./dist-android"), emptyOutDir: true, target: "es2020" },
  clearScreen: false,
});
