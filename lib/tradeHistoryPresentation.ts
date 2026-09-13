import type { Account, Trade } from '../types.js';
import { isLegacyJournalTrade } from './journalTradeFacts.js';

export const isCombinedTrade = (trade: Trade): boolean => String(trade.id).startsWith('combined_');

/** Display identity is explicit; coincident timestamps never prove a copy. */
export const buildTradeGroupIndex = (trades: readonly Trade[]): Map<string, Trade[]> => {
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    if (!trade.groupId || isCombinedTrade(trade)) continue;
    const group = groups.get(trade.groupId) ?? [];
    group.push(trade);
    groups.set(trade.groupId, group);
  }
  return groups;
};

export const tradeGroupMembers = (trade: Trade, groups: ReadonlyMap<string, Trade[]>): Trade[] => {
  const candidates = trade.groupId ? groups.get(trade.groupId) ?? [] : [];
  // A combined card carries the exact rows which passed the active filters.
  // Looking up its whole historical group here would reintroduce excluded accounts.
  if (isCombinedTrade(trade) && trade.combinedTradeIds) {
    const included = new Set(trade.combinedTradeIds.map(String));
    return candidates.filter(member => included.has(String(member.id)));
  }
  return candidates.length ? candidates : isCombinedTrade(trade) ? [] : [trade];
};

export const tradeDetailMembers = (trade: Trade, allTrades: readonly Trade[]): Trade[] =>
  isCombinedTrade(trade)
    ? tradeGroupMembers(trade, buildTradeGroupIndex(allTrades))
    : [trade];

/** Screenshots/chart belong to a real account row, never to a synthetic sum. */
export const tradeDetailSource = (trade: Trade, allTrades: readonly Trade[]): Trade | undefined => {
  const members = tradeDetailMembers(trade, allTrades);
  return members.find(member => member.accountId === trade.accountId) ?? members[0];
};

/** Do not invent the leader from an account name or array position. */
export const explicitTradeMaster = (trades: readonly Trade[]): Trade | undefined =>
  trades.find(trade => trade.isMaster)
  ?? trades.find(trade => trades.some(copy => copy.masterTradeId != null && String(copy.masterTradeId) === String(trade.id)));

export const tradeAccountCount = (trades: readonly Trade[]): number =>
  new Set(trades.map(trade => trade.accountId)).size;

/** Legacy synthetic copies stay reviewable, but are never called confirmed copies. */
export const tradeAccountLabel = (trades: readonly Trade[]): string => {
  const count = tradeAccountCount(trades);
  const estimated = tradeAccountCount(trades.filter(trade => trade.pnlEstimated === true));
  const label = `${count} ${count === 1 ? 'účet' : count < 5 ? 'účty' : 'účtů'}`;
  return estimated ? `${label} · ${estimated} s odhadem` : label;
};

export const aggregateHistoryTrades = (trades: readonly Trade[]): Trade[] => {
  const groups = buildTradeGroupIndex(trades);
  const result = trades.filter(trade => !trade.groupId);
  for (const [groupId, members] of groups) {
    const representative = explicitTradeMaster(members) ?? members[0];
    const count = tradeAccountCount(members);
    result.push({
      ...representative,
      id: `combined_${groupId}`,
      // Presentation metadata only: individual records retain their own times,
      // prices, quantity and PnL; a combined row is never an account execution.
      combinedTradeIds: members.map(trade => trade.id),
      pnl: members.reduce((sum, trade) => sum + trade.pnl, 0),
      pnlEstimated: members.some(trade => trade.pnlEstimated === true),
      riskAmount: members.some(trade => trade.copierTradeId?.startsWith('journal:')) ? undefined
        : members.reduce((sum, trade) => sum + (trade.riskAmount || 0), 0),
      notes: `${representative.notes || ''} (Kombinováno z ${count} účtů)`.trim(),
      tags: [...new Set([...(representative.tags || []), 'aggregated'])],
    });
  }
  return result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
};

export const tradeEstimateNotice = (trade: Trade): string | null => {
  if (isLegacyJournalTrade(trade)) return 'Původní záznam kopírky: zobrazené ceny a P&L pocházejí ze staršího záznamu hlavního účtu. Nejsou nově ověřené z jednotlivých plnění. Historie posunů SL/TP není dostupná; odhadované kopie nejsou započítané.';
  if (!trade.pnlEstimated) return null;
  return isCombinedTrade(trade)
    ? 'Součet obsahuje odhadované PnL. Vlastní plnění některých účtů zatím nejsou doložena.'
    : 'Odhad podle leadera. Vlastní plnění, ceny a časy tohoto účtu zatím nejsou doloženy.';
};

/** Percent view uses the distinct accounts actually included by the filters.
 * Missing balances or missing selected members cannot become a partial denominator. */
export function journalDisplayBalance(trade: Trade, accounts: readonly Pick<Account, 'id' | 'initialBalance'>[], members: readonly Trade[] = []): number | undefined {
  let selected = [trade];
  if (isCombinedTrade(trade)) {
    const ids = new Set(trade.combinedTradeIds?.map(String));
    if (!ids.size || members.length !== ids.size || members.some(member => !ids.has(String(member.id)))
      || new Set(members.map(member => String(member.id))).size !== members.length) return undefined;
    selected = [...members];
  }
  const byId = new Map(accounts.map(account => [account.id, account.initialBalance]));
  let total = 0;
  for (const id of new Set(selected.map(member => member.accountId))) {
    const balance = byId.get(id);
    if (typeof balance !== 'number' || !Number.isFinite(balance) || balance <= 0) return undefined;
    total += balance;
  }
  return Number.isFinite(total) && total > 0 ? total : undefined;
}
