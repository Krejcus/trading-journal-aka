import type { MarketTimeframe } from './marketData';

export type NasdaqFuturesRoot = 'MNQ' | 'NQ';

const INSTRUMENT_NAMES: Record<NasdaqFuturesRoot, string> = {
  MNQ: 'Micro E-mini Nasdaq-100 Index Futures',
  NQ: 'NASDAQ 100 E-mini Futures',
};

export const resolveNasdaqFuturesRoot = (
  explicitRoot: NasdaqFuturesRoot | undefined,
  instrument: string | undefined,
): NasdaqFuturesRoot => {
  if (explicitRoot) return explicitRoot;
  const normalized = (instrument ?? '').toUpperCase();
  if (/(^|[^A-Z])MNQ/.test(normalized) || normalized.includes('MICRO E-MINI')) return 'MNQ';
  if (/(^|[^A-Z])NQ/.test(normalized) || normalized.includes('NASDAQ 100 E-MINI')) return 'NQ';
  return 'MNQ';
};

export const chartTimeframeLegendLabel = (timeframe: MarketTimeframe): string => {
  if (timeframe.endsWith('m')) return timeframe.slice(0, -1);
  return timeframe === '1d' ? 'D' : timeframe;
};

export const chartInstrumentLegend = (
  root: NasdaqFuturesRoot,
  timeframe: MarketTimeframe,
) => ({
  badge: root === 'MNQ' ? 'M' : 'N',
  name: INSTRUMENT_NAMES[root],
  timeframe: chartTimeframeLegendLabel(timeframe),
});
