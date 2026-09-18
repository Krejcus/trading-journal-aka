import { describe, expect, it } from 'vitest';
import { mergeTradeAnalytics, tradeAnalyticsById, TRADE_ANALYTICS_FIELDS } from '../lib/tradeAnalyticsMerge';
import type { Trade } from '../types';

const trade = (id: string, extras: Partial<Trade> = {}): Trade => ({ id, instrument: 'MNQ', pnl: 1, direction: 'Long', date: '2026-09-18', ...extras } as Trade);

describe('deferred trade analytics', () => {
  it('indexes rpc rows by id and drops null fields and malformed rows', () => {
    const byId = tradeAnalyticsById([
      { id: 'a', counterfactual: { best: 1 }, excursion: null, entryMap: { x: 1 } },
      { id: 'b', counterfactual: null, entryContext: null },
      { id: 42 }, null, 'x',
    ]);
    expect([...byId.keys()]).toEqual(['a']);
    expect(byId.get('a')).toEqual({ counterfactual: { best: 1 }, entryMap: { x: 1 } });
    expect(tradeAnalyticsById('nope').size).toBe(0);
  });
  it('merges only missing analytics fields and keeps every other field and object identity', () => {
    const own = { source: 'detail' };
    const trades = [trade('a', { counterfactual: own }), trade('b'), trade('c', { notes: 'n' })];
    const merged = mergeTradeAnalytics(trades, new Map([
      ['a', { counterfactual: { source: 'rpc' }, excursion: { mfe: 2 } }],
      ['b', { entryContext: { bias: 'long' } }],
    ]));
    expect(merged[0].counterfactual).toBe(own);
    expect(merged[0].excursion).toEqual({ mfe: 2 });
    expect(merged[1].entryContext).toEqual({ bias: 'long' });
    expect(merged[2]).toBe(trades[2]);
    expect(merged[2].notes).toBe('n');
    expect(mergeTradeAnalytics(trades, new Map())).toEqual(trades);
  });
  it('covers exactly the fields the light dashboard read leaves out', () => {
    expect([...TRADE_ANALYTICS_FIELDS]).toEqual(['counterfactual', 'entryContext', 'excursion', 'aiSuggestions', 'executionPath', 'entryMap', 'visionAnalysis']);
  });
});
