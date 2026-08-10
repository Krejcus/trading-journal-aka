#!/bin/bash
# Installs the low-latency TradeCopia event collector as a persistent launchd job.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.alphatrade"
SOURCE_CONFIG="$CONFIG_DIR/tradecopia-sync.json"
FAST_CONFIG="$CONFIG_DIR/tradecopia-fast-events.json"
RUNTIME_DIR="$CONFIG_DIR/bin"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/com.alphatrade.tradecopia-fast-events.plist"
LOG="$CONFIG_DIR/tradecopia-fast-events-launchd.log"
NODE_BIN="$(command -v node || true)"
NOTIFY_URL="${TRADECOPIA_NOTIFY_URL:-https://alphatrade-mentor-15.vercel.app/api/tradecopia-events}"

if [ ! -x "$NODE_BIN" ]; then echo "CHYBA: node není v PATH."; exit 1; fi
if [ ! -f "$SOURCE_CONFIG" ]; then echo "CHYBA: chybí $SOURCE_CONFIG."; exit 1; fi

mkdir -p "$CONFIG_DIR" "$RUNTIME_DIR" "$LAUNCH_DIR"
chmod 700 "$CONFIG_DIR" "$RUNTIME_DIR"
install -m 700 "$SCRIPT_DIR/fast-events.mjs" "$RUNTIME_DIR/fast-events.mjs"
install -m 600 "$SCRIPT_DIR/fast-event-core.mjs" "$RUNTIME_DIR/fast-event-core.mjs"

jq --arg notifyUrl "$NOTIFY_URL" '{importToken, dbPath, notifyUrl: $notifyUrl}' "$SOURCE_CONFIG" > "$FAST_CONFIG.tmp"
chmod 600 "$FAST_CONFIG.tmp"
mv "$FAST_CONFIG.tmp" "$FAST_CONFIG"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.alphatrade.tradecopia-fast-events</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$RUNTIME_DIR/fast-events.mjs</string>
    <string>--watch</string><string>--interval=1000</string><string>--debounce=450</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF

plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/com.alphatrade.tradecopia-fast-events" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Fast event collector je aktivní. Log: $LOG"
