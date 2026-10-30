#!/bin/sh
# Write a PNG of the village canvas to $1 (needs the app running with COC_DRIVER=1).
set -eu
[ $# -eq 1 ] || { echo "usage: snap.sh <out.png>" >&2; exit 2; }
dir=$(dirname "$0")
"$dir/drive.sh" '__cocDriver.snapshot()' | python3 -c 'import base64,json,sys
b=json.load(sys.stdin)
if not isinstance(b,str) or not b: sys.exit("empty snapshot (village canvas not registered yet)")
open(sys.argv[1],"wb").write(base64.b64decode(b))' "$1"
