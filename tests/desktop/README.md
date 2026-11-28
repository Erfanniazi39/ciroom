# Desktop end-to-end tests (the real packaged app)

These run the **real packaged CiRoom** (an AppImage, or an extracted `squashfs-root`) the way a user does, and check what
the user sees and hears. They complement `tests/e2e/` (the built UI in headless Chrome) and the API-level suites.

| Piece | How |
|---|---|
| Display | A private nested X server (Xephyr). The app's window, its fullscreen and mpv's window stay inside it; only the Xephyr window ("CiRoom tests") appears on the desktop. Don't type into it while tests run. |
| Input | Real mouse and keyboard events (XTest, `xinput.c`) at the element's position. No window manager: the helper gives the window the keyboard focus and releases stuck modifier keys before each input. |
| Page access | WebKitGTK's remote inspector (`WEBKIT_INSPECTOR_HTTP_SERVER`, works in release builds): evaluate JS, read the console. |
| Sound | A silent PipeWire sink. The page player and mpv play into it; `sink.level()` / `sink.tone()` record it (loudness, main frequency: tells audio tracks apart). |
| Isolation | Own HOME/XDG folders, own D-Bus session (else the single-instance plugin hands over to the user's CiRoom), own data/cache/library, own XDG_RUNTIME_DIR (mpv socket). Synthetic media from `tests/fixtures`. TMDB is the functional tests' mock, loaded into the app's bundled Node with `NODE_OPTIONS`. |
| Close / crash | Close = WM_DELETE_WINDOW (what the title bar's X sends). Crash = SIGKILL of the `ciroom` process. |

Files: `app.js` (driver), `common.js` (display + sink per file, evidence on failure, player helpers), `journeys.test.js`
(first install, watching a movie, resume after close/crash), `library.test.js` (details/artwork, My List, series + Up
Next, search, rescan), `player.test.js` (subtitles, audio, page player ↔ mpv, settings after restart), `devices.test.js`
(phone remote by QR code, watching on the phone, watch party, missing media, unplugged library, killed ffmpeg/mpv/server).
Known defects are `{ todo: "D-xx" }` tests: reported, not failing.

## Run

```bash
CIROOM_APP=/path/to/CiRoom.AppImage CIROOM_E2E_TMP=/tmp/cre2e npm run test:desktop
```

- `CIROOM_APP`: the AppImage or an extracted `squashfs-root` (default `~/Applications/CiRoom.AppImage`). To test a new
  build in the shipped engine, drop the new `usr/bin/ciroom` (patchelf rpath `$ORIGIN/../lib`), `dist/`, `server/`,
  `mpv/` into an extracted package (see project-knowledge-archive §10aw).
- `CIROOM_E2E_TMP`: scratch base folder. Keep it SHORT (mpv's socket path must stay under ~100 characters).
- `CIROOM_E2E_EVIDENCE`: where failure screenshots, page text, console and server log go.
- Needs: Xephyr, cc + libX11/libXtst headers, PipeWire (`pw-cli`, `pw-record`), `xwd`, ffmpeg, `dbus-run-session`,
  Google Chrome (phone / guest browser), python3 + OpenCV (QR decoding), mpv. About 25 minutes for everything.
- **Not for CI**: needs a desktop session (PipeWire, an X server to nest in).
