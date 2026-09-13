import type { AccountDisplayCache, AccountDisplayValues } from './tradovateAccountDisplayMerge';
import { tradovateDisplayTradeDate } from './tradovateDisplayDay';

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
const prefix = 'alphatrade:tradovate-display:v1:';
const maxAge = 24 * 60 * 60 * 1_000;
function sessionStorageSafe(): StorageLike | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

/** Only display amounts, scoped to the signed-in user; never restore execution state. */
function sanitize(input: unknown, now: number): AccountDisplayCache {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: AccountDisplayCache = {};
  for (const [key, raw] of Object.entries(input).slice(0, 1_000)) {
    if (!/^(demo|live):[^:]+:[1-9]\d*$/.test(key) || !raw || typeof raw !== 'object') continue;
    const values: AccountDisplayValues = {};
    for (const field of ['totalCashValue', 'dailyRealizedPnL'] as const) {
      const entry = (raw as AccountDisplayValues)[field];
      if (!entry || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) continue;
      const requested = Date.parse(entry.requestedAt);
      const confirmed = Date.parse(entry.confirmedAt);
      if (!Number.isFinite(requested) || !Number.isFinite(confirmed) || confirmed < requested
        || confirmed > now + 1_000 || requested < now - maxAge) continue;
      if (field === 'dailyRealizedPnL' && (tradovateDisplayTradeDate(requested) !== tradovateDisplayTradeDate(now)
        || tradovateDisplayTradeDate(confirmed) !== tradovateDisplayTradeDate(now))) continue;
      values[field] = { value: entry.value, requestedAt: entry.requestedAt, confirmedAt: entry.confirmedAt };
    }
    if (Object.keys(values).length) result[key] = values;
  }
  return result;
}
export function readTradovateDisplaySession(userId: string, storage = sessionStorageSafe(), now = Date.now()): AccountDisplayCache {
  if (!userId || !storage) return {};
  try { return sanitize(JSON.parse(storage.getItem(prefix + userId) ?? 'null'), now); } catch { return {}; }
}
export function writeTradovateDisplaySession(userId: string, values: AccountDisplayCache, storage = sessionStorageSafe(), now = Date.now()): void {
  if (!userId || !storage) return;
  try { storage.setItem(prefix + userId, JSON.stringify(sanitize(values, now))); } catch { /* Optional display cache. */ }
}
