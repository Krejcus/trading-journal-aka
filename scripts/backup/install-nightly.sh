#!/bin/bash
# Nainstaluje noční zálohu Supabase do launchd (denně ve 3:30 místního času).
#
#   ./scripts/backup/install-nightly.sh              instalace, nebo aktualizace po změně skriptů zálohy
#   ./scripts/backup/install-nightly.sh --run-now    navíc hned jeden běh přes launchd (mimo obchodní dobu)
#   ./scripts/backup/install-nightly.sh --uninstall  odebrat úlohu i kopii skriptů (zálohy zůstanou)
#
# launchd úloha nesmí číst ~/Documents (macOS TCC: „Operation not permitted“), proto se
# skripty zálohy a údaje o připojení ze supabase/.temp (project ref, host poolera — bez
# hesla) kopírují do ~/Library/Application Support/AlphaTrade/supabase-backup. Heslo
# zůstává v Keychainu. Po každé změně skriptů v scripts/backup* spusť instalaci znovu.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib.sh"

LABEL=com.alphatrade.supabase-backup
DEST="$HOME/Library/Application Support/AlphaTrade/supabase-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
HOUR="${BACKUP_NIGHTLY_HOUR:-3}"
MINUTE="${BACKUP_NIGHTLY_MINUTE:-30}"

RUN_NOW=0
case "${1:-}" in
  "") ;;
  --run-now) RUN_NOW=1 ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; rm -rf "$DEST"
    log "Noční záloha odinstalovaná. Zálohy zůstaly v $BACKUP_ROOT."; exit 0 ;;
  *) die "Neznámá volba $1 (--run-now, --uninstall)" ;;
esac

for f in project-ref pooler-url; do
  [ -s "$REPO/supabase/.temp/$f" ] || die "Chybí supabase/.temp/$f — nejdřív npx supabase link."
done
security find-generic-password -s "$KEYCHAIN_SERVICE" -a postgres >/dev/null 2>&1 \
  || die "Heslo k DB není v Keychainu (viz BACKUP_RESTORE.md → Jednorázové nastavení)."

mkdir -p "$DEST/scripts/backup" "$DEST/supabase/.temp" "$(dirname "$PLIST")" "$BACKUP_ROOT"
chmod 700 "$DEST"
install -m 700 "$REPO/scripts/backup-supabase.sh" "$DEST/scripts/backup-supabase.sh"
install -m 700 "$HERE/nightly.sh" "$DEST/scripts/backup/nightly.sh"
install -m 600 "$HERE/lib.sh" "$HERE/storage-sync.mjs" "$DEST/scripts/backup/"
for f in project-ref pooler-url postgres-version; do
  if [ -f "$REPO/supabase/.temp/$f" ]; then install -m 600 "$REPO/supabase/.temp/$f" "$DEST/supabase/.temp/$f"; fi
done
printf '%s, nainstalováno %s\n' "$(git -C "$REPO" rev-parse --short HEAD)" "$(date '+%Y-%m-%d %H:%M')" > "$DEST/installed-from.txt"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DEST/scripts/backup/nightly.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>$DEST/launchd.log</string>
  <key>StandardErrorPath</key><string>$DEST/launchd.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict></plist>
EOF
plutil -lint -s "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for attempt in 1 2 3 4 5; do
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break
  [ "$attempt" -lt 5 ] || die "launchctl bootstrap selhal ($PLIST)."
  sleep 1
done
log "Noční záloha nainstalovaná: denně $HOUR:$(printf '%02d' "$MINUTE") → $BACKUP_ROOT"
log "Přehled běhů: $BACKUP_ROOT/nightly-runs.log, výpis: $BACKUP_ROOT/nightly.log"

if [ "$RUN_NOW" = 1 ]; then
  trading_time && die "Teď je obchodní doba — běh by se jen přeskočil. Zkus večer nebo o víkendu."
  launchctl kickstart "$DOMAIN/$LABEL"
  log "Běh spuštěný přes launchd (pár minut): tail -f \"$BACKUP_ROOT/nightly.log\""
fi
