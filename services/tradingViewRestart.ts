import type { LocalCopierAgentCommand, LocalCopierAgentCommandResult, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import { formatSnapshotRepairError } from '../lib/copierBlockerMessages';
import { localCopierAgentErrorDetails } from '../lib/localCopierAgentProtocol';
import { canUseDirectLocalCopierAgent, createLocalCopierAgentClient } from './localCopierAgentClient';
import { executeTradovateCopierRelayCommand, loadTradovateCopierRelayStatus, loadTradovateOAuthStatus } from './tradovateOAuthConnection';

/**
 * Restart TradingView s CDP z deníku (i z telefonu nebo cizího prohlížeče).
 * Pošle stejný příkaz jako „Obnovit TradingView snímky“ v LIVE
 * (`snapshot-test` + `repairCamera`): přímo na Mac worker, jinak přes relay.
 * Nic neposílá brokerovi; worker restart pustí jen v připojeném,
 * zkontrolovaném, vypnutém a flat stavu bez čekajících příkazů — UI nic
 * neautorizuje. Výsledek se ověřuje ze `snapshotHealth` workeru: „přijato“
 * ještě neznamená „restartováno“.
 */

export interface TradingViewRestartDeps {
  canUseLocal: boolean;
  local: { status(): Promise<LocalCopierAgentStatus>; execute(command: LocalCopierAgentCommand): Promise<LocalCopierAgentCommandResult> };
  connectedConnectionIds(): Promise<string[]>;
  relayStatus(connectionId: string): Promise<{ connected: boolean; status?: LocalCopierAgentStatus } | null>;
  relayExecute(connectionId: string, command: LocalCopierAgentCommand): Promise<LocalCopierAgentCommandResult>;
  newRequestId(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type TradingViewRestartRoute = 'local' | 'relay';

export type TradingViewRestartOutcome =
  /** TradingView už má CDP — restart by nic nespravil (problém je v grafu, ne v připojení). */
  | { kind: 'already-connected'; route: TradingViewRestartRoute }
  /** Worker TradingView restartoval a CDP i graf snímků jsou připravené. */
  | { kind: 'ready'; route: TradingViewRestartRoute }
  /** Worker příkaz přijal, ale TradingView se v limitu nepřipojilo. */
  | { kind: 'not-ready'; route: TradingViewRestartRoute; state: string | null };

export class TradingViewRestartUnavailableError extends Error {
  constructor() {
    super('Mac worker teď není připojený — TradingView na dálku restartovat nejde.');
    this.name = 'TradingViewRestartUnavailableError';
  }
}

const VERIFY_MS = 45_000;
const VERIFY_STEP_MS = 1_500;

interface Route {
  route: TradingViewRestartRoute;
  status: LocalCopierAgentStatus | null;
  execute(command: LocalCopierAgentCommand): Promise<LocalCopierAgentCommandResult>;
  read(): Promise<LocalCopierAgentStatus | null>;
}

async function pickRoute(deps: TradingViewRestartDeps): Promise<Route> {
  if (deps.canUseLocal) {
    // Lokální worker nedostupný (jiný port, vypnutý) → zkus relay. Odmítnutí
    // příkazu workerem se ale vrací uživateli, nezkouší se druhou cestou.
    const status = await deps.local.status().catch(() => null);
    if (status) return { route: 'local', status, execute: command => deps.local.execute(command), read: () => deps.local.status() };
  }
  let lastError: unknown = null;
  for (const connectionId of await deps.connectedConnectionIds()) {
    const remote = await deps.relayStatus(connectionId).catch(reason => { lastError = reason; return null; });
    if (remote?.connected) {
      return {
        route: 'relay',
        status: remote.status ?? null,
        execute: command => deps.relayExecute(connectionId, command),
        read: async () => (await deps.relayStatus(connectionId))?.status ?? null,
      };
    }
  }
  // Síťová chyba / odhlášení se nevydává za „worker není připojený“.
  if (lastError) throw lastError;
  throw new TradingViewRestartUnavailableError();
}

const cdpReady = (status: LocalCopierAgentStatus | null) => status?.snapshotHealth?.state === 'ready' && status.snapshotHealth.cdpReachable === true;

export async function restartTradingView(deps: TradingViewRestartDeps = defaultDeps()): Promise<TradingViewRestartOutcome> {
  const target = await pickRoute(deps);
  if (cdpReady(target.status)) return { kind: 'already-connected', route: target.route };
  await target.execute({ type: 'snapshot-test', requestId: deps.newRequestId(), repairCamera: true });
  // Worker restart spustí na pozadí a hned odpoví; konec poznáme ze stavu snímků.
  const deadline = deps.now() + VERIFY_MS;
  let state: string | null = null;
  while (deps.now() < deadline) {
    await deps.sleep(VERIFY_STEP_MS);
    const next = await target.read().catch(() => null);
    if (!next) continue;
    state = next.snapshotHealth?.state ?? null;
    if (cdpReady(next)) return { kind: 'ready', route: target.route };
    // Během restartu `checking`; jiný konečný stav = oprava se nepovedla.
    if (state && state !== 'checking') return { kind: 'not-ready', route: target.route, state };
  }
  return { kind: 'not-ready', route: target.route, state };
}

function defaultDeps(): TradingViewRestartDeps {
  const client = createLocalCopierAgentClient();
  return {
    canUseLocal: typeof window !== 'undefined' && canUseDirectLocalCopierAgent(window.location),
    local: client,
    connectedConnectionIds: async () => {
      const status = await loadTradovateOAuthStatus();
      return [...new Set(status.connections.filter(connection => connection.connected).map(connection => connection.id))];
    },
    relayStatus: loadTradovateCopierRelayStatus,
    relayExecute: (connectionId, command) => executeTradovateCopierRelayCommand(connectionId, command),
    newRequestId: () => crypto.randomUUID(),
    sleep: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** Česká hláška k odmítnutí / chybě restartu (strukturované blokery workeru mají přednost). */
export function tradingViewRestartErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  if (localCopierAgentErrorDetails(reason)?.code === 'snapshot-repair-blocked') {
    return formatSnapshotRepairError(reason, accountId => `účet ${accountId}`);
  }
  if (/pouze read-only/.test(message)) return 'Z vývojového localhostu jde restart jen přímo přes Mac worker (port 3000); na produkci a z telefonu funguje přes relay.';
  if (/snapshot-test-already-running/.test(message)) return 'Restart TradingView už běží — chvíli počkej.';
  if (/snapshot-test-unavailable/.test(message)) return 'Worker má snímky vypnuté, TradingView neovládá.';
  // Starší worker bez strukturovaných blokerů posílá jen tuhle větu.
  if (/DISARMED|reconciled|pracovních příkazů/.test(message)) {
    return 'TradingView jde restartovat jen při vypnuté a zkontrolované kopírce bez pozic a příkazů.';
  }
  return message || 'Restart TradingView se nepodařil.';
}

/** Co říct po doběhnutí restartu. */
export function tradingViewRestartOutcomeText(outcome: TradingViewRestartOutcome): { ok: boolean; text: string } {
  if (outcome.kind === 'ready') return { ok: true, text: 'TradingView znovu připojené · svíčky do ~1 min' };
  if (outcome.kind === 'already-connected') {
    return { ok: false, text: 'TradingView je připojené, restart nepomůže — zkontroluj, že je otevřený 1m graf MNQ.' };
  }
  return { ok: false, text: `Worker příkaz přijal, ale TradingView se zatím nepřipojilo${outcome.state && outcome.state !== 'checking' ? ` (${outcome.state})` : ''}.` };
}
