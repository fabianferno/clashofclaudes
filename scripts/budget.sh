#!/bin/sh
# Measure the performance budgets (docs/verification/plan-2-village.md).
#   budget.sh mem          physical footprint (what Activity Monitor shows) of the app + its WebKit helpers
#   budget.sh cpu [secs]   average CPU, % of one core, of the same processes over secs (default 20)
#   budget.sh cold         launch the debug binary (needs `pnpm dev` serving :1420) and time until the
#                          driver reports the village visible: !document.hidden, ticker running, entities > 0
# The app's WebKit helpers (WebContent, GPU, Networking) are XPC services, not children: they are the
# com.apple.WebKit.* processes started within 60 s after the app. Start no other WebKit app meanwhile.
set -eu
here=$(dirname "$0")

case "${1:-}" in mem|cpu) pgrep -x clash-of-claudes >/dev/null || { echo "clash-of-claudes is not running" >&2; exit 1; } ;; esac

pids() {
  app=$(pgrep -x clash-of-claudes | head -1)
  ps -axo pid=,lstart=,comm= | python3 -c '
import sys, datetime
app = sys.argv[1]; rows = []
for line in sys.stdin:
    p = line.split(None, 6)
    rows.append((p[0], datetime.datetime.strptime(" ".join(p[1:6]), "%a %b %d %H:%M:%S %Y"), p[6] if len(p) > 6 else ""))
t0 = next(t for p, t, c in rows if p == app)
print(" ".join([app] + [p for p, t, c in rows if "com.apple.WebKit." in c and -2 <= (t - t0).total_seconds() <= 60]))
' "$app"
}

case "${1:-}" in
mem)
  args=""; for p in $(pids); do args="$args -p $p"; done
  footprint -f bytes $args 2>/dev/null | python3 -c '
import sys, re
for l in sys.stdin:
    m = re.match(r"^(\S+) \[(\d+)\]: 64-bit\s+Footprint: (\d+) B", l)
    if m: print("%-30s %6.0f MB" % (m.group(1) + " " + m.group(2), int(m.group(3)) / 1048576))
    m = re.match(r"^Summary Footprint: (\d+) B", l)
    if m: print("%-30s %6.0f MB" % ("TOTAL", int(m.group(1)) / 1048576))'
  ;;
cpu)
  list=$(pids | tr ' ' ','); n=${2:-20}
  secs() { ps -o time= -p "$list" | python3 -c '
import sys
t = 0.0
for v in sys.stdin.read().split():
    s = 0.0
    for part in v.split(":"): s = s * 60 + float(part)
    t += s
print(t)'; }
  c0=$(secs); t0=$(python3 -c 'import time; print(time.time())')
  i=0; while [ "$i" -lt "$n" ]; do ps -o %cpu= -p "$list" | awk '{s+=$1} END {print s}'; i=$((i+1)); sleep 1; done |
    awk '{s+=$1} END {printf "ps %%cpu, mean of %d 1-s samples: %.2f%%\n", NR, s/NR}'
  c1=$(secs); t1=$(python3 -c 'import time; print(time.time())')
  python3 -c "print('cpu time: %.2f s in %.1f s = %.2f%% of one core' % ($c1 - $c0, $t1 - $t0, 100 * ($c1 - $c0) / ($t1 - $t0)))"
  ;;
cold)
  f="$HOME/Library/Application Support/dev.clashofclaudes.app/driver.json"
  bin="$here/../src-tauri/target/debug/clash-of-claudes"
  rm -f "$f"
  t0=$(python3 -c 'import time; print(time.time())')
  COC_DRIVER=1 "$bin" >/dev/null 2>&1 &
  q='(()=>{const s=window.__cocDriver&&__cocDriver.scene(); return s&&!document.hidden&&s.running&&s.entities.length>0})()'
  # Short client timeout: an eval sent before the page has loaded is lost (the driver answers it after 10 s).
  until [ -s "$f" ] && [ "$(curl -s --max-time 0.25 --data-binary "$q" "http://127.0.0.1:$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$f")/eval/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$f")" 2>/dev/null)" = "true" ]; do
    if python3 -c "import sys, time; sys.exit(time.time() - $t0 < 30)"; then
      echo "village not visible after 30 s (screen locked or window covered?); app pid $!" >&2; exit 1
    fi
    sleep 0.05
  done
  python3 -c "import time; print('launch to village visible: %.2f s' % (time.time() - $t0))"
  echo "the app is still running (pid $!); quit it when done"
  ;;
*)
  sed -n '2,8p' "$0"; exit 2
  ;;
esac
