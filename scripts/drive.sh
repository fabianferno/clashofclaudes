#!/bin/sh
# Evaluate a JS expression in the running debug app (COC_DRIVER=1 pnpm tauri dev); prints JSON.
set -eu
f="$HOME/Library/Application Support/dev.clashofclaudes.app/driver.json"
port=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$f")
token=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$f")
curl -sS --max-time 15 --data-binary "$1" "http://127.0.0.1:$port/eval/$token"
echo
