import { describe, expect, it } from 'vitest';
import { chartDrawingToolForShortcut } from '../services/chartDrawingShortcuts';

const shortcut = (code: string, overrides: Partial<KeyboardEvent> = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code,
  ...overrides,
});

describe('TradingView drawing shortcuts', () => {
  it('maps the supported Option/Alt drawing shortcuts by physical key', () => {
    expect(chartDrawingToolForShortcut(shortcut('KeyT'))).toBe('TrendLine');
    expect(chartDrawingToolForShortcut(shortcut('KeyH'))).toBe('HorizontalLine');
    expect(chartDrawingToolForShortcut(shortcut('KeyJ'))).toBe('HorizontalRay');
    expect(chartDrawingToolForShortcut(shortcut('KeyV'))).toBe('VerticalLine');
    expect(chartDrawingToolForShortcut(shortcut('KeyC'))).toBe('CrossLine');
  });

  it('ignores unmodified and conflicting shortcut combinations', () => {
    expect(chartDrawingToolForShortcut(shortcut('KeyT', { altKey: false }))).toBeNull();
    expect(chartDrawingToolForShortcut(shortcut('KeyH', { metaKey: true }))).toBeNull();
    expect(chartDrawingToolForShortcut(shortcut('KeyV', { shiftKey: true }))).toBeNull();
    expect(chartDrawingToolForShortcut(shortcut('KeyR'))).toBeNull();
  });
});
