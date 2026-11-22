#!/usr/bin/env bash
# Fails unless the AppImage carries the GStreamer plugins that video + sound need (0.1.5 shipped without them: video froze).
# Usage: scripts/check-appimage.sh <CiRoom.AppImage | squashfs-root folder>
set -euo pipefail
src="${1:?usage: check-appimage.sh <AppImage or extracted squashfs-root>}"
if [ -d "$src" ]; then root="$src"; else
  work="$(mktemp -d "${TMPDIR:-/tmp}/ciroom-check.XXXXXX")"; trap 'rm -rf "$work"' EXIT
  cp "$src" "$work/a.AppImage"; chmod +x "$work/a.AppImage"
  (cd "$work" && ./a.AppImage --appimage-extract >/dev/null)
  root="$work/squashfs-root"
fi
dir="$(find "$root" -type d -name gstreamer-1.0 ! -path '*/include/*' 2>/dev/null | while read -r d; do ls "$d"/libgst*.so >/dev/null 2>&1 && { echo "$d"; break; }; done)"
[ -n "$dir" ] || { echo "FAIL: no gstreamer-1.0 plugin folder in the AppImage (video would freeze)"; exit 1; }
missing=()
# One of each: demux/decode/play/sound, all needed for the page player.
for need in app playback isomp4 matroska audioconvert audioresample typefindfunctions autodetect volume libav; do
  [ -e "$dir/libgst$need.so" ] || missing+=("$need")
done
anyof() { for n in "$@"; do [ -e "$dir/libgst$n.so" ] && return 0; done; return 1; }
anyof videoconvertscale videoconvert || missing+=("videoconvert(scale)")
anyof pulseaudio pipewire || missing+=("pulseaudio or pipewire")
if [ ${#missing[@]} -gt 0 ]; then echo "FAIL: missing GStreamer plugins: ${missing[*]}"; exit 1; fi
echo "OK: $(ls "$dir"/libgst*.so | wc -l) GStreamer plugins in $dir"
