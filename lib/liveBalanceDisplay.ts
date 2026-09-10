import type { LiveAccount } from '../services/tradecopiaLiveService';
import { isLiveAccountReadVerified } from './liveReadFreshness';

export interface LiveBalanceDisplay {
  value: number | null;
  stale: boolean;
  confirmedAt: string | null;
}

/** Presentation only: retained cash is not fresh risk/execution evidence. */
export function liveBalanceDisplay(account: LiveAccount | null | undefined, now = Date.now()): LiveBalanceDisplay {
  const missing: LiveBalanceDisplay = { value: null, stale: false, confirmedAt: null };
  if (!account || !Number.isFinite(account.balance) || account.cashAvailability === 'denied') return missing;
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
