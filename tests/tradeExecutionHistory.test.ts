import { describe, expect, it } from 'vitest';
import { buildJournalAccountTrades, groupProtectionMarkers } from '../lib/tradeExecutionHistory';
import { journalObservation, type JournalEvidence, type JournalEntityType } from '../lib/tradovateJournalEvidence';
import { journalLogicalCoordinate, journalTimeLogical } from '../services/journalChartPrimitive';

let sequence = 0;
const observation = (type: JournalEntityType, entity: Record<string, string | number | boolean>): JournalEvidence => ({
  ...journalObservation(type, entity, 'stream', 'Updated', ++sequence)!,
  id: String(sequence), connectionId: 'conn', environment: 'demo', sessionId: 'session', sequence,
});
const rows = () => [
  observation('contract', { id: 1, name: 'MNQU6' }),
  observation('order', { id: 10, accountId: 101, action: 'Buy' }),
  observation('order', { id: 11, accountId: 101, action: 'Sell' }),
  observation('order', { id: 12, accountId: 101, action: 'Sell' }),
  observation('fill', { id: 100, orderId: 10, contractId: 1, qty: 3, price: 20_000, timestamp: '2026-09-01T12:00:00.123Z', action: 'Buy' }),
  observation('fill', { id: 101, orderId: 11, contractId: 1, qty: 1, price: 20_005, timestamp: '2026-09-01T12:01:00.456Z', action: 'Sell' }),
  observation('fill', { id: 102, orderId: 12, contractId: 1, qty: 2, price: 20_010, timestamp: '2026-09-01T12:02:00.789Z', action: 'Sell' }),
  observation('fillfee', { id: 100, commission: 3, commissionCurrencyId: 840 }),
  observation('fillfee', { id: 101, commission: 1, commissionCurrencyId: 840 }),
  observation('fillfee', { id: 102, commission: 2, commissionCurrencyId: 840 }),
  observation('fillpair', { id: 500, buyFillId: 100, sellFillId: 101, qty: 1, active: true }),
  observation('fillpair', { id: 501, buyFillId: 100, sellFillId: 102, qty: 2, active: true }),
];
describe('account execution history', () => {
  it('uses actual partial exit prices and allocates shared entry fees once', () => {
    const trades = buildJournalAccountTrades(rows());
    expect(trades.map(trade => trade.history.grossPnl)).toEqual([10, 40]);
    expect(trades.map(trade => trade.history.fees)).toEqual([2, 4]);
    expect(trades.map(trade => trade.history.netPnl)).toEqual([8, 36]);
    expect(trades[1]).toMatchObject({ quantity: 2, entryAt: Date.parse('2026-09-01T12:00:00.123Z'), exitAt: Date.parse('2026-09-01T12:02:00.789Z') });
  });
  it('does not fabricate net PnL when fees are unavailable or assign different accounts to one pair', () => {
    const evidence = rows().filter(event => event.entityType !== 'fillfee');
    expect(buildJournalAccountTrades(evidence)[0].history.netPnl).toBeNull();
    evidence.push(observation('order', { id: 11, accountId: 999, action: 'Sell' }));
    expect(buildJournalAccountTrades(evidence)).toHaveLength(1);
  });
  it('does not infer a copy from matching symbol and time, and retains explicit connections', () => {
    const evidence = rows();
    expect(buildJournalAccountTrades(evidence)[0].groupId).toBeUndefined();
    evidence.push(observation('copylink', { id: 'link-1', leaderConnectionId: 'leader-conn', leaderAccountId: 1, leaderOrderId: '700', accountId: 101, orderId: '10', role: 'entry' }));
    expect(buildJournalAccountTrades(evidence)[0].groupId).toBe('execution:demo:leader-conn:700');
  });
  it('withdraws invalidated pairs and refuses over-allocation or unreconciled corrections', () => {
    const evidence = rows();
    evidence.push(observation('fillpair', { id: 500, buyFillId: 100, sellFillId: 101, qty: 1, active: false }));
    expect(buildJournalAccountTrades(evidence)).toHaveLength(1);
    evidence.push(observation('executionreport', { id: 700, orderId: 12, execType: 'TradeCorrect' }));
    expect(buildJournalAccountTrades(evidence)[0].history.grossPnl).toBeNull();
  });
  it('keeps subsecond events within a minute without interpolating across missing candles', () => {
    const candles = [{ time: 60 }, { time: 120 }, { time: 360 }];
    expect(journalTimeLogical(candles, 120_123, 60)).toBeCloseTo(1.00205);
    expect(journalTimeLogical(candles, 121_123, 60)).toBeCloseTo(1.0187167);
    expect(journalTimeLogical(candles, 240_000, 60)).toBeNull();
    const events = [120_123, 120_456, 158_789].map((at, i) => ({ id: String(i), orderId: '10', commandId: String(i), accountId: 1,
      at, timeSource: 'broker' as const, kind: 'sl' as const, price: 100 + i, quantity: 1, status: 'confirmed' as const }));
    expect(groupProtectionMarkers(events)).toMatchObject([{ at: 120_000, events }]);
  });
  it('projects subcandle timestamps through integer chart coordinates', () => {
    const integerOnlyChart = (index: number) => Number.isInteger(index) ? 100 + index * 12 : 0;
    expect(journalLogicalCoordinate(25.25, integerOnlyChart)).toBe(403);
    expect(journalLogicalCoordinate(null, integerOnlyChart)).toBeNull();
  });
});
