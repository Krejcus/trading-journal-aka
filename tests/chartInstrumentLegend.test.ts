import { describe, expect, it } from 'vitest';
import {
  chartInstrumentLegend,
  chartTimeframeLegendLabel,
  resolveNasdaqFuturesRoot,
} from '../services/chartInstrumentLegend';

describe('chart instrument legend', () => {
  it('uses the explicit workspace root for independently configured panels', () => {
    expect(resolveNasdaqFuturesRoot('MNQ', 'NQ1!')).toBe('MNQ');
    expect(resolveNasdaqFuturesRoot('NQ', 'MNQ1!')).toBe('NQ');
  });

  it('recognizes MNQ and NQ trade symbols outside the workspace', () => {
    expect(resolveNasdaqFuturesRoot(undefined, 'CME_MINI:MNQ1!')).toBe('MNQ');
    expect(resolveNasdaqFuturesRoot(undefined, 'NQ')).toBe('NQ');
    expect(resolveNasdaqFuturesRoot(undefined, undefined)).toBe('MNQ');
  });

  it('formats TradingView-like timeframe labels', () => {
    expect(chartTimeframeLegendLabel('1m')).toBe('1');
    expect(chartTimeframeLegendLabel('15m')).toBe('15');
    expect(chartTimeframeLegendLabel('4h')).toBe('4h');
    expect(chartTimeframeLegendLabel('1d')).toBe('D');
  });

  it('provides the correct badge and instrument name', () => {
    expect(chartInstrumentLegend('MNQ', '5m')).toEqual({
      badge: 'M',
      name: 'Micro E-mini Nasdaq-100 Index Futures',
      timeframe: '5',
    });
  });
});
