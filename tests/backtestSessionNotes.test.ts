import { describe, expect, it } from 'vitest';
import {
  createBacktestOrder,
  createBacktestRuntime,
  enqueueBacktestOrder,
  executeBacktestMarketOrder,
  processBacktestCandles,
  updatePositionBracket,
} from '../services/backtestEngine';
import { applyBacktestRewind, planBacktestRewind } from '../services/backtestRewind';
import {
  addBacktestNote,
  backtestNoteSessionAt,
  backtestSessionPlan,
  backtestTradeNoteFields,
  buildBacktestJournal,
  summarizeBacktestNotes,
  unexplainedBacktestMoves,
  backtestReachFromExcursion,
  backtestSkipAsClosedTrade,
  backtestSkipContextFromTrade,
  pendingBacktestSkips,
  trimBacktestNotes,
  type BacktestNote,
  type BacktestSkipNote,
} from '../services/backtestSessionNotes';
import { backtestClosedTradeToTrade } from '../services/backtestIntel';
import { DEFAULT_BACKTEST_CONFIG, type BacktestRuntimeState } from '../services/backtestTypes';

const RUN = 'run-notes';
const T0 = 1784016000; // 14. 7. 2026 10:00 Praha = 04:00 New York
const at = (minute: number) => T0 + minute * 60;
const candle = (minute: number, open: number, high: number, low: number, close: number) => ({ time: at(minute), open, high, low, close, volume: 1 });

const marketLong = (runtime: BacktestRuntimeState, minute: number, price: number, stopLoss: number, takeProfit: number) => {
  const order = createBacktestOrder({ runId: RUN, instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1, stopLoss, takeProfit, now: at(minute) });
  const queued = enqueueBacktestOrder(runtime, order, Date.now());
  return { runtime: executeBacktestMarketOrder(queued, order.id, { time: at(minute), close: price }, DEFAULT_BACKTEST_CONFIG), orderId: order.id };
};

const plan = (minute: number, bias: 'long' | 'short', extra: Partial<BacktestNote> = {}): BacktestNote => ({
  id: `plan-${minute}`, kind: 'plan', marketTime: at(minute), recordedAt: 1, ...backtestNoteSessionAt(at(minute)),
  bias, dayType: 'trend', expectation: 'návrat k VWAP', invalidation: 'pod −2σ', ...extra,
} as BacktestNote);

describe('session podle newyorského času', () => {
  it('dopoledne v Praze je Londýn, odpoledne New York', () => {
    expect(backtestNoteSessionAt(T0)).toEqual({ day: '2026-07-14', session: 'london' });
    expect(backtestNoteSessionAt(T0 + 6 * 3600)).toEqual({ day: '2026-07-14', session: 'ny' }); // 16:00 Praha = 10:00 NY
    expect(backtestNoteSessionAt(T0 + 4 * 3600 - 60).session).toBe('london'); // 13:59 Praha
    expect(backtestNoteSessionAt(T0 + 4 * 3600).session).toBe('ny'); // 14:00 Praha = 8:00 NY
  });
});

describe('popisy v backtest session', () => {
  let runtime = createBacktestRuntime(50_000);
  runtime = addBacktestNote(runtime, plan(0, 'long'));
  runtime = addBacktestNote(runtime, {
    id: 'skip-1', kind: 'skip', marketTime: at(1), recordedAt: 2, side: 'sell', price: 101, stopLoss: 104, takeProfit: 95,
    reasons: ['Proti biasu'], text: 'cíl moc blízko',
  });
  const entry = marketLong(runtime, 2, 100, 90, 110);
  runtime = entry.runtime;
  runtime = addBacktestNote(runtime, {
    id: 'entry-1', kind: 'entry', marketTime: at(2), recordedAt: 3, orderId: entry.orderId, side: 'buy', price: 100,
    reaction: 'bounce', level: '−1σ', text: 'první FVG po zlomu',
  });
  runtime = processBacktestCandles(runtime, RUN, 'MNQ', [candle(3, 100, 104, 99, 103)], DEFAULT_BACKTEST_CONFIG);
  runtime = updatePositionBracket(runtime, 'MNQ', 100, 110, at(3), 1_000);
  const beforeExit = runtime;
  runtime = processBacktestCandles(runtime, RUN, 'MNQ', [candle(4, 103, 111, 102, 110)], DEFAULT_BACKTEST_CONFIG);

  it('engine poznámky při zpracování svíček nezahodí', () => {
    expect(runtime.notes).toHaveLength(3);
    expect(runtime.closedTrades).toHaveLength(1);
  });

  it('najde posun stopky bez důvodu a po doplnění ho už nehlásí', () => {
    const missing = unexplainedBacktestMoves(beforeExit.orderEvents, beforeExit.notes);
    expect(missing).toHaveLength(1);
    expect(missing[0].price).toBe(100);
    const explained = addBacktestNote(beforeExit, {
      id: 'move-1', kind: 'move', marketTime: at(3), recordedAt: 4, eventId: missing[0].id, orderId: missing[0].orderId,
      field: 'stop', from: 90, to: 100, reason: 'structure', text: '',
    });
    expect(unexplainedBacktestMoves(explained.orderEvents, explained.notes)).toHaveLength(0);
  });

  it('opravený popis téhož vstupu nahradí původní', () => {
    const corrected = addBacktestNote(runtime, {
      id: 'entry-2', kind: 'entry', marketTime: at(2), recordedAt: 9, orderId: entry.orderId, side: 'buy', text: 'oprava',
    });
    expect(corrected.notes?.filter(note => note.kind === 'entry')).toHaveLength(1);
    expect(corrected.notes?.find(note => note.kind === 'entry')).toMatchObject({ text: 'oprava' });
  });

  it('do deníkového obchodu předá text vstupu a bias session', () => {
    expect(backtestTradeNoteFields(runtime, runtime.closedTrades[0])).toEqual({ notes: 'Odraz −1σ — první FVG po zlomu', sessionBias: 'Long' });
  });

  it('plán změněný až po vstupu se obchodu nepřipíše', () => {
    const flipped = addBacktestNote(runtime, plan(10, 'short', { previousBias: 'long', changeReason: 'zlom na 5m' } as Partial<BacktestNote>));
    expect(backtestTradeNoteFields(flipped, flipped.closedTrades[0]).sessionBias).toBe('Long');
    expect(backtestSessionPlan(flipped.notes, '2026-07-14', 'london')?.bias).toBe('short');
  });

  it('zpětně doplněný popis je v deníku označený', () => {
    const late = addBacktestNote(runtime, {
      id: 'entry-3', kind: 'entry', marketTime: at(2), recordedAt: 9, orderId: entry.orderId, side: 'buy', text: 'dopsáno', late: true,
    });
    expect(backtestTradeNoteFields(late, late.closedTrades[0]).notes).toBe('dopsáno (doplněno zpětně)');
  });

  it('složí časový sloupec s hlavičkou session a chybějícími popisy', () => {
    const rows = buildBacktestJournal(runtime);
    expect(rows.map(row => row.type)).toEqual(['header', 'plan', 'skip', 'entry', 'move', 'exit']);
    expect(rows[0]).toMatchObject({ session: 'london', hasPlan: true });
    expect(rows.find(row => row.type === 'move')).toMatchObject({ note: null, field: 'stop' });
    expect(summarizeBacktestNotes(runtime)).toEqual({ plans: 1, skips: 1, entries: 1, entriesDescribed: 1, moves: 1, movesExplained: 0 });
  });

  it('návrat replaye smaže zápisy za cílem a popisy smazaných obchodů', () => {
    const second = marketLong(runtime, 10, 110, 100, 130);
    let later = addBacktestNote(second.runtime, {
      id: 'entry-b', kind: 'entry', marketTime: at(10), recordedAt: 5, orderId: second.orderId, side: 'buy', text: 'druhý',
    });
    later = addBacktestNote(later, { id: 'skip-2', kind: 'skip', marketTime: at(11), recordedAt: 6, side: 'buy', price: 111, reasons: [], text: '' });
    later = processBacktestCandles(later, RUN, 'MNQ', [candle(11, 110, 112, 104, 105), candle(12, 105, 106, 99, 100)], DEFAULT_BACKTEST_CONFIG);
    const rewound = applyBacktestRewind(later, planBacktestRewind(later, at(5)), 50_000);
    expect(rewound.notes?.map(note => note.id).sort()).toEqual(['entry-1', 'plan-0', 'skip-1']);
  });
});

describe('kam by nevzatý obchod došel', () => {
  const skip: BacktestSkipNote = {
    id: 'skip-x', kind: 'skip', marketTime: at(0), recordedAt: 1, side: 'buy', price: 100, stopLoss: 98, takeProfit: 104, reasons: ['Choppy'], text: '',
  };
  const mapping = { accountId: 'a', timeZone: 'Europe/Prague', orderEvents: [] };
  const path = [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 103, 99.5, 102.5), candle(2, 102.5, 105, 102, 104.5), candle(3, 104.5, 104.6, 97, 97.5)];
  const reach = (upTo: number) => {
    const candles = path.slice(0, upTo + 1);
    const mapped = backtestClosedTradeToTrade(backtestSkipAsClosedTrade(skip, RUN, 'MNQ'), { ...mapping, candles, replayHorizonTime: at(upTo) });
    return backtestReachFromExcursion(mapped.excursion, at(upTo));
  };

  it('dokud cena nedojde na cíl ani SL, dopočet zůstává otevřený', () => {
    expect(reach(1)).toMatchObject({ complete: false, result: 'open', tpR: 2 });
    expect(reach(1)?.mfeR).toBeCloseTo(1.5, 2);
  });

  it('cíl zasažený před SL je výhra a dosah pokračuje až do SL', () => {
    expect(reach(2)).toMatchObject({ complete: false, result: 'tp' });
    const done = reach(3);
    expect(done).toMatchObject({ complete: true, result: 'tp' });
    expect(done?.mfeR).toBeCloseTo(2.5, 2);
  });

  it('čeká, dokud chybí kontext vstupu nebo hotový dopočet', () => {
    const context = { available: false };
    const done = { horizonTime: at(3), complete: true, result: 'tp' as const, mfeR: 2.5, tpR: 2, top: null };
    expect(pendingBacktestSkips([skip])).toHaveLength(1);
    expect(pendingBacktestSkips([{ ...skip, context }])).toHaveLength(1);
    expect(pendingBacktestSkips([{ ...skip, context, stopLoss: undefined }])).toHaveLength(0);
    expect(pendingBacktestSkips([{ ...skip, context, outcome: done }])).toHaveLength(0);
    expect(pendingBacktestSkips([{ ...skip, outcome: done }])).toHaveLength(1);
  });

  it('z namapovaného obchodu vybere strukturu, FVG a pořadí zlomu', () => {
    const mapped = backtestClosedTradeToTrade(backtestSkipAsClosedTrade(skip, RUN, 'MNQ'), { ...mapping, candles: path, replayHorizonTime: at(3) });
    const context = backtestSkipContextFromTrade(mapped);
    expect(context).toHaveProperty('available');
    if (context.available) expect(context).toHaveProperty('structureOrder');
    expect(backtestSkipContextFromTrade({})).toEqual({ available: false });
  });

  it('návrat replaye zahodí dopočet ze svíček za cílem', () => {
    const outcome = { horizonTime: at(3), complete: true, result: 'tp' as const, mfeR: 2.5, tpR: 2, top: null };
    const kept = trimBacktestNotes([{ ...skip, outcome }], at(1), new Set());
    expect(kept).toHaveLength(1);
    expect((kept?.[0] as BacktestSkipNote).outcome).toBeUndefined();
    expect((trimBacktestNotes([{ ...skip, outcome }], at(5), new Set())?.[0] as BacktestSkipNote).outcome).toEqual(outcome);
  });
});
