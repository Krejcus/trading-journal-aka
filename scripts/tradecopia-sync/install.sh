#!/bin/bash
# Instalace Tradecopia sync agenta na další Mac.
#
# Použití:
#   bash scripts/tradecopia-sync/install.sh
#
# Token najdeš na už zprovozněném Macu:
#   grep importToken ~/.alphatrade/tradecopia-sync.json
#
# Agenti na více strojích jsou bezpeční: server dedupuje podle business klíčů,
# takže stejný obchod poslaný dvakrát vznikne jen jednou.

set -euo pipefail

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  read -r -s -p "Import token (nebude vidět ani uložen v historii shellu): " TOKEN
  echo ""
fi
if [ -z "$TOKEN" ]; then
  echo "Chybí import token."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync.mjs"
DB_PATH="$HOME/Library/Application Support/Tradecopia/tradecopia-desktop-logs.db"
CONFIG_DIR="$HOME/.alphatrade"
CONFIG_PATH="$CONFIG_DIR/tradecopia-sync.json"
PLIST_PATH="$HOME/Library/LaunchAgents/com.alphatrade.tradecopia-sync.plist"
EDGE_URL="https://kopinlpdvjfgmvxydohk.supabase.co/functions/v1/import-trades"

if [ ! -f "$SYNC_SCRIPT" ]; then
  echo "CHYBA: sync.mjs nenalezen ($SYNC_SCRIPT)"
  exit 1
fi
if [ ! -f "$DB_PATH" ]; then
  echo "CHYBA: Tradecopia databáze nenalezena ($DB_PATH)"
  echo "Spusť Tradecopii aspoň jednou a zkus znovu."
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "CHYBA: node není v PATH. Nainstaluj Node.js a zkus znovu."
  exit 1
fi

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
cat > "$CONFIG_PATH" <<EOF
{
  "edgeUrl": "$EDGE_URL",
  "importToken": "$TOKEN",
  "dbPath": "$DB_PATH",
  "lastTradeId": 0,
  "lastOrderId": 0
}
EOF
chmod 600 "$CONFIG_PATH"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.alphatrade.tradecopia-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SYNC_SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$CONFIG_DIR/tradecopia-sync.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$CONFIG_DIR/tradecopia-sync.launchd.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.alphatrade.tradecopia-sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo "Hotovo. Agent běží každých 5 minut."
echo "Log: $CONFIG_DIR/tradecopia-sync.log"
echo ""
echo "První sync (může chvíli trvat, posílá historii):"
"$NODE_BIN" "$SYNC_SCRIPT"
