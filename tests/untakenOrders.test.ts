import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: {} }));

import { untakenMonthSummary, untakenTrade, type UntakenRow } from '../services/untakenOrders';

const row = (orderId: string, extra: Partial<UntakenRow> = {}): UntakenRow => ({
  connection_id: '754e4b5b-9b68-4ee8-b400-365863cec131', order_id: orderId, external_account_id: '64503883',
  journal_account_id: 'bd16870b-3176-4831-8ee5-8916ce94c500', placed_at: '2026-10-01T07:37:49.875Z', ended_at: '2026-10-01T07:47:32.264Z',
  data: { orderId, side: 'Sell', type: 'Limit', quantity: 5, placedAt: Date.parse('2026-10-01T07:37:49.875Z'),
    legs: [{ at: Date.parse('2026-10-01T07:37:49.875Z'), price: 30900 }], end: { kind: 'cancel', at: Date.parse('2026-10-01T07:47:32.264Z') },
    bracket: { sl: 30926, tp: 30761.25 }, accountId: 64503883, contractId: 4470324, symbol: 'MNQZ6' },
  review: null,
  ...extra,
});

describe('untakenTrade', () => {
  it('turns a stored untaken order into a fill-less review card', () => {
    const trade = untakenTrade(row('647188297199'))!;
    expect(trade).toMatchObject({
      id: 'untaken:754e4b5b-9b68-4ee8-b400-365863cec131:647188297199', accountId: 'bd16870b-3176-4831-8ee5-8916ce94c500',
      direction: 'Short', pnl: 0, entryPrice: 30900, positionSize: 5, needsReview: true,
    });
    expect(trade.executionHistory?.fills).toEqual([]);
    expect(trade.executionHistory?.entryOrders?.map(order => order.orderId)).toEqual(['647188297199']);
    expect(trade.untaken?.order.bracket).toEqual({ sl: 30926, tp: 30761.25 });
  });

  it('is reviewed once a reason is stored and skips broken rows', () => {
    expect(untakenTrade(row('1', { review: { reason: 'Omyl', reviewedAt: '2026-10-02T08:00:00Z' } }))?.needsReview).toBe(false);
    expect(untakenTrade(row('2', { data: { ...row('2').data, legs: [] } }))).toBeNull();
  });
});

describe('untakenMonthSummary', () => {
  it('sums what cancelling cost and saved this month', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const reviewed = (orderId: string, reason: string, points: number, quantity: number) => untakenTrade(row(orderId, {
      data: { ...row(orderId).data, quantity },
      review: { reason, reviewedAt: '2026-10-02T08:00:00Z', pointValue: 2,
        outcome: { kind: 'fill', fillAt: 0, price: 30900, result: points > 0 ? 'tp' : 'sl', resultAt: 0, exitPrice: 0, points } },
    }))!;
    const summary = untakenMonthSummary([
      reviewed('a', 'Zrušil jsem předčasně', 138.75, 5),
      reviewed('b', 'Setup přestal platit', -36.75, 1),
      reviewed('c', 'Zrušil jsem předčasně', 10, 1),
      { ...untakenTrade(row('old'))!, timestamp: Date.parse('2026-09-20T10:00:00Z') },
    ], now);
    expect(summary).toEqual({ count: 3, missed: 1387.5 + 20, saved: 73.5, topReason: 'Zrušil jsem předčasně' });
  });
});
