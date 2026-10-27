import type { TradovateAccountDisplayFeedState, TradovateAccountDisplaySnapshot } from './tradovateAccountDisplayTypes.js';

type Field = keyof TradovateAccountDisplaySnapshot['fields'];
export interface ConfirmedDisplayValue { value: number; requestedAt: string; confirmedAt: string }
export type AccountDisplayValues = Partial<Record<Field, ConfirmedDisplayValue>>;
export type AccountDisplayCache = Record<string, AccountDisplayValues>;
const fields: Field[] = ['dailyRealizedPnL', 'totalCashValue', 'totalCashValueSOD', 'realizedPnL', 'netLiq', 'openPnL'];

/** Merge only into display state. No risk timestamps or account execution fields are modified. */
export function mergeTradovateAccountDisplay(
  previous: AccountDisplayCache,
  feeds: readonly TradovateAccountDisplayFeedState[],
  membership: ReadonlyMap<string, { environment: 'demo' | 'live'; accountIds: ReadonlySet<number> }>,
  now = Date.now(),
): AccountDisplayCache {
  const next: AccountDisplayCache = {};
  for (const [key, value] of Object.entries(previous)) {
    const separator = key.lastIndexOf(':');
    const prefix = key.slice(0, separator);
    const environmentSeparator = prefix.indexOf(':');
    const environment = prefix.slice(0, environmentSeparator);
    const connectionId = prefix.slice(environmentSeparator + 1);
    const accountId = Number(key.slice(separator + 1));
    if (membership.get(connectionId)?.environment === environment && membership.get(connectionId)?.accountIds.has(accountId)) next[key] = value;
  }
  for (const feed of feeds.slice(0, 100)) {
    if (!feed || typeof feed !== 'object') continue;
    const connection = membership.get(feed.connectionId);
    if (!connection || feed.environment !== connection.environment || !Array.isArray(feed.snapshots)) continue;
    for (const snapshot of feed.snapshots.slice(0, 100)) {
      if (!snapshot || typeof snapshot !== 'object') continue;
      if (snapshot.connectionId !== feed.connectionId || snapshot.environment !== connection.environment || !connection.accountIds.has(snapshot.accountId)) continue;
      const requestedAt = Date.parse(snapshot.requestedAt);
      const confirmedAt = Date.parse(snapshot.confirmedAt);
      if (!Number.isFinite(requestedAt) || !Number.isFinite(confirmedAt) || confirmedAt < requestedAt || confirmedAt > now + 1_000) continue;
      const key = `${feed.environment}:${feed.connectionId}:${snapshot.accountId}`;
      const values = { ...next[key] };
      for (const field of fields) {
        const value = snapshot.fields?.[field];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const old = values[field];
        if (old && Date.parse(old.requestedAt) >= requestedAt) continue;
        values[field] = { value, requestedAt: snapshot.requestedAt, confirmedAt: snapshot.confirmedAt };
      }
      next[key] = values;
    }
  }
  return next;
}

/** Částka, za kterou worker ručí k času svého statusu (od potvrzení ji nic nezměnilo). */
export interface VouchedDisplayValue { value: number; confirmedAt: string; vouchedAt: string }
export type AccountDisplayVouch = Partial<Record<'dailyRealizedPnL' | 'totalCashValue', VouchedDisplayValue>>;
/** Audit workeru čte každý účet nejpozději po 10 minutách; stejné okno drží záložní poller. */
export const DISPLAY_VOUCH_MAX_SNAPSHOT_AGE_MS = 11 * 60_000;

/**
 * Worker ručí za nezměněnou částku, dokud má připojený stream účtu: broker
 * pošle událost při každé změně a worker po ní účet hned přečte. Feed bez
 * chyby, účet bez čekajícího čtení a snímek mladší než audit = částka platí
 * i k času statusu workeru (`vouchedAt`), ne jen k poslednímu čtení.
 * Relay vrací feedy všech spojení z každého spojení, takže jedno spojení může
 * přijít ve více kopiích různého stáří: ručí se jen, když jsou zdravé VŠECHNY
 * a účet nikde nečeká; částka je z nejnovějšího snímku.
 * Jen zobrazení (INV-UI-03): nic z toho není risk ani execution důkaz.
 */
export function vouchedTradovateAccountDisplay(
  feeds: readonly TradovateAccountDisplayFeedState[],
  membership: ReadonlyMap<string, { environment: 'demo' | 'live'; accountIds: ReadonlySet<number> }>,
  vouchedAt: number,
  now = Date.now(),
): Record<string, AccountDisplayVouch> {
  const vouches: Record<string, AccountDisplayVouch> = {};
  if (!Number.isFinite(vouchedAt) || vouchedAt > now + 1_000) return vouches;
  const { unhealthy, pending, newest } = displayFeedCopies(feeds, membership);
  const at = new Date(vouchedAt).toISOString();
  for (const [key, snapshot] of newest) {
    const prefix = key.slice(0, key.lastIndexOf(':'));
    if (unhealthy.has(prefix) || pending.get(prefix)?.has(snapshot.accountId)) continue;
    const requestedAt = Date.parse(snapshot.requestedAt);
    const confirmedAt = Date.parse(snapshot.confirmedAt);
    if (confirmedAt < requestedAt || confirmedAt > vouchedAt + 1_000 || vouchedAt - confirmedAt > DISPLAY_VOUCH_MAX_SNAPSHOT_AGE_MS) continue;
    const vouch: AccountDisplayVouch = {};
    for (const field of VOUCH_FIELDS) {
      const value = snapshot.fields?.[field];
      if (typeof value === 'number' && Number.isFinite(value)) vouch[field] = { value, confirmedAt: snapshot.confirmedAt, vouchedAt: at };
    }
    if (Object.keys(vouch).length) vouches[key] = vouch;
  }
  return vouches;
}

/**
 * Další stav ručení po přijatém statusu workeru. Čekající čtení (i audit)
 * ručení jen neprodlouží — poslední dobíhá stejných 45 s jako běžné čtení, aby
 * čísla při auditu neblikala. Skutečný výpadek ho ruší hned: spojení bez
 * feedu (restart workeru, odpadlé spojení), bez streamu nebo v backoffu,
 * a pole, u kterého nejnovější snímek nese jinou částku.
 */
export function nextTradovateDisplayVouches(
  previous: Readonly<Record<string, AccountDisplayVouch>>,
  feeds: readonly TradovateAccountDisplayFeedState[],
  membership: ReadonlyMap<string, { environment: 'demo' | 'live'; accountIds: ReadonlySet<number> }>,
  vouchedAt: number,
  now = Date.now(),
): Record<string, AccountDisplayVouch> {
  const { present, down, newest } = displayFeedCopies(feeds, membership);
  const next: Record<string, AccountDisplayVouch> = {};
  for (const [key, vouch] of Object.entries(previous)) {
    const prefix = key.slice(0, key.lastIndexOf(':'));
    if (!present.has(prefix) || down.has(prefix)) continue;
    const latest = newest.get(key)?.fields;
    const kept: AccountDisplayVouch = {};
    for (const field of VOUCH_FIELDS) {
      const entry = vouch[field];
      const value = latest?.[field];
      if (entry && !(typeof value === 'number' && Number.isFinite(value) && Math.abs(value - entry.value) >= 0.005)) kept[field] = entry;
    }
    if (Object.keys(kept).length) next[key] = kept;
  }
  for (const [key, vouch] of Object.entries(vouchedTradovateAccountDisplay(feeds, membership, vouchedAt, now))) {
    const merged: AccountDisplayVouch = { ...next[key] };
    for (const field of VOUCH_FIELDS) {
      const fresh = vouch[field];
      const old = merged[field];
      if (fresh && !(old && old.value === fresh.value && Date.parse(old.vouchedAt) > Date.parse(fresh.vouchedAt))) merged[field] = fresh;
    }
    next[key] = merged;
  }
  return next;
}

const VOUCH_FIELDS = ['dailyRealizedPnL', 'totalCashValue'] as const;

/** Kopie feedů podle spojení: zdraví, čekající účty a nejnovější platný snímek účtu. */
function displayFeedCopies(
  feeds: readonly TradovateAccountDisplayFeedState[],
  membership: ReadonlyMap<string, { environment: 'demo' | 'live'; accountIds: ReadonlySet<number> }>,
) {
  const present = new Set<string>();
  const down = new Set<string>();
  const unhealthy = new Set<string>();
  const pending = new Map<string, Set<number>>();
  const newest = new Map<string, TradovateAccountDisplaySnapshot>();
  for (const feed of feeds.slice(0, 100)) {
    if (!feed || typeof feed !== 'object') continue;
    const connection = membership.get(feed.connectionId);
    if (!connection || feed.environment !== connection.environment) continue;
    const prefix = `${feed.environment}:${feed.connectionId}`;
    present.add(prefix);
    if (feed.streamConnected !== true || feed.retryAt) down.add(prefix);
    if (feed.streamConnected !== true || feed.retryAt || feed.lastErrorAt) unhealthy.add(prefix);
    const waiting = pending.get(prefix) ?? new Set<number>();
    for (const accountId of Array.isArray(feed.pendingAccountIds) ? feed.pendingAccountIds : []) waiting.add(accountId);
    pending.set(prefix, waiting);
    if (!Array.isArray(feed.snapshots)) { unhealthy.add(prefix); continue; }
    for (const snapshot of feed.snapshots.slice(0, 100)) {
      if (!snapshot || typeof snapshot !== 'object') continue;
      if (snapshot.connectionId !== feed.connectionId || snapshot.environment !== connection.environment || !connection.accountIds.has(snapshot.accountId)) continue;
      const requestedAt = Date.parse(snapshot.requestedAt);
      if (!Number.isFinite(requestedAt) || !Number.isFinite(Date.parse(snapshot.confirmedAt))) continue;
      const key = `${prefix}:${snapshot.accountId}`;
      const current = newest.get(key);
      if (!current || requestedAt > Date.parse(current.requestedAt)) newest.set(key, snapshot);
    }
  }
  return { present, down, unhealthy, pending, newest };
}
