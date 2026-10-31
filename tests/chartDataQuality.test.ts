import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chartDataQuality, regularNasdaqSession } from '../lib/chartDataQuality';
import ChartDataStatus from '../components/ChartDataStatus';
vi.mock('../services/supabase', () => ({ supabase: {} }));
import { coversTrade } from '../services/provisionalCandles';
const start = Date.parse('2026-10-30T18:00:00Z');
const candles = Array.from({ length: 5 }, (_, i) => ({ time: start / 1000 + i * 60, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const base = { candles, dayStart: start, dayEnd: start + 300000, now: start + 300000, needsLive: true, liveStatus: 'live', liveCapturedAt: start + 300000, liveSource: 'CME_MINI:MNQ1!' };
describe('truthful chart coverage', () => {
  it('detects interior gaps without inventing their cause', () => {
    const model = chartDataQuality({ ...base, candles: [candles[0], candles[4]] });
    expect(model.missingMinutes).toBe(3);
    expect(model.title).toBe('Svíčky: pokrytí neověřené');
    expect(model.reasons.join()).toContain('svátek ani minutu bez obchodů');
    expect(coversTrade([candles[0], candles[4]].map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]), start, start + 240000)).toBe(false);
  });
  it('does not declare exchange-verified completeness for a contiguous range', () => {
    const model = chartDataQuality(base);
    expect(model.missingMinutes).toBe(0);
    expect(model.tone).toBe('info');
    expect(model.reasons.join()).toContain('není nezávislé potvrzení');
    expect(coversTrade(candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]), start + 1000, start + 240000)).toBe(true);
  });
  it('excludes regular daily/weekend closure with New York DST', () => {
    expect(regularNasdaqSession(Date.parse('2026-10-30T21:30:00Z'))).toBe(false);
    expect(regularNasdaqSession(Date.parse('2026-10-30T20:14:00Z'))).toBe(true);
    expect(regularNasdaqSession(Date.parse('2026-10-30T20:15:00Z'))).toBe(false);
    expect(regularNasdaqSession(Date.parse('2026-10-30T20:30:00Z'))).toBe(true);
    expect(regularNasdaqSession(Date.parse('2026-10-31T14:00:00Z'))).toBe(false);
    expect(regularNasdaqSession(Date.parse('2026-11-01T23:00:00Z'))).toBe(true);
    expect(regularNasdaqSession(Date.parse('2026-11-02T22:30:00Z'))).toBe(false);
    const saturday = Date.parse('2026-10-31T14:00:00Z');
    expect(chartDataQuality({ ...base, candles: [], dayStart: saturday, dayEnd: saturday + 3600000, now: saturday + 3600000 }).missingMinutes).toBe(0);
  });
  it('does not reject a covered trade solely for the scheduled 16:15–16:30 halt', () => {
    const before = Date.parse('2026-10-30T20:14:00Z');
    const after = Date.parse('2026-10-30T20:30:00Z');
    const bars = [before, after].map(ms => [ms / 1000, 100, 101, 99, 100, 1] as [number, number, number, number, number, number]);
    expect(coversTrade(bars, before, after)).toBe(true);
    expect(coversTrade(bars, before, after + 60000)).toBe(false);
    expect(coversTrade(bars.slice(1), before, after)).toBe(false);
  });
  it('shows failed refresh and stale provenance even while old candles remain visible', () => {
    const model = chartDataQuality({ ...base, liveStatus: 'stale', historicalError: 'timeout', liveProblem: 'market-mismatch' });
    expect(model.lastCandleAt).toBe(start + 240000);
    expect(model.title).toBe('Svíčky: obnova selhala');
    const html = renderToStaticMarkup(React.createElement(ChartDataStatus, { quality: model }));
    expect(html).toContain('Stav svíček');
    expect(html).toContain('Historická data se nepodařilo obnovit');
    expect(html).toContain('Trh nebo kontrakt');
    expect(html).toContain('starší než 5 minut');
  });
  it('distinguishes volume and proxy-market limitations from missing minute records', () => {
    const model = chartDataQuality({ ...base, validation: {
      discardedRows: 0, trimmedRows: 0, unknownVolume: true, sourceVerified: true, priceFamilyProxy: true, contract: 'NQZ2026',
    } });
    expect(model.missingMinutes).toBe(0);
    expect(model.tone).toBe('warn');
    expect(model.reasons.join()).toContain('nemá ověřený objem');
    expect(model.reasons.join()).toContain('NQ místo MNQ');
  });
});
