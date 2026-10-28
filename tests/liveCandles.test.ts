import { describe, expect, it, vi } from 'vitest';
import { tvLiveBarsStoragePath, type TvBar, type TvBarsCapture } from '../lib/tradingViewBars';
import { startTradingViewLiveBars, TV_LIVE_BARS_PHASE_MS } from '../services/tradingViewBars';
import { LIVE_CANDLES_CATCH_UP_MS, LIVE_CANDLES_POLL_PHASE_MS, liveCandlesCatchUpDelay, nextLiveCandlesPollDelay } from '../hooks/useLiveCandles';

vi.mock('../services/supabase', () => ({ supabase: {} }));
import { LIVE_CANDLES_STALE_MS, parseLiveCandlesFile, stitchLiveCandles } from '../services/liveCandles';

const AT = Date.UTC(2026, 9, 13, 6, 30, 20);
const minute = (offset: number) => Math.floor(AT / 60_000) * 60 + offset * 60;
const bar = (offset: number, close = 31_420): TvBar => [minute(offset), close, close + 2, close - 2, close, 10];
const capture = (bars: TvBar[], at = AT): TvBarsCapture => ({ root: 'MNQ', at, source: 'CME_MINI:MNQ1!', bars });

/** Ruční interval: test spouští ticky sám a čeká, až doběhnou. */
function manualInterval() {
  let fn: (() => void) | null = null;
  const setIntervalImpl = ((callback: () => void) => { fn = callback; return { unref() {} }; }) as unknown as typeof setInterval;
  const clearIntervalImpl = vi.fn() as unknown as typeof clearInterval;
  return { setIntervalImpl, clearIntervalImpl, tick: () => fn?.() };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('tvLiveBarsStoragePath', () => {
  it('stores MNQ and NQ in one file per price family inside the user folder', () => {
    expect(tvLiveBarsStoragePath('user-1', 'MNQ')).toBe('user-1/tv-live/NQ.json');
    expect(tvLiveBarsStoragePath('user-1', 'NQ')).toBe('user-1/tv-live/NQ.json');
    expect(tvLiveBarsStoragePath('user-1', 'MES')).toBe('user-1/tv-live/ES.json');
  });
});

describe('startTradingViewLiveBars', () => {
  it('uploads a fresh read, skips an unchanged chart and uploads again after a new candle', async () => {
    const clock = manualInterval();
    const reads = [capture([bar(-1), bar(0)]), capture([bar(-1), bar(0)]), capture([bar(-1), bar(0), bar(1)])];
    const read = vi.fn(async () => reads.shift() ?? null);
    const upload = vi.fn(async (_capture: TvBarsCapture) => {});
    const feed = startTradingViewLiveBars({ roots: ['MNQ'], read, upload, ...clock });
    await flush();
    clock.tick(); await flush();
    clock.tick(); await flush();
    expect(read).toHaveBeenCalledTimes(3);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0].bars).toHaveLength(3);
    feed.stop();
    expect(clock.clearIntervalImpl).toHaveBeenCalledOnce();
  });

  it('never overlaps reads and never throws when the chart or the upload fails', async () => {
    const clock = manualInterval();
    let release: (value: TvBarsCapture | null) => void = () => {};
    const read = vi.fn(() => new Promise<TvBarsCapture | null>(resolve => { release = resolve; }));
    const upload = vi.fn(async (_capture: TvBarsCapture) => { throw new Error('relay-unavailable'); });
    const log = vi.fn();
    startTradingViewLiveBars({ roots: ['MNQ'], read, upload, log, ...clock });
    clock.tick(); clock.tick();
    expect(read).toHaveBeenCalledOnce();
    release(capture([bar(0)]));
    await flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('TV LIVE failed root=MNQ error=relay-unavailable'));
  });

  it('retries a failed upload on the next tick and logs a repeated state only once', async () => {
    const clock = manualInterval();
    const read = vi.fn(async () => capture([bar(0)]));
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('relay-unavailable'))
      .mockRejectedValueOnce(new Error('relay-unavailable'))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    startTradingViewLiveBars({ roots: ['MNQ'], read, upload, log, ...clock });
    await flush();
    clock.tick(); await flush();
    clock.tick(); await flush();
    expect(upload).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.filter(([message]) => String(message).includes('failed'))).toHaveLength(1);
    expect(log.mock.calls.filter(([message]) => String(message).includes('uploading'))).toHaveLength(1);
  });

  it('skips silently without a 1m chart and stops reading after stop()', async () => {
    const clock = manualInterval();
    const read = vi.fn(async (_root: string): Promise<TvBarsCapture | null> => null);
    const upload = vi.fn(async (_capture: TvBarsCapture) => {});
    const log = vi.fn();
    const feed = startTradingViewLiveBars({ roots: ['MNQ', 'nonsense/..', 'MNQ'], read, upload, log, ...clock });
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=no-1m-chart'));
    feed.stop();
    clock.tick(); await flush();
    expect(read).toHaveBeenCalledOnce();
  });
});

describe('startTradingViewLiveBars guards', () => {
  it('re-sends an unchanged chart after the keepalive so a quiet market is not reported as down', async () => {
    const clock = manualInterval();
    let now = AT;
    const read = vi.fn(async () => capture([bar(0)]));
    const upload = vi.fn(async (_capture: TvBarsCapture) => {});
    startTradingViewLiveBars({ roots: ['MNQ'], read, upload, now: () => now, ...clock });
    await flush();
    now += 60_000; clock.tick(); await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    now += 70_000; clock.tick(); await flush();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('does not upload when stop() arrives during a slow chart read', async () => {
    const clock = manualInterval();
    let release: (value: TvBarsCapture | null) => void = () => {};
    const read = vi.fn(() => new Promise<TvBarsCapture | null>(resolve => { release = resolve; }));
    const upload = vi.fn(async (_capture: TvBarsCapture) => {});
    const feed = startTradingViewLiveBars({ roots: ['MNQ'], read, upload, ...clock });
    feed.stop();
    release(capture([bar(0)]));
    await flush();
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not read the chart before the relay is ready and reads one root per price family', async () => {
    const clock = manualInterval();
    let ready = false;
    const read = vi.fn(async (_root: string): Promise<TvBarsCapture | null> => null);
    startTradingViewLiveBars({ roots: ['MNQ', 'NQ', 'MES', 'ES', 'MGC'], read, upload: vi.fn(), ready: () => ready, ...clock });
    await flush();
    expect(read).not.toHaveBeenCalled();
    ready = true;
    clock.tick(); await flush();
    expect(read.mock.calls.map(([root]) => root)).toEqual(['MNQ', 'MES']);
  });
});

describe('parseLiveCandlesFile', () => {
  it('turns a stored read into chart candles and marks old reads as stale', () => {
    const text = JSON.stringify({ v: 1, ...capture([bar(-2), bar(-1), bar(0)]) });
    const fresh = parseLiveCandlesFile(text, 'MNQ', AT + 30_000);
    expect(fresh?.stale).toBe(false);
    expect(fresh?.response.provider).toBe('tradingview');
    expect(fresh?.response.candles.map(candle => candle.time)).toEqual([minute(-2), minute(-1), minute(0)]);
    expect(parseLiveCandlesFile(text, 'MNQ', AT + LIVE_CANDLES_STALE_MS + 1)?.stale).toBe(true);
  });

  it('rejects junk, empty and future reads instead of throwing', () => {
    expect(parseLiveCandlesFile('not json', 'MNQ', AT)).toBeNull();
    expect(parseLiveCandlesFile(JSON.stringify({ at: AT, bars: [] }), 'MNQ', AT)).toBeNull();
    expect(parseLiveCandlesFile(JSON.stringify({ at: AT + 3_600_000, bars: [bar(0)] }), 'MNQ', AT)).toBeNull();
  });
});

describe('stitchLiveCandles', () => {
  const candle = (time: number, close: number) => ({ time, open: close, high: close, low: close, close, volume: 1 });
  it('keeps historical candles and appends only live candles after the last historical one', () => {
    const historical = [candle(60, 1), candle(120, 2)];
    const live = [candle(60, 9), candle(120, 9), candle(180, 3), candle(240, 4)];
    expect(stitchLiveCandles(historical, live).map(item => item.close)).toEqual([1, 2, 3, 4]);
    expect(stitchLiveCandles([], live)).toHaveLength(4);
  });
});

describe('zarovnání na minutu (předposlední svíčka grafu dne, 28. 10. 2026)', () => {
  it('worker čte hned a pak vždy v 10. sekundě minuty, interval až po zarovnání', async () => {
    const minuteStart = Date.UTC(2026, 9, 28, 13, 41, 0);
    let timeoutDelay = -1;
    let timeoutFn: (() => void) | null = null;
    const clock = manualInterval();
    const read = vi.fn(async () => null);
    startTradingViewLiveBars({
      roots: ['MNQ'], read, upload: vi.fn(), ...clock,
      phaseMs: TV_LIVE_BARS_PHASE_MS,
      now: () => minuteStart + 41_000,
      setTimeoutImpl: ((fn: () => void, ms: number) => { timeoutFn = fn; timeoutDelay = ms; return { unref() {} }; }) as unknown as typeof setTimeout,
    });
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(timeoutDelay).toBe(29_000);
    clock.tick();
    await flush();
    expect(read).toHaveBeenCalledOnce();
    timeoutFn!();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('po uspání Macu (skok hodin) se další běh vrátí na 10. sekundu minuty', async () => {
    const minuteStart = Date.UTC(2026, 9, 28, 13, 41, 0);
    let clockNow = minuteStart + 10_000;
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    startTradingViewLiveBars({
      roots: ['MNQ'], read: vi.fn(async () => null), upload: vi.fn(),
      phaseMs: TV_LIVE_BARS_PHASE_MS,
      now: () => clockNow,
      setTimeoutImpl: ((fn: () => void, ms: number) => { pending = fn; delays.push(ms); return { unref() {} }; }) as unknown as typeof setTimeout,
    });
    expect(delays.at(-1)).toBe(60_000);
    // Mac spal: časovač vystřelí o 25 s později (v 35. s další minuty).
    clockNow = minuteStart + 60_000 + 35_000;
    pending!();
    await flush();
    expect(delays.at(-1)).toBe(35_000);
    // Časovač vystřelí o chlup dřív: druhý běh hned za sebou se neplánuje.
    clockNow = minuteStart + 120_000 + 9_999;
    pending!();
    expect(delays.at(-1)).toBe(60_001);
  });

  it('appka načítá soubor ve 20. sekundě minuty (po uploadu v 10. s)', () => {
    const minuteStart = Date.UTC(2026, 9, 28, 13, 41, 0);
    expect(LIVE_CANDLES_POLL_PHASE_MS).toBeGreaterThan(TV_LIVE_BARS_PHASE_MS);
    expect(nextLiveCandlesPollDelay(minuteStart + 41_000, 60_000)).toBe(39_000);
    expect(nextLiveCandlesPollDelay(minuteStart + 5_000, 60_000)).toBe(15_000);
    // Těsně před 20. s nečekat 1 s, ale celou další minutu.
    expect(nextLiveCandlesPollDelay(minuteStart + 18_000, 60_000)).toBe(62_000);
    expect(nextLiveCandlesPollDelay(minuteStart + 18_000, 30_000)).toBe(30_000);
  });

  it('načtení mimo fázi v :00–:14 se dožene hned po uploadu (předposlední svíčka nečeká do :20)', () => {
    const minuteStart = Date.UTC(2026, 9, 28, 13, 41, 0);
    expect(LIVE_CANDLES_CATCH_UP_MS).toBeGreaterThan(TV_LIVE_BARS_PHASE_MS);
    expect(LIVE_CANDLES_CATCH_UP_MS).toBeLessThan(LIVE_CANDLES_POLL_PHASE_MS);
    expect(liveCandlesCatchUpDelay(minuteStart + 3_000)).toBe(11_000);
    expect(liveCandlesCatchUpDelay(minuteStart + 13_999)).toBe(1);
    expect(liveCandlesCatchUpDelay(minuteStart + 14_000)).toBeNull();
    expect(liveCandlesCatchUpDelay(minuteStart + 45_000)).toBeNull();
  });
});
