# Společné funkce pro scripts/backup-supabase.sh a scripts/restore-test-supabase.sh.
# Psáno pro /bin/bash 3.2 (macOS bez Homebrew): žádná asociativní pole ani mapfile.

# Mimo ~/Documents: noční úloha z launchd tam nesmí číst (macOS TCC).
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/AlphaTrade-backups/supabase}"
MIN_FREE_GB="${BACKUP_MIN_FREE_GB:-10}"
KEYCHAIN_SERVICE="${BACKUP_KEYCHAIN_SERVICE:-alphatrade-supabase-db}"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }

# Najde adresář s pg nástroji, jejichž major verze je >= $1 (major verze serveru).
# Pořadí: $PG_BIN, Postgres.app (nejnovější verze první), PATH.
find_pg_bin() {
  local need="$1" dir candidates major
  candidates="${PG_BIN:-}"
  for dir in /Applications/Postgres.app/Contents/Versions/latest/bin \
             $(ls -d /Applications/Postgres.app/Contents/Versions/[0-9]*/bin 2>/dev/null | sort -t/ -k6 -rn); do
    candidates="$candidates $dir"
  done
  if command -v pg_dump >/dev/null 2>&1; then candidates="$candidates $(dirname "$(command -v pg_dump)")"; fi
  for dir in $candidates; do
    [ -x "$dir/pg_dump" ] || continue
    major="$("$dir/pg_dump" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
    if [ "$major" -ge "$need" ] 2>/dev/null; then printf '%s\n' "$dir"; return 0; fi
  done
  return 1
}

pg_bin_hint() {
  cat >&2 <<EOF
Chybí PostgreSQL nástroje verze $1 nebo novější (pg_dump, pg_restore, psql, initdb).
Nainstaluj Postgres.app (https://postgresapp.com, přetáhnout do Aplikací —
server spouštět nemusíš, skripty si berou jen jeho programy), nebo nastav PG_BIN.
EOF
}

# Připojení k produkci přes session pooler (port 5432; transakční 6543 pg_dump neumí).
# Host a uživatel se berou z linku Supabase CLI, jde přepsat proměnnými SUPABASE_DB_*.
load_prod_connection() {
  local repo="$1" url
  PROJECT_REF="${SUPABASE_PROJECT_REF:-$(cat "$repo/supabase/.temp/project-ref" 2>/dev/null || true)}"
  [ -n "$PROJECT_REF" ] || die "Neznám project ref (supabase/.temp/project-ref ani SUPABASE_PROJECT_REF)."
  url="$(cat "$repo/supabase/.temp/pooler-url" 2>/dev/null || true)"
  url="${url#*://}"; url="${url#*@}"
  export PGHOST="${SUPABASE_DB_HOST:-${url%%:*}}"
  export PGPORT="${SUPABASE_DB_PORT:-5432}"
  export PGUSER="${SUPABASE_DB_USER:-postgres.$PROJECT_REF}"
  export PGDATABASE=postgres
  export PGAPPNAME=alphatrade-backup
  export PGCONNECT_TIMEOUT=20
  # verify-full jen s kořenovým certifikátem Supabase (Dashboard → Database → SSL).
  if [ -n "${PGSSLROOTCERT:-}" ]; then export PGSSLMODE=verify-full; else export PGSSLMODE=require; fi
  [ -n "$PGHOST" ] || die "Neznám host poolera (supabase/.temp/pooler-url ani SUPABASE_DB_HOST)."
}

# Heslo k DB jen z Keychainu (nebo SUPABASE_DB_PASSWORD pro jednorázové spuštění).
# Do dočasného pgpass souboru 0600, aby nebylo vidět v argumentech procesů.
setup_pgpass() {
  local tmpdir="$1" pass
  pass="${SUPABASE_DB_PASSWORD:-}"
  if [ -z "$pass" ]; then
    pass="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a postgres -w 2>/dev/null)" || {
      cat >&2 <<EOF
STOP: Heslo k databázi není v Keychainu. Ulož ho jednou příkazem (zeptá se na heslo):
  security add-generic-password -U -s $KEYCHAIN_SERVICE -a postgres -w
Heslo je v Supabase Dashboard → Project Settings → Database (případně „Reset database password“).
EOF
      exit 1; }
  fi
  pass="$(printf '%s' "$pass" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g')"
  printf '%s:%s:*:%s:%s\n' "$PGHOST" "$PGPORT" "$PGUSER" "$pass" > "$tmpdir/pgpass"
  chmod 600 "$tmpdir/pgpass"
  export PGPASSFILE="$tmpdir/pgpass"
}

free_gb() { df -Pk "$1" | awk 'NR==2 { printf "%d", $4 / 1048576 }'; }

# Obchodní doba Po–Pá 8:00–22:30 pražského času: pg_dump by zatížil DB, přes kterou jede kopírka.
trading_time() {
  local minute=$((10#$(TZ=Europe/Prague date +%H) * 60 + 10#$(TZ=Europe/Prague date +%M)))
  [ "$(TZ=Europe/Prague date +%u)" -le 5 ] && [ "$minute" -ge 480 ] && [ "$minute" -lt 1350 ]
}

# Nejnovější kompletní záloha (adresáře YYYYMMDDTHHMMSSZ, rozpracované mají .partial).
latest_backup() { ls -d "$BACKUP_ROOT"/[0-9]*T[0-9]*Z 2>/dev/null | sort | tail -1 || true; }
