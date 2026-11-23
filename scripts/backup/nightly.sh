#!/bin/bash
# Noční záloha Supabase. Spouští ji launchd (com.alphatrade.supabase-backup), instaluje
# scripts/backup/install-nightly.sh. Běží z kopie skriptů v ~/Library/Application Support:
# launchd úloha nesmí číst ~/Documents (macOS TCC), takže tam není ani repo, ani zálohy.
#
# launchd ji spouští KAŽDOU HODINU (v :30) a skript sám rozhodne, jestli je čas:
# - cíl je jedna záloha denně, nejraději v noci (3:00–7:00);
# - MacBook v noci na baterii spí a budí se jen na pár sekund (DarkWake) — v takovém
#   probuzení se záloha nespouští (21.–23. 11. 2026 jí uprostřed práce padalo spojení).
#   Zmeškanou noc dožene první celá hodina, kdy je Mac opravdu vzhůru;
# - v obchodní době (Po–Pá 8:00–22:30) se dohání jen tehdy, když je poslední kompletní
#   záloha starší než 44 h; jinak počká na večer;
# - během zálohy drží Mac vzhůru (`caffeinate`), aby neusnul nečinností;
# - selhání nebo neúplná záloha (Storage) = upozornění v Centru oznámení macOS, nejvýš
#   jednou za 12 h;
# - každý běh zálohy = řádek v nightly-runs.log, celý výpis v nightly.log (posledních 5000 řádků).
set -uo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

KEEP_NIGHTLY="${BACKUP_NIGHTLY_KEEP:-3}"
mkdir -p "$BACKUP_ROOT"
LOG="$BACKUP_ROOT/nightly.log"
RUNS="$BACKUP_ROOT/nightly-runs.log"

notify() {
  [ "${BACKUP_NO_NOTIFY:-0}" != 1 ] || return 0 # zkoušky: bez oznámení v macOS
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

# Dnešní záloha už je → hodinové spuštění končí potichu.
MIN_AGE_H="${BACKUP_NIGHTLY_MIN_AGE_H:-20}"
# Mimo noční okno se dohání až po této době (ať se čas zálohy neposouvá každý den dřív).
CATCH_UP_AGE_H="${BACKUP_NIGHTLY_CATCH_UP_AGE_H:-26}"
# V obchodní době se dohání až po této době.
OVERDUE_AGE_H="${BACKUP_NIGHTLY_OVERDUE_AGE_H:-44}"
STAMPS="$BACKUP_ROOT/.nightly-state"
mkdir -p "$STAMPS"

# Plné probuzení má schopnost „Graphics“; krátké noční probuzení (DarkWake) ne.
# Neznámý výstup pmset zálohu neblokuje.
fully_awake() {
  local state
  state="$("${BACKUP_PMSET:-/usr/bin/pmset}" -g systemstate 2>/dev/null || true)"
  case "$state" in
    *Capabilities*) printf '%s' "$state" | grep -q 'Graphics' ;;
    *) return 0 ;;
  esac
}
night_window() {
  local hour=$((10#$(${BACKUP_DATE:-date} +%H)))
  [ "$hour" -ge 3 ] && [ "$hour" -lt 7 ]
}
# Jednou za $2 hodin (razítko $1): vrací 0, když je čas, a razítko obnoví.
once_per_hours() {
  local stamp="$STAMPS/$1" now last
  now="$(date +%s)"
  last="$(cat "$stamp" 2>/dev/null || echo 0)"
  [ $((now - last)) -ge $(($2 * 3600)) ] || return 1
  printf '%s\n' "$now" > "$stamp"
}
notify_limited() { if once_per_hours notified 12; then notify "$1"; fi; }

AGE="$(latest_age_h)"
# Jednorázové vynucení (install-nightly.sh --run-now): soubor se spotřebuje.
FORCE=0
if [ -e "$STAMPS/force-once" ]; then rm -f "$STAMPS/force-once"; FORCE=1; fi
if [ "$FORCE" != 1 ]; then
  [ "$AGE" -ge "$MIN_AGE_H" ] || exit 0
  if ! fully_awake; then
    # Mac spí (krátké probuzení): zkusí se znovu za hodinu, až bude vzhůru.
    if once_per_hours skip-asleep 24; then record SKIP "Mac spí, poslední záloha před $AGE h — dožene se, až bude vzhůru"; fi
    exit 0
  fi
  night_window || [ "$AGE" -ge "$CATCH_UP_AGE_H" ] || exit 0
  if trading_time && [ "$AGE" -lt "$OVERDUE_AGE_H" ]; then
    if once_per_hours skip-trading 24; then record SKIP "obchodní doba, poslední záloha před $AGE h — dožene se večer"; fi
    exit 0
  fi
fi
BEFORE="$(latest_backup)"

touch "$LOG"
FROM_LINE=$(($(wc -l < "$LOG") + 1))
{
  printf '\n===== %s noční záloha (%s) =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(cat "$HERE/../../installed-from.txt" 2>/dev/null || echo '?')"
  # caffeinate: Mac během zálohy neusne nečinností (zavřené víko na baterii ho uspí i tak → doženeme později).
  # --force: o obchodní době už rozhodl tento skript (dohání se jen zastaralá záloha nebo vynucený běh).
  /usr/bin/caffeinate -i -m "$HERE/../backup-supabase.sh" --no-git --keep "$KEEP_NIGHTLY" --force
} >> "$LOG" 2>&1
RC=$?
sleep 1 # tee uvnitř backup-supabase.sh dopisuje výstup po jeho skončení

AFTER="$(latest_backup)"
case "$RC" in
  0) record OK "$(basename "$AFTER")" ;;
  2) if [ "$AFTER" != "$BEFORE" ]; then
       record PARTIAL "$(basename "$AFTER") — Storage neúplný"
       notify_limited "Databáze zálohovaná, ale soubory ze Storage ne celé. Detail v $LOG"
     else
       # Kód 2 bez nové zálohy = spadlo spojení s databází (psql), ne neúplný Storage.
       record FAIL "kód 2: spojení s databází spadlo, nová záloha nevznikla (poslední před $AGE h)"
       notify_limited "Záloha selhala: spojení s databází spadlo. Zkusí se znovu za hodinu."
     fi ;;
  *) REASON="$(tail -n +"$FROM_LINE" "$LOG" | grep '^STOP:' | tail -1 | cut -c7-)"
     record FAIL "kód $RC: ${REASON:-viz nightly.log}"
     notify_limited "Záloha selhala: ${REASON:-kód $RC, viz $LOG}. Zkusí se znovu za hodinu." ;;
esac

# Rozpracované adresáře po selhání (jen logy) starší než týden.
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '*.partial' -mtime +7 -exec rm -rf {} + 2>/dev/null || true

tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit "$RC"
