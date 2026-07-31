import { describe, expect, it } from 'vitest';
import {
  analyzeIncidentExecutions,
  findEntryOrderEvidence,
  type ImportedOrderEvidence,
} from '../services/coachIncidentAnalytics';
import type { ImportedExecution } from '../services/importPairing';

const execution = (overrides: Partial<ImportedExecution> = {}): ImportedExecution => ({
  id: 'exec-1',
  account_ext_id: 10,
  symbol: 'MNQU6',
  direction: 'Long',
  buy_price: 28000,
  sell_price: 28010,
  qty: 2,
  pnl: 40,
  entry_at: '2026-07-30T14:00:00.000Z',
  exit_at: '2026-07-30T14:01:00.000Z',
  status: 'incident',
  ...overrides,
});

const order = (overrides: Partial<ImportedOrderEvidence> = {}): ImportedOrderEvidence => ({
  id: 'order-1',
  account_ext_id: 10,
  symbol: 'MNQU6',
  side: 'Buy',
  order_type: 'Market',
  quantity: 2,
  filled_qty: 2,
  avg_fill_price: 28000,
  status: 'Filled',
  placed_at: '2026-07-30T13:59:59.000Z',
  ...overrides,
});

describe('Coach incident execution analytics', () => {
  it('seskupí fan-out kopie jako jedno rozhodnutí a zachová velikosti po účtech', () => {
    const executions = [
      execution({ id: 'a', account_ext_id: 10, pnl: -100, group_key: 'copy-1' }),
      execution({ id: 'b', account_ext_id: 11, qty: 4, pnl: -200, group_key: 'copy-1' }),
    ];
    const result = analyzeIncidentExecutions(executions);

    expect(result).toMatchObject({
      executionCount: 2,
      decisionCount: 1,
      accountCount: 2,
      totalPnl: -300,
      maxRepresentativeQuantity: 4,
    });
    expect(result.decisions[0].quantitiesByAccount).toEqual([
      { accountExtId: 10, quantity: 2 },
      { accountExtId: 11, quantity: 4 },
    ]);
  });

  it('spočítá rychlost rozhodnutí a eskalaci size bez násobení copy fan-outem', () => {
    const result = analyzeIncidentExecutions([
      execution({ id: 'a', group_key: 'one', qty: 1, pnl: -20 }),
      execution({
        id: 'b', group_key: 'two', qty: 3, pnl: -60,
        entry_at: '2026-07-30T14:00:20.000Z',
        exit_at: '2026-07-30T14:02:00.000Z',
      }),
      execution({
        id: 'c', group_key: 'three', qty: 2, pnl: -40,
        entry_at: '2026-07-30T14:01:20.000Z',
        exit_at: '2026-07-30T14:03:00.000Z',
      }),
    ]);

    expect(result.decisionCount).toBe(3);
    expect(result.fastestSecondsBetweenDecisions).toBe(20);
    expect(result.medianSecondsBetweenDecisions).toBe(40);
    expect(result.quantityEscalationRatio).toBe(3);
    expect(result.durationSeconds).toBe(180);
  });

  it('označí přesnou order shodu jako vysokou confidence', () => {
    expect(findEntryOrderEvidence(execution(), [order()])).toMatchObject({
      orderId: 'order-1',
      orderType: 'Market',
      confidence: 'high',
      timeDeltaMs: 1000,
    });
  });

  it('nevydává nejednoznačný order type za ověřený fakt', () => {
    const evidence = findEntryOrderEvidence(execution(), [
      order({ id: 'market', order_type: 'Market' }),
      order({ id: 'limit', order_type: 'Limit' }),
    ]);
    expect(evidence.confidence).toBe('low');

    const result = analyzeIncidentExecutions([execution()], [
      order({ id: 'market', order_type: 'Market' }),
      order({ id: 'limit', order_type: 'Limit' }),
    ]);
    expect(result.verifiedOrderTypeCount).toBe(0);
    expect(result.orderTypeCounts).toEqual({});
    expect(result.warnings).toContain('Část typů vstupu má slabou nebo chybějící vazbu na objednávku.');
  });
});
