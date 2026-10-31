import { describe, expect, it } from 'vitest';
import { indicatorContextWindow, renderableCandleWindow } from '../services/chartCandleWindow';

describe('history replacement while a viewport restore is pending', () => {
  it('includes the complete historical viewport and warm-up without using future bars', () => {
    const rows = Array.from({ length: 1000 }, (_, time) => ({ time }));
    expect(indicatorContextWindow(rows, { from: 100, to: 190 }, 45)).toEqual({ start: 55, end: 191 });
    expect(indicatorContextWindow(rows, { from: 3, to: 90 }, 45)).toEqual({ start: 0, end: 91 });
    expect(indicatorContextWindow(rows, { from: -100, to: -1 }, 45)).toEqual({ start: 0, end: 0 });
    const expanded = [...Array.from({ length: 300 }, (_, i) => ({ time: i - 300 })), ...rows];
    const range = indicatorContextWindow(expanded, { from: 100, to: 190 }, 45);
    expect(expanded.slice(range.start, range.end)).toEqual(rows.slice(55, 191));
  });
  it('keeps a shorter nonempty history visible instead of retaining indices beyond its end', () => {
    const window = renderableCandleWindow({ start: 13000, end: 15000 }, { start: 410, end: 1700 }, 1700);
    expect(Array.from({ length: 1700 }).slice(window.start, window.end).length).toBe(1290);
    expect(renderableCandleWindow(window, { start: 0, end: 100 }, 1700)).toBe(window);
  });
  it('preserves a valid expanded range, clamps its end, and represents an empty input honestly', () => {
    const current = { start: 20, end: 100 };
    expect(renderableCandleWindow(current, { start: 50, end: 100 }, 100)).toBe(current);
    expect(renderableCandleWindow(current, current, 60)).toEqual({ start: 20, end: 60 });
    expect(renderableCandleWindow(current, current, 0)).toEqual({ start: 0, end: 0 });
  });
});
