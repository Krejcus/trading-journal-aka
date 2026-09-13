import { describe, expect, it } from 'vitest';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import type { JournalProtectionEvent } from '../lib/tradovateJournalEvidence';
import { journalProtectionSegments } from '../lib/journalProtectionSegments';

const change = (at: number, price: number | null, status: JournalProtectionEvent['status'] = 'confirmed'): JournalProtectionEvent => ({
  id: `${at}:${price}`, at, price, status, orderId: 'stop', commandId: null, accountId: 1,
  timeSource: 'broker', kind: 'sl', quantity: 2,
});
const history = (protection: JournalProtectionEvent[], overrides: Partial<TradeExecutionHistory> = {}): TradeExecutionHistory => ({
  connectionId: 'conn', environment: 'demo', accountId: 1, fills: [], protection, gaps: [],
  grossPnl: null, fees: null, netPnl: null, complete: false, issues: [],
  position: { id: 'position', status: 'closed', openedAt: 1000, closedAt: 60_000, openQuantity: 0, peakQuantity: 2 },
  ...overrides,
});
describe('confirmed protection chart segments', () => {
  it('preserves millisecond changes and ignores rejected and pending requests', () => {
    const segments = journalProtectionSegments(history([
      change(1000, 100), change(12_123, 101), change(12_456, 102), change(13_000, 103, 'pending'), change(14_000, 104, 'rejected'),
    ]));
    expect(segments.map(row => [row.from, row.to, row.price, row.nextPrice])).toEqual([
      [1000, 12_123, 100, 101], [12_123, 12_456, 101, 102], [12_456, 60_000, 102, null],
    ]);
  });
  it('ends the previous line on contradictory evidence, cancellation or conflicting ties', () => {
    for (const boundary of [[change(10_000, 102, 'uncertain')], [change(10_000, null, 'cancelled')],
      [change(10_000, 102), change(10_000, 103)]]) {
      const segments = journalProtectionSegments(history([change(1000, 100), ...boundary, change(20_000, 104)]));
      expect(segments.map(row => [row.from, row.to, row.price, row.nextPrice])).toEqual([
        [1000, 10_000, 100, null], [20_000, 60_000, 104, null],
      ]);
    }
  });
  it('does not join levels across a recording gap or resume from a confirmation inside it', () => {
    const segments = journalProtectionSegments(history([change(1000, 100), change(15_000, 102), change(25_000, 104)],
      { gaps: [{ from: 10_000, to: 20_000 }] }));
    expect(segments.map(row => [row.from, row.to, row.nextPrice])).toEqual([[1000, 10_000, null], [25_000, 60_000, null]]);
  });
  it('uses the last observed position time, not a partial exit or an invented final close', () => {
    const value = history([change(1000, 100), change(15_000, 101)], {
      position: { id: 'position', status: 'open', openedAt: 1000, closedAt: null, openQuantity: 1, peakQuantity: 2, observedThrough: 20_000 },
    });
    expect(journalProtectionSegments(value).at(-1)?.to).toBe(20_000);
    value.position!.status = 'incomplete'; value.position!.observedThrough = 12_000;
    expect(journalProtectionSegments(value).map(row => [row.from, row.to])).toEqual([[1000, 12_000]]);
    delete value.position!.observedThrough;
    expect(journalProtectionSegments(value)).toEqual([]);
  });
});
