import { describe, expect, it } from 'vitest';
import {
  bracketDisplayValue,
  bracketPriceFromInput,
  draftFromPositionBox,
  inferTicketOrderType,
  liveDraftChartLines,
  newTicketDraft,
  ticketMetrics,
  ticketProblems,
  ticketQuantity,
  withEntryPrice,
  withSide,
  type TicketDraft,
} from '../lib/liveOrderTicket';
import { normalizePositionSettings, type PositionDrawing } from '../services/chartPositionDrawing';

const MNQ = { symbol: 'MNQZ6', tickSize: 0.25, pointValue: 2 };
const quote = { bid: 100, ask: 100.25 };
const draft = (patch: Partial<TicketDraft> = {}): TicketDraft => ({
  side: 'buy', type: 'limit', price: 95, sizing: 'qty', quantity: 2, riskUsd: 200, stopLoss: 85, takeProfit: 115, ...patch,
});

const box = (tool: PositionDrawing['tool'], entry: number, target: number, stop: number, risk = 200): PositionDrawing => ({
  id: 'box',
  tool,
  points: [{ time: 120, price: entry }, { time: 600, price: target }, { time: 600, price: stop }],
  style: {
    color: '#787b86', width: 1, dashed: false, fill: null,
    position: normalizePositionSettings({ risk, accountSize: 50_000, pointValue: 2, tickSize: 0.25 }),
  },
});

describe('live order ticket metrics', () => {
  it('computes SL/TP dollars and R:R per account', () => {
    expect(ticketMetrics(draft(), MNQ, quote)).toMatchObject({
      entry: 95, quantity: 2, stopLossUsd: -40, takeProfitUsd: 80, riskReward: 2,
    });
  });

  it('sizes by risk rounding down, never above the requested risk', () => {
    // 10 b stop × $2 = $20 na kontrakt → $210 dá 10, ne 11.
    expect(ticketQuantity(draft({ sizing: 'risk', riskUsd: 210 }), MNQ, quote)).toBe(10);
    expect(ticketQuantity(draft({ sizing: 'risk', stopLoss: null }), MNQ, quote)).toBe(0);
  });

  it('prices a market order at the side of the market', () => {
    expect(ticketMetrics(draft({ type: 'market' }), MNQ, quote).entry).toBe(100.25);
    expect(ticketMetrics(draft({ type: 'market', side: 'sell', stopLoss: 110, takeProfit: 90 }), MNQ, quote).entry).toBe(100);
  });
});

describe('live order ticket problems', () => {
  it('flags brackets on the wrong side and a triggered stop as errors', () => {
    const levels = ticketProblems(draft({ stopLoss: 96, takeProfit: 94 }), MNQ, quote, null).map(p => p.level);
    expect(levels.filter(level => level === 'error')).toHaveLength(2);
    expect(ticketProblems(draft({ type: 'stop', price: 99 }), MNQ, quote, null).some(p => p.level === 'error' && p.text.startsWith('Stop je'))).toBe(true);
  });

  it('never checks the day limit from the chart price of a Market draft (INV-UI-04)', () => {
    const problems = ticketProblems(draft({ type: 'market', quantity: 30, stopLoss: 90, takeProfit: 120 }), MNQ, quote, { limitUsd: 1000, dayPnlUsd: -388 });
    expect(problems.some(p => p.text.includes('denního limitu'))).toBe(false);
  });

  it('warns about a marketable limit and the remaining day limit', () => {
    const problems = ticketProblems(draft({ price: 101, quantity: 30, stopLoss: 90 }), MNQ, quote, { limitUsd: 1000, dayPnlUsd: -388 });
    expect(problems.map(p => p.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('vyplní se hned'),
      expect.stringContaining('denního limitu'),
    ]));
  });
});

describe('order type from the side of the market', () => {
  it.each([
    ['buy', 99, 'limit'], ['buy', 101, 'stop'], ['buy', 100.25, 'market'],
    ['sell', 101, 'limit'], ['sell', 99, 'stop'], ['sell', 100, 'market'],
  ] as const)('%s at %s is %s', (side, price, type) => {
    expect(inferTicketOrderType(side, price, quote, 0.25)).toBe(type);
  });
});

describe('bracket inputs', () => {
  it('round-trips points, ticks, dollars and price', () => {
    const d = draft();
    expect(bracketDisplayValue(d, 'sl', 'pts', MNQ, quote)).toBe(10);
    expect(bracketDisplayValue(d, 'sl', 'ticks', MNQ, quote)).toBe(40);
    expect(bracketDisplayValue(d, 'sl', 'usd', MNQ, quote)).toBe(40);
    expect(bracketPriceFromInput(d, 'sl', 'pts', 12, MNQ, quote)).toBe(83);
    expect(bracketPriceFromInput(d, 'tp', 'ticks', 40, MNQ, quote)).toBe(105);
    expect(bracketPriceFromInput(d, 'tp', 'usd', 100, MNQ, quote)).toBe(120);
    expect(bracketPriceFromInput(d, 'tp', 'price', 110.1, MNQ, quote)).toBe(110);
  });
});

describe('draft edits', () => {
  it('mirrors brackets when the side flips', () => {
    expect(withSide(draft(), 'sell', quote, MNQ)).toMatchObject({ side: 'sell', stopLoss: 105, takeProfit: 75 });
  });

  it('moves brackets with the entry only on Shift', () => {
    expect(withEntryPrice(draft(), 96, MNQ)).toMatchObject({ price: 96, stopLoss: 85, takeProfit: 115 });
    expect(withEntryPrice(draft(), 96, MNQ, true)).toMatchObject({ price: 96, stopLoss: 86, takeProfit: 116 });
  });

  it('starts a new draft with a 12 b stop and a 2R target', () => {
    expect(newTicketDraft('sell', 'limit', 105, MNQ, quote)).toMatchObject({ price: 105, stopLoss: 117, takeProfit: 81 });
  });
});

describe('draft chart lines', () => {
  it('draws entry, SL and TP with the account tag on a single-account draft', () => {
    const lines = liveDraftChartLines(draft(), MNQ, quote, 'T3');
    expect(lines.map(line => line.kind)).toEqual(['entry', 'stopLoss', 'takeProfit']);
    expect(lines[0].label).toBe('BUY 2 LIMIT T3  95.00 · návrh');
    expect(lines[1].label).toBe('SL  −$40.00 · 10.00 b · návrh');
    expect(lines[0].addableBrackets).toBeUndefined();
  });

  it('keeps a market entry line fixed and offers missing brackets', () => {
    const [entry] = liveDraftChartLines(draft({ type: 'market', stopLoss: null }), MNQ, quote);
    expect(entry.draggable).toBe(false);
    expect(entry.addableBrackets).toEqual(['stopLoss']);
  });
});

describe('⚡ from a position box', () => {
  it('pre-fills a buy limit below the market with the box risk', () => {
    const { draft: next, quantity } = draftFromPositionBox(box('LongPosition', 90, 115, 80), MNQ, quote);
    expect(next).toMatchObject({ side: 'buy', type: 'limit', price: 90, sizing: 'risk', riskUsd: 200, stopLoss: 80, takeProfit: 115 });
    expect(quantity).toBe(10);
  });

  it('turns a short box below the market into a sell stop', () => {
    expect(draftFromPositionBox(box('ShortPosition', 95, 80, 100), MNQ, quote).draft.type).toBe('stop');
  });

  it('rejects a box with brackets on the wrong side', () => {
    expect(() => draftFromPositionBox(box('LongPosition', 90, 85, 95), MNQ, quote)).toThrow('Long box');
  });
});
