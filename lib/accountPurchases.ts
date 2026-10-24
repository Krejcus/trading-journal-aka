/**
 * Účty × Byznys bez duplicit.
 *
 * Peníze (nákupy, výplaty) žijí jen v Byznysu; účty jen svůj životní cyklus.
 * Cena účtu se nezadává — dopočítá se z nákupu v Byznysu, ke kterému se účet
 * spáruje podle firmy, počtu a data („5× Lucid 50k, 22. 10.“ = 5 nových Lucid
 * účtů kolem 22. 10., každý za 1/5 částky). Párování je deterministické a jen
 * pro zobrazení; nic se z něj nezapisuje.
 */

import type { Account, BusinessExpense, BusinessPayout, Trade } from '../types';
import { accountFirmKey, purchaseParts } from './businessFirms';

export { purchaseParts, type PurchasePart } from './businessFirms';

const DAY_MS = 86_400_000;

/** Nákup účtu (ne aktivace funded účtu ani software). */
export const isAccountPurchase = (expense: Pick<BusinessExpense, 'category' | 'label'>): boolean =>
  expense.category === 'Challenges' && !/aktivac|activation/i.test(expense.label || '');

export interface AccountPurchase {
  expenseId: string;
  date: string;
  label: string;
  /** Podíl nákupu na jeden účet. */
  price: number;
  /** Datum sedí do 3 dnů; jinak jen návrh k potvrzení. */
  sure: boolean;
}

export interface PurchasePairing {
  byAccount: Map<string, AccountPurchase>;
  /** expenseId → firmKey → spárované účty. */
  byExpense: Map<string, Map<string, string[]>>;
}

const dayOf = (value: string | number): number => {
  const time = typeof value === 'number' ? value : Date.parse(value.length <= 10 ? `${value}T12:00:00` : value);
  return Math.floor(time / DAY_MS);
};

/**
 * Funded účet z prošlé challenge se nekupuje — vzniká ručně jako klon po passu.
 * Účty od brokera (Tradovate) se vždy kupují: u Lucid jsou to evaluace
 * (LFE i LFF), i kdyby měly v appce omylem fázi Funded.
 */
export const isFundedFromChallenge = (account: Pick<Account, 'phase' | 'oauth'>): boolean =>
  account.phase === 'Funded' && !account.oauth;

export function pairAccountsWithPurchases(accounts: readonly Account[], expenses: readonly BusinessExpense[]): PurchasePairing {
  const slots = expenses.filter(isAccountPurchase).flatMap(expense => {
    const parts = purchaseParts(expense.label);
    const total = parts.reduce((sum, part) => sum + part.count, 0) || 1;
    return parts.map(part => ({
      expense, firmKey: part.firmKey, count: part.count,
      price: (Number(expense.amount) || 0) * part.count / total / part.count,
      accounts: [] as string[],
    }));
  });
  const byAccount = new Map<string, AccountPurchase>();
  const candidates = accounts
    .filter(account => account.type !== 'Backtest' && !isFundedFromChallenge(account))
    .sort((a, b) => a.createdAt - b.createdAt);
  const assign = (account: Account, slot: typeof slots[number], sure: boolean) => {
    slot.accounts.push(account.id);
    byAccount.set(account.id, {
      expenseId: slot.expense.id, date: String(slot.expense.date).slice(0, 10), label: slot.expense.label,
      price: Math.round(slot.price * 100) / 100, sure,
    });
  };
  // 1. kolo: nákup kolem dne, kdy appka účet poprvé uviděla (−4 … +8 dní).
  // 2. kolo: účet připojený později než nákup (OAuth) → nejbližší starší nákup
  //    firmy s volným místem do 75 dní, jen jako návrh.
  for (const [minDelta, maxDelta, nearest] of [[-4, 8, true], [0, 75, false]] as const) {
    for (const account of candidates) {
      if (byAccount.has(account.id)) continue;
      const firmKey = accountFirmKey(account);
      let best: { slot: typeof slots[number]; delta: number } | null = null;
      for (const slot of slots) {
        if (slot.firmKey !== firmKey || slot.accounts.length >= slot.count) continue;
        const delta = dayOf(account.createdAt) - dayOf(String(slot.expense.date));
        if (delta < minDelta || delta > maxDelta) continue;
        if (!best || (nearest ? Math.abs(delta) < Math.abs(best.delta) : delta < best.delta)) best = { slot, delta };
      }
      if (best) assign(account, best.slot, nearest && Math.abs(best.delta) <= 3);
    }
  }
  const byExpense = new Map<string, Map<string, string[]>>();
  for (const slot of slots) {
    const firms = byExpense.get(slot.expense.id) ?? new Map<string, string[]>();
    firms.set(slot.firmKey, slot.accounts);
    byExpense.set(slot.expense.id, firms);
  }
  return { byAccount, byExpense };
}

export type AccountOutcome = 'alive' | 'burned' | 'passed' | 'archived' | 'hidden';

/** Živý / spálený / prošlý / ručně archivovaný; skryté (úklid testovacích) se nepočítají. */
export const accountOutcome = (account: Account): AccountOutcome => {
  if (account.result === 'Failed') return 'burned';
  if (account.result === 'Passed') return 'passed';
  if (account.isArchived) return 'hidden';
  return account.status === 'Active' ? 'alive' : 'archived';
};

export interface AccountLifecycle {
  accountId: string;
  firmKey: string;
  outcome: AccountOutcome;
  /** První obchod, jinak založení účtu. */
  start: number;
  /** Datum spálení, jinak poslední obchod, jinak archivace; u živého null. */
  end: number | null;
  lifeDays: number | null;
  trades: number;
  pnl: number;
  /** Nejvyšší kumulovaný zisk z obchodů (od startu). */
  maxProfit: number | null;
  payouts: number;
}

export function accountLifecycles(accounts: readonly Account[], trades: readonly Trade[], payouts: readonly BusinessPayout[]): Map<string, AccountLifecycle> {
  const tradesByAccount = new Map<string, Trade[]>();
  for (const trade of trades) {
    if (!trade.accountId) continue;
    const list = tradesByAccount.get(trade.accountId);
    if (list) list.push(trade); else tradesByAccount.set(trade.accountId, [trade]);
  }
  const paidByAccount = new Map<string, number>();
  for (const payout of payouts) {
    if (!payout.accountId || (payout.status || 'Received') !== 'Received') continue;
    paidByAccount.set(payout.accountId, (paidByAccount.get(payout.accountId) ?? 0) + (Number(payout.amount) || 0));
  }
  const result = new Map<string, AccountLifecycle>();
  for (const account of accounts) {
    if (account.type === 'Backtest') continue;
    const list = (tradesByAccount.get(account.id) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
    let pnl = 0;
    let peak: number | null = null;
    for (const trade of list) {
      pnl += Number(trade.pnl) || 0;
      peak = peak == null ? pnl : Math.max(peak, pnl);
    }
    const outcome = accountOutcome(account);
    const start = list[0]?.timestamp ?? account.createdAt;
    const failure = account.failureDate ? Date.parse(`${account.failureDate}T12:00:00`) : NaN;
    const end = outcome === 'alive'
      ? null
      : Number.isFinite(failure) ? failure : list.at(-1)?.timestamp ?? account.archivedAt ?? null;
    result.set(account.id, {
      accountId: account.id,
      firmKey: accountFirmKey(account),
      outcome,
      start,
      end,
      lifeDays: end != null && end >= start ? Math.floor(end / DAY_MS) - Math.floor(start / DAY_MS) + 1 : null,
      trades: list.length,
      pnl: outcome === 'burned' && account.failureAmountLost ? -Math.abs(account.failureAmountLost) : pnl,
      maxProfit: peak != null && peak > 0 ? peak : null,
      payouts: paidByAccount.get(account.id) ?? 0,
    });
  }
  return result;
}

export interface FirmLifecycleStats {
  bought: number;
  alive: number;
  burned: number;
  passed: number;
  avgLifeDays: number | null;
  inApp: number;
}

/** Počty a životnost po firmách: koupeno z nákupů v Byznysu, zbytek z účtů. */
export function firmLifecycleStats(expenses: readonly BusinessExpense[], lifecycles: Iterable<AccountLifecycle>): Map<string, FirmLifecycleStats> {
  const stats = new Map<string, FirmLifecycleStats & { lives: number[] }>();
  const row = (key: string) => {
    if (!stats.has(key)) stats.set(key, { bought: 0, alive: 0, burned: 0, passed: 0, avgLifeDays: null, inApp: 0, lives: [] });
    return stats.get(key)!;
  };
  for (const expense of expenses) {
    if (!isAccountPurchase(expense)) continue;
    for (const part of purchaseParts(expense.label)) row(part.firmKey).bought += part.count;
  }
  for (const life of lifecycles) {
    if (life.outcome === 'hidden') continue;
    const firm = row(life.firmKey);
    firm.inApp += 1;
    if (life.outcome === 'alive') firm.alive += 1;
    else if (life.outcome === 'passed') firm.passed += 1;
    else if (life.outcome === 'burned') firm.burned += 1;
    if (life.outcome !== 'alive' && life.lifeDays != null) firm.lives.push(life.lifeDays);
  }
  return new Map([...stats].map(([key, { lives, ...rest }]) => [key, {
    ...rest,
    avgLifeDays: lives.length ? Math.round(lives.reduce((sum, days) => sum + days, 0) / lives.length) : null,
  }]));
}
