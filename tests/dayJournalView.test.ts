import { describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { emptyDayJournal, pragueWallTime, sessionWindows, type DayJournal } from '../lib/dayJournal';
import { dayChecklist, dayFeed, dayStats, prepSummary, streakState, tradesForDay, tradesInScope, tradingDaysBack } from '../lib/dayJournalView';

vi.mock('../services/supabase', () => ({ supabase: {} }));
vi.mock('../services/marketData', () => ({
  loadMarketCandles: vi.fn(), loadTradeMarketCandles: vi.fn(),
  marketDataWindowForEntry: (ms: number) => ({ start: new Date(ms - 14 * 86_400_000), end: new Date(ms + 86_400_000) }),
  resolveMarketSymbol: (root: string) => `${root}.v.0`,
}));
import { composeDayCandles, dayCandleWindow, loadDayHistoricalCandles } from '../services/dayCandles';

const DAY = '2026-10-13';
const at = (clock: string, day = DAY) => pragueWallTime(day, clock);
const windows = sessionWindows(DAY);
const trade = (id: string, clock: string, pnl: number, extra: Partial<Trade> = {}): Trade => ({
  id, accountId: 'a', pnl, direction: 'Long', date: DAY, timestamp: at(clock) + 20 * 60_000, entryTime: at(clock), durationMinutes: 20, riskAmount: 100, ...extra,
} as Trade);
const NOTE = '3f2a8c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b';

describe('trades of the day', () => {
  const trades = [trade('t1', '10:05', 300), trade('t2', '11:48', -100), trade('t3', '16:10', 200), trade('x', '23:59', 50, { date: '2026-10-14', entryTime: at('00:30', '2026-10-14') }), trade('u', '10:00', 0, { untaken: {} as never })];

  it('keeps Prague-day entries without untaken orders and splits them by session', () => {
    const day = tradesForDay(trades, DAY);
    expect(day.map(item => item.id)).toEqual(['t1', 't2', 't3']);
    expect(tradesInScope(day, 'london', windows).map(item => item.id)).toEqual(['t1', 't2']);
    expect(tradesInScope(day, 'ny', windows).map(item => item.id)).toEqual(['t3']);
  });

  it('sums P&L, R, drawdown and only sums R when every trade has it', () => {
    const stats = dayStats(tradesForDay(trades, DAY));
    expect(stats).toMatchObject({ count: 3, pnl: 400, wins: 2, losses: 1, rSum: 4, maxDrawdown: -100, best: 300, avgHoldMinutes: 20 });
    expect(dayStats([trade('t1', '10:05', 300), trade('t2', '11:00', 100, { riskAmount: undefined })]).rSum).toBeNull();
    expect(dayStats([]).winRate).toBeNull();
  });
});

describe('checklist and feed', () => {
  const journal: DayJournal = {
    ...emptyDayJournal(DAY),
    preps: { london: { session: 'london', bias: 'long', scenario: 'Sweep Asia low a long z FVG', rules: [], durationSec: 52, writtenAt: new Date(at('07:55')).toISOString(), savedAt: new Date(at('07:56')).toISOString() } },
    closes: { london: { session: 'london', summary: 'Ráno čisté. Po TP odejít.', execution: 'partial', verdicts: {}, writtenAt: new Date(at('13:10')).toISOString(), closedAt: new Date(at('13:10')).toISOString() } },
    notes: [
      { id: NOTE, session: 'london', text: 'Pin z přípravy', time: Math.floor(at('10:00') / 1000), price: 31_388, voice: true, origin: 'prep', writtenAt: new Date(at('07:53')).toISOString(), updatedAt: new Date(at('07:53')).toISOString() },
      { id: '11111111-2222-4333-8444-555555555555', session: 'london', text: 'Stop moc těsně', time: Math.floor(at('11:50') / 1000), price: 31_441, voice: false, origin: 'chart', writtenAt: new Date(at('20:40')).toISOString(), updatedAt: new Date(at('20:40')).toISOString() },
    ],
  };
  const trades = [trade('t1', '10:05', 300, { planAdherence: 'Yes' }), trade('t2', '11:48', -100)];

  it('reports what is left to journal for the day', () => {
    const items = dayChecklist(journal, trades, windows, at('15:00'));
    const byId = Object.fromEntries(items.map(item => [item.id, item]));
    expect(byId['prep:london']).toMatchObject({ done: true, meta: '07:55 · 52 s' });
    expect(byId['prep:ny']).toMatchObject({ done: false, meta: 'do 15:30' });
    expect(byId.rated).toMatchObject({ done: false, meta: '1/2' });
    expect(byId['loss-notes']).toMatchObject({ done: true, meta: '1/1' });
    expect(byId['close:london']).toMatchObject({ done: true, meta: '13:10' });
    expect(byId['close:ny']).toMatchObject({ done: false, meta: 'po 15:30' });
  });

  it('orders prep, trades, later notes and close by time and folds prep pins into the prep card', () => {
    const feed = dayFeed(journal, trades, windows, 'london');
    expect(feed.map(item => item.kind)).toEqual(['prep', 'trade', 'trade', 'close', 'note']);
    expect(feed[0]).toMatchObject({ kind: 'prep', pins: 1 });
    expect(feed[4]).toMatchObject({ kind: 'note', phase: 'later' });
    expect(feed[2]).toMatchObject({ kind: 'trade', plan: null });
    expect(dayFeed(journal, trades, windows, 'ny')).toEqual([]);
    expect(prepSummary(journal.preps.london!, 1)).toBe('Bias Long · Sweep Asia low a long z FVG · 1 poznámka v grafu');
  });
});

describe('streak', () => {
  it('lists the last trading days without weekends', () => {
    expect(tradingDaysBack('2026-10-13', 3)).toEqual(['2026-10-09', '2026-10-12', '2026-10-13']);
  });

  it('marks a day full only with both preps and every traded session closed', () => {
    const base = emptyDayJournal(DAY);
    const prep = (session: 'london' | 'ny') => ({ session, bias: 'long' as const, scenario: '', rules: [], durationSec: null, writtenAt: '', savedAt: '' });
    const close = (session: 'london' | 'ny') => ({ session, summary: '', execution: null, verdicts: {}, writtenAt: '', closedAt: '' });
    const full = { ...base, preps: { london: prep('london'), ny: prep('ny') }, closes: { london: close('london') } };
    expect(streakState(full, new Set(['london']), false)).toBe('full');
    expect(streakState(full, new Set(['london', 'ny']), false)).toBe('part');
    expect(streakState(undefined, new Set(), true)).toBe('open');
    expect(streakState(undefined, new Set(), false)).toBe('none');
  });
});

describe('day candles', () => {
  it('caps history just past the Databento delay so the paid fallback is never used', () => {
    const now = at('14:00');
    const window = dayCandleWindow(DAY, now);
    expect(window.needsLive).toBe(true);
    expect(window.historicalEnd!.getTime()).toBe(Math.floor((now - 24 * 3_600_000 - 20 * 60_000) / 900_000) * 900_000);
    const old = dayCandleWindow('2026-10-05', now);
    expect(old.needsLive).toBe(false);
    expect(old.historicalEnd!.getTime()).toBe(old.dayEnd);
  });

  it('cuts everything after the end of the day and stitches live candles only after history', () => {
    const window = dayCandleWindow(DAY, at('14:00'));
    const sec = (clock: string, day = DAY) => Math.floor(at(clock, day) / 1000);
    const candle = (time: number, close: number) => ({ time, open: close, high: close, low: close, close, volume: 1 });
    const historical = [candle(sec('10:00', '2026-10-12'), 1)];
    const live = [candle(sec('10:00', '2026-10-12'), 9), candle(sec('13:59'), 2), candle(sec('00:01', '2026-10-14'), 3)];
    expect(composeDayCandles(window, historical, live).map(item => item.close)).toEqual([1, 2]);
    expect(composeDayCandles({ ...window, needsLive: false }, historical, live).map(item => item.close)).toEqual([1]);
  });

  it('verifies the contract with the first trade entry when the day has trades', async () => {
    const response = { provider: 'databento', candles: [] } as never;
    const deps = { loadContinuous: vi.fn(async () => response), loadForTrade: vi.fn(async () => response) };
    await loadDayHistoricalCandles({ day: '2026-10-05', now: at('14:00'), deps });
    expect(deps.loadContinuous).toHaveBeenCalledWith('MNQ.v.0', expect.any(Date), expect.any(Date));
    await loadDayHistoricalCandles({ day: '2026-10-05', now: at('14:00'), anchor: { symbol: 'MNQZ6', at: at('10:00', '2026-10-05'), price: 31_000 }, deps });
    expect(deps.loadForTrade).toHaveBeenCalledWith(expect.objectContaining({ tradeSymbol: 'MNQZ6', entryPrice: 31_000 }));
  });
});

describe('bubble placement', async () => {
  const { bubbleTransform } = await import('../components/day/DayNotesLayer');
  it('prefers right, then left, then below within the chart', () => {
    expect(bubbleTransform(100, 200, 0, 600)).toBe('translate(14px, -50%)');
    expect(bubbleTransform(500, 200, 0, 600)).toBe('translate(calc(-100% - 14px), -50%)');
    expect(bubbleTransform(150, 230, 0, 330)).toBe('translate(-115px, 14px)');
  });
});

describe('day journal export', async () => {
  const { dayJournalCoachText, dayJournalMarkdown } = await import('../lib/dayJournalExport');
  const journal: DayJournal = {
    ...emptyDayJournal(DAY),
    preps: { london: { session: 'london', bias: 'long', scenario: 'Sweep Asia low', rules: ['2 ztráty v řadě'], durationSec: 52, writtenAt: new Date(at('07:55')).toISOString(), savedAt: new Date(at('07:55')).toISOString() } },
    closes: { london: { session: 'london', summary: 'Ráno čisté. Po TP odejít.', execution: 'partial', verdicts: { [NOTE]: 'ok' }, writtenAt: new Date(at('13:10')).toISOString(), closedAt: new Date(at('13:10')).toISOString() } },
    notes: [{ id: NOTE, session: 'london', text: 'Long z FVG | po displacementu', time: Math.floor(at('10:00') / 1000), price: 31_388, voice: true, origin: 'prep', writtenAt: new Date(at('07:53')).toISOString(), updatedAt: new Date(at('07:53')).toISOString() }],
  };

  it('tells the coach when each thing was written and in which phase', () => {
    const text = dayJournalCoachText([journal], () => windows);
    expect(text).toContain('London: příprava zapsána 07:55 · bias Long · Sweep Asia low · neobchoduju pokud: 2 ztráty v řadě | uzavřeno 13:10 · exekuce částečně');
    expect(text).toContain('plán „Long z FVG | po displacementu“ → vyšlo');
    expect(text).toContain('pozn. zapsáno 07:53 [příprava, hlasem, z přípravy] → 10:00 @ 31388');
  });

  it('exports a markdown day with escaped table cells', () => {
    const md = dayJournalMarkdown(journal, [trade('t1', '10:05', 300, { planAdherence: 'Yes' })], windows);
    expect(md).toContain('# Deník dne 2026-10-13');
    expect(md).toContain('| 10:05 | Long | 300 | 3.00 | podle plánu |');
    expect(md).toContain('| 07:53 | příprava (hlasem) | London | 10:00 @ 31388 | Long z FVG / po displacementu |');
    expect(md).toContain('> Ráno čisté. Po TP odejít.');
  });
});

describe('sameCandleSeries', async () => {
  const { sameCandleSeries } = await import('../lib/candleSeries');
  const c = (time: number, close: number) => ({ time, open: close, close });
  it('treats a live append as the same series but a rollover or another week as new', () => {
    const base = [c(60, 31_000), c(120, 31_002)];
    expect(sameCandleSeries(base, [...base, c(180, 31_005)])).toBe(true);
    expect(sameCandleSeries(base, [c(60, 31_310), c(120, 31_312)])).toBe(false);
    expect(sameCandleSeries(base, [c(600, 31_000)])).toBe(false);
    expect(sameCandleSeries([], base)).toBe(false);
  });
});
