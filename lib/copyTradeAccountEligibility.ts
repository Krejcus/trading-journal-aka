import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type { CopierAccountEligibility } from '../services/copierEngine';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const eligibilitySeverity: Record<CopierAccountEligibility['state'], number> = {
  active: 0,
  'dll-locked': 1,
  unverifiable: 2,
  breached: 3,
};

const observedAt = (account: LiveAccount): number => {
  const parsed = account.updatedAt ? Date.parse(account.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Konzervativní read-model pro chvíli, kdy web nemá dostupný stav Mac
 * workeru nebo zobrazuje jinou uloženou skupinu než execution runtime.
 *
 * Nehádá broker status. Používá pouze dvě uživatelsky ověřitelné hranice:
 * skutečný drawdown floor z LIVE snapshotu a explicitně nastavený DLL.
 * Vrací jen odchylky od aktivního stavu; neznámý účet se dál neposuzuje.
 */
export function inferredCopyTradeAccountEligibility(
  accounts: readonly LiveAccount[],
  profiles: readonly TradovateAccountProfile[],
): CopierAccountEligibility[] {
  const profilesByAccount = new Map<number, TradovateAccountProfile>();
  for (const profile of profiles) {
    const accountId = Number(profile.externalAccountId);
    if (Number.isSafeInteger(accountId)) profilesByAccount.set(accountId, profile);
  }

  const inferred: CopierAccountEligibility[] = [];
  for (const account of accounts) {
    const at = observedAt(account);
    if (account.cushion != null && Number.isFinite(account.cushion) && account.cushion <= 0) {
      inferred.push({
        accountId: account.id,
        state: 'breached',
        at,
        reason: `LIVE equity dosáhla drawdown flooru (rezerva ${account.cushion.toFixed(2)} USD)`,
      });
      continue;
    }

    const dailyLossLimit = profilesByAccount.get(account.id)?.dailyLossLimit
      ?? account.dailyLossLimit;
    const currentDailyPnl = account.realizedPnl + account.unrealizedPnl;
    if (
      dailyLossLimit != null
      && Number.isFinite(dailyLossLimit)
      && dailyLossLimit > 0
      && Number.isFinite(currentDailyPnl)
      && currentDailyPnl <= -dailyLossLimit
    ) {
      inferred.push({
        accountId: account.id,
        state: 'dll-locked',
        at,
        reason: `LIVE denní P&L ${currentDailyPnl.toFixed(2)} USD dosáhlo nastavený DLL ${dailyLossLimit.toFixed(2)} USD`,
      });
    }
  }
  return inferred;
}

/**
 * Durable broker/runtime klasifikace je autoritativní. LIVE inference ji
 * pouze doplní, když worker není dosažitelný, nebo ji bezpečně zpřísní,
 * pokud LIVE čísla prokazují závažnější stav.
 */
export function effectiveCopyTradeAccountEligibility(
  accounts: readonly LiveAccount[],
  profiles: readonly TradovateAccountProfile[],
  runtimeEligibility: readonly CopierAccountEligibility[],
): CopierAccountEligibility[] {
  const merged = new Map<number, CopierAccountEligibility>(
    runtimeEligibility.map(entry => [entry.accountId, entry]),
  );

  for (const inferred of inferredCopyTradeAccountEligibility(accounts, profiles)) {
    const runtime = merged.get(inferred.accountId);
    if (!runtime || eligibilitySeverity[inferred.state] > eligibilitySeverity[runtime.state]) {
      merged.set(inferred.accountId, inferred);
    }
  }

  return [...merged.values()];
}
