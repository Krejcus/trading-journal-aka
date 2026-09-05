import { describe, expect, it } from 'vitest';

import {
  formatTradingWindows,
  isAfterTradingWindowsAt,
  isTradingWindowWarningAt,
  lastTradingWindowEnd,
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

describe('copier daily trading window — více oken', () => {
  const twoWindows = { ...window, additional: [{ from: '23:00', to: '23:30' }] };

  it('inside platí v kterémkoli okně, mezera mezi okny je outside, ale ne konec dne', () => {
    expect(tradingWindowStateAt(twoWindows, Date.parse('2026-01-15T20:00:00Z'))).toBe('inside');
    // 22:15 Praha = mezera mezi okny
    expect(tradingWindowStateAt(twoWindows, Date.parse('2026-01-15T21:15:00Z'))).toBe('outside');
    expect(isAfterTradingWindowsAt(twoWindows, Date.parse('2026-01-15T21:15:00Z'))).toBe(false);
    // 23:10 Praha = druhé okno
    expect(tradingWindowStateAt(twoWindows, Date.parse('2026-01-15T22:10:00Z'))).toBe('inside');
    // 23:30 Praha = po posledním okně
    expect(tradingWindowStateAt(twoWindows, Date.parse('2026-01-15T22:30:00Z'))).toBe('outside');
    expect(isAfterTradingWindowsAt(twoWindows, Date.parse('2026-01-15T22:30:00Z'))).toBe(true);
  });

  it('varování před koncem a konec dne se řídí posledním oknem', () => {
    expect(lastTradingWindowEnd(twoWindows)).toBe(23 * 60 + 30);
    expect(isTradingWindowWarningAt(twoWindows, Date.parse('2026-01-15T20:55:00Z'))).toBe(false);
    expect(isTradingWindowWarningAt(twoWindows, Date.parse('2026-01-15T22:25:00Z'))).toBe(true);
    expect(formatTradingWindows(twoWindows)).toBe('15:30–22:00, 23:00–23:30');
  });
});
