import type { TvPriceFeedView } from './tvPriceStore';
import type { TradovateWorkerAccountCoverage } from './tradovateRequestControl';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import type { TradeCardModel } from './liveTradeCard';
import { workerAccountCoverageUsable } from './tradovateWorkerCoverage';

export const IBKR_DISPLAY_PRICE_MAX_AGE_MS = 2_000;
export const IBKR_DISPLAY_POSITION_MAX_AGE_MS = 45_000;
export const ibkrPositionFingerprint = (accountId: number, symbol: string, net: number, entry: number, capturedAt: number) =>
  JSON.stringify([accountId, symbol, net, entry, capturedAt]);

/** Verified store only; real bid/ask remain nullable, never fabricated from the last trade. */
export function independentIbkrTick(view: TvPriceFeedView, receivedAt: number | null, now: number) {
  const p = view.latest;
  const match = /^IBKR:((MNQ|NQ)([HMUZ])20(\d{2}))$/.exec(p?.chart ?? '');
  if (!view.fresh || !p || !match || p.front !== match[1] || p.interval !== '1' || p.mode !== 'streaming'
    || p.last == null || !Number.isFinite(p.last) || p.last <= 0 || receivedAt == null || !Number.isFinite(receivedAt)
    || receivedAt > now + 1_000 || now - receivedAt > IBKR_DISPLAY_PRICE_MAX_AGE_MS) return null;
  return { source: p.chart, symbol: `${match[2]}${match[3]}${match[4].slice(-1)}`, price: p.last, at: receivedAt,
    bid: p.bid, ask: p.ask, identity: `${p.runId}:${p.seq}:${p.at}` };
}

export interface IbkrDisplayPositionLeg {
  accountId: number;
  symbol: string;
  netPosition: number;
  averagePrice: number;
  capturedAt: number;
  fingerprint: string;
  fees: number;
  continuity?: TradovateWorkerAccountCoverage;
}

export function ibkrPositionPnl(legs: readonly IbkrDisplayPositionLeg[] | null | undefined,
  view: TvPriceFeedView, receivedAt: number | null, now: number): number | null {
  const tick = independentIbkrTick(view, receivedAt, now);
  if (!tick || !legs?.length) return null;
  const seen = new Set<string>();
  let total = 0;
  for (const leg of legs) {
    const key = `${leg.accountId}:${leg.symbol}`;
    const current = leg.continuity != null ? workerAccountCoverageUsable(leg.continuity, leg.continuity, leg.accountId, now)
      : now - leg.capturedAt <= IBKR_DISPLAY_POSITION_MAX_AGE_MS;
    if (seen.has(key) || leg.symbol !== tick.symbol || !Number.isSafeInteger(leg.accountId) || leg.accountId <= 0
      || !Number.isSafeInteger(leg.netPosition) || leg.netPosition === 0 || !Number.isFinite(leg.averagePrice) || leg.averagePrice <= 0
      || !Number.isFinite(leg.capturedAt) || leg.capturedAt <= 0 || leg.capturedAt > now + 1_000 || !current
      || !Number.isFinite(leg.fees) || leg.fees < 0
      || leg.fingerprint !== ibkrPositionFingerprint(leg.accountId, leg.symbol, leg.netPosition, leg.averagePrice, leg.capturedAt)) return null;
    seen.add(key);
    const point = leg.symbol.startsWith('MNQ') ? 2 : leg.symbol.startsWith('NQ') ? 20 : null;
    if (point == null) return null;
    total += (tick.price - leg.averagePrice) * leg.netPosition * point - leg.fees;
  }
  return Number.isFinite(total) ? total : null;
}

export function liveAccountIbkrLegs(account: LiveAccount | null | undefined, verified: boolean, fees = 0): IbkrDisplayPositionLeg[] | null {
  if (!account || !verified) return null;
  const capturedAt = Date.parse(account.positionsUpdatedAt ?? '');
  const rows = account.positions.filter(p => p.netPosition !== 0);
  if (!rows.length || !Number.isFinite(capturedAt) || rows.some(row => row.netPrice == null)) return null;
  return rows.map((row, i) => ({ accountId: account.id, symbol: row.symbol, netPosition: row.netPosition, averagePrice: row.netPrice!,
    capturedAt, fingerprint: ibkrPositionFingerprint(account.id, row.symbol, row.netPosition, row.netPrice!, capturedAt),
    fees: i === 0 ? fees : 0, ...(account.displayStreamCoverage ? { continuity: account.displayStreamCoverage } : {}) }));
}

export function tradeCardIbkrLegs(card: TradeCardModel | null | undefined): IbkrDisplayPositionLeg[] | null {
  if (!card || card.kind !== 'position' || card.positionsComplete !== true || !card.accounts.length) return null;
  const rows: IbkrDisplayPositionLeg[] = [];
  for (const account of card.accounts) {
    const capturedAt = Date.parse(account.positionAsOf ?? '');
    if (account.entry == null || !Number.isFinite(capturedAt) || account.positionVerified !== true) return null;
    const net = account.quantity * card.direction;
    rows.push({ accountId: account.accountId, symbol: card.symbol, netPosition: net, averagePrice: account.entry, capturedAt,
      fingerprint: ibkrPositionFingerprint(account.accountId, card.symbol, net, account.entry, capturedAt), fees: account.fees ?? 0,
      ...(account.displayStreamCoverage ? { continuity: account.displayStreamCoverage } : {}) });
  }
  return rows;
}
