import type { Account, DashboardMode, Trade, TradeFilters } from '../types.js';
import { visibleJournalTrades } from './journalTradeFacts.js';

/** Filter individual records before aggregation. An account's current parent or
 * copier role never expands an explicit selection of historical accounts. */
export function filterHistoryTrades(trades: readonly Trade[], accounts: readonly Account[], archived: readonly Account[],
  filters: TradeFilters, mode: DashboardMode, now = Date.now()): Trade[] {
  const byId = new Map([...archived, ...accounts].map(account => [account.id, account]));
  const selected = new Set(filters.accounts);
  const strictActive = mode === 'funded' || mode === 'challenge' || mode === 'backtesting';
  const active = new Set(accounts.filter(account => account.status === 'Active').map(account => account.id));
  const maxDays = { all: undefined, week: 7, month: 30, quarter: 90, year: 365 }[filters.period];
  return visibleJournalTrades(trades).filter(trade => {
    const account = byId.get(trade.accountId);
    if (strictActive && !active.has(trade.accountId)) return false;
    if ((account?.type === 'Backtest') !== (mode === 'backtesting')) return false;
    if (mode === 'funded' && account?.type !== 'Live' && !(account?.type === 'Funded' && account.phase === 'Funded')) return false;
    if (mode === 'challenge' && !(account?.type === 'Funded' && account.phase === 'Challenge')) return false;
    if (selected.size ? !selected.has(trade.accountId) : mode !== 'combined') return false;
    const date = new Date(trade.date);
    const hour = new Date(trade.timestamp).getHours();
    const day = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'][date.getDay()];
    if (!filters.days.includes(day) || !filters.hours.includes(hour)) return false;
    if (!filters.directions.some(direction => direction.toLowerCase() === trade.direction?.toLowerCase())) return false;
    if (!filters.executionStatuses.includes(trade.executionStatus || 'Valid')) return false;
    const outcome = trade.pnl > 0 ? 'Win' : trade.pnl < 0 ? 'Loss' : trade.pnl === 0 ? 'BE' : null;
    if (!outcome || !filters.outcomes.includes(outcome)) return false;
    if (mode !== 'backtesting' && maxDays && (now - date.getTime()) / 86_400_000 > maxDays) return false;
    return (!filters.htfConfluences.length || trade.htfConfluence?.some(value => filters.htfConfluences.includes(value)))
      && (!filters.ltfConfluences.length || trade.ltfConfluence?.some(value => filters.ltfConfluences.includes(value)))
      && (!filters.mistakes.length || trade.mistakes?.some(value => filters.mistakes.includes(value)));
  });
}
