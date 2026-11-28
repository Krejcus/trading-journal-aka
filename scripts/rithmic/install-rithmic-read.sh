#!/bin/zsh
# Služba Rithmicu „jen pro čtení“ jako launchd úloha: po přihlášení k Macu běží sama (ceny, upozornění,
# order flow pro grafy a telefon), po pádu ji launchd spustí znovu. Nikdy neobchoduje.
#
#   scripts/rithmic/install-rithmic-read.sh             instalace / aktualizace (spustí čtení)
#   scripts/rithmic/install-rithmic-read.sh --uninstall odebrat úlohu
#
# Obchod a zavírání dál přes scripts/rithmic/lucid.sh — ten čtení před startem uvolní a po skončení vrátí.
# Kód se spouští z checkoutu služby (~/alphatrade-worktrees/rithmic, stejná složka results jako lucid.sh);
# po aktualizaci checkoutu stačí úlohu restartovat (tenhle skript znovu). Mimo ~/Documents → bez TCC.
# Návrh a oponentura: docs/reviews/rithmic-service-no-terminal-design-20261128.md (fáze 1).
set -euo pipefail

LABEL=com.alphatrade.rithmic-read
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SERVICE_REPO="${RITHMIC_SERVICE_REPO:-$HOME/alphatrade-worktrees/rithmic}"
LOGDIR="$HOME/Library/Application Support/AlphaTrade/rithmic-read"
die() { echo "CHYBA: $*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Služba jen pro čtení odinstalovaná (obchod a zavírání dál přes lucid.sh)."
  exit 0
fi
[ -z "${1:-}" ] || die "Neznámá volba $1 (--uninstall)"

ENV_FILE="$SERVICE_REPO/scripts/rithmic/results/lucid.env"
[ -f "$ENV_FILE" ] || die "Chybí $ENV_FILE."
source "$ENV_FILE"
[ -n "${LUCID_USER:-}" ] && [ -n "${TAILSCALE_LOGIN:-}" ] || die "V $ENV_FILE chybí LUCID_USER nebo TAILSCALE_LOGIN."
LOADER="$SERVICE_REPO/node_modules/tsx/dist/loader.mjs"
[ -f "$LOADER" ] || die "Chybí $LOADER (npm ci v checkoutu služby)."
# Checkout musí znát rezervu rozpočtu pro čtení a zákaz uspání (jinak by čtení ujídalo rozpočet obchodu).
grep -q "RMS_READ_ONLY_WEEKLY_CAP" "$SERVICE_REPO/scripts/rithmic/devTradeServer.ts" \
  || die "Checkout služby ($SERVICE_REPO) je starší než rezerva rozpočtu pro čtení — nejdřív ho aktualizuj na main."
security find-generic-password -s alphatrade-rithmic-prop -w >/dev/null 2>&1 || die "Heslo Rithmicu (alphatrade-rithmic-prop) není v Klíčence."
NODE="$(command -v node)"; [ -x "$NODE" ] || die "Nenašel jsem node."
LOCK_PID=""
for f in "$HOME/Library/Application Support/AlphaTrade/rithmic"/service-*.lock(N); do LOCK_PID="$(cat "$f" 2>/dev/null || true)"; done
if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null && ! launchctl list "$LABEL" >/dev/null 2>&1; then
  die "Teď běží jiná služba (proces $LOCK_PID, nejspíš z lucid.sh) — ukonči ji a instalaci spusť znovu."
fi

mkdir -p "$LOGDIR" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--import</string><string>$LOADER</string>
    <string>scripts/rithmic/devTradeServer.ts</string>
    <string>--system</string><string>LucidTrading</string>
    <string>--user</string><string>$LUCID_USER</string>
    <string>--contract</string><string>MNQ</string>
    <string>--mobile</string>
    <string>--tailscale-login</string><string>$TAILSCALE_LOGIN</string>
    <string>--read-only</string>
    <string>--order-flow</string>
  </array>
  <key>WorkingDirectory</key><string>$SERVICE_REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>RITHMIC_DEV_ORIGINS</key><string>http://localhost:5273</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGDIR/service.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/service.log</string>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in {1..30}; do launchctl list "$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Nainstalováno: $LABEL — služba jen pro čtení běží (log $LOGDIR/service.log)."
echo "Obchod/zavírání: scripts/rithmic/lucid.sh (čtení uvolní a po skončení vrátí)."
