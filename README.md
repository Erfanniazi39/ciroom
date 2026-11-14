# CiRoom

A local-first, Netflix/Plex-style media center for your own movie and series folders.
It only ever **reads** your media; it never moves, renames or deletes files.

Desktop app for Linux and Windows (Tauri window + a bundled Node server). Playback uses mpv, with an
in-page player for the watch page, watch parties and the phone remote. Updates come from GitHub Releases.
The full product spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Run it

```bash
npm install
npm run dev-app    # the test version "CiRoom Dev": port 1430, its own copy of the data (.dev-data/)
npm run serve      # the standalone server alone (after npm run build) → http://127.0.0.1:1420
npm run dev        # the web UI only, with the server routes inside Vite
```

Needs `ffmpeg`, `ffprobe` and `mpv` on the PATH (Settings shows what is missing).

## Check it

```bash
npm run build      # type-check + production build + prebuilt watch-party guest page
npm test           # node --test tests/*.test.js
```

## Structure

```
src/              React app (pages, components, stores, the data-access layer in src/api)
  party/, remote/ the watch-party guest page and the phone remote page
server/
  index.js        standalone server: serves dist/ and all API routes
  lib/            the server's modules
    mpv-bridge.js   routes + mpv control          scanner.js, scan-worker.js   library scan (worker thread)
    stream.js       in-page streaming, thumbs     subtitles.js, subtitle-search.js, zip.js
    metadata.js, artwork-store.js   TMDB          intro.js, intro-worker.js    skip intro
    userdb.js       SQLite user data              remote.js, party.js          phone remote, watch party
    paths.js        data/cache folders            library-ids.json             title aliases + legacy ids
src-tauri/        Tauri shell (Rust): starts the server, updater, window
scripts/          release, test-data and guest-page build scripts
tests/            node:test suites
mpv/              mpv config and Lua scripts
```

## Releases

`npm run release -- "notes"` bumps the version, tags it and pushes; GitHub Actions builds the Linux AppImage and
the Windows installer.
