#!/usr/bin/env bash
# Runs the app in development mode: frontend edits appear instantly (hot reload), Rust edits
# rebuild and relaunch the window on their own. Uses its own data folder so experiments never
# touch the installed app's workspaces; run `COC_DATA_DIR= scripts/dev.sh` to use the real data
# (quit the installed app first: two copies writing one state file will fight).
# The debug-only test driver is on, so Claude can click and screenshot the window
# (scripts/drive.sh, scripts/snap-dom.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
export COC_DATA_DIR="${COC_DATA_DIR-$HOME/Library/Application Support/dev.clashofclaudes.app.dev}"
export COC_DRIVER="${COC_DRIVER-1}"
exec pnpm tauri dev
