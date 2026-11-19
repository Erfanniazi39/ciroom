#!/usr/bin/env bash
# Packaged playback smoke test: starts the built AppImage with a scratch library (one generated 20 s clip, H.264 + AAC),
# lets its page play the clip muted for 8 s and checks that the time really advanced. Exit 0 = video plays.
# Opens the CiRoom window for ~20 s (under xvfb-run if installed, so nothing shows). Needs ffmpeg and a free port 1420
# (close the installed CiRoom first). Usage: scripts/smoke-appimage.sh <CiRoom.AppImage>
set -euo pipefail
app="$(readlink -f "${1:?usage: smoke-appimage.sh <CiRoom.AppImage>}")"
command -v ffmpeg >/dev/null || { echo "ffmpeg is needed to make the test clip"; exit 2; }
if (exec 3<>/dev/tcp/127.0.0.1/1420) 2>/dev/null; then echo "Port 1420 is in use: close the installed CiRoom first."; exit 2; fi
work="$(mktemp -d "${TMPDIR:-/tmp}/ciroom-smoke.XXXXXX")"
pid=""
cleanup() { [ -n "$pid" ] && kill -- -"$pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/lib/Movies/Smoke Clip (2020)" "$work/lib/Series" "$work/data" "$work/cache"
ffmpeg -v error -f lavfi -i "testsrc=duration=20:size=640x360:rate=24" -f lavfi -i "sine=frequency=440:duration=20" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$work/lib/Movies/Smoke Clip (2020)/Smoke Clip (2020).mp4"
run=("$app"); command -v xvfb-run >/dev/null && run=(xvfb-run -a "$app")
CIROOM_SMOKE=1 CIROOM_MEDIA_ROOT="$work/lib" CIROOM_DATA_DIR="$work/data" CIROOM_CACHE_DIR="$work/cache" \
  setsid "${run[@]}" >"$work/app.log" 2>&1 &
pid=$!
for _ in $(seq 120); do [ -e "$work/data/smoke-result.json" ] && break; sleep 1; done
if [ ! -e "$work/data/smoke-result.json" ]; then echo "FAIL: no result after 120 s (the window or the player never started)"; tail -5 "$work/app.log"; exit 1; fi
cat "$work/data/smoke-result.json"; echo
grep -q '"ok":true' "$work/data/smoke-result.json" && { echo "OK: video plays in the packaged app"; exit 0; }
echo "FAIL: video did not play"; exit 1
