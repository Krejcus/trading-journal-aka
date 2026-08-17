/**
 * Watchdog Mac copier runtime.
 *
 * Runtime se umí bezpečně zastavit sám — ale o tom, ŽE se zastavil, se dnes
 * uživatel dozví jen pohledem do LIVE UI. Watchdog tu díru zavírá: polluje
 * lokální execution agent a při problému pošle macOS notifikaci.
 *
 * Záměrně NIC neopravuje. Nerestartuje agenta, nearmuje, neposílá příkazy —
 * jen hlásí. Oprava je vždy rozhodnutí člověka; automatická „záchrana" je
 * přesně ta kategorie chování, kterou copier nikde jinde nemá.
 *
 *   npx tsx scripts/copier/watchdog.ts            # výchozí 127.0.0.1:3211
 *   npx tsx scripts/copier/watchdog.ts --interval 5
 */
import { execFile } from 'node:child_process';
import { LOCAL_COPIER_AGENT_BASE_URL } from '../../lib/localCopierAgentProtocol';
import type { CopierControllerStatus } from '../../services/copierRuntimeController';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const baseUrl = flag('url', LOCAL_COPIER_AGENT_BASE_URL);
const intervalSeconds = Math.max(2, Math.min(60, Number(flag('interval', '5')) || 5));

type Condition =
  | 'agent-unreachable'
  | 'kill-switch'
  | 'fail-closed'
  | 'stuck-outbox'
  | 'disconnected'
  | 'divergence'
  | 'disarmed';

interface Finding {
  condition: Condition;
  detail: string;
}

/**
 * Vyhodnocení stavu. Pořadí odpovídá závažnosti — hlásí se všechny nálezy,
 * ale notifikace nese ten nejzávažnější.
 */
export function evaluateStatus(status: CopierControllerStatus, wasArmed: boolean): Finding[] {
  const findings: Finding[] = [];
  if (status.killSwitch) {
    findings.push({ condition: 'kill-switch', detail: 'Kill switch je aktivní' });
  }
  if (status.lastError) {
    findings.push({ condition: 'fail-closed', detail: `Fail-closed: ${status.lastError}` });
  }
  if (status.stuckOutbox) {
    findings.push({
      condition: 'stuck-outbox',
      detail: 'Outbox čeká na člověka (unknown/rejected/abandoned operace)',
    });
  }
  if (!status.connected && status.started) {
    findings.push({ condition: 'disconnected', detail: 'Tradovate WebSocket není připojený' });
  }
  if (status.divergentAccounts.length > 0) {
    findings.push({
      condition: 'divergence',
      detail: `Divergentní účty: ${status.divergentAccounts.join(', ')}`,
    });
  }
  // Samotný DISARMED je legitimní klidový stav. Zpráva je to jen tehdy,
  // když ARM zmizel, aniž by ho uživatel odvolal vědomě — to poznáme podle
  // přechodu armed -> disarmed mezi dvěma poll cykly.
  if (wasArmed && !status.armed) {
    findings.push({ condition: 'disarmed', detail: 'Runtime se odzbrojil (byl ARMED)' });
  }
  return findings;
}

function notify(title: string, body: string): void {
  // osascript je na macOS vždy k dispozici; žádná závislost navíc.
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Sosumi"`;
  execFile('osascript', ['-e', script], () => { /* selhání notifikace neshazuje watchdog */ });
}

async function fetchStatus(): Promise<CopierControllerStatus | null> {
  try {
    const response = await fetch(`${baseUrl}/v1/status`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { controller?: CopierControllerStatus };
    return payload.controller ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`Copier watchdog — ${baseUrl}, interval ${intervalSeconds}s. Jen hlásí, nikdy nezasahuje.`);
  let wasArmed = false;
  let lastSignature = '';
  let unreachableSince: number | null = null;

  for (;;) {
    const status = await fetchStatus();
    let findings: Finding[];

    if (!status) {
      // Krátký výpadek při restartu agenta není poplach; mrtvý agent ano.
      unreachableSince ??= Date.now();
      const downSeconds = Math.round((Date.now() - unreachableSince) / 1_000);
      findings = downSeconds >= intervalSeconds * 3
        ? [{ condition: 'agent-unreachable', detail: `Execution agent neodpovídá ${downSeconds}s` }]
        : [];
    } else {
      unreachableSince = null;
      findings = evaluateStatus(status, wasArmed);
      wasArmed = status.armed;
    }

    // Notifikace jen při změně stavu — stejný problém se nehlásí každý tik.
    const signature = findings.map(finding => finding.condition).join('|');
    if (signature && signature !== lastSignature) {
      const worst = findings[0];
      notify('AlphaTrade Copier', worst.detail);
      for (const finding of findings) {
        console.log(`${new Date().toISOString()} [${finding.condition}] ${finding.detail}`);
      }
    }
    if (!signature && lastSignature) {
      console.log(`${new Date().toISOString()} [ok] stav se vrátil do normálu`);
    }
    lastSignature = signature;

    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1_000));
  }
}

// Import bez spuštění (testy) vs. přímé spuštění.
if (process.argv[1]?.endsWith('watchdog.ts')) {
  void main();
}
