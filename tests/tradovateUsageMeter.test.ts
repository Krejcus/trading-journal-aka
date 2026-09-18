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
  it('vrací semafor podle oficiálních limitů: 5000/h na uživatele, 300 syncrequest/h na IP, tempo 84/min', () => {
    expect(tradovateUsageLevel({ minute: 10, hour: 100 })).toBe('ok');
    expect(tradovateUsageLevel({ minute: 85, hour: 100 })).toBe('warn');
    expect(tradovateUsageLevel({ minute: 10, hour: 3_001 })).toBe('warn');
    expect(tradovateUsageLevel({ minute: 1, hour: 5_001 })).toBe('over');
    expect(tradovateUsageLevel({ minute: 1, hour: 10 }, 181)).toBe('warn');
    expect(tradovateUsageLevel({ minute: 1, hour: 10 }, 301)).toBe('over');
  });
});
