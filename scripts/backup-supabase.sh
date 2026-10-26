#!/usr/bin/env bash
# Logická záloha produkční Supabase do ~/AlphaTrade-backups/supabase/<UTC čas>/.
# Každou noc ji spouští launchd (scripts/backup/install-nightly.sh).
#
#   ./scripts/backup-supabase.sh            plná záloha (DB + soubory ze Storage + git bundle)
#   ./scripts/backup-supabase.sh --check    jen ověří nástroje, heslo, spojení a místo na disku
#   volby: --no-storage  --no-git  --keep N (výchozí 5 posledních záloh)
#          --force  spustit i v obchodní době (Po–Pá 8:00–22:30 pražského času)
#
# Obsah jedné zálohy:
#   db.dump               pg_dump -Fc celé databáze (schéma + data, všechna schémata)
#   roles.sql             role clusteru bez hesel (pg_dumpall --roles-only)
#   schema.sql            čitelné schéma vytažené z db.dump (pro diff a ruční obnovu)
#   db.toc.txt            seznam objektů v db.dump (zároveň důkaz, že archiv jde číst)
#   table-rowcounts.tsv   přesné počty řádků v archivu (celý archiv se při tom dekomprimuje)
#   tables.tsv            velikosti a odhady řádků tabulek v produkci v okamžiku zálohy
#   storage-objects.json  seznam objektů Storage z DB; storage-manifest.tsv = SHA-256 souborů
#   alphatrade-git.bundle všechny commitnuté větve repa (necommitnutá práce v něm není)
#   manifest.txt, SHA256SUMS, backup.log
# Soubory Storage leží ve sdíleném zrcadle storage-mirror/ (stahují se jen nové).
# Rozpracovaná záloha má příponu .partial; přejmenuje se až po všech kontrolách.
# Heslo k DB se čte jen z Keychainu (viz BACKUP_RESTORE.md), nikdy z repa.
# Zálohu spouštěj mimo obchodní hodiny: pg_dump čte celou DB (~5 GB) a zatíží ji na pár minut.
# Během zálohy nespouštěj migrace: DDL by čekal na zámek pg_dump a zablokoval tabulku i pro appku.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
. "$HERE/backup/lib.sh"

KEEP="${BACKUP_KEEP:-5}"; STORAGE=1; GIT=1; CHECK=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --no-storage) STORAGE=0 ;;
    --no-git) GIT=0 ;;
    --force) FORCE=1 ;;
    --keep) [ $# -ge 2 ] || die "--keep potřebuje číslo"; KEEP="$2"; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Neznámá volba $1 (viz --help)" ;;
  esac
  shift
done
case "$KEEP" in ''|*[!0-9]*) die "--keep musí být celé číslo ≥ 1" ;; esac
KEEP=$((10#$KEEP))
[ "$KEEP" -ge 1 ] || die "--keep musí být celé číslo ≥ 1"

TMP="$(mktemp -d /tmp/atbackup.XXXXXX)"
LOCK="$BACKUP_ROOT/.lock"
WORK=""
cleanup() {
  local rc=$?
  rm -rf "$TMP"
  [ -d "$LOCK" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
  if [ $rc -ne 0 ] && [ -n "$WORK" ] && [ -d "$WORK" ]; then
    # Velké soubory pryč hned (disk sdílí worker kopírky), logy zůstanou pro diagnostiku.
    rm -f "$WORK/db.dump" "$WORK/alphatrade-git.bundle"
    printf 'Záloha NEDOKONČENA (kód %s). Logy pro diagnostiku: %s\n' "$rc" "$WORK" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Nástroje, spojení, místo -------------------------------------------------
EXPECTED_MAJOR="$(sed -E 's/^([0-9]+).*/\1/' "$REPO/supabase/.temp/postgres-version" 2>/dev/null || echo 17)"
PG="$(find_pg_bin "$EXPECTED_MAJOR")" || { pg_bin_hint "$EXPECTED_MAJOR"; exit 1; }
for tool in pg_dump pg_dumpall pg_restore psql; do [ -x "$PG/$tool" ] || die "Chybí $PG/$tool"; done
load_prod_connection "$REPO"
setup_pgpass "$TMP"
psql_prod() { "$PG/psql" -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }

SERVER_NUM="$(psql_prod -c 'show server_version_num')" || die "Nepovedlo se připojit k $PGUSER@$PGHOST:$PGPORT (heslo, síť?)"
SERVER_MAJOR=$((SERVER_NUM / 10000))
PG_MAJOR="$("$PG/pg_dump" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
[ "$PG_MAJOR" -ge "$SERVER_MAJOR" ] || die "pg_dump $PG_MAJOR je starší než server $SERVER_MAJOR"
mkdir -p "$BACKUP_ROOT"
PREV="$(latest_backup)"
NEED_GB=3
[ -n "$PREV" ] && NEED_GB=$(( $(du -sk "$PREV" | awk '{print $1}') / 1048576 + 1 ))
FREE_GB="$(free_gb "$BACKUP_ROOT")"
log "Server PostgreSQL $SERVER_MAJOR ($PGHOST), nástroje $PG_MAJOR z $PG"
log "Volné místo ${FREE_GB} GB, záloha odhadem ${NEED_GB} GB, minimum po záloze ${MIN_FREE_GB} GB"
[ $((FREE_GB - NEED_GB)) -ge "$MIN_FREE_GB" ] || die "Málo místa na disku (worker kopírky zapisuje na stejný disk). Uvolni místo nebo sniž --keep."
TRADING_TIME=0
trading_time && TRADING_TIME=1
if [ "$CHECK" = 1 ]; then
  [ "$TRADING_TIME" = 0 ] || log "Pozor: teď je obchodní doba — ostrá záloha bude chtít --force."
  log "Kontrola OK — záloha by šla spustit."; exit 0
fi
[ "$TRADING_TIME" = 0 ] || [ "$FORCE" = 1 ] || die "Obchodní doba (Po–Pá 8:00–22:30 Praha): pg_dump by zatížil DB, přes kterou jede kopírka. Spusť večer/o víkendu, nebo s --force."

# --- Zámek a pracovní adresář -------------------------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  OTHER="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null; then die "Už běží jiná záloha (pid $OTHER)."; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
# Zámek je náš, takže žádný jiný běh neexistuje: zbytky nedokončených záloh pryč.
find "$BACKUP_ROOT/" -maxdepth 1 -name '*.partial' -exec rm -rf {} + 2>/dev/null || true

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="$BACKUP_ROOT/$STAMP"
WORK="$DIR.partial"
mkdir -p "$WORK"
exec > >(tee -a "$WORK/backup.log") 2>&1
STARTED=$SECONDS
log "Záloha $STAMP → $DIR"

# --- Stav produkce v okamžiku zálohy -----------------------------------------
psql_prod -F "$(printf '\t')" -c "
  select n.nspname, c.relname, format('%I.%I', n.nspname, c.relname), c.relkind,
         (exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))::int,
         c.reltuples::bigint, pg_total_relation_size(c.oid)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
   order by 1, 2" > "$WORK/tables.tsv"
psql_prod -c "
  select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name,
           'size', (metadata->>'size')::bigint, 'etag', metadata->>'eTag', 'updated_at', updated_at)
           order by bucket_id, name), '[]')
    from storage.objects" > "$WORK/storage-objects.json"
SERVER_VERSION="$(psql_prod -c 'select version()')"
DB_BYTES="$(psql_prod -c 'select pg_database_size(current_database())')"
log "Databáze $((DB_BYTES / 1048576)) MB, $(wc -l < "$WORK/tables.tsv" | tr -d ' ') tabulek"

# --- Role a databáze ----------------------------------------------------------
log "Role clusteru (bez hesel)…"
"$PG/pg_dumpall" --roles-only --no-role-passwords -l postgres -f "$WORK/roles.sql"

log "pg_dump celé databáze (custom formát)…"
T=$SECONDS
if ! "$PG/pg_dump" --format=custom --compress=6 --no-subscriptions --lock-wait-timeout=60s \
     --verbose --file "$WORK/db.dump" 2> "$WORK/pg_dump.log"; then
  tail -20 "$WORK/pg_dump.log" >&2
  die "pg_dump selhal (celý výpis v $WORK/pg_dump.log)"
fi
log "pg_dump hotov za $((SECONDS - T)) s, $(( $(stat -f %z "$WORK/db.dump") / 1048576 )) MB"

# --- Ověření archivu ------------------------------------------------------------
log "Ověřuji archiv: seznam objektů, schéma a přesné počty řádků…"
"$PG/pg_restore" --list "$WORK/db.dump" > "$WORK/db.toc.txt"
"$PG/pg_restore" --schema-only --file "$WORK/schema.sql" "$WORK/db.dump"
T=$SECONDS
"$PG/pg_restore" --data-only --file - "$WORK/db.dump" | awk '
  /^COPY / && !inside { table = substr($0, 6); sub(/ \(.*$/, "", table); sub(/ FROM stdin;$/, "", table); rows = 0; inside = 1; next }
  inside && $0 == "\\." { print table "\t" rows; inside = 0; next }
  inside { rows++ }' > "$WORK/table-rowcounts.tsv"
log "Celý archiv přečten za $((SECONDS - T)) s: $(wc -l < "$WORK/table-rowcounts.tsv" | tr -d ' ') tabulek s daty, $(awk -F'\t' '{s += $2} END {print s}' "$WORK/table-rowcounts.tsv") řádků"
# Každá běžná tabulka (ne součást rozšíření) musí mít v archivu blok dat, i prázdný.
[ -s "$WORK/table-rowcounts.tsv" ] || die "Archiv neobsahuje žádná data."
MISSING="$(awk -F'\t' 'NR == FNR { have[$1] = 1; next } $4 == "r" && $5 == 0 && !($3 in have) { print $3 }' \
  "$WORK/table-rowcounts.tsv" "$WORK/tables.tsv")"
[ -z "$MISSING" ] || die "V archivu chybí data tabulek: $(echo $MISSING)"
# Seznam souborů ze Storage (bere se před dumpem) musí odpovídat storage.objects v archivu.
OBJECTS_JSON="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$WORK/storage-objects.json")"
OBJECTS_DUMP="$(awk -F'\t' '$1 == "storage.objects" { print $2 }' "$WORK/table-rowcounts.tsv")"
if [ $(( (${OBJECTS_DUMP:-0} > 0) != (OBJECTS_JSON > 0) )) = 1 ]; then
  die "Seznam Storage ($OBJECTS_JSON) nesedí s archivem (${OBJECTS_DUMP:-0} řádků storage.objects)."
fi

# --- Soubory ze Storage -------------------------------------------------------
# Chyba Storage nezahodí hotový dump: záloha se dokončí, ale skript skončí kódem 2.
STORAGE_LINE="vynecháno (--no-storage)"; STORAGE_FAILED=0
if [ "$STORAGE" = 1 ]; then
  log "Soubory ze Storage → $BACKUP_ROOT/storage-mirror…"
  if STORAGE_LINE="$(node "$HERE/backup/storage-sync.mjs" --objects "$WORK/storage-objects.json" \
       --mirror "$BACKUP_ROOT/storage-mirror" --out "$WORK/storage-manifest.tsv" --project-ref "$PROJECT_REF")"; then
    log "$STORAGE_LINE"
  else
    STORAGE_FAILED=1; STORAGE_LINE="CHYBA: ${STORAGE_LINE:-storage-sync selhal}"; log "$STORAGE_LINE"
  fi
fi

# --- Git ----------------------------------------------------------------------
# Noční kopie skriptů (install-nightly.sh) není git repo: commit, ze kterého je nainstalovaná.
REPO_HEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null) ($(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null))" \
  || REPO_HEAD="noční kopie skriptů z $(cat "$REPO/installed-from.txt" 2>/dev/null || echo '?')"
if [ "$GIT" = 1 ]; then
  log "Git bundle všech větví…"
  git -C "$REPO" bundle create "$WORK/alphatrade-git.bundle" --all 2> "$TMP/git.log" || { cat "$TMP/git.log" >&2; die "git bundle selhal"; }
  git -C "$REPO" bundle verify -q "$WORK/alphatrade-git.bundle" > /dev/null 2>&1 || die "git bundle verify selhal"
fi

# --- Manifest, kontrolní součty, dokončení ------------------------------------
cat > "$WORK/manifest.txt" <<EOF
created_utc=$STAMP
project_ref=$PROJECT_REF
host=$PGHOST:$PGPORT
server_version=$SERVER_VERSION
server_major=$SERVER_MAJOR
pg_dump_version=$("$PG/pg_dump" --version)
db_size_bytes=$DB_BYTES
dump_bytes=$(stat -f %z "$WORK/db.dump")
rows_in_dump=$(awk -F'\t' '{s += $2} END {print s}' "$WORK/table-rowcounts.tsv")
storage=$STORAGE_LINE
repo_head=$REPO_HEAD
duration_s=$((SECONDS - STARTED))
EOF
(cd "$WORK" && shasum -a 256 $(ls | grep -v -e '^backup.log$' -e '^pg_dump.log$' -e '^SHA256SUMS$') > SHA256SUMS)
mv "$WORK" "$DIR"
WORK=""
ln -sfn "$STAMP" "$BACKUP_ROOT/latest"

# Rotace: maže jen kompletní zálohy (jméno YYYYMMDDTHHMMSSZ + SHA256SUMS), nikdy nejnovější
# a nikdy poslední zálohu, jejíž zkušební obnova prošla (PASS).
TESTED=""
for d in $(ls -d "$BACKUP_ROOT"/[0-9]*T[0-9]*Z | sort -r); do
  if grep -qs ': PASS$' "$d"/restore-test-*.txt; then TESTED="$d"; break; fi
done
ALL="$(ls -d "$BACKUP_ROOT"/[0-9]*T[0-9]*Z | sort)"
COUNT="$(printf '%s\n' "$ALL" | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  printf '%s\n' "$ALL" | head -n $((COUNT - KEEP)) | while read -r old; do
    case "$(basename "$old")" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) continue ;; esac
    [ "$old" != "$DIR" ] && [ "$old" != "$TESTED" ] && [ -f "$old/SHA256SUMS" ] || continue
    log "Mažu starou zálohu $(basename "$old")"; rm -rf "$old"
  done
fi
log "HOTOVO za $((SECONDS - STARTED)) s: $DIR ($(du -sh "$DIR" | awk '{print $1}')), volno $(free_gb "$BACKUP_ROOT") GB"
log "Zkušební obnova: ./scripts/restore-test-supabase.sh $DIR"
[ "$STORAGE_FAILED" = 0 ] || { log "POZOR: databáze je zálohovaná, ale soubory ze Storage ne celé (viz výše)."; exit 2; }
