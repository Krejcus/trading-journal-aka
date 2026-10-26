#!/bin/bash
# Noční záloha Supabase. Spouští ji launchd (com.alphatrade.supabase-backup), instaluje
# scripts/backup/install-nightly.sh. Běží z kopie skriptů v ~/Library/Application Support:
# launchd úloha nesmí číst ~/Documents (macOS TCC), takže tam není ani repo, ani zálohy.
#
# - v obchodní době (Mac se probudil až ráno) zálohu přeskočí; upozorní jen tehdy, když
#   je poslední kompletní záloha starší než 2 dny;
# - selhání nebo neúplná záloha (Storage) = upozornění v Centru oznámení macOS;
# - každý běh = řádek v nightly-runs.log, celý výpis v nightly.log (posledních 5000 řádků).
set -uo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

KEEP_NIGHTLY="${BACKUP_NIGHTLY_KEEP:-3}"
mkdir -p "$BACKUP_ROOT"
LOG="$BACKUP_ROOT/nightly.log"
RUNS="$BACKUP_ROOT/nightly-runs.log"

notify() {
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "AlphaTrade záloha"' \
    -e 'end run' "$1" >/dev/null 2>&1 || true
}
record() { printf '%s\t%s\t%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$1" "$2" >> "$RUNS"; }
latest_age_h() {
  local last
  last="$(latest_backup)"
  [ -n "$last" ] || { echo 9999; return; }
  echo $(( ($(date -u +%s) - $(date -j -u -f %Y%m%dT%H%M%SZ "$(basename "$last")" +%s)) / 3600 ))
}

if trading_time; then
  AGE="$(latest_age_h)"
  record SKIP "obchodní doba, poslední záloha před $AGE h"
  [ "$AGE" -lt 48 ] || notify "Noční záloha se nespustila a poslední je stará $AGE h. Spusť ./scripts/backup-supabase.sh večer."
  exit 0
fi

touch "$LOG"
FROM_LINE=$(($(wc -l < "$LOG") + 1))
{
  printf '\n===== %s noční záloha (%s) =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(cat "$HERE/../../installed-from.txt" 2>/dev/null || echo '?')"
  "$HERE/../backup-supabase.sh" --no-git --keep "$KEEP_NIGHTLY"
} >> "$LOG" 2>&1
RC=$?
sleep 1 # tee uvnitř backup-supabase.sh dopisuje výstup po jeho skončení

case "$RC" in
  0) record OK "$(basename "$(latest_backup)")" ;;
  2) record PARTIAL "$(basename "$(latest_backup)") — Storage neúplný"
     notify "Databáze zálohovaná, ale soubory ze Storage ne celé. Detail v $LOG" ;;
  *) REASON="$(tail -n +"$FROM_LINE" "$LOG" | grep '^STOP:' | tail -1 | cut -c7-)"
     record FAIL "kód $RC: ${REASON:-viz nightly.log}"
     notify "Noční záloha selhala: ${REASON:-kód $RC, viz $LOG}" ;;
esac

tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit "$RC"
