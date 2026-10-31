#!/usr/bin/env bash
# Builds Clash of Claudes for this Mac only (no DMG, no LTO; ~40 s cold, seconds after a small
# change), installs it to /Applications and opens it. If the app is running, waits for you to
# quit it (Cmd+Q, so running agents get the usual warning) before replacing it.
# Usage: scripts/install-local.sh [--no-open]
set -euo pipefail
cd "$(dirname "$0")/.."

OPEN=1
for a in "$@"; do
  case "$a" in
    --no-open) OPEN=0 ;;
    *) echo "unknown argument: $a (usage: scripts/install-local.sh [--no-open])" >&2; exit 2 ;;
  esac
done

APP_NAME="Clash of Claudes"
BUILT="src-tauri/target/local/bundle/macos/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

pnpm tauri build --bundles app -- --profile local

running() { pgrep -f "$DEST/Contents/MacOS" >/dev/null; }
if running; then
  echo "Quit $APP_NAME (Cmd+Q) to finish installing…"
  while running; do sleep 1; done
fi

rm -rf "$DEST"
ditto "$BUILT" "$DEST"
echo "Installed $DEST"
if [ "$OPEN" = 1 ]; then open "$DEST"; fi
