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
src-tauri/        Tauri shell (Rust): starts the server, updater, window; gen/android = the Android app's project
android-app/      the Android app's own first screen (Connect: QR / address, English + Persian, update notice)
scripts/          release, test-data and guest-page build scripts
tests/            node:test suites
mpv/              mpv config and Lua scripts
```

## Android app

A phone app for your own CiRoom: it controls the PC (remote), browses the library and **plays videos on the phone**.
It is a thin client: CiRoom has to be running on your PC, with **Phone remote** switched on (Settings → Phone remote),
and the phone must be on the same home Wi-Fi.

- **Install:** download `CiRoom_<version>_android-arm64.apk` from the latest [release](../../releases) on the phone and open
  it. Android asks once to allow **Install unknown apps** for the browser you used (Samsung: Settings → Apps → Chrome or
  Samsung Internet → Install unknown apps). The app is built for 64-bit ARM phones (almost every phone since 2017).
- **Connect:** on the PC open Settings → Phone remote → Pair a phone, then in the app tap **Scan QR code** (or type the PC's
  address and the 6-digit PIN). The app remembers the PC and opens it next time by itself.
- **Language:** the first screen follows the phone's language (English or Persian). The pages from the PC are in English.
- **Updates:** the first screen tells you when a newer release has an APK; **Download** opens it in the browser.
- **Build it yourself:** `npx tauri android build --apk --target aarch64` (needs the Android SDK/NDK, JDK 21 and the Rust
  target `aarch64-linux-android`). A release APK is signed with a key you provide through the `CIROOM_ANDROID_KEYSTORE`,
  `CIROOM_ANDROID_KEYSTORE_PASSWORD`, `CIROOM_ANDROID_KEY_ALIAS` and `CIROOM_ANDROID_KEY_PASSWORD` environment variables;
  without them the release APK is unsigned.

## Releases

`npm run release -- "notes"` bumps the version, tags it and pushes; GitHub Actions builds the Linux AppImage, the Windows installer and the signed Android APK.
