import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type { CopierAccountEligibility } from '../services/copierEngine';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { tradovateDisplayTradeDate } from './tradovateDisplayDay';
import { liveDailyPnlDisplay } from './liveBalanceDisplay';
import { liveDayReadAnswered } from './liveDaySummary';

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
  now = Date.now(),
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
    const displayedRealized = liveDailyPnlDisplay(account, now).value;
    const realizedCandidates = [account.realizedPnl, displayedRealized]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const conservativeRealized = realizedCandidates.length > 0 ? Math.min(...realizedCandidates) : Number.NaN;
    const currentDailyPnl = conservativeRealized + account.unrealizedPnl;
    if (
      dailyLossLimit != null
      && Number.isFinite(dailyLossLimit)
      && dailyLossLimit > 0
      && account.dailyPnlAvailable === true
      && account.dailyPnlTradeDate === tradovateDisplayTradeDate(now)
      && account.unrealizedPnlSource !== 'stale'
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
  now = Date.now(),
): CopierAccountEligibility[] {
  const merged = new Map<number, CopierAccountEligibility>(
    runtimeEligibility.map(entry => [entry.accountId, entry]),
  );

  for (const inferred of inferredCopyTradeAccountEligibility(accounts, profiles, now)) {
    const runtime = merged.get(inferred.accountId);
    if (!runtime || eligibilitySeverity[inferred.state] > eligibilitySeverity[runtime.state]) {
      merged.set(inferred.accountId, inferred);
    }
  }

  return [...merged.values()];
}

/**
 * Účty, u kterých LIVE zatím nemůže rozhodnout o DLL: mají nastavený denní
 * limit, ale dnešní denní report brokera ještě nebyl přečten (první rychlé
 * načtení ho nečte, doplní ho až plné). Jejich „aktivní“ stav — i když ho
 * hlásí worker — je jen předběžný; DLL zámek může dorazit vzápětí. Slouží
 * VÝHRADNĚ zobrazení („Ověřuji“), bezpečnostní logiku nemění.
 */
export function copyTradeDailyLossPendingAccountIds(
  accounts: readonly LiveAccount[],
  profiles: readonly TradovateAccountProfile[],
  now = Date.now(),
  profilesLoaded = true,
): Set<number> {
  // Bez plánů účtů nevíme, který účet DLL (či drawdown floor) vůbec má —
  // „aktivní“ by bylo jen předběžné.
  if (!profilesLoaded) return new Set(accounts.map(account => account.id));
  const limits = new Map<number, number | null | undefined>();
  for (const profile of profiles) {
    const accountId = Number(profile.externalAccountId);
    if (Number.isSafeInteger(accountId)) limits.set(accountId, profile.dailyLossLimit);
  }
  const today = tradovateDisplayTradeDate(now);
  const pending = new Set<number>();
  for (const account of accounts) {
    const dailyLossLimit = limits.get(account.id) ?? account.dailyLossLimit;
    if (dailyLossLimit == null || !Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0) continue;
    if (account.dailyPnlAvailable === true && account.dailyPnlTradeDate === today) continue;
    if (liveDayReadAnswered(account, now)) continue;
    pending.add(account.id);
  }
  return pending;
}
