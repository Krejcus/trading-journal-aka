import type { Trade } from '../types';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';
import { loadJournalChartDetail } from './journalChartDetail';
import {
  loadMarketCandles,
  loadTradeMarketCandles,
  marketDataSessionWindowForTrade,
  marketDataWindowForTrade,
  type MarketCandleResponse,
} from './marketData';
import { storageService } from './storageService';

/**
 * Data grafu obchodu na jednom místě — detail je stáhne předem (při otevření)
 * a graf je pak dostane z cache. Obě strany proto musí počítat okno i kontrakt
 * úplně stejně.
 */

export type TradeChartDepth = 'session' | 'full';

export interface TradeChartTiming {
  entryMs: number;
  exitMs: number;
  /** První plnění ověřuje, že svíčky patří kontraktu obchodu (rollover). */
  firstEntry: { at: number; price: number };
}

export function tradeChartTiming(trade: Trade): TradeChartTiming {
  let entryMs: number;
  if (typeof trade.entryTime === 'number' && trade.entryTime > 0) entryMs = trade.entryTime;
  else {
    const parsed = trade.entryDate ? Date.parse(trade.entryDate) : NaN;
    if (Number.isFinite(parsed)) entryMs = parsed;
    else {
      const exit = trade.timestamp || Date.parse(trade.date) || Date.now();
      entryMs = exit - Math.max(0, Number(trade.durationMinutes) || 0) * 60_000;
    }
  }
  const exitMs = trade.timestamp || Date.parse(trade.exitDate || trade.date) || entryMs;
  const fill = trade.executionHistory?.fills.filter(item => item.role === 'entry').sort((a, b) => a.at - b.at)[0];
  return { entryMs, exitMs, firstEntry: fill ? { at: fill.at, price: fill.price } : { at: entryMs, price: Number(trade.entryPrice) } };
}

/** Databento historical zveřejňuje data zhruba 24 h po trhu. */
export const tradeChartDataAvailable = ({ entryMs, exitMs }: TradeChartTiming) => Math.max(entryMs, exitMs) <= Date.now() - 24 * 60 * 60 * 1000;

export function loadTradeChartCandles(trade: Trade, root: 'MNQ' | 'NQ', depth: TradeChartDepth,
  timing = tradeChartTiming(trade)): Promise<MarketCandleResponse> {
  const { start, end } = depth === 'session'
    ? marketDataSessionWindowForTrade(timing.entryMs, timing.exitMs)
    : marketDataWindowForTrade(timing.entryMs, timing.exitMs);
  return loadTradeMarketCandles({ root, tradeSymbol: trade.symbol || trade.instrument, start, end,
    entryMs: timing.firstEntry.at, entryPrice: timing.firstEntry.price });
}

/**
 * Plná historie (16 dní) ke kontraktu, který už vybralo první načtení — bez
 * nové volby kontraktu. Dny seance jsou v denní cache, stáhnou se jen chybějící.
 */
export function loadTradeChartHistory(symbol: string, timing: TradeChartTiming): Promise<MarketCandleResponse> {
  const { start, end } = marketDataWindowForTrade(timing.entryMs, timing.exitMs);
  return loadMarketCandles({ symbol, start, end });
}

// Detail obchodu stažený předem si graf vyzvedne při připojení; chvíli poté
// zmizí, takže další načtení (obnova na pozadí, „Zkusit znovu“) jde čerstvě na
// server. Krátká lhůta místo okamžitého smazání: React efekt při připojení
// může proběhnout dvakrát (StrictMode) a druhý běh by jinak stahoval znovu.
const prefetchedDetails = new Map<string, Promise<Trade>>();
const detailKey = (trade: Trade) => `${trade.accountId}:${trade.id}`;
const TAKEN_GRACE_MS = 3_000;

export function takePrefetchedJournalDetail(trade: Trade): Promise<Trade> | null {
  const key = detailKey(trade);
  const pending = prefetchedDetails.get(key) ?? null;
  if (pending) setTimeout(() => { if (prefetchedDetails.get(key) === pending) prefetchedDetails.delete(key); }, TAKEN_GRACE_MS);
  return pending;
}

/**
 * Při otevření detailu: stáhne podklady grafu na pozadí, dokud uživatel kouká
 * na snímek. Selhání se tiše zahodí — graf si je pak načte sám jako dřív.
 */
export function prefetchTradeChart(trade: Trade, verifiedDetail?: Trade): void {
  const journal = isEvidenceJournalTrade(trade) && !(verifiedDetail === trade && trade.executionHistory);
  let detail: Promise<Trade>;
  if (journal) {
    const key = detailKey(trade);
    detail = prefetchedDetails.get(key) ?? loadJournalChartDetail(trade, id => storageService.getTradeById(id));
    prefetchedDetails.set(key, detail);
    detail.catch(() => { if (prefetchedDetails.get(key) === detail) prefetchedDetails.delete(key); });
    // Nevyzvednutý detail (graf se neotevřel) po minutě zastará.
    setTimeout(() => { if (prefetchedDetails.get(key) === detail) prefetchedDetails.delete(key); }, 60_000);
  } else detail = Promise.resolve(trade);
  void detail.then(row => {
    const timing = tradeChartTiming(row);
    if (!tradeChartDataAvailable(timing)) return;
    return loadTradeChartCandles(row, 'MNQ', 'session', timing);
  }).catch(() => { /* graf si data načte sám */ });
  // Moduly grafu (líně načítané) ať jsou taky připravené.
  void import('../components/AccountExecutionChart').catch(() => {});
  void import('../components/TradeMarketChart').catch(() => {});
}
