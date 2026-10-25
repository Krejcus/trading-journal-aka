#!/usr/bin/env bash
# Zkušební obnova zálohy ze scripts/backup-supabase.sh do DOČASNÉHO lokálního PostgreSQL.
# Na produkci ani na Supabase nesahá: server poslouchá jen na unix socketu v /tmp,
# po testu se zastaví a smaže.
#
#   ./scripts/restore-test-supabase.sh [adresář zálohy]   (výchozí: poslední kompletní záloha)
#   volby: --full   obnoví i data tradovate_journal_evidence (~4 GB na disku navíc)
#          --keep   nechá obnovenou DB běžet pro ruční dotazy (vypíše, jak se připojit a uklidit)
#
# Kontroluje: SHA-256 všech souborů, že pg_restore proběhne bez chyb, že každá tabulka
# má po obnově přesně tolik řádků, kolik jich je v archivu, a že sedí počet RLS politik.
# Bez --full se data evidence neobnovují, jejich počet řádků se ověří jen přečtením
# archivu (to už udělala záloha). Výsledek: <záloha>/restore-test-<čas>.txt (+ .log
# s výpisem pg_restore) a řádek v restore-tests.log.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/backup/lib.sh"

FULL=0; KEEP_SERVER=0; SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1 ;;
    --keep) KEEP_SERVER=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Neznámá volba $1 (viz --help)" ;;
    *) SRC="$1" ;;
  esac
  shift
done
SRC="${SRC:-$(latest_backup)}"
[ -n "$SRC" ] && [ -f "$SRC/SHA256SUMS" ] && [ -f "$SRC/db.dump" ] || die "Nenašel jsem kompletní zálohu (${SRC:-žádná v $BACKUP_ROOT})."
SRC="$(cd "$SRC" && pwd)"

# Data, která se bez --full neobnovují (mezerou oddělené schema.tabulka), a schémata,
# která mimo Supabase nedávají smysl: vault = šifrovaná tajemství, klíč drží Supabase.
SKIP_DATA="${RESTORE_SKIP_DATA:-public.tradovate_journal_evidence}"
[ "$FULL" = 1 ] && SKIP_DATA=""
DROP_SCHEMAS="${RESTORE_DROP_SCHEMAS:-vault}"

log "Záloha $SRC"
log "Ověřuji SHA-256…"
(cd "$SRC" && shasum -a 256 -c -q SHA256SUMS) || die "Kontrolní součty nesouhlasí — záloha je poškozená."

MAJOR="$(sed -n 's/^server_major=//p' "$SRC/manifest.txt")"
PG="$(find_pg_bin "${MAJOR:-17}")" || { pg_bin_hint "${MAJOR:-17}"; exit 1; }
for tool in initdb pg_ctl postgres psql pg_restore; do [ -x "$PG/$tool" ] || die "Chybí $PG/$tool"; done

WORKBASE="${RESTORE_WORKDIR:-$BACKUP_ROOT/.restore-test}"
mkdir -p "$WORKBASE"
EST_GB="$(awk -F'\t' -v skip=" $SKIP_DATA " 'index(skip, " " $1 "." $2 " ") == 0 { s += $7 } END { printf "%d", s * 1.3 / 1073741824 + 1 }' "$SRC/tables.tsv")"
FREE_GB="$(free_gb "$WORKBASE")"
log "Obnova zabere odhadem ${EST_GB} GB, volno ${FREE_GB} GB (minimum po obnově ${MIN_FREE_GB} GB)"
[ $((FREE_GB - EST_GB)) -ge "$MIN_FREE_GB" ] || die "Málo místa. Bez --full je obnova menší; jinak RESTORE_WORKDIR na jiný disk."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
W="$WORKBASE/$STAMP"
SOCK="$(mktemp -d /tmp/atrestore.XXXXXX)"   # krátká cesta: unix socket má limit ~100 znaků
mkdir -p "$W"
unset PGHOST PGPORT PGUSER PGDATABASE PGPASSFILE PGPASSWORD PGSSLMODE PGSSLROOTCERT PGSERVICE
export PGHOST="$SOCK" PGPORT=54329 PGUSER=atrestore
STARTED_SERVER=0
cleanup() {
  local rc=$?
  if [ "$KEEP_SERVER" = 1 ] && [ $rc -eq 0 ] && [ "$STARTED_SERVER" = 1 ]; then
    printf '\nObnovená DB běží:  "%s/psql" -h %s -p %s -U atrestore alphatrade_restore\n' "$PG" "$SOCK" "$PGPORT"
    printf 'Úklid:  "%s/pg_ctl" -D "%s/data" stop -m fast && rm -rf "%s" "%s"\n' "$PG" "$W" "$W" "$SOCK"
    return
  fi
  [ "$STARTED_SERVER" = 1 ] && "$PG/pg_ctl" -D "$W/data" stop -m fast > /dev/null 2>&1 || true
  rm -rf "$W" "$SOCK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Dočasný server -----------------------------------------------------------
# Vlastní superuser atrestore: roles.sql z Supabase obsahuje i „postgres“ (tam není superuser)
# a nesmí nám ho vzít. fsync a WAL jsou vypnuté, data jsou na jedno použití.
log "Zakládám dočasný PostgreSQL $("$PG/postgres" --version | sed -E 's/^[^0-9]*([0-9.]+).*/\1/') v $W"
"$PG/initdb" -D "$W/data" -U atrestore -A trust -E UTF8 --locale=en_US.UTF-8 --no-sync > "$W/initdb.log" 2>&1 \
  || { tail -5 "$W/initdb.log" >&2; die "initdb selhal"; }
"$PG/pg_ctl" -D "$W/data" -l "$W/server.log" -w -t 120 -o "-c listen_addresses='' -k $SOCK -p $PGPORT \
  -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c autovacuum=off \
  -c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=8GB -c maintenance_work_mem=512MB \
  -c max_locks_per_transaction=512" start > /dev/null \
  || { tail -20 "$W/server.log" >&2; die "Server nenastartoval"; }
STARTED_SERVER=1
psql_local() { "$PG/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_local -d postgres -c 'create database alphatrade_restore'

log "Role z roles.sql…"
# GRANT … GRANTED BY supabase_admin lokálně neprojde (supabase_admin tu nemá ADMIN OPTION),
# členství proto udělí náš superuser; jinak se roles.sql nahraje beze změny.
sed -E 's/ GRANTED BY "?supabase_admin"?;$/;/' "$SRC/roles.sql" > "$W/roles.sql"
"$PG/psql" -X -q -d postgres -f "$W/roles.sql" > "$W/roles.log" 2>&1 || true
ROLE_ERRORS="$(grep -c 'ERROR' "$W/roles.log" || true)"

# --- Výběr objektů k obnově ---------------------------------------------------
"$PG/pg_restore" --list "$SRC/db.dump" > "$W/full.list"
AVAILABLE=" $(psql_local -A -t -d postgres -c 'select string_agg(name, $$ $$) from pg_available_extensions') "
MISSING_EXT=""
for ext in $(awk '$4 == "EXTENSION" && $5 == "-" { print $6 }' "$W/full.list"); do
  case "$AVAILABLE" in *" $ext "*) ;; *) MISSING_EXT="$MISSING_EXT $ext" ;; esac
done
cp "$W/full.list" "$W/restore.list"
filter_out() { grep -v -E "$1" "$W/restore.list" > "$W/restore.tmp" || true; mv "$W/restore.tmp" "$W/restore.list"; }
for ext in $MISSING_EXT; do filter_out " EXTENSION (- )?$ext( |$)"; done
for schema in $DROP_SCHEMAS; do filter_out "^[0-9]+; [0-9]+ [0-9]+ ([A-Z]+ )+(- |- SCHEMA )?$schema "; done
for table in $SKIP_DATA; do filter_out " TABLE DATA ${table%%.*} ${table#*.} "; done
log "Obnovuji $(grep -c '^[0-9]' "$W/restore.list") z $(grep -c '^[0-9]' "$W/full.list") objektů archivu" \
    "(vynecháno: rozšíření${MISSING_EXT:- žádné}; schémata $DROP_SCHEMAS; data ${SKIP_DATA:-nic})"

# --- Obnova -------------------------------------------------------------------
T=$SECONDS
"$PG/pg_restore" -d alphatrade_restore -j 4 -L "$W/restore.list" "$SRC/db.dump" > "$W/restore.log" 2>&1 || true
RESTORE_ERRORS="$(grep -c '^pg_restore: error:' "$W/restore.log" || true)"
log "pg_restore doběhl za $((SECONDS - T)) s, chyb: $RESTORE_ERRORS"

# --- Kontrola: počty řádků proti archivu ---------------------------------------
cat > "$W/counts.sql" <<'EOF'
create function pg_temp.row_count(t text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from only ' || t into n; return n;
exception when others then return -1;
end $$;
create temp table expected (t text, n bigint);
\copy expected from 'table-rowcounts.tsv'
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
select t, n, pg_temp.row_count(t) from expected order by t;
EOF
(cd "$SRC" && psql_local -d alphatrade_restore -f "$W/counts.sql") > "$W/counts.tsv"
awk -F'\t' -v skip=" $SKIP_DATA " -v drop=" $DROP_SCHEMAS " '
  { schema = $1; sub(/\..*$/, "", schema) }
  NF != 3 { printf "%-60s  NEČITELNÝ ŘÁDEK VÝSTUPU\n", $0; bad++; next }
  index(drop, " " schema " ") { next }
  index(skip, " " $1 " ") { printf "%-60s %12s  jen archiv (bez --full)\n", $1, $2; skipped++; next }
  $3 == -1 { printf "%-60s %12s  CHYBÍ TABULKA\n", $1, $2; bad++; next }
  $3 != $2 { printf "%-60s %12s  NESOUHLASÍ: obnoveno %s\n", $1, $2, $3; bad++; next }
  { ok++; rows += $3 }
  END { printf "SUMMARY %d %d %d %d\n", ok + 0, bad + 0, skipped + 0, rows + 0 }' "$W/counts.tsv" > "$W/compare.txt"
read -r _ OK_TABLES BAD_TABLES SKIPPED_TABLES ROWS <<EOF
$(grep '^SUMMARY' "$W/compare.txt")
EOF
TOC_POLICIES="$(grep -c ' POLICY ' "$W/restore.list" || true)"
DB_POLICIES="$(psql_local -A -t -d alphatrade_restore -c 'select count(*) from pg_policies')"
AUTH_USERS="$(psql_local -A -t -d alphatrade_restore -c 'select count(*) from auth.users' 2>/dev/null || echo '?')"

RESULT=PASS
[ "$RESTORE_ERRORS" = 0 ] && [ "$BAD_TABLES" = 0 ] && [ "$OK_TABLES" -gt 0 ] && [ "$DB_POLICIES" = "$TOC_POLICIES" ] || RESULT=FAIL
REPORT="$SRC/restore-test-$STAMP.txt"
# Výpisy pg_restore a roles.sql zůstanou u zálohy i po smazání dočasného serveru.
{ echo "== pg_restore"; cat "$W/restore.log"; echo; echo "== roles.sql"; cat "$W/roles.log"; } > "$SRC/restore-test-$STAMP.log"
{
  echo "Zkušební obnova $STAMP: $RESULT"
  echo "záloha: $SRC ($(sed -n 's/^created_utc=//p' "$SRC/manifest.txt"))"
  echo "nástroje: $("$PG/pg_restore" --version)"
  echo "tabulky: $OK_TABLES souhlasí ($ROWS řádků), $BAD_TABLES nesouhlasí, $SKIPPED_TABLES jen z archivu"
  echo "chyby pg_restore: $RESTORE_ERRORS; chyby roles.sql: $ROLE_ERRORS"
  [ "$ROLE_ERRORS" = 0 ] || sed -E -n 's/^.*ERROR: +/  roles.sql: /p' "$W/roles.log" | sort | uniq -c | head -10
  echo "RLS politiky: $DB_POLICIES v DB / $TOC_POLICIES v archivu; auth.users: $AUTH_USERS"
  echo "vynecháno: rozšíření${MISSING_EXT:- žádné}; schémata $DROP_SCHEMAS; data ${SKIP_DATA:-nic}"
  echo
  grep -v '^SUMMARY' "$W/compare.txt" || true
  if [ "$RESTORE_ERRORS" != 0 ]; then echo; echo "Chyby pg_restore (celý výpis v restore-test-$STAMP.log):"; grep -A2 '^pg_restore: error:' "$W/restore.log" | head -60; fi
} > "$REPORT"
printf '%s\t%s\t%s\ttabulky %s/%s\tchyby %s\n' "$STAMP" "$RESULT" "$(basename "$SRC")" "$OK_TABLES" "$((OK_TABLES + BAD_TABLES))" "$RESTORE_ERRORS" >> "$BACKUP_ROOT/restore-tests.log"
cat "$REPORT"
[ "$RESULT" = PASS ] || { KEEP_SERVER=0; exit 1; }
