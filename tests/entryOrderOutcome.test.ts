import { describe, expect, it } from 'vitest';
import { cancelledOrderOutcome } from '../lib/entryOrderOutcome';
import type { TradeEntryOrder } from '../lib/journalEntryOrders';

const T = (hhmm: string) => Date.parse(`2026-10-01T${hhmm}:00Z`);
const bar = (hhmm: string, high: number, low: number) => ({ time: T(hhmm) / 1000, high, low });
const order = (over: Partial<TradeEntryOrder> = {}): TradeEntryOrder => ({
  orderId: 'o', side: 'Sell', type: 'Limit', quantity: 5, placedAt: T('07:37'),
  legs: [{ at: T('07:37'), price: 30900 }], end: { kind: 'cancel', at: T('07:47') + 32_000 }, ...over,
});
// Skutečné 1m svíčky z 1. 10. (TradingView), UTC.
const BARS = [
  bar('07:47', 30846.25, 30833), bar('07:48', 30850.75, 30817.5), bar('07:50', 30858.25, 30833.25),
  bar('07:51', 30877.5, 30851.5), bar('07:53', 30883.5, 30857.25), bar('07:56', 30898.5, 30875), bar('07:58', 30863.25, 30848),
];

describe('cancelledOrderOutcome', () => {
  it('reports how far price stayed from a limit that would never fill', () => {
    const outcome = cancelledOrderOutcome(order({ bracket: { sl: 30926, tp: 30761.25 } }), BARS);
    expect(outcome).toEqual({ kind: 'nofill', closestAt: T('07:56'), closestPrice: 30898.5, missBy: 1.5 });
  });

  it('fills a sell limit on touch and follows the bracket to the stop', () => {
    const outcome = cancelledOrderOutcome(order({ legs: [{ at: T('07:42'), price: 30842.75 }], end: { kind: 'cancel', at: T('07:43') + 24_000 },
      quantity: 1, bracket: { sl: 30879.5, tp: 30704 } }), [bar('07:44', 30858.25, 30819), ...BARS]);
    expect(outcome).toMatchObject({ kind: 'fill', fillAt: T('07:44'), result: 'sl', resultAt: T('07:53'), exitPrice: 30879.5, points: -36.75 });
  });

  it('flags a candle that touches both stop and target as ambiguous, and handles buy stops', () => {
    const ambiguous = cancelledOrderOutcome(order({ legs: [{ at: T('07:40'), price: 30840 }], end: { kind: 'cancel', at: T('07:46') },
      bracket: { sl: 30850, tp: 30820 } }), [bar('07:47', 30855, 30815)]);
    expect(ambiguous).toMatchObject({ kind: 'fill', result: 'ambiguous', points: null });
    const buyStop = cancelledOrderOutcome(order({ side: 'Buy', type: 'Stop', legs: [{ at: T('07:40'), price: 30870 }], end: { kind: 'cancel', at: T('07:46') },
      bracket: { sl: 30850, tp: 30895 } }), BARS);
    expect(buyStop).toMatchObject({ kind: 'fill', fillAt: T('07:51'), result: 'tp', resultAt: T('07:56'), points: 25 });
  });

  it('ignores filled orders and orders without candles after the cancel', () => {
    expect(cancelledOrderOutcome(order({ end: { kind: 'fill', at: T('07:44') } }), BARS)).toBeNull();
    expect(cancelledOrderOutcome(order(), [])).toBeNull();
  });
});
