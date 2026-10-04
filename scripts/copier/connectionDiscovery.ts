import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Nová propfirma bez CLI (4. 10. 2026): spárovaný Mac se scope `owner` si
 * od serveru zjistí OAuth připojení vlastníka. Připojení, které worker ještě
 * nemá, načte až po bezpečném restartu (DISARMED, flat, reconciled).
 *
 * Tento modul je čistá politika: co načíst při startu, kdy za běhu žádat
 * restart a jak dlouho čekat po selhání, aby vadné připojení nikdy
 * nespustilo smyčku restartů (launchd KeepAlive restartuje do 10 s).
 */

export interface ConnectionDiscoveryFailure {
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

export interface ConnectionDiscoveryState {
  version: 1;
  failures: Record<string, ConnectionDiscoveryFailure>;
}

export const emptyConnectionDiscoveryState = (): ConnectionDiscoveryState => ({ version: 1, failures: {} });

/** 5 min, 15 min, 45 min, pak nejvýš 6 h — přechodné chyby se zkoušejí znovu. */
export const connectionDiscoveryBackoffMs = (attempts: number): number =>
  Math.min(6 * 60 * 60_000, 5 * 60_000 * 3 ** Math.max(0, attempts - 1));

export function recordConnectionDiscoveryFailure(
  state: ConnectionDiscoveryState,
  connectionId: string,
  error: unknown,
  now: number,
): ConnectionDiscoveryState {
  const attempts = (state.failures[connectionId]?.attempts ?? 0) + 1;
  return {
    version: 1,
    failures: {
      ...state.failures,
      [connectionId]: {
        attempts,
        nextAttemptAt: now + connectionDiscoveryBackoffMs(attempts),
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      },
    },
  };
}

export function recordConnectionDiscoverySuccess(
  state: ConnectionDiscoveryState,
  connectionId: string,
): ConnectionDiscoveryState {
  if (!state.failures[connectionId]) return state;
  const failures = { ...state.failures };
  delete failures[connectionId];
  return { version: 1, failures };
}

const coolingDown = (state: ConnectionDiscoveryState, connectionId: string, now: number): boolean =>
  (state.failures[connectionId]?.nextAttemptAt ?? 0) > now;

/** Připojení ze serveru, která worker při startu načte navíc k manifestu. */
export function connectionsToLoadAtStartup(options: {
  serverConnectionIds: readonly string[];
  manifestConnectionIds: readonly string[];
  state: ConnectionDiscoveryState;
  now: number;
}): string[] {
  const manifest = new Set(options.manifestConnectionIds);
  return [...new Set(options.serverConnectionIds)]
    .filter(connectionId => !manifest.has(connectionId) && !coolingDown(options.state, connectionId, options.now))
    .sort();
}

export interface ConnectionPollDecision {
  /** Nová připojení k načtení — worker požádá o bezpečný restart. */
  added: string[];
  /** Načtená připojení, která server už nevrací (odpojena/odvolána). */
  removed: string[];
}

/**
 * Poll za běhu. `removed` vzniká jen z úspěšné odpovědi serveru; chyba
 * listování se sem vůbec nedostane (žádná falešná ztráta připojení).
 */
export function evaluateConnectionPoll(options: {
  serverConnectionIds: readonly string[];
  loadedConnectionIds: readonly string[];
  /** Připojení z manifestu: jejich odebrání ze serveru hlídá lease, ne poll. */
  manifestConnectionIds: readonly string[];
  state: ConnectionDiscoveryState;
  now: number;
}): ConnectionPollDecision {
  const server = new Set(options.serverConnectionIds);
  const loaded = new Set(options.loadedConnectionIds);
  const manifest = new Set(options.manifestConnectionIds);
  return {
    added: [...server]
      .filter(connectionId => !loaded.has(connectionId) && !coolingDown(options.state, connectionId, options.now))
      .sort(),
    removed: [...loaded]
      .filter(connectionId => !server.has(connectionId) && !manifest.has(connectionId))
      .sort(),
  };
}

export async function loadConnectionDiscoveryState(path: string): Promise<ConnectionDiscoveryState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ConnectionDiscoveryState>;
    if (parsed?.version !== 1 || typeof parsed.failures !== 'object' || parsed.failures == null) {
      return emptyConnectionDiscoveryState();
    }
    const failures: Record<string, ConnectionDiscoveryFailure> = {};
    for (const [connectionId, failure] of Object.entries(parsed.failures)) {
      if (
        failure && Number.isSafeInteger(failure.attempts) && failure.attempts > 0
        && Number.isFinite(failure.nextAttemptAt)
      ) {
        failures[connectionId] = {
          attempts: failure.attempts,
          nextAttemptAt: failure.nextAttemptAt,
          lastError: String(failure.lastError ?? ''),
        };
      }
    }
    return { version: 1, failures };
  } catch {
    return emptyConnectionDiscoveryState();
  }
}

export async function saveConnectionDiscoveryState(path: string, state: ConnectionDiscoveryState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
