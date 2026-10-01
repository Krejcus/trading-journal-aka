import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import { monthlyInvalidSummary, planSideError, reviewFacts, reviewR, undoPatch } from '../lib/tradeReviewFacts';

const T0 = Date.UTC(2026, 8, 30, 18, 55, 7);
const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 't1', accountId: 'a1', instrument: 'MNQ', direction: 'Long', pnl: 424.56,
  date: new Date(T0 + 514_000).toISOString(), timestamp: T0 + 514_000,
  ...over,
} as Trade);
const fill = (role: 'entry' | 'exit', at: number, price: number, side: 'Buy' | 'Sell' = role === 'entry' ? 'Buy' : 'Sell') => ({
  id: `${role}-${at}`, orderId: 'o', accountId: 1, contractId: 1, at, timeSource: 'broker' as const, side, quantity: 2, price, fees: 1.48, feeCurrencyId: null,
  role, allocatedQuantity: 2,
});
const protection = (kind: 'sl' | 'tp', at: number, price: number, status: 'confirmed' | 'cancelled' = 'confirmed') => ({
  id: `${kind}-${at}`, orderId: `${kind}`, commandId: null, accountId: 1, at, timeSource: 'broker' as const, kind, price, quantity: 2, status,
});
const history = (over: Partial<TradeExecutionHistory> = {}): TradeExecutionHistory => ({
  connectionId: 'c', environment: 'live', accountId: 1,
  fills: [fill('entry', T0, 30801), fill('exit', T0 + 514_000, 30837)],
  protection: [protection('sl', T0 + 100, 30789), protection('tp', T0 + 100, 30837), protection('sl', T0 + 365_000, 30801.25)],
  gaps: [], grossPnl: 429, fees: 4.44, netPnl: 424.56, complete: true, issues: [],
  ...over,
} as TradeExecutionHistory);

describe('reviewFacts', () => {
  it('builds the trade timeline from Tradovate fills and protection orders', () => {
    const facts = reviewFacts(trade(), history());
    expect(facts.entryPrice).toBe(30801);
    expect(facts.exitPrice).toBe(30837);
    expect(facts.move).toBe(36);
    expect(facts.brokerSL).toBe(30789);
    expect(facts.brokerTP).toBe(30837);
    expect(facts.exitKind).toBe('tp');
    expect(facts.steps.map(step => step.label)).toEqual(['Vstup', 'SL zadán', 'TP zadán', 'SL posunut', 'Výstup · TP']);
  });

  it('ignores cancelled orders and repeated confirmations of the same price', () => {
    const facts = reviewFacts(trade(), history({
      protection: [protection('sl', T0 + 100, 30789), protection('sl', T0 + 200, 30789), protection('sl', T0 + 300, 30700, 'cancelled')],
    }));
    expect(facts.steps.filter(step => step.kind === 'sl')).toHaveLength(1);
    expect(facts.exitKind).toBe('manual');
  });

  it('recognises a stop-loss exit and a short direction', () => {
    const facts = reviewFacts(trade({ direction: 'Short' }), history({
      fills: [fill('entry', T0, 30829, 'Sell'), fill('exit', T0 + 60_000, 30843, 'Buy')],
      protection: [protection('sl', T0 + 50, 30843)],
    }));
    expect(facts.long).toBe(false);
    expect(facts.move).toBe(-14);
    expect(facts.exitKind).toBe('sl');
  });

  it('labels a slipped stop exit by the order that filled it', () => {
    const exit = { ...fill('exit', T0 + 60_000, 30786.5), orderId: 'sl' };
    const facts = reviewFacts(trade(), history({ fills: [fill('entry', T0, 30801), exit], protection: [protection('sl', T0 + 100, 30789)] }));
    expect(facts.exitKind).toBe('sl');
    expect(facts.steps.at(-1)?.label).toBe('Výstup · SL');
  });

  it('does not match a manual exit against a stop that was already cancelled', () => {
    const facts = reviewFacts(trade(), history({
      fills: [fill('entry', T0, 30801), fill('exit', T0 + 60_000, 30789)],
      protection: [protection('sl', T0 + 100, 30789), protection('sl', T0 + 30_000, 30789, 'cancelled')],
    }));
    expect(facts.exitKind).toBe('manual');
  });

  it('falls back to stored prices when the trade has no execution history', () => {
    const facts = reviewFacts(trade({ entryPrice: 100, exitPrice: 110, stopLoss: 95 }), undefined);
    expect(facts.entryPrice).toBe(100);
    expect(facts.brokerSL).toBe(95);
    expect(facts.steps.map(step => step.kind)).toEqual(['entry', 'exit']);
  });
});

describe('reviewR', () => {
  it('uses the planned stop over the broker stop and never needs P&L', () => {
    const facts = reviewFacts(trade(), history());
    expect(reviewR(facts).r).toBeCloseTo(3);
    expect(reviewR(facts, 30790).r).toBeCloseTo(36 / 11);
    expect(reviewR(facts, null, 30850).rr).toBeCloseTo(49 / 12);
  });

  it('rejects a planned stop or target on the wrong side of the entry', () => {
    const facts = reviewFacts(trade(), history());
    expect(planSideError(facts, 30810)).toBe('sl');
    expect(planSideError(facts, null, 30790)).toBe('tp');
    expect(planSideError(facts, 30790, 30850)).toBeNull();
    expect(reviewR(facts, 30810).r).toBeNull();
    const short = reviewFacts(trade({ direction: 'Short' }), history({ fills: [fill('entry', T0, 30829, 'Sell'), fill('exit', T0 + 60_000, 30843, 'Buy')], protection: [] }));
    expect(planSideError(short, 30840)).toBeNull();
    expect(planSideError(short, 30820)).toBe('sl');
  });

  it('returns no R for a market entry without any stop', () => {
    const facts = reviewFacts(trade(), history({ protection: [] }));
    expect(reviewR(facts)).toEqual({ r: null, rr: null });
  });
});

describe('monthlyInvalidSummary', () => {
  it('counts only this month’s trades outside the plan and their most common reason', () => {
    const now = Date.UTC(2026, 8, 30, 12);
    const at = (d: number) => Date.UTC(2026, 8, d, 15);
    const rows = [
      trade({ id: '1', pnl: -100, executionStatus: 'Invalid', invalidReasons: ['FOMO / honění'], timestamp: at(3) }),
      trade({ id: '2', pnl: -50, planAdherence: 'No', invalidReasons: ['FOMO / honění', 'Revenge'], timestamp: at(10) }),
      trade({ id: '3', pnl: 200, executionStatus: 'Valid', timestamp: at(12) }),
      trade({ id: '4', pnl: -999, executionStatus: 'Invalid', timestamp: Date.UTC(2026, 7, 29, 15) }),
    ];
    expect(monthlyInvalidSummary(rows, now)).toEqual({ count: 2, pnl: -150, topReason: 'FOMO / honění' });
  });
});

describe('undoPatch', () => {
  it('restores previous values and neutral defaults instead of nulls the trigger would drop', () => {
    const before = trade({ notes: 'původní', emotions: ['Flow'] });
    const undo = undoPatch(before, {
      notes: 'nové', emotions: ['FOMO'], mistakes: ['x'], executionStatus: 'Invalid', isValid: false,
      planAdherence: 'No', invalidNote: 'proč', plannedStopLoss: 30790,
    } as never);
    expect(undo).toEqual({
      notes: 'původní', emotions: ['Flow'], mistakes: [], executionStatus: 'Valid', isValid: true,
      planAdherence: null, invalidNote: '', plannedStopLoss: null,
    });
  });
});
