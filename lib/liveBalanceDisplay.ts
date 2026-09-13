import { tradovateDisplayTradeDate } from './tradovateDisplayDay';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { sameTradovateSession } from '../services/copierArmSession';
import { isLiveAccountReadVerified } from './liveReadFreshness';

export interface LiveBalanceDisplay {
  value: number | null;
  stale: boolean;
  confirmedAt: string | null;
}

/** Presentation only: retained cash is not fresh risk/execution evidence. */
export function liveBalanceDisplay(account: LiveAccount | null | undefined, now = Date.now()): LiveBalanceDisplay {
  const missing: LiveBalanceDisplay = { value: null, stale: false, confirmedAt: null };
  if (!account || account.cashAvailability === 'denied') return missing;
  const confirmed = confirmedField(account, 'totalCashValue', now);
  if (confirmed) return confirmed;
  if (!Number.isFinite(account.balance)) return missing;
  // Legacy shadow snapshots have no per-source freshness contract.
  if (account.cashAvailability == null) return { value: account.balance, stale: false, confirmedAt: null };
  const at = Date.parse(account.cashUpdatedAt ?? '');
  // Failed reads can contain a numeric zero fallback. Only a retained evidence
  // timestamp proves a balance was actually loaded before that failure.
  if (!Number.isFinite(at) || at > now + 1_000) return missing;
  return { value: account.balance, stale: !isLiveAccountReadVerified(account, 'cash', now), confirmedAt: account.cashUpdatedAt! };
}

export function liveCapitalDisplay(accounts: Array<LiveAccount | null | undefined>, now = Date.now()): LiveBalanceDisplay {
  const values = accounts.map(account => liveBalanceDisplay(account, now));
  if (!values.length || values.some(item => item.value == null)) return { value: null, stale: false, confirmedAt: null };
  const times = values.flatMap(item => item.confirmedAt ? [item.confirmedAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { value: values.reduce((sum, item) => sum + item.value!, 0), stale: values.some(item => item.stale), confirmedAt: times[0] ?? null };
}

/** A display update never changes the original account's risk freshness. */
function confirmedField(account: LiveAccount, field: 'totalCashValue' | 'dailyRealizedPnL', now: number): LiveBalanceDisplay | null {
  const entry = account.displayValues?.[field];
  if (!entry || !Number.isFinite(entry.value)) return null;
  const requested = Date.parse(entry.requestedAt);
  const confirmed = Date.parse(entry.confirmedAt);
  const raw = Date.parse((field === 'dailyRealizedPnL' ? account.dailyPnlUpdatedAt : account.cashUpdatedAt) ?? '');
  if (!Number.isFinite(requested) || !Number.isFinite(confirmed) || confirmed < requested || confirmed > now + 1_000 || (Number.isFinite(raw) && requested <= raw)) return null;
  if (field === 'dailyRealizedPnL' && (!sameTradovateSession(requested, now) || !sameTradovateSession(confirmed, now))) return null;
  return { value: entry.value, stale: now - confirmed > 45_000, confirmedAt: entry.confirmedAt };
}

export function liveDailyPnlDisplay(account: LiveAccount | null | undefined, now = Date.now(), pending = false): LiveBalanceDisplay {
  const missing = { value: null, stale: false, confirmedAt: null };
  if (!account || account.cashAvailability === 'denied') return missing;
  const confirmed = confirmedField(account, 'dailyRealizedPnL', now);
  if (confirmed) return confirmed;
  if (!Number.isFinite(account.realizedPnl) || account.dailyPnlAvailable === false || (pending && account.dailyPnlAvailable !== true)) return missing;
  if (account.cashAvailability == null) return { value: account.realizedPnl, stale: false, confirmedAt: null };
  if (account.dailyPnlTradeDate && account.dailyPnlTradeDate !== tradovateDisplayTradeDate(now)) return missing;
  const at = Date.parse(account.dailyPnlUpdatedAt ?? account.cashUpdatedAt ?? '');
  if (!Number.isFinite(at) || at > now + 1_000 || !sameTradovateSession(at, now)) return missing;
  return { value: account.realizedPnl, stale: !isLiveAccountReadVerified(account, 'cash', now), confirmedAt: account.dailyPnlUpdatedAt ?? account.cashUpdatedAt! };
}

export function liveGroupDailyPnlDisplay(accounts: Array<LiveAccount | null | undefined>, now = Date.now(), pending = false): number | null {
  const values = accounts.map(account => liveDailyPnlDisplay(account, now, pending).value);
  return !values.length || values.some(value => value == null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}
