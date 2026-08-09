import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDICATOR_SETTINGS,
  indicatorVisibleOnTimeframe,
} from '../components/ChartIndicatorSettingsDialog';
import { colorWithAlpha, splitColorAlpha } from '../components/TradingViewColorPicker';
import { matchingIndicatorTemplateName, upsertIndicatorTemplate, type IndicatorTemplateRecord } from '../components/IndicatorTemplateMenu';

describe('indicatorVisibleOnTimeframe', () => {
  it('respects minute visibility bounds', () => {
    const visibility = {
      ...DEFAULT_INDICATOR_SETTINGS.fvg.visibility,
      minuteFrom: 5,
      minuteTo: 15,
    };
    expect(indicatorVisibleOnTimeframe('1m', visibility)).toBe(false);
    expect(indicatorVisibleOnTimeframe('5m', visibility)).toBe(true);
    expect(indicatorVisibleOnTimeframe('15m', visibility)).toBe(true);
    expect(indicatorVisibleOnTimeframe('30m', visibility)).toBe(false);
  });

  it('can independently hide hourly and daily charts', () => {
    const visibility = {
      ...DEFAULT_INDICATOR_SETTINGS.structure.visibility,
      hours: false,
      days: false,
    };
    expect(indicatorVisibleOnTimeframe('1m', visibility)).toBe(true);
    expect(indicatorVisibleOnTimeframe('1h', visibility)).toBe(false);
    expect(indicatorVisibleOnTimeframe('4h', visibility)).toBe(false);
    expect(indicatorVisibleOnTimeframe('1d', visibility)).toBe(false);
  });
});

describe('TradingView color values', () => {
  it('round-trips a color with opacity', () => {
    const value = colorWithAlpha('#2196f3', 30);
    expect(value).toBe('#2196f34d');
    expect(splitColorAlpha(value)).toEqual({ color: '#2196f3', opacity: 30 });
  });

  it('keeps independent FVG opacity defaults', () => {
    expect(DEFAULT_INDICATOR_SETTINGS.fvg.bullOpacity).toBe(30);
    expect(DEFAULT_INDICATOR_SETTINGS.fvg.bearOpacity).toBe(30);
  });
});

describe('indicator templates', () => {
  it('replaces a same-name template for the same indicator without duplicating it', () => {
    const original: IndicatorTemplateRecord = {
      id: 'first', indicator: 'fvg', name: 'Černo modrá', value: { maxCount: 10 }, updatedAt: '2026-08-01',
    };
    const next = upsertIndicatorTemplate([original], {
      id: 'second', indicator: 'fvg', name: 'černo MODRÁ', value: { maxCount: 20 }, updatedAt: '2026-08-02',
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'first', name: 'černo MODRÁ', value: { maxCount: 20 } });
  });

  it('allows the same template name for another indicator', () => {
    const original: IndicatorTemplateRecord = {
      id: 'fvg', indicator: 'fvg', name: 'Moje', value: {}, updatedAt: '2026-08-01',
    };
    expect(upsertIndicatorTemplate([original], {
      id: 'levels', indicator: 'levels', name: 'Moje', value: {}, updatedAt: '2026-08-02',
    })).toHaveLength(2);
  });

  it('shows the matching template name while ignoring the runtime timeframe', () => {
    const template: IndicatorTemplateRecord = {
      id: 'fib-blue',
      indicator: 'drawing:fib-retracement',
      name: 'Moje Fib',
      value: { levels: [0, 0.5, 1], runtimeTimeframeMinutes: 1 },
      updatedAt: '2026-08-02T00:00:00.000Z',
    };

    expect(matchingIndicatorTemplateName(
      [template],
      'drawing:fib-retracement',
      { levels: [0, 0.5, 1], runtimeTimeframeMinutes: 15 },
    )).toBe('Moje Fib');
    expect(matchingIndicatorTemplateName(
      [template],
      'drawing:fib-retracement',
      { levels: [0, 0.618, 1], runtimeTimeframeMinutes: 15 },
    )).toBeNull();
  });
});
