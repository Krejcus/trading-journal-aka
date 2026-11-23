#!/bin/bash
# Nainstaluje noční zálohu Supabase do launchd. Úloha se spouští každou hodinu v :30 a nightly.sh sám
# rozhodne, jestli je čas (jedna záloha denně, nejraději v noci; zmeškanou noc dožene, až je Mac vzhůru).
#
#   ./scripts/backup/install-nightly.sh              instalace, nebo aktualizace po změně skriptů zálohy
#   ./scripts/backup/install-nightly.sh --run-now    navíc hned jeden běh přes launchd (bez ohledu na čas)
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

# Údaje o připojení: z linku Supabase CLI v tomto repu; worktree je nemá (nejsou v gitu), pak z dosavadní instalace.
TEMP_SRC="$REPO/supabase/.temp"
[ -s "$TEMP_SRC/project-ref" ] || TEMP_SRC="$DEST/supabase/.temp"
for f in project-ref pooler-url; do
  [ -s "$TEMP_SRC/$f" ] || die "Chybí supabase/.temp/$f — nejdřív npx supabase link."
done
security find-generic-password -s "$KEYCHAIN_SERVICE" -a postgres >/dev/null 2>&1 \
  || die "Heslo k DB není v Keychainu (viz BACKUP_RESTORE.md → Jednorázové nastavení)."

mkdir -p "$DEST/scripts/backup" "$DEST/supabase/.temp" "$(dirname "$PLIST")" "$BACKUP_ROOT"
chmod 700 "$DEST"
install -m 700 "$REPO/scripts/backup-supabase.sh" "$DEST/scripts/backup-supabase.sh"
install -m 700 "$HERE/nightly.sh" "$DEST/scripts/backup/nightly.sh"
install -m 600 "$HERE/lib.sh" "$HERE/storage-sync.mjs" "$DEST/scripts/backup/"
if [ "$TEMP_SRC" != "$DEST/supabase/.temp" ]; then
  for f in project-ref pooler-url postgres-version; do
    if [ -f "$TEMP_SRC/$f" ]; then install -m 600 "$TEMP_SRC/$f" "$DEST/supabase/.temp/$f"; fi
  done
fi
printf '%s, nainstalováno %s\n' "$(git -C "$REPO" rev-parse --short HEAD)" "$(date '+%Y-%m-%d %H:%M')" > "$DEST/installed-from.txt"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DEST/scripts/backup/nightly.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Minute</key><integer>$MINUTE</integer></dict>
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
log "Noční záloha nainstalovaná: kontrola každou hodinu v :$(printf '%02d' "$MINUTE"), jedna záloha denně → $BACKUP_ROOT"
log "Přehled běhů: $BACKUP_ROOT/nightly-runs.log, výpis: $BACKUP_ROOT/nightly.log"

if [ "$RUN_NOW" = 1 ]; then
  # Jednorázově bez ohledu na stáří poslední zálohy a obchodní dobu.
  mkdir -p "$BACKUP_ROOT/.nightly-state" && touch "$BACKUP_ROOT/.nightly-state/force-once"
  launchctl kickstart "$DOMAIN/$LABEL"
  log "Běh spuštěný přes launchd (pár minut): tail -f \"$BACKUP_ROOT/nightly.log\""
fi
