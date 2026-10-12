#!/usr/bin/env bash
# Měření iPhonu: ./scripts/ios/perf-measure.sh <App.app> <štítek> [počet-běhů]
# Odinstaluje a nainstaluje sestavení (přihlášení v Keychainu zůstane), pak
# opakovaně spustí appku studeně na Dashboard a na LIVE a uloží značky AT-PERF.
# Kopírku NIKDY nezapíná — ON měří jen ruční klepnutí uživatele během běhu.
set -euo pipefail
APP="$1"; LABEL="$2"; RUNS="${3:-3}"
UDID="${IPHONE_UDID:-00008110-0002098A1EDB801E}"
OUT="${PERF_OUT:-$HOME/alphatrade-build/perf}/$LABEL"
mkdir -p "$OUT"
grep -rlq kopinlpdvjfgmvxydohk "$APP/public/assets" || { echo "Sestavení nemá Supabase konfiguraci (.env.local)"; exit 1; }
xcrun devicectl list devices | grep "$UDID" | grep -q "available (paired)" || { echo "iPhone není dostupný"; exit 1; }
for attempt in 1 2 3; do xcrun devicectl device uninstall app --device "$UDID" app.alphatrade.native >/dev/null 2>&1 && break; sleep 3; done
xcrun devicectl device install app --device "$UDID" "$APP" >/dev/null
python3 -m pymobiledevice3 syslog live -m AT-PERF > "$OUT/syslog.txt" 2>/dev/null &
LOG_PID=$!
trap 'kill $LOG_PID 2>/dev/null || true' EXIT
sleep 3
launch() { xcrun devicectl device process launch --device "$UDID" --terminate-existing ${1:+--payload-url "$1"} app.alphatrade.native >/dev/null; }
# První spuštění po instalaci zahřeje WebKit a obnoví token; do výsledků nepočítat.
launch ""; sleep 20
for i in $(seq 1 "$RUNS"); do launch ""; sleep 20; done
for i in $(seq 1 "$RUNS"); do launch "alphatrade-native://live"; sleep 20; done
kill $LOG_PID 2>/dev/null || true
node "$(dirname "$0")/perf-report.mjs" "$OUT/syslog.txt" | tee "$OUT/report.txt"
