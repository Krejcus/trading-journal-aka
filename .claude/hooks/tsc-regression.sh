#!/usr/bin/env bash
# Stop hook: zkontroluje, jestli moje změny nepřidaly NOVOU TypeScript chybu.
# Běží jen když se v pracovním stromu změnily .ts/.tsx soubory (jinak rychlý exit).
# Porovnává proti .claude/tsc-baseline.txt (pre-existující chyby) — flagne jen regrese.
# Aktualizace baseline po opravě starých chyb:
#   npx tsc --noEmit 2>&1 | grep "error TS" | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u > .claude/tsc-baseline.txt
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 0

# Gate: pokud se neměnily žádné TS soubory, neztrácej čas (tsc je ~30s).
changed="$( { git diff --name-only; git diff --cached --name-only; } 2>/dev/null | grep -E '\.tsx?$' || true )"
[ -z "$changed" ] && exit 0

baseline=".claude/tsc-baseline.txt"
[ -f "$baseline" ] || exit 0

current="$(npx tsc --noEmit 2>&1 | grep 'error TS' | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u || true)"
new_errors="$(comm -13 "$baseline" <(printf '%s\n' "$current") || true)"

if [ -n "$new_errors" ]; then
  echo "⚠️  Nové TypeScript chyby (nebyly v baseline) — oprav je před dokončením:" >&2
  echo "$new_errors" >&2
  echo "" >&2
  echo "(Pokud jsou legitimní/pre-existující, přidej je do .claude/tsc-baseline.txt)" >&2
  exit 2  # exit 2 = zablokuje Stop a vrátí mi tohle k nápravě
fi
exit 0
