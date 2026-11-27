# Functional and end-to-end tests

Three layers, same runner (`node --test`) as the existing tests:

| Command | What runs | Needs |
|---|---|---|
| `npm test` | the existing unit/server tests in `tests/*.test.js` | ffmpeg for a few |
| `npm run test:functional` | `tests/functional/*.test.js`: the real server on a synthetic library | ffmpeg; mpv for `mpv.test.js` and part of `remote.test.js` (skipped without it); a private LAN address for `party`/`remote` |
| `npm run test:e2e` | `tests/e2e/*.test.js`: the built app in headless Chrome, driven like a user | `npm run build`, ffmpeg, Chrome/Chromium, mpv for journey 3 and D-18 |
| `npm run test:all` | all of the above | all of the above |

One file: `node --test tests/functional/library.test.js`. One test or scenario: add
`--test-name-pattern="journey 3"`. Spec-style output: add `--test-reporter=spec`.

## Rules these tests keep

- Never the user's library, data, app or mpv: every server gets a scratch media folder (`tests/fixtures/media.js`),
  its own data/cache folders, its own `XDG_RUNTIME_DIR` (so mpv's control socket is private) and a random port.
- mpv is the real mpv, but started through a wrapper with `--vo=null --ao=null --fullscreen=no`: no window, no sound.
- Chrome runs headless with a fresh profile in a scratch folder, muted, without a proxy.
- Nothing goes online. TMDB, TMDB images and the IMDb dataset are answered inside the test server by
  `tmdb-mock.js` (loaded with `node --import`); that is the only mocked dependency.
- Known defects are tests marked `{ todo: "D-xx" }`: they assert the expected behaviour, are reported as failing
  "todo" tests, and don't fail the run. When a defect is fixed, its test passes; remove the `todo` then.

## Files

| File | Area |
|---|---|
| `env.js` | start/stop/restart a real server on a synthetic library; user-state helpers |
| `tmdb-mock.js` | the TMDB/IMDb stand-in |
| `tsload.js` | loads front-end TypeScript (src/…) in Node through esbuild, for logic tests |
| `library.test.js` | scanning, rescans, stable ids, user data kept, unusual names, drive unplugged, library folder change |
| `metadata.test.js` | TMDB matching, manual (locked) matches, series episodes, IMDb ratings, trailers, artwork |
| `playback.test.js` | probe / stream / seek points / audio tracks / levelling / every subtitle kind / missing and broken files |
| `mpv.test.js` | the full player with the real mpv |
| `persistence.test.js` | user data and settings across clean and crashed restarts, backups |
| `logic.test.js` | next up, next episode, continue watching, watched rules, subtitle choice, health report |
| `party.test.js` | watch party protocol: invite, join, sync, chat, guest controls, episode change, reconnect, revoke |
| `remote.test.js` | phone remote: pairing rules, commands to the window and to mpv, removing a phone |
| `../e2e/browser.js` | the headless-Chrome driver |
| `../e2e/journeys.test.js` | user journeys 1–9 in the real app |
| `../e2e/party-journey.test.js` | host and guest in two browsers |
