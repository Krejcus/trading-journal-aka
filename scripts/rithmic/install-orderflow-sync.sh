#!/bin/bash
# Nainstaluje automatické doplňování archivu order flow do launchd (jednou za hodinu, když je Mac vzhůru).
#
#   scripts/rithmic/install-orderflow-sync.sh             instalace, nebo aktualizace po změně skriptů
#   scripts/rithmic/install-orderflow-sync.sh --run-now   navíc hned jeden běh přes launchd
#   scripts/rithmic/install-orderflow-sync.sh --uninstall odebrat úlohu (archiv a stažená data zůstanou)
#
# launchd úloha nesmí číst ~/Documents (macOS TCC), proto se skripty zabalí (esbuild) do
# ~/Library/Application Support/AlphaTrade/orderflow-sync a dostanou config.json: systém a uživatel Rithmicu
# (z lucid.env), veřejná adresa a anon klíč Supabase (z .env.local) a složka souborů služby.
# Hesla a klíče zůstávají v Klíčence (Rithmic: alphatrade-rithmic-prop, archiv: alphatrade-orderflow-archive).
# Stahování z Rithmicu poběží JEN když služba neběží (bere si její zámek). Po změně skriptů spusť znovu.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL=com.alphatrade.orderflow-sync
DEST="$HOME/Library/Application Support/AlphaTrade/orderflow-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SERVICE_REPO="${ORDERFLOW_SERVICE_REPO:-$HOME/alphatrade-worktrees/rithmic}"
LUCID_ENV="$SERVICE_REPO/scripts/rithmic/results/lucid.env"
ENV_LOCAL="${ORDERFLOW_ENV_LOCAL:-$HOME/Documents/trading-journal-aka/.env.local}"
die() { echo "CHYBA: $*" >&2; exit 1; }

RUN_NOW=0
case "${1:-}" in
  "") ;;
  --run-now) RUN_NOW=1 ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; rm -rf "$DEST"
    echo "Doplňování archivu odinstalované (archiv a stažená data v Application Support zůstala)."; exit 0 ;;
  *) die "Neznámá volba $1 (--run-now, --uninstall)" ;;
esac

[ -f "$LUCID_ENV" ] || die "Chybí $LUCID_ENV (LUCID_USER)."
# shellcheck disable=SC1090
LUCID_USER="$(. "$LUCID_ENV"; printf '%s' "${LUCID_USER:-}")"
[ -n "$LUCID_USER" ] || die "V $LUCID_ENV chybí LUCID_USER."
[ -f "$ENV_LOCAL" ] || die "Chybí $ENV_LOCAL."
SUPABASE_URL="$(grep -E '^VITE_SUPABASE_URL=' "$ENV_LOCAL" | head -1 | cut -d= -f2- | tr -d '"'"'")"
ANON_KEY="$(grep -E '^VITE_SUPABASE_ANON_KEY=' "$ENV_LOCAL" | head -1 | cut -d= -f2- | tr -d '"'"'")"
[ -n "$SUPABASE_URL" ] && [ -n "$ANON_KEY" ] || die "V $ENV_LOCAL chybí VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY."
security find-generic-password -s alphatrade-orderflow-archive -w >/dev/null 2>&1 || die "Klíč archivu není v Klíčence — nejdřív orderFlowArchiveUpload.ts --set-key."
security find-generic-password -s alphatrade-rithmic-prop -w >/dev/null 2>&1 || die "Heslo Rithmicu (alphatrade-rithmic-prop) není v Klíčence."
NODE="$(command -v node)"; [ -x "$NODE" ] || die "Nenašel jsem node."
ESBUILD="$REPO/node_modules/.bin/esbuild"; [ -x "$ESBUILD" ] || die "Chybí $ESBUILD (npm ci)."

mkdir -p "$DEST" "$(dirname "$PLIST")"
chmod 700 "$DEST"
# CommonJS knihovny (ws) v ESM balíčku potřebují require.
BANNER="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
bundle() { "$ESBUILD" "$REPO/scripts/rithmic/$1" --bundle --platform=node --format=esm --target=node20 \
  --external:bufferutil --external:utf-8-validate --banner:js="$BANNER" --log-level=warning --outfile="$DEST/$2"; }
bundle orderFlowArchiveSync.ts orderflow-sync.mjs
bundle orderFlowBackfill.ts backfill.mjs
bundle orderFlowArchiveBuild.ts build.mjs
bundle orderFlowArchiveUpload.ts upload.mjs

LOG="$DEST/sync.log"
cat > "$DEST/config.json" <<EOF
{
  "system": "LucidTrading",
  "user": "$LUCID_USER",
  "supabaseUrl": "$SUPABASE_URL",
  "anonKey": "$ANON_KEY",
  "liveDir": "$SERVICE_REPO/scripts/rithmic/results",
  "log": "$LOG"
}
EOF
chmod 600 "$DEST/config.json"
printf '%s, nainstalováno %s\n' "$(git -C "$REPO" rev-parse --short HEAD)" "$(date '+%Y-%m-%d %H:%M')" > "$DEST/installed-from.txt"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/orderflow-sync.mjs</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict></plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Nainstalováno: $LABEL (každou hodinu; log $LOG)."
if [ "$RUN_NOW" = 1 ]; then launchctl kickstart -k "$DOMAIN/$LABEL"; echo "Spuštěn jeden běh — sleduj $LOG."; fi
