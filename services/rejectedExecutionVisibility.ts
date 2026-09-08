import type { CopierRejectedExecution } from './copierEngine';
import { sameTradovateSession, tradovateSessionEndAt } from './copierArmSession';

/**
 * Viditelnost řádku „odmítnutý příkaz" pod účtem v LIVE.
 *
 * Pravidlo: nevyřešené odmítnutí (follower není potvrzeně flat) je vidět vždy,
 * bez ohledu na stáří — to je bezpečnostní informace. Vyřešené odmítnutí je
 * kontext k dnešní seanci: zmizí s koncem Tradovate session (17:00 CT), nebo
 * dřív, když ho uživatel zavře křížkem. Zavření platí jen na tomto zařízení
 * a jen do konce session, worker se nemění.
 */
export type RejectedExecutionVisibility = 'visible' | 'expired' | 'dismissed';

export const rejectedExecutionDismissKey = (accountId: number, execution: Pick<CopierRejectedExecution, 'at' | 'brokerOrderId'>): string =>
  `${accountId}:${execution.brokerOrderId ?? ''}:${execution.at}`;

export const rejectedExecutionResolved = (
  execution: Pick<CopierRejectedExecution, 'resolution'>,
  accountAuthoritativelyFlat: boolean,
): boolean => {
  const kind = execution.resolution?.kind;
  return kind === 'follower-flat' || kind === 'guard-flattened' || kind === 'auto-closed' || accountAuthoritativelyFlat;
};

export function rejectedExecutionVisibility(input: {
  accountId: number;
  execution: Pick<CopierRejectedExecution, 'at' | 'brokerOrderId' | 'resolution'>;
  accountAuthoritativelyFlat: boolean;
  dismissed: ReadonlySet<string>;
  now: number;
}): RejectedExecutionVisibility {
  if (!rejectedExecutionResolved(input.execution, input.accountAuthoritativelyFlat)) return 'visible';
  if (input.dismissed.has(rejectedExecutionDismissKey(input.accountId, input.execution))) return 'dismissed';
  const resolvedAt = input.execution.resolution?.at ?? input.execution.at;
  if (!sameTradovateSession(resolvedAt, input.now)) return 'expired';
  return 'visible';
}

// ---------------------------------------------------------------------------
// Úložiště zavřených odmítnutí: module-level store pro useSyncExternalStore,
// persistované v localStorage jen do konce session.

const STORAGE_KEY = 'at:live:rejection-dismissed';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const resolveStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

let storage: StorageLike | null | undefined;
let entries: Map<string, number> | null = null;
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const load = (now: number): Map<string, number> => {
  if (entries) return entries;
  entries = new Map();
  storage = storage === undefined ? resolveStorage() : storage;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    for (const [key, until] of Object.entries(parsed)) {
      if (typeof until === 'number' && until > now) entries.set(key, until);
    }
  } catch {
    // Poškozený záznam = žádná zavřená odmítnutí; nic horšího se stát nemůže.
  }
  snapshot = new Set(entries.keys());
  return entries;
};

const persist = () => {
  if (!entries) return;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Bez úložiště zůstane zavření jen v paměti této záložky.
  }
  snapshot = new Set(entries.keys());
  listeners.forEach(listener => listener());
};

export const getDismissedRejections = (): ReadonlySet<string> => {
  load(Date.now());
  return snapshot;
};

export const subscribeDismissedRejections = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Zavře odmítnutí do konce aktuální Tradovate session. */
export const dismissRejection = (key: string, now = Date.now()): void => {
  const current = load(now);
  for (const [existing, until] of current) {
    if (until <= now) current.delete(existing);
  }
  current.set(key, tradovateSessionEndAt(now));
  persist();
};

/** Jen pro testy: vymění úložiště a vyprázdní paměť. */
export const __resetDismissedRejectionsForTests = (nextStorage: StorageLike | null = null): void => {
  storage = nextStorage;
  entries = null;
  snapshot = new Set();
};
