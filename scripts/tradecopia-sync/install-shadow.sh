#!/bin/bash
# Installs the isolated Tradecopia shadow collector as a persistent launchd job.
# Requires the existing ~/.alphatrade/tradecopia-sync.json configuration.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/shadow-sync.mjs"
CORE_SCRIPT="$SCRIPT_DIR/shadow-core.mjs"
CONFIG_PATH="$HOME/.alphatrade/tradecopia-sync.json"
SHADOW_CONFIG_PATH="$HOME/.alphatrade/tradecopia-shadow-sync.json"
RUNTIME_DIR="$HOME/.alphatrade/bin"
RUNTIME_SYNC_SCRIPT="$RUNTIME_DIR/shadow-sync.mjs"
RUNTIME_CORE_SCRIPT="$RUNTIME_DIR/shadow-core.mjs"
PLIST_PATH="$HOME/Library/LaunchAgents/com.alphatrade.tradecopia-shadow-sync.plist"
LOG_PATH="$HOME/.alphatrade/tradecopia-shadow-launchd.log"
NODE_BIN="$(command -v node || true)"

if [ ! -x "$NODE_BIN" ]; then
  echo "CHYBA: node není v PATH."
  exit 1
fi
if [ ! -f "$SYNC_SCRIPT" ] || [ ! -f "$CORE_SCRIPT" ]; then
  echo "CHYBA: runtime soubory shadow collectoru nejsou kompletní."
  exit 1
fi
if [ ! -f "$CONFIG_PATH" ]; then
  echo "CHYBA: nejdřív nastav původní Tradecopia import ($CONFIG_PATH)."
  exit 1
fi

mkdir -p "$HOME/.alphatrade" "$RUNTIME_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.alphatrade"
chmod 700 "$RUNTIME_DIR"

# The launchd service must not depend on the currently checked-out git branch.
install -m 700 "$SYNC_SCRIPT" "$RUNTIME_SYNC_SCRIPT"
install -m 600 "$CORE_SCRIPT" "$RUNTIME_CORE_SCRIPT"

ANON_KEY="$(jq -r '.anonKey // empty' "$CONFIG_PATH")"
if [ -z "$ANON_KEY" ] && [ -f "$SCRIPT_DIR/../../.env.local" ]; then
  ANON_KEY="$(sed -n 's/^VITE_SUPABASE_ANON_KEY=["'\''"]\{0,1\}\([^"'\'']*\)["'\''"]\{0,1\}$/\1/p' "$SCRIPT_DIR/../../.env.local" | head -n 1)"
fi
if [ -z "$ANON_KEY" ]; then
  echo "CHYBA: chybí veřejný Supabase anon key."
  exit 1
fi

SHADOW_CONFIG_TEMP="$SHADOW_CONFIG_PATH.tmp"
jq --arg anonKey "$ANON_KEY" \
  '{edgeUrl, importToken, dbPath, anonKey: $anonKey}' \
  "$CONFIG_PATH" > "$SHADOW_CONFIG_TEMP"
chmod 600 "$SHADOW_CONFIG_TEMP"
mv "$SHADOW_CONFIG_TEMP" "$SHADOW_CONFIG_PATH"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.alphatrade.tradecopia-shadow-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$RUNTIME_SYNC_SCRIPT</string>
    <string>--watch</string>
    <string>--interval=5000</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST_PATH"
launchctl bootout "gui/$(id -u)/com.alphatrade.tradecopia-shadow-sync" 2>/dev/null || true
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  # launchd can briefly keep the old label reserved immediately after bootout.
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
fi

echo "Shadow collector běží každých 5 sekund a restartuje se po pádu."
echo "Log: $LOG_PATH"
