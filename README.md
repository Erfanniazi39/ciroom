# CiRoom

A local-first, Netflix/Plex-style media center for your own movie and series folders.
It only ever **reads** your media; it never moves, renames or deletes files.

**Status: Stage 1** is a complete UI prototype running on mock data that mirrors the real library.
The full product and technical spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Run the prototype

```bash
npm install
npm run dev        # → http://localhost:1420
npm run build      # type-check + production build
```

Things to try:
- **Ctrl+K** or **/** opens global search ("breaking", "2019", "pilot").
- **Play / Resume** opens the Now Playing bar. Playback is simulated at 20× speed, and progress, Continue Watching and the Up Next countdown all update live.
- **Movies / Series** have filters and sort. They're stored in the URL, so Back restores them.
- **Library** has a simulated scan and the *Needs attention* queue (built from the real edge cases in this library).

## Structure

```
src/
  api/          single data-access layer (mock now → Tauri invoke() in Stage 2)
  components/   reusable UI (PosterCard, Row, Hero, DetailHero, EpisodeRow, SearchPalette, …)
  pages/        screens
  store/        zustand: library cache, user state (favorites/progress), player session
  lib/          pure logic: next-up, continue watching, recommendations, formatting, artwork
  types/        domain types mirroring the SQLite schema
  data/mock.ts  Stage 1 fixtures (deleted once the backend exists)
```

## Next stages (see SPEC §8)
2. Tauri + Rust scanner + SQLite
3. mpv playback over JSON IPC
4. TMDB metadata
5. Polish and packaging

Prerequisites for Stage 2 on Linux (not installed yet):
```bash
curl https://sh.rustup.rs -sSf | sh
sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev mpv
```
