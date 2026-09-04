import { describe, expect, it } from 'vitest';

import {
  isTradingWindowWarningAt,
  tradingWindowStateAt,
} from '../services/copierDailyRules';

const window = {
  enabled: true,
  from: '15:30',
  to: '22:00',
  timeZone: 'Europe/Prague',
};

describe('copier daily trading window', () => {
  it('uses an inclusive start and exclusive end in Europe/Prague', () => {
    expect(tradingWindowStateAt(window, Date.parse('2026-01-15T14:29:59Z'))).toBe('outside');
    expect(tradingWindowStateAt(window, Date.parse('2026-01-15T14:30:00Z'))).toBe('inside');
    expect(tradingWindowStateAt(window, Date.parse('2026-01-15T20:59:59Z'))).toBe('inside');
    expect(tradingWindowStateAt(window, Date.parse('2026-01-15T21:00:00Z'))).toBe('outside');
  });

  it('respects Prague daylight saving time and disabled rules', () => {
    expect(tradingWindowStateAt(window, Date.parse('2026-06-15T13:29:00Z'))).toBe('outside');
    expect(tradingWindowStateAt(window, Date.parse('2026-06-15T13:30:00Z'))).toBe('inside');
    expect(tradingWindowStateAt(window, Date.parse('2026-06-15T20:00:00Z'))).toBe('outside');
    expect(tradingWindowStateAt({ ...window, enabled: false }, Date.parse('2026-06-15T20:00:00Z'))).toBe('off');
  });

  it('warns exactly during the final ten wall-clock minutes', () => {
    expect(isTradingWindowWarningAt(window, Date.parse('2026-01-15T20:49:00Z'))).toBe(false);
    expect(isTradingWindowWarningAt(window, Date.parse('2026-01-15T20:50:00Z'))).toBe(true);
    expect(isTradingWindowWarningAt(window, Date.parse('2026-01-15T20:59:59Z'))).toBe(true);
    expect(isTradingWindowWarningAt(window, Date.parse('2026-01-15T21:00:00Z'))).toBe(false);
  });
});
