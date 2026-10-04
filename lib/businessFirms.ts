import type { Account, BusinessExpense, BusinessPayout } from '../types';
import { FIRM_LOGOS, firmLabel, firmOf } from '../utils/accountFirm';

/*
 * Byznys po firmách: náklady nemají vlastní pole „firma“, proto ji poznáme
 * z popisu („5x tradeify“, „2x Lucid + 5x Apex“) — nový formulář popis skládá
 * právě takhle. Výplata patří účtu, firma účtu se bere z firmOf().
 * Smíšený nákup (víc firem v jednom popisu) se dělí rovným dílem.
 */

export const OTHER_FIRM = 'OSTATNÍ';

const FIRM_PATTERNS: ReadonlyArray<{ key: string; label: string; re: RegExp }> = [
  { key: 'FUNDEDNEXT', label: 'FundedNext', re: /funded\s*next|^\s*fnf/i },
  { key: 'MYFUNDEDFUTURES', label: 'MyFundedFutures', re: /my\s*funded\s*futures|\bmffu?\b/i },
  { key: 'TRADEIFY', label: 'Tradeify', re: /tradeify|^\s*tdfy/i },
  { key: 'LUCID', label: 'Lucid', re: /lucid|^\s*lff\d/i },
  { key: 'APEX', label: 'Apex', re: /apex/i },
  { key: 'TOPSTEP', label: 'Topstep', re: /top\s*step/i },
  { key: 'ALPHAFUTURES', label: 'Alpha Futures', re: /alpha(\s*futures)?/i },
];

/** Firmy zmíněné v textu (v pořadí výskytu v registru), bez duplicit. */
export function firmsInText(text: string, extraKeys: readonly string[] = []): string[] {
  const found = FIRM_PATTERNS.filter(firm => firm.re.test(text)).map(firm => firm.key);
  const lower = text.toLocaleLowerCase('cs');
  for (const key of extraKeys) {
    if (!key || key === OTHER_FIRM || found.includes(key)) continue;
    const word = key.toLocaleLowerCase('cs');
    if (word.length >= 3 && new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(lower)) found.push(key);
  }
  return found;
}

/** Firma účtu jako jednotný klíč (např. „Alpha Futures 50K“ → ALPHAFUTURES). */
export function accountFirmKey(account: Pick<Account, 'name' | 'firmOverride'> | undefined): string {
  if (!account) return OTHER_FIRM;
  const byText = firmsInText(`${account.firmOverride ?? ''} ${account.name ?? ''}`);
  return byText[0] ?? firmOf(account);
}

export function expenseFirmKeys(expense: Pick<BusinessExpense, 'label'>, extraKeys: readonly string[] = []): string[] {
  const keys = firmsInText(expense.label || '', extraKeys);
  return keys.length ? keys : [OTHER_FIRM];
}

export function firmDisplayName(key: string): string {
  if (key === OTHER_FIRM) return 'Ostatní';
  return FIRM_PATTERNS.find(firm => firm.key === key)?.label ?? firmLabel(key);
}

export function firmLogo(key: string): string | undefined {
  return FIRM_LOGOS[key];
}

/** Firmy, které jde vybrat ve formuláři nákladu: známé + ručně nastavené firmy účtů.
 *  (První slovo názvu účtu nebereme — Tradovate účty mají v názvu jen kód.) */
export function selectableFirms(accounts: readonly Account[]): string[] {
  const keys = new Set<string>(FIRM_PATTERNS.map(firm => firm.key));
  accounts.forEach(account => {
    if (account.type === 'Backtest' || !account.firmOverride?.trim()) return;
    keys.add(accountFirmKey(account));
  });
  keys.delete(OTHER_FIRM);
  return [...keys];
}

const isReceived = (payout: BusinessPayout) => (payout.status || 'Received') === 'Received';

export interface FirmSummary {
  key: string;
  cost: number;
  paid: number;
  net: number;
  purchases: number;
  payouts: number;
}

export function firmSummaries(
  expenses: readonly BusinessExpense[],
  payouts: readonly BusinessPayout[],
  accounts: readonly Account[],
): FirmSummary[] {
  const extra = accounts.map(account => accountFirmKey(account));
  const rows = new Map<string, FirmSummary>();
  const row = (key: string) => {
    if (!rows.has(key)) rows.set(key, { key, cost: 0, paid: 0, net: 0, purchases: 0, payouts: 0 });
    return rows.get(key)!;
  };
  expenses.forEach(expense => {
    const keys = expenseFirmKeys(expense, extra);
    keys.forEach(key => { const r = row(key); r.cost += (Number(expense.amount) || 0) / keys.length; r.purchases += 1; });
  });
  payouts.filter(isReceived).forEach(payout => {
    const r = row(accountFirmKey(accounts.find(account => account.id === payout.accountId)));
    r.paid += Number(payout.amount) || 0;
    r.payouts += 1;
  });
  return [...rows.values()].map(r => ({ ...r, net: r.paid - r.cost })).sort((a, b) => b.net - a.net);
}

export interface MonthCashflow {
  /** YYYY-MM */
  month: string;
  paid: number;
  cost: number;
  net: number;
  /** Čistá hotovost po tomto měsíci (od začátku záznamů). */
  cumulative: number;
}

const monthOf = (date: string) => {
  const s = String(date || '');
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function monthlyCashflow(expenses: readonly BusinessExpense[], payouts: readonly BusinessPayout[]): MonthCashflow[] {
  const map = new Map<string, { paid: number; cost: number }>();
  const at = (month: string) => { if (!map.has(month)) map.set(month, { paid: 0, cost: 0 }); return map.get(month)!; };
  expenses.forEach(expense => { const m = monthOf(expense.date); if (m) at(m).cost += Number(expense.amount) || 0; });
  payouts.filter(isReceived).forEach(payout => { const m = monthOf(payout.date); if (m) at(m).paid += Number(payout.amount) || 0; });
  let cumulative = 0;
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => {
    cumulative += v.paid - v.cost;
    return { month, paid: v.paid, cost: v.cost, net: v.paid - v.cost, cumulative };
  });
}

/** „5x tradeify“ → 5, „Tradeify 50k“ → 1. */
export function accountCountInLabel(label: string): number {
  const match = label.match(/(\d+)\s*\.?\s*[x×]/i) || label.match(/[x×]\s*(\d+)/i);
  return match ? Math.max(1, Number(match[1])) : 1;
}

export { monthOf as expenseMonth };
