#!/bin/zsh
# Bezpečný reinstall Mac copier workera z aktuálního checkoutu.
#
# Brána (zrcadlí canSafelyRestartLocalCopierAgent + lastError): worker musí být
# started, DISARMED, bez kill switche, connected, reconciled, flat, bez
# divergence, working orders, stuck outboxu/operací a bez lastError.
# Jinak skript skončí BEZ jakékoli změny. Parametry běžícího agenta
# (leader, followers, manifest, port) se přebírají z běžícího procesu,
# aby se nic nepřepisovalo ručně.
set -euo pipefail

PORT="${COPIER_PORT:-3211}"
STATUS_JSON="$(curl -s -m 5 -H "Origin: http://localhost:3000" "http://127.0.0.1:${PORT}/v1/status" || true)"
if [[ -z "$STATUS_JSON" ]]; then
  echo "STOP: lokální agent na portu ${PORT} neodpovídá" >&2
  exit 2
fi

BLOCKERS="$(printf '%s' "$STATUS_JSON" | python3 -c '
import sys, json
d = json.load(sys.stdin); c = d["controller"]; b = []
if not c.get("started"): b.append("not-started")
if c.get("armed"): b.append("armed")
if c.get("killSwitch"): b.append("kill-switch")
if not c.get("connected"): b.append("disconnected")
if c.get("reconciliationRequired"): b.append("reconciliation-required")
if c.get("groupFlat") is not True: b.append("group-not-flat")
if c.get("divergentAccounts"): b.append("divergent-accounts=" + ",".join(map(str, c["divergentAccounts"])))
if c.get("workingOrderAccounts"): b.append("working-orders=" + ",".join(map(str, c["workingOrderAccounts"])))
if c.get("stuckOutbox"): b.append("stuck-outbox")
if c.get("stuckOperations"): b.append("stuck-operations")
if c.get("lastError"): b.append("lastError=" + str(c["lastError"]))
print(" ".join(b))
')"
if [[ -n "$BLOCKERS" ]]; then
  echo "STOP: worker není v bezpečném stavu pro restart: ${BLOCKERS}" >&2
  echo "Nic nebylo změněno. Oprav stav (OAuth / Edit group / read-only reconcile) a spusť znovu." >&2
  exit 3
fi

AGENT_PID="$(pgrep -f 'copier-agent.mjs agent' | head -1 || true)"
if [[ -z "$AGENT_PID" ]]; then
  echo "STOP: běžící copier-agent.mjs nenalezen, parametry nelze převzít" >&2
  exit 4
fi
ARGS=("${(@f)$(ps -o args= -p "$AGENT_PID" | python3 -c '
import sys, shlex
argv = shlex.split(sys.stdin.read())
def flag(name):
    return argv[argv.index(name) + 1] if name in argv else ""
print(flag("--leader")); print(flag("--followers")); print(flag("--connections-manifest")); print(flag("--port") or "3211")
')}")
LEADER="${ARGS[1]}"; FOLLOWERS="${ARGS[2]}"; MANIFEST="${ARGS[3]}"; AGENT_PORT="${ARGS[4]}"
if [[ -z "$LEADER" || -z "$FOLLOWERS" || -z "$MANIFEST" ]]; then
  echo "STOP: z běžícího agenta se nepodařilo přečíst --leader/--followers/--connections-manifest" >&2
  exit 5
fi

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
echo "Reinstall z ${REPO} @ ${COMMIT}"
echo "leader=${LEADER} followers=${FOLLOWERS} port=${AGENT_PORT}"
echo "manifest=${MANIFEST}"

cd "$REPO"
npm run copier:mac -- install --connections-manifest "$MANIFEST" --leader "$LEADER" --followers "$FOLLOWERS" --port "$AGENT_PORT" --adopt-durable-group

BUNDLE="$HOME/Library/Application Support/AlphaTrade/copier/copier-agent.mjs"
echo "bundle sha256: $(shasum -a 256 "$BUNDLE" | cut -c1-16)…  commit: ${COMMIT}"
echo "Čekám na nový agent…"
for i in {1..30}; do
  sleep 2
  if curl -s -m 3 -H "Origin: http://localhost:3000" "http://127.0.0.1:${AGENT_PORT}/v1/status" >/dev/null 2>&1; then
    curl -s -m 5 -H "Origin: http://localhost:3000" "http://127.0.0.1:${AGENT_PORT}/v1/status" | python3 -c '
import sys, json
d = json.load(sys.stdin); c = d["controller"]
print("po restartu: armed=%s connected=%s reconciliationRequired=%s divergent=%s lastError=%s" % (
  c.get("armed"), c.get("connected"), c.get("reconciliationRequired"), c.get("divergentAccounts"), c.get("lastError")))'
    echo "Hotovo. Teď spusť read-only reconcile: npm run copier:mac -- reconcile"
    exit 0
  fi
done
echo "VAROVÁNÍ: agent po restartu do 60 s neodpověděl, zkontroluj mac-agent.stderr.log" >&2
exit 6
