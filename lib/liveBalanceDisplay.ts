import { tradovateDisplayTradeDate } from './tradovateDisplayDay';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { sameTradovateSession } from '../services/copierArmSession';
import { isLiveAccountReadVerified, LIVE_READ_MAX_AGE_MS } from './liveReadFreshness';

export interface LiveBalanceDisplay {
  value: number | null;
  stale: boolean;
  confirmedAt: string | null;
}

export type LiveRiskDisplayState = 'ready' | 'loading' | 'unavailable' | 'unknown-limit' | 'no-limit';

/**
 * Prokazatelně přečtený denní report BEZ záznamu pro dnešek = žádný uzavřený
 * obchod. Důkazem musí být čas čtení DENNÍHO reportu (`dailyPnlUpdatedAt`,
 * tedy `readState.dailyAsOf`) v aktuální broker session — ne čerstvost čtení
 * zůstatku. Zůstatek a denní report chodí z jiných endpointů: cash může být
 * čerstvý, zatímco denní se ještě nenačetl, a z toho by „nic se neobchodovalo“
 * byla domněnka vydávaná za fakt.
 */
export function liveDayReadAnswered(account: LiveAccount, now = Date.now(), pending = false): boolean {
  if (pending || account.dailyPnlAvailable !== false) return false;
  const readAt = Date.parse(account.dailyPnlUpdatedAt ?? '');
  return Number.isFinite(readAt) && readAt <= now + 1_000 && sameTradovateSession(readAt, now);
}


export interface LiveDailyLossDisplay extends LiveBalanceDisplay {
  state: LiveRiskDisplayState;
  reason: string | null;
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
  return { value: entry.value, stale: now - confirmed > LIVE_READ_MAX_AGE_MS, confirmedAt: entry.confirmedAt };
}

export function liveDailyPnlDisplay(account: LiveAccount | null | undefined, now = Date.now(), pending = false): LiveBalanceDisplay {
  const missing = { value: null, stale: false, confirmedAt: null };
  if (!account) return missing;
  const confirmed = confirmedField(account, 'dailyRealizedPnL', now);
  if (confirmed) return confirmed;
  if (account.cashAvailability === 'denied') return missing;
  pending ||= account.dailyPnlPending === true;
  if (!Number.isFinite(account.realizedPnl) || account.dailyPnlAvailable === false || (pending && account.dailyPnlAvailable !== true)) return missing;
  if (account.cashAvailability == null) return { value: account.realizedPnl, stale: false, confirmedAt: null };
  if (account.dailyPnlTradeDate && account.dailyPnlTradeDate !== tradovateDisplayTradeDate(now)) return missing;
  const at = Date.parse(account.dailyPnlUpdatedAt ?? account.cashUpdatedAt ?? '');
  if (!Number.isFinite(at) || at > now + 1_000 || !sameTradovateSession(at, now)) return missing;
  return { value: account.realizedPnl, stale: now - at > LIVE_READ_MAX_AGE_MS, confirmedAt: account.dailyPnlUpdatedAt ?? account.cashUpdatedAt! };
}

const oldestConfirmedInput = (values: Array<string | null | undefined>, now: number): string | null => {
  const parsed = values.map(value => ({ value, at: Date.parse(value ?? '') }));
  if (parsed.some(item => !item.value || !Number.isFinite(item.at) || item.at > now + 1_000)) return null;
  return parsed.sort((a, b) => a.at - b.at)[0]?.value ?? null;
};

/** Presentation-only DLL remaining. Every number and timestamp belongs to an
 * input actually used by the formula; cash freshness is deliberately absent. */
export function liveDailyLossRemainingDisplay(
  account: LiveAccount | null | undefined,
  now = Date.now(),
  pending = false,
): LiveDailyLossDisplay {
  if (!account) return { value: null, stale: false, confirmedAt: null, state: 'unavailable', reason: 'Účet není v aktuálním OAuth snapshotu.' };
  pending ||= account.dailyPnlPending === true;
  const limit = account.dailyLossLimit;
  if (account.riskDisplayDailyLossDisabled && (limit == null || limit === 0)) {
    return { value: null, stale: false, confirmedAt: null, state: 'no-limit', reason: 'Potvrzený plán nemá denní limit ztráty.' };
  }
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return {
      value: null, stale: false, confirmedAt: null,
      state: pending ? 'loading' : 'unknown-limit',
      reason: pending ? 'Načítá se risk limit tohoto připojení.' : account.riskDisplayUnavailableReason ?? 'Tradovate ani profil nepotvrdily denní limit ztráty.',
    };
  }
  let realized = liveDailyPnlDisplay(account, now, pending);
  // Denní report je v aktuální session přečtený a dnešní záznam v něm není:
  // prokazatelně žádný uzavřený obchod, realizované P&L dne je 0 (stejné
  // pravidlo jako sloupec „Dnes“). DLL zbývá je pak celý limit + otevřený P&L.
  if (realized.value == null && liveDayReadAnswered(account, now, pending)) {
    const readAt = account.dailyPnlUpdatedAt!;
    realized = { value: 0, stale: now - Date.parse(readAt) > LIVE_READ_MAX_AGE_MS, confirmedAt: readAt };
  }
  if (realized.value == null) {
    return {
      value: null, stale: false, confirmedAt: null,
      state: pending ? 'loading' : 'unavailable',
      reason: pending
        ? 'Načítá se denní P&L tohoto připojení.'
        : account.dailyPnlUnavailableReason ?? 'Tradovate nepotvrdil realizované P&L pro aktuální obchodní den.',
    };
  }
  if (!Number.isFinite(account.unrealizedPnl)) {
    return { value: null, stale: false, confirmedAt: null, state: 'unavailable', reason: 'Otevřený P&L není dostupný.' };
  }
  const confirmedAt = oldestConfirmedInput([
    realized.confirmedAt,
    account.unrealizedPnlUpdatedAt,
    ...(account.dailyLossLimitSource === 'profile' ? [] : [account.dailyLossLimitUpdatedAt]),
  ], now);
  if (!confirmedAt) {
    return {
      value: null, stale: false, confirmedAt: null,
      state: pending ? 'loading' : 'unavailable',
      reason: pending ? 'Načítají se časy vstupů pro DLL.' : 'Čas realizovaného P&L, otevřeného P&L nebo limitu není potvrzený.',
    };
  }
  const at = Date.parse(confirmedAt);
  return {
    value: limit + realized.value + account.unrealizedPnl,
    stale: realized.stale || account.unrealizedPnlSource === 'stale' || now - at > LIVE_READ_MAX_AGE_MS,
    confirmedAt,
    state: 'ready',
    reason: null,
  };
}

export function liveGroupDailyPnlDisplay(accounts: Array<LiveAccount | null | undefined>, now = Date.now(), pending = false): number | null {
  const values = accounts.map(account => liveDailyPnlDisplay(account, now, pending).value);
  return !values.length || values.some(value => value == null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}
