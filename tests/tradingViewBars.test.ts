import { describe, expect, it, vi } from 'vitest';
import {
  mergeTvBarCaptures,
  parseTvBarsFileName,
  pickTvBars,
  sanitizeTvBars,
  tvBarsStoragePath,
  tvSymbolRoot,
  validateTvBarsCapture,
  type TvBar,
} from '../lib/tradingViewBars';
import { scheduleTradingViewBarsCapture } from '../services/tradingViewBars';

const AT = Date.UTC(2026, 8, 30, 18, 48, 30);
const minute = (offset: number) => Math.floor(AT / 60_000) * 60 + offset * 60;
const bar = (offset: number, close = 30_680): TvBar => [minute(offset), close, close + 2, close - 2, close, 10];

describe('tvSymbolRoot', () => {
  it('reads the contract root from TradingView and Tradovate symbols', () => {
    expect(tvSymbolRoot('CME_MINI:MNQ1!')).toBe('MNQ');
    expect(tvSymbolRoot('NQ1!')).toBe('NQ');
    expect(tvSymbolRoot('M2K1!')).toBe('M2K');
    expect(tvSymbolRoot('MNQZ6')).toBe('MNQ');
    expect(tvSymbolRoot('ESH27')).toBe('ES');
    expect(tvSymbolRoot('MNQ')).toBe('MNQ');
    expect(tvSymbolRoot('../evil')).toBeNull();
    expect(tvSymbolRoot(42)).toBeNull();
  });
});

describe('sanitizeTvBars', () => {
  it('keeps only ordered, minute-aligned, consistent candles near the capture time', () => {
    const rows = [
      bar(-3), bar(-3), [minute(-2) + 5, 1, 2, 0.5, 1, 1], [minute(-1), 10, 9, 8, 10, 1],
      [minute(-1), 30_680, 30_682, 30_678, 30_681, -5], bar(0), bar(3), 'junk',
    ];
    const clean = sanitizeTvBars(rows, AT);
    expect(clean.map(item => item[0])).toEqual([minute(-3), minute(-1), minute(0)]);
    expect(clean[1][5]).toBe(0);
  });

  it('drops candles older than a day', () => {
    expect(sanitizeTvBars([[minute(-24 * 60 - 1), 1, 1, 1, 1, 1]], AT)).toEqual([]);
  });
});

describe('pickTvBars', () => {
  it('prefers the exact contract root, then the same price family, and ignores other markets', () => {
    const readings = [
      { symbol: 'CME:ES1!', bars: [bar(-5), bar(-4), bar(-3)] },
      { symbol: 'CME_MINI:NQ1!', bars: [bar(-5), bar(-4), bar(-3)] },
      { symbol: 'CME_MINI:MNQ1!', bars: [bar(-2)] },
    ];
    expect(pickTvBars(readings, 'MNQ', AT)?.source).toBe('CME_MINI:MNQ1!');
    expect(pickTvBars(readings.slice(0, 2), 'MNQ', AT)?.source).toBe('CME_MINI:NQ1!');
    expect(pickTvBars(readings.slice(0, 1), 'MNQ', AT)).toBeNull();
  });
});

describe('validateTvBarsCapture', () => {
  it('accepts a clean capture and rejects bad roots, times and oversized payloads', () => {
    const capture = validateTvBarsCapture({ root: 'MNQ', at: AT, source: 'CME_MINI:MNQ1!', bars: [bar(-1), bar(0)] }, AT);
    expect(capture.bars).toHaveLength(2);
    expect(() => validateTvBarsCapture({ root: 'MNQ/../x', at: AT, bars: [bar(0)] }, AT)).toThrow('tv-bars-invalid-root');
    expect(() => validateTvBarsCapture({ root: 'MNQ', at: AT + 3_600_000, bars: [bar(0)] }, AT)).toThrow('tv-bars-invalid-at');
    expect(() => validateTvBarsCapture({ root: 'MNQ', at: AT, bars: Array(1_501).fill(bar(0)) }, AT)).toThrow('tv-bars-invalid-bars');
    expect(() => validateTvBarsCapture({ root: 'MNQ', at: AT, bars: [['x']] }, AT)).toThrow('tv-bars-empty');
  });
});

describe('storage path and merge', () => {
  it('stores captures per user and UTC day and parses the file name back', () => {
    const path = tvBarsStoragePath('user-1', { root: 'MNQ', at: AT });
    expect(path).toBe(`user-1/tv-bars/2026-09-30/MNQ-${AT}.json`);
    expect(parseTvBarsFileName(path.split('/').pop()!)).toEqual({ root: 'MNQ', at: AT });
    expect(parseTvBarsFileName('MNQ-1.png')).toBeNull();
  });

  it('merges captures so the later reading wins for the same minute', () => {
    const merged = mergeTvBarCaptures([
      { at: AT + 20 * 60_000, bars: [bar(0, 30_700), bar(1)] },
      { at: AT, bars: [bar(-1), bar(0, 30_690)] },
    ]);
    expect(merged.map(item => item[0])).toEqual([minute(-1), minute(0), minute(1)]);
    expect(merged[1][4]).toBe(30_700);
  });
});

describe('scheduleTradingViewBarsCapture', () => {
  it('reads after the exit, uploads fresh bars and skips a chart that ends before the exit', async () => {
    vi.useFakeTimers();
    try {
      const upload = vi.fn(async () => {});
      const log = vi.fn();
      const fresh = { root: 'MNQ', at: AT, source: 'MNQ1!', bars: [bar(-1), bar(0)] };
      const stale = { ...fresh, bars: [bar(-30)] };
      const read = vi.fn().mockResolvedValueOnce(fresh).mockResolvedValueOnce(stale);
      scheduleTradingViewBarsCapture({ symbol: 'MNQZ6', exitAt: AT, upload, read, log, delaysMs: [1_000, 2_000], now: () => AT });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(read).toHaveBeenCalledWith('MNQ');
      expect(upload).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=stale-chart'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending reads and never throws when upload fails', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn().mockResolvedValue({ root: 'MNQ', at: AT, source: 'MNQ1!', bars: [bar(0)] });
      const log = vi.fn();
      const cancel = scheduleTradingViewBarsCapture({ symbol: 'MNQZ6', exitAt: AT, read, log, delaysMs: [1_000, 5_000], now: () => AT,
        upload: async () => { throw new Error('relay-unavailable'); } });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('error=relay-unavailable'));
      cancel();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('storeTvBarsCapture', () => {
  it('uploads the capture and prunes only days past the retention window', async () => {
    const { storeTvBarsCapture } = await import('../server/copierSnapshotStore');
    const uploads: string[] = [];
    const removed: string[][] = [];
    const listing: Record<string, { name: string }[]> = {
      'user-1/tv-bars': [{ name: '2026-09-25' }, { name: '2026-09-27' }, { name: '2026-09-30' }, { name: 'junk' }],
      'user-1/tv-bars/2026-09-25': [{ name: 'MNQ-1.json' }, { name: 'note.txt' }],
    };
    const bucket = {
      upload: async (path: string) => { uploads.push(path); return { error: null }; },
      list: async (folder: string) => ({ data: listing[folder] ?? [] }),
      remove: async (paths: string[]) => { removed.push(paths); return { error: null }; },
    };
    const db = { storage: { from: () => bucket } } as never;
    const result = await storeTvBarsCapture({ db, userId: 'user-1', capture: { root: 'MNQ', at: AT, source: 'MNQ1!', bars: [bar(0)] } });
    expect(result.storagePath).toBe(`user-1/tv-bars/2026-09-30/MNQ-${AT}.json`);
    expect(uploads).toEqual([result.storagePath]);
    expect(removed).toEqual([['user-1/tv-bars/2026-09-25/MNQ-1.json']]);
  });
});
