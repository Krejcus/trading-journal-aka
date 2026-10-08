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
  /** Kdy worker naposledy restartoval kvůli změně adresáře účtů. */
  directoryRestartAt?: number;
}

export const emptyConnectionDiscoveryState = (): ConnectionDiscoveryState => ({ version: 1, failures: {} });

/** 5 min, 15 min, 45 min, pak nejvýš 6 h — přechodné chyby se zkoušejí znovu. */
export const connectionDiscoveryBackoffMs = (attempts: number): number =>
  Math.min(6 * 60 * 60_000, 5 * 60_000 * 3 ** Math.max(0, attempts - 1));

/**
 * Prázdný adresář (propfirma po breachi účty skryla) se nově ověřuje levným
 * read-only dotazem bez restartu, takže stačí krátký pevný interval: nové
 * účty koupené pod stejným loginem se načtou do pár minut, ne za 6 h (8. 10.).
 */
export const EMPTY_DIRECTORY_ERROR = 'adresář účtů je prázdný (propfirma účty skryla nebo zavřela)';
export const EMPTY_DIRECTORY_RETRY_MS = 3 * 60_000;
const isEmptyDirectoryError = (error: unknown) => (
  (error instanceof Error ? error.message : String(error)).includes(EMPTY_DIRECTORY_ERROR)
);

export function recordConnectionDiscoveryFailure(
  state: ConnectionDiscoveryState,
  connectionId: string,
  error: unknown,
  now: number,
): ConnectionDiscoveryState {
  const attempts = (state.failures[connectionId]?.attempts ?? 0) + 1;
  return {
    ...state,
    version: 1,
    failures: {
      ...state.failures,
      [connectionId]: {
        attempts,
        nextAttemptAt: now + (isEmptyDirectoryError(error)
          ? EMPTY_DIRECTORY_RETRY_MS
          : connectionDiscoveryBackoffMs(attempts)),
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
  return { ...state, version: 1, failures };
}

/** Selhání s prázdným adresářem: ověřuje se read-only sondou, ne restartem. */
export const failedWithEmptyDirectory = (state: ConnectionDiscoveryState, connectionId: string): boolean => (
  state.failures[connectionId]?.lastError.includes(EMPTY_DIRECTORY_ERROR) === true
);

/**
 * Změna adresáře účtů načteného připojení (8. 10. 2026). Nové účty koupené
 * pod existujícím loginem worker dřív neviděl až do ručního restartu.
 * Změna se bere jako skutečná až po dvou shodných čteních za sebou, aby
 * jednorázový výpadek Tradovate (prázdný list) nespustil restart.
 */
export interface AccountDirectoryWatch {
  /** Kandidát změny z minulého čtení: připojení → seřazená ID. */
  pending: Map<string, string>;
}

export const createAccountDirectoryWatch = (): AccountDirectoryWatch => ({ pending: new Map() });

/** Klíč účtu v adresáři: ID a zda je použitelný (active && canTrade). */
export const directoryKey = (accountId: number, usable: boolean): string => `${accountId}${usable ? '' : ':inactive'}`;

export function evaluateAccountDirectory(options: {
  watch: AccountDirectoryWatch;
  connectionId: string;
  knownKeys: readonly string[];
  currentKeys: readonly string[];
}): { changed: false } | { changed: true; added: string[]; removed: string[] } {
  const known = new Set(options.knownKeys);
  const current = new Set(options.currentKeys);
  const added = [...current].filter(key => !known.has(key)).sort();
  const removed = [...known].filter(key => !current.has(key)).sort();
  if (added.length === 0 && removed.length === 0) {
    options.watch.pending.delete(options.connectionId);
    return { changed: false };
  }
  const signature = [...current].sort().join(',');
  if (options.watch.pending.get(options.connectionId) !== signature) {
    options.watch.pending.set(options.connectionId, signature);
    return { changed: false };
  }
  return { changed: true, added, removed };
}

/** Restart kvůli adresáři nejvýš jednou za 10 min (ochrana proti smyčce). */
export const DIRECTORY_RESTART_MIN_INTERVAL_MS = 10 * 60_000;
export const directoryRestartAllowed = (state: ConnectionDiscoveryState, now: number): boolean => (
  state.directoryRestartAt == null || now - state.directoryRestartAt >= DIRECTORY_RESTART_MIN_INTERVAL_MS
);

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
  /** Připojení z manifestu. */
  manifestConnectionIds: readonly string[];
  /**
   * Jen se scope `owner` vrací server úplný seznam připojení vlastníka; pak
   * je zmizení i manifestového připojení důkaz odpojení. Se scope
   * `connection` vrací jen připojení zařízení, ostatní tedy neposuzujeme.
   */
  scope: 'owner' | 'connection';
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
      .filter(connectionId => !server.has(connectionId) && (options.scope === 'owner' || !manifest.has(connectionId)))
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
    return {
      version: 1,
      failures,
      ...(Number.isFinite(parsed.directoryRestartAt) ? { directoryRestartAt: parsed.directoryRestartAt } : {}),
    };
  } catch {
    return emptyConnectionDiscoveryState();
  }
}

export async function saveConnectionDiscoveryState(path: string, state: ConnectionDiscoveryState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
