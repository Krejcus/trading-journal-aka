#!/bin/zsh
# Služba pro účet Lucid jedním příkazem. Spouští JEN člověk v terminálu (obchodní režim chce opsání věty).
#
#   scripts/rithmic/lucid.sh             obchodní režim: vydá souhlas a spustí službu (PC 3311, telefon 3313)
#   scripts/rithmic/lucid.sh obnovit     existující souhlas, potvrzení heslem k Macu nebo přes Touch ID
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
# VICE_VSTUPU=ano zapne víc čekajících vstupů a vstupy s libovolnými SL/TP (proti brokerovi zatím neověřeno);
# bez toho platí jeden čekající vstup jako dřív. Jen pro obchodní režim (obchod / obnovit).
MULTI=()
[ "${VICE_VSTUPU:-}" = "ano" ] && MULTI=(--multi-entry)
# ORDER_FLOW=ano zapne order flow pro indikátory Bubliny a Volume profil (odběr NQ, objem po cenách, velké
# obchody). Jen zobrazení — do příkazů, upozornění ani svíček nezasahuje; platí ve všech režimech.
FLOW=()
[ "${ORDER_FLOW:-}" = "ano" ] && FLOW=(--order-flow)
export RITHMIC_DEV_ORIGINS="http://localhost:5273"

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "Spusť to v terminálu (obchodní režim se potvrzuje opsáním věty)." >&2
  exit 2
fi

# Služba „jen čtení“ jako launchd úloha (install-rithmic-read.sh) drží přihlášení k Rithmicu: uvolnit ji
# (odpojit úlohu, ať ji KeepAlive hned nespustí znovu) a po skončení vrátit — jen když značka pořád patří
# tomuhle běhu (při `obnovit` ji převezme nový běh a starý pak čtení nevrací).
READ_LABEL=com.alphatrade.rithmic-read
READ_PLIST="$HOME/Library/LaunchAgents/$READ_LABEL.plist"
READ_MARK="$HOME/Library/Application Support/AlphaTrade/rithmic/read-paused-by-lucid"
DOMAIN="gui/$(id -u)"
if [ -f "$READ_PLIST" ]; then
  mkdir -p "${READ_MARK:h}"
  print -r -- "$$" > "$READ_MARK"
  if launchctl list "$READ_LABEL" >/dev/null 2>&1; then
    echo "Uvolňuji službu jen pro čtení (launchd)…"
    launchctl bootout "$DOMAIN/$READ_LABEL" 2>/dev/null || true
    for _ in {1..30}; do launchctl list "$READ_LABEL" >/dev/null 2>&1 || break; sleep 1; done
  fi
  restore_read() {
    if [ "$(cat "$READ_MARK" 2>/dev/null)" = "$$" ]; then
      rm -f "$READ_MARK"
      launchctl bootout "$DOMAIN/$READ_LABEL" 2>/dev/null || true
      launchctl bootstrap "$DOMAIN" "$READ_PLIST" 2>/dev/null && echo "Služba jen pro čtení zase běží (launchd)."
    fi
  }
  trap restore_read EXIT
  # Ctrl+C: shell počká, až služba doběhne, a teprve pak skončí (a vrátí čtení).
  trap 'exit 130' INT TERM
fi

case "$MODE" in
  obchod)
    npx tsx scripts/rithmic/grantLiveTrading.ts --system "$SYSTEM" --user "$LUCID_USER" --account "$LUCID_ACCOUNT" \
      --hours "${HODIN:-12}" --max-quantity "${KS:-3}" "${NO_STOP[@]}"
    npx tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --live-trading "${MULTI[@]}" "${FLOW[@]}"
    ;;
  obnovit)
    ./node_modules/.bin/tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --live-trading --resume-touch-id --resume-account "$LUCID_ACCOUNT" "${MULTI[@]}" "${FLOW[@]}"
    ;;
  cteni)
    npx tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --read-only "${FLOW[@]}"
    ;;
  zavirani)
    npx tsx scripts/rithmic/devTradeServer.ts "${COMMON[@]}" --close-only "${FLOW[@]}"
    ;;
  *)
    echo "Neznámý režim: $MODE (obchod | obnovit | cteni | zavirani)" >&2
    exit 2
    ;;
esac
