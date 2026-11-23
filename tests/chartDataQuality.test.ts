import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chartDataQuality, regularNasdaqSession } from '../lib/chartDataQuality';
import ChartDataStatus from '../components/ChartDataStatus';
const start = Date.parse('2026-10-30T18:00:00Z');
const candles = Array.from({ length: 5 }, (_, i) => ({ time: start / 1000 + i * 60, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const base = { candles, dayStart: start, dayEnd: start + 300000, now: start + 300000, needsLive: true, liveStatus: 'live', liveCapturedAt: start + 300000, liveSource: 'Rithmic:MNQZ6' };
describe('truthful chart coverage', () => {
  it('detects interior gaps without inventing their cause', () => {
    const model = chartDataQuality({ ...base, candles: [candles[0], candles[4]] });
    expect(model.missingMinutes).toBe(3);
    expect(model.title).toBe('Svíčky: pokrytí neověřené');
    expect(model.reasons.join()).toContain('svátek ani minutu bez obchodů');
  });
  it('does not declare exchange-verified completeness for a contiguous range', () => {
    const model = chartDataQuality(base);
    expect(model.missingMinutes).toBe(0);
    expect(model.tone).toBe('info');
    expect(model.reasons.join()).toContain('není nezávislé potvrzení');
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
  it('shows failed refresh and stale provenance even while old candles remain visible', () => {
    const model = chartDataQuality({ ...base, liveStatus: 'stale', historicalError: 'timeout' });
    expect(model.lastCandleAt).toBe(start + 240000);
    expect(model.title).toBe('Svíčky: obnova selhala');
    expect(model.source).toBe('Historie + Rithmic:MNQZ6');
    const html = renderToStaticMarkup(React.createElement(ChartDataStatus, { quality: model }));
    expect(html).toContain('Stav svíček');
    expect(html).toContain('Historická data se nepodařilo obnovit');
    expect(html).toContain('Služba Rithmic neposílá čerstvé ceny');
  });
  it('says plainly when the Rithmic service is not running or is still connecting', () => {
    const off = chartDataQuality({ ...base, liveStatus: 'unavailable', liveCapturedAt: null, liveSource: null });
    expect(off.tone).toBe('warn');
    expect(off.reasons.join()).toContain('Služba Rithmic na Macu neběží');
    expect(off.source).toBe('Historie');
    const waiting = chartDataQuality({ ...base, liveStatus: 'loading', liveCapturedAt: null, liveSource: null });
    expect(waiting.title).toBe('Svíčky: načítání');
    expect(chartDataQuality({ ...base, liveStatus: 'stale' }).title).toBe('Svíčky: živá data stojí');
  });
});
