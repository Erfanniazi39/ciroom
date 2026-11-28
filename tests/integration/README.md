# Integration tests (component boundaries)

`npm run test:integration` runs `tests/integration/*.test.js`. These test what happens **between** parts of CiRoom:
the server and the programs it starts (ffmpeg, ffprobe, mpv), the server and its database/data folder, the scanner while
others read, the phone racing the full player, and the exact bytes the desktop shell and the Android app send. The
browser-side counterparts (window ↔ server across failures) are in `tests/e2e/integration.test.js` (`npm run test:e2e`).

Same kit and rules as `tests/functional/` (scratch library and data per server, real mpv without window/sound, nothing
online). Extra helpers in `procs.js`: process lookups scoped to one test server (`/proc`), stream and event-stream readers,
media fingerprints, read-only folders.

| File | Boundary | Needs |
|---|---|---|
| `lifecycle.test.js` | shell ↔ server start-up contract (raw ping + proof, port taken, stdin closed); clean stop vs crash with mpv and ffmpeg running; Android `pc_check` request | Linux; mpv + ffmpeg for half; a private LAN address for the Android test |
| `media-engines.test.js` | ffmpeg killed mid-stream, seek storms, deleted source, missing ffmpeg/mpv, mpv command bursts and crashes; media never modified | Linux, ffmpeg (mpv for the last group) |
| `persistence.test.js` | concurrent and interrupted database saves, user data vs settings, read-only data folder, pending positions handed to the window | not root (read-only tests) |
| `filesystem.test.js` | reads during a 1,500-movie rescan, changes mid-scan, symbolic links | — |
| `remote-race.test.js` | phone vs full player (one screen at a time) | mpv, a private LAN address |

Tests named `D-21`…`D-30` cover the defects found in testing round 2. All are fixed: no known defects are open, and these
tests must pass like any other.
