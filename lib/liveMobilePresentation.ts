import type { LiveAccount, LiveOrder, LivePosition } from '../services/tradecopiaLiveService';
import { isLiveAccountReadVerified, LIVE_READ_MAX_AGE_MS } from './liveReadFreshness';
import { pointValueUsd } from '../services/futuresContractSpecs';

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const symbolKey = (s: string) => s.trim().toUpperCase();
const typeKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
export interface MobileLevel {
  price: number | null;
  coverage: number;
  exact: boolean;
  distance: number | null;
  pnl: number | null;
}
export interface MobilePosition {
  symbol: string;
  quantity: number;
  entry: number | null;
  mark: number | null;
  openPnl: number | null;
  stop: MobileLevel;
  target: MobileLevel;
  ordersVerified: boolean;
}

export function mobileOpenPnl(account: LiveAccount | undefined): number | null {
  return account && account.unrealizedPnlSource !== 'stale' && finite(account.unrealizedPnl)
    ? account.unrealizedPnl : null;
}
export function mobileGroupOpenPnl(accounts: Array<LiveAccount | undefined>): number | null {
  const values = accounts.map(mobileOpenPnl);
  return values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
}

/** Display only. Account P&L can imply an approximate mark only for a single position. */
export function mobilePosition(account: LiveAccount, position: LivePosition, orders: LiveOrder[], now = Date.now()): MobilePosition {
  const quantity = position.netPosition;
  const entry = finite(position.netPrice) ? position.netPrice : null;
  const value = pointValueUsd(position.symbol);
  const positionsVerified = isLiveAccountReadVerified(account, 'positions', now);
  const ordersVerified = positionsVerified && isLiveAccountReadVerified(account, 'orders', now);
  const solePosition = account.positions.filter(p => p.netPosition !== 0).length === 1;
  const openPnl = positionsVerified && solePosition ? mobileOpenPnl(account) : null;
  const at = Date.parse(account.unrealizedPnlUpdatedAt ?? '');
  const freshPnl = Number.isFinite(at) && at <= now + 1000 && now - at <= LIVE_READ_MAX_AGE_MS;
  const mark = entry != null && value != null && quantity !== 0 && openPnl != null && freshPnl
    ? entry + openPnl / (quantity * value) : null;
  const protection = ordersVerified ? orders.filter(o => o.working && o.accountId === account.id
    && symbolKey(o.symbol) === symbolKey(position.symbol)
    && o.action.trim().toLowerCase() === (quantity > 0 ? 'sell' : 'buy')) : [];
  const level = (stop: boolean): MobileLevel => {
    const matching = protection.filter(o => stop ? ['stop', 'stoplimit'].includes(typeKey(o.orderType)) : typeKey(o.orderType) === 'limit');
    const coverage = matching.reduce((n, o) => n + (finite(o.quantity) && o.quantity > 0 ? o.quantity : 0), 0);
    const prices = matching.map(o => stop ? o.stopPrice : o.price);
    const known = matching.length > 0 && prices.every(finite) && matching.every(o => finite(o.quantity) && o.quantity > 0);
    const exact = known && coverage === Math.abs(quantity);
    const price = known && prices.every(p => p === prices[0]) ? prices[0]! : null;
    return {
      price, coverage, exact,
      distance: price != null && mark != null ? Math.abs(price - mark) : null,
      // Incomplete or excess protection never becomes a projected full-position exit.
      pnl: exact && entry != null && value != null
        ? matching.reduce((sum, o, i) => sum + (prices[i]! - entry) * Math.sign(quantity) * o.quantity * value, 0) : null,
    };
  };
  return { symbol: position.symbol, quantity, entry, mark, openPnl, stop: level(true), target: level(false), ordersVerified };
}

/** A common card is truthful only for the same exact contract and direction. */
export function mobileGroupPosition(accounts: Array<LiveAccount | undefined>, orders: LiveOrder[], now = Date.now()): MobilePosition | null {
  if (!accounts.length || accounts.some(a => !a || !isLiveAccountReadVerified(a, 'positions', now))) return null;
  const positions = accounts.flatMap(a => a!.positions.filter(p => p.netPosition !== 0).map(p => mobilePosition(a!, p, orders, now)));
  const first = positions[0];
  if (!first || positions.some(p => symbolKey(p.symbol) !== symbolKey(first.symbol) || Math.sign(p.quantity) !== Math.sign(first.quantity))) return null;
  const mergeLevel = (key: 'stop' | 'target'): MobileLevel => {
    const levels = positions.map(p => p[key]);
    const samePrice = levels.every(l => l.price != null && l.price === levels[0].price);
    const pnls = levels.map(l => l.pnl);
    const distances = levels.map(l => l.distance);
    return { price: samePrice ? levels[0].price : null,
      coverage: levels.reduce((n, l) => n + l.coverage, 0), exact: levels.every(l => l.exact),
      pnl: pnls.every(finite) ? pnls.reduce((a, b) => a + b, 0) : null,
      distance: samePrice && distances.every(finite) && Math.max(...distances) - Math.min(...distances) < 0.01 ? distances[0] : null };
  };
  return { ...first, quantity: positions.reduce((n, p) => n + p.quantity, 0),
    entry: positions.every(p => p.entry === first.entry) ? first.entry : null,
    mark: positions.every(p => p.mark != null && first.mark != null && Math.abs(p.mark - first.mark) < 0.01) ? first.mark : null,
    openPnl: mobileGroupOpenPnl(accounts), ordersVerified: positions.every(p => p.ordersVerified), stop: mergeLevel('stop'), target: mergeLevel('target') };
}
