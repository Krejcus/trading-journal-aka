import { describe, expect, it } from 'vitest';
import { createTradovateUsageMeter, tradovateUsageLevel } from '../lib/tradovateUsageMeter';

describe('Tradovate usage meter', () => {
  it('počítá klouzavou minutu a hodinu po minutových koších', () => {
    let now = Date.parse('2026-09-18T18:50:10.000Z');
    const meter = createTradovateUsageMeter(() => now);
    meter.record(3);
    now += 30_000; meter.record(2);
    expect(meter.snapshot()).toEqual({ minute: 5, hour: 5 });
    now += 60_000; meter.record();
    expect(meter.snapshot()).toEqual({ minute: 1, hour: 6 });
    now += 60 * 60_000;
    expect(meter.snapshot()).toEqual({ minute: 0, hour: 0 });
    meter.record(0); meter.record(-4); meter.record(Number.NaN);
    expect(meter.snapshot()).toEqual({ minute: 0, hour: 0 });
  });
  it('vrací semafor podle limitů 80/min a 5000/h', () => {
    expect(tradovateUsageLevel({ minute: 10, hour: 100 })).toBe('ok');
    expect(tradovateUsageLevel({ minute: 49, hour: 100 })).toBe('warn');
    expect(tradovateUsageLevel({ minute: 81, hour: 100 })).toBe('over');
    expect(tradovateUsageLevel({ minute: 1, hour: 5_001 })).toBe('over');
  });
});
