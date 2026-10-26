import type { MarketCandle } from '../services/marketData';
import { tvBarIsCurrent, tvChartRoot, tvPriceFamily } from './tvLivePnl';
import type { TvPriceFeedView } from './tvPriceStore';

/**
 * Živá poslední 1m svíčka grafu dne z kanálu ceny TradingView (krok 5 návrhu
 * `docs/reviews/tv-price-channel-design-20261026.md`, bod C3). **Jen
 * zobrazení (INV-UI-04)**: svíčka se jen překreslí v grafu (`updateBar`),
 * nikdy se neukládá do cache dne, hodnocení, Lab ani storage — dokončené
 * minuty dál dodá worker souborem `tv-live` a druhý den Databento.
 *
 * Bar bere TradingView sám (OHLC rozpracované minuty včetně knotů mezi
 * vzorky), nesestavuje se z cen. `null` = cena stojí, není 1m streaming,
 * svíčka není z aktuální minuty, jiný trh, nebo patří za konec dne.
 */
export function tvLiveCandle(feed: TvPriceFeedView, root: string, dayEndMs: number): MarketCandle | null {
  const latest = feed.latest;
  if (!feed.fresh || !latest || latest.interval !== '1' || latest.mode !== 'streaming' || !latest.bar) return null;
  const family = tvPriceFamily(tvChartRoot(latest.chart));
  if (!family || family !== tvPriceFamily(root)) return null;
  if (!tvBarIsCurrent(latest)) return null;
  const [time, open, high, low, close] = latest.bar;
  if (time * 1_000 >= dayEndMs) return null;
  return { time, open, high, low, close, volume: 0 };
}
