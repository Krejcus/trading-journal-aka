#!/bin/zsh
# Služba pro účet Lucid jedním příkazem. Spouští JEN člověk v terminálu (obchodní režim chce opsání věty).
#
#   scripts/rithmic/lucid.sh             obchodní režim: vydá souhlas a spustí službu (PC 3311, telefon 3313)
#   scripts/rithmic/lucid.sh obnovit     existující souhlas, potvrzení přes Touch ID
#   scripts/rithmic/lucid.sh cteni       jen čtení (graf a stav účtu, žádné příkazy)
#   scripts/rithmic/lucid.sh zavirani    jen zavírání a správa SL/TP (když souhlas vypršel a pozice zůstala)
#
# Proměnné: KS = strop kontraktů v souhlasu (výchozí 3, vždy nejvýše podle RMS účtu), HODIN = platnost (výchozí 12),
# SL=povinny = každý vstup musí mít SL (pak nejde ani přikoupení bez SL/TP). Bez ní souhlas povolí vstup
# a přikoupení BEZ SL/TP (--allow-no-stop) — vydání souhlasu to vypíše před větou („SL u vstupu: NEPOVINNÝ").
# Účet, uživatel a přihlášení Tailscale jsou v scripts/rithmic/results/lucid.env (mimo git).
# Rithmic Test běží zvlášť (porty 3321/3323) a tahle služba ho neovlivní.
# Znovu spustit při běžící službě nejde (zámek); nový souhlas by běžící službě zastavil nové vstupy (chce restart).
set -e
set -o pipefail
cd "${0:A:h}/../.."

ENV_FILE="scripts/rithmic/results/lucid.env"
[ -f "$ENV_FILE" ] || { echo "Chybí $ENV_FILE (LUCID_USER, LUCID_ACCOUNT, TAILSCALE_LOGIN)." >&2; exit 2; }
source "$ENV_FILE"
[ -n "$LUCID_USER" ] && [ -n "$LUCID_ACCOUNT" ] && [ -n "$TAILSCALE_LOGIN" ] || { echo "V $ENV_FILE chybí LUCID_USER, LUCID_ACCOUNT nebo TAILSCALE_LOGIN." >&2; exit 2; }
SYSTEM="LucidTrading"
MODE="${1:-obchod}"
COMMON=(--system "$SYSTEM" --user "$LUCID_USER" --contract MNQ --mobile --tailscale-login "$TAILSCALE_LOGIN")
NO_STOP=(--allow-no-stop)
[ "${SL:-}" = "povinny" ] && NO_STOP=()
export RITHMIC_DEV_ORIGINS="http://localhost:5273"

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "Spusť to v terminálu (obchodní režim se potvrzuje opsáním věty)." >&2
  exit 2
fi

case "$MODE" in
  obchod)
    npx tsx scripts/rithmic/grantLiveTrading.ts --system "$SYSTEM" --user "$LUCID_USER" --account "$LUCID_ACCOUNT" \
      --hours "${HODIN:-12}" --max-quantity "${KS:-3}" "${NO_STOP[@]}"
    exec npx tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --live-trading
    ;;
  obnovit)
    exec ./node_modules/.bin/tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --live-trading --resume-touch-id --resume-account "$LUCID_ACCOUNT"
    ;;
  cteni)
    exec npx tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --read-only
    ;;
  zavirani)
    exec npx tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --close-only
    ;;
  *)
    echo "Neznámý režim: $MODE (obchod | obnovit | cteni | zavirani)" >&2
    exit 2
    ;;
esac
