import {
  LOCAL_COPIER_AGENT_BASE_URL,
  type LocalCopierAgentCommand,
  type LocalCopierAgentCommandResult,
  type LocalCopierAgentStatus,
} from '../../lib/localCopierAgentProtocol';

/**
 * Shadow režim běžícího workeru bez UI.
 *
 * Shadow ARM vyhodnotí události leadera, projde rizikovou bránou a naplánuje
 * kopie, ale nic neodešle brokerovi (`dispatch: !shadowMode && ...`). Slouží
 * k ověření, že worker leadera vidí a počítá správná množství — typicky po
 * zásahu do konfigurace skupiny nebo po přeinstalaci workeru.
 *
 * V LIVE kartě je shadow záměrně skrytý (jeden Connect/Disconnect přepínač),
 * proto tenhle skript umí i `off` — jinak by se ze shadow stavu dalo vyjít
 * jen kill switchem.
 *
 * Použití:
 *   npx tsx scripts/copier/shadow.ts on
 *   npx tsx scripts/copier/shadow.ts off
 *   npx tsx scripts/copier/shadow.ts status
 */

const MODES = ['on', 'off', 'status'] as const;
type Mode = typeof MODES[number];

const [modeArg] = process.argv.slice(2);
if (!modeArg || !MODES.includes(modeArg as Mode)) {
  throw new Error(`Použití: shadow.ts <${MODES.join('|')}>`);
}
const mode = modeArg as Mode;

// Agent pouští jen požadavky z originů aplikace. Ta kontrola brání cizímu
// webu v prohlížeči ovládnout copier — na lokální proces nikdy nemířila
// (ten si hlavičku nastaví tak jako tak). Autentizace je nonce ze /v1/status.
const AGENT_HEADERS = { Origin: 'http://127.0.0.1:3000' } as const;

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!response.ok) throw new Error(`Agent odpověděl ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Agent nevrátil JSON: ${text.slice(0, 200)}`);
  }
};

async function loadStatus(): Promise<LocalCopierAgentStatus> {
  const response = await fetch(`${LOCAL_COPIER_AGENT_BASE_URL}/v1/status`, {
    cache: 'no-store',
    headers: AGENT_HEADERS,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    throw new Error(`Lokální agent neodpovídá na ${LOCAL_COPIER_AGENT_BASE_URL}. Běží worker?`);
  });
  return await readJson(response) as LocalCopierAgentStatus;
}

const describe = (status: LocalCopierAgentStatus): string => {
  const controller = status.controller;
  if (controller.killSwitch) return 'KILL SWITCH — brokerové akce jsou zablokované';
  if (!controller.armed) return 'DISARMED — copier neposlouchá leadera';
  return controller.shadowMode
    ? 'SHADOW — copier plánuje kopie, ale nic neodesílá'
    : 'ARMED NAOSTRO — kopie se odesílají brokerovi';
};

async function main(): Promise<void> {
  const status = await loadStatus();
  if (mode === 'status') {
    console.log(describe(status));
    return;
  }

  // Ostrý ARM se přes tenhle skript poslat nedá — `off` vede vždy na DISARM,
  // takže omylem spuštěný skript nemůže zapnout odesílání příkazů.
  if (mode === 'off' && !status.controller.armed) {
    console.log('Copier už je DISARMED, není co vypínat.');
    return;
  }
  if (mode === 'on' && status.controller.armed && !status.controller.shadowMode) {
    throw new Error('Copier je ARMED naostro. Nejdřív ho odpoj v LIVE kartě, pak zapni shadow.');
  }

  const command: LocalCopierAgentCommand = mode === 'on' ? { type: 'shadow' } : { type: 'disarm' };
  const response = await fetch(`${LOCAL_COPIER_AGENT_BASE_URL}/v1/command`, {
    method: 'POST',
    headers: {
      ...AGENT_HEADERS,
      'Content-Type': 'application/json',
      'X-AlphaTrade-Agent-Nonce': status.nonce,
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await readJson(response) as LocalCopierAgentCommandResult;
  console.log(describe(payload.status));
}

main().catch(reason => {
  console.error(reason instanceof Error ? reason.message : String(reason));
  process.exitCode = 1;
});
