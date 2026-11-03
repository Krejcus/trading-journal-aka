import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKTEST_BREAK_EVEN_ACTION,
  backtestBreakEven,
  backtestPositionSummary,
  backtestPositionDraftProblem,
  backtestRuntimeToasts,
  backtestSubmitDraft,
  backtestTicketInstrument,
  backtestTicketQuote,
  seedBacktestToastSeen,
  shiftDraftBrackets,
  withBacktestLineControls,
} from '../lib/backtestChartTrading';
import { pendingOrderChartLines, positionChartLines } from '../services/backtestOrderLines';
import { LIVE_DRAFT_ID, liveDraftChartLines, newTicketDraft } from '../lib/liveOrderTicket';
import type { BacktestClosedTrade, BacktestFill, BacktestOrder, BacktestPosition } from '../services/backtestTypes';

const position = (patch: Partial<BacktestPosition> = {}): BacktestPosition => ({
  positionId: 'p1', instrument: 'MNQ', side: 'long', quantity: 2, averagePrice: 20000.1, openedAt: 100, entryFillIds: ['f1'], entryCommission: 1, ...patch,
});
const order = (patch: Partial<BacktestOrder> = {}): BacktestOrder => ({
  id: 'o1', runId: 'r', instrument: 'MNQ', side: 'buy', type: 'limit', status: 'pending', quantity: 1, remainingQuantity: 1,
  limitPrice: 19990, stopLoss: 19980, takeProfit: 20010, createdAt: 1_700_000_000, updatedAt: 1_700_000_000, ...patch,
});
const fill = (patch: Partial<BacktestFill> = {}): BacktestFill => ({
  id: 'f1', runId: 'r', orderId: 'o1', instrument: 'MNQ', side: 'buy', quantity: 1, price: 19990, commission: 0.5, realizedPnl: 0,
  filledAt: 1_700_000_060, reason: 'order', positionId: 'p1', ...patch,
});
const trade = (patch: Partial<BacktestClosedTrade> = {}): BacktestClosedTrade => ({
  id: 't1', runId: 'r', instrument: 'MNQ', direction: 'Long', quantity: 1, entryPrice: 19990, exitPrice: 20010,
  entryTime: 1_700_000_060, exitTime: 1_700_000_600, grossPnl: 40, commission: 1, pnl: 39, reason: 'take-profit', ...patch,
});

describe('backtest chart trading', () => {
  it('quotes the replay close on both sides and sizes the instrument from the engine', () => {
    expect(backtestTicketQuote(20000)).toEqual({ bid: 20000, ask: 20000 });
    expect(backtestTicketQuote(null)).toBeNull();
    expect(backtestTicketQuote(Number.NaN)).toBeNull();
    expect(backtestTicketInstrument('MNQ')).toEqual({ symbol: 'MNQ', tickSize: 0.25, pointValue: 2 });
    expect(backtestTicketInstrument('NQ').pointValue).toBe(20);
  });

  it('allows BE only when the replay price is beyond the entry and the stop is not already better', () => {
    expect(backtestBreakEven(position(), 20010, 0.25)).toEqual({ price: 20000, blocked: null });
    expect(backtestBreakEven(position(), 20000, 0.25).blocked).toMatch(/hned vyplnil/);
    expect(backtestBreakEven(position(), null, 0.25).blocked).toMatch(/Bez ceny/);
    expect(backtestBreakEven(position({ stopLoss: 20000 }), 20010, 0.25).blocked).toBe('SL už je na BE.');
    expect(backtestBreakEven(position({ stopLoss: 20005 }), 20010, 0.25).blocked).toMatch(/v zisku/);
    // Short: BE zaokrouhlený nahoru, cena musí být pod vstupem.
    expect(backtestBreakEven(position({ side: 'short' }), 19990, 0.25)).toEqual({ price: 20000.25, blocked: null });
    expect(backtestBreakEven(position({ side: 'short' }), 20000.25, 0.25).blocked).toMatch(/pod vstupem/);
  });

  it('adds BE to the position label, a dead zone to engine lines and confirm to pending cancel, but leaves the draft alone', () => {
    const pos = position({ stopLoss: 19980, takeProfit: 20040 });
    const draft = liveDraftChartLines(newTicketDraft('buy', 'limit', 19990, backtestTicketInstrument('MNQ'), { bid: 20000, ask: 20000 }), backtestTicketInstrument('MNQ'), { bid: 20000, ask: 20000 });
    const lines = withBacktestLineControls([
      ...positionChartLines(pos, 20010),
      ...pendingOrderChartLines(order()),
      ...draft,
    ], [pos], 20010, LIVE_DRAFT_ID);
    const entry = lines.find(line => line.ownerType === 'position' && line.kind === 'entry')!;
    expect(entry.actions).toEqual([expect.objectContaining({ id: BACKTEST_BREAK_EVEN_ACTION, label: 'BE', confirm: true, disabled: false })]);
    expect(entry.confirmCancel).toBeUndefined();
    expect(lines.find(line => line.id === 'MNQ:position:stopLoss')!.dragDeadZonePx).toBe(4);
    const pending = lines.find(line => line.id === 'o1:entry')!;
    expect(pending.confirmCancel).toBe(true);
    expect(pending.dragDeadZonePx).toBe(4);
    expect(lines.filter(line => line.ownerId === LIVE_DRAFT_ID)).toEqual(draft);
  });

  it('summarises the open position from the replay price', () => {
    expect(backtestPositionSummary(position({ averagePrice: 20000, stopLoss: 19980 }), 20010)).toEqual({
      side: 'long', quantity: 2, entry: 20000, mark: 20010, openPnl: 40, stop: 19980, target: null, protection: 'jen SL',
    });
    expect(backtestPositionSummary(position(), null)).toMatchObject({ mark: null, openPnl: null, protection: 'bez SL a TP' });
  });

  it('turns only new engine events into trade cards, timed by the replay clock', () => {
    const seen = seedBacktestToastSeen({ orders: [order({ id: 'old' })], fills: [], closedTrades: [] });
    const toasts = backtestRuntimeToasts({
      orders: [order({ id: 'old' }), order(), order({ id: 'mkt', type: 'market', status: 'filled' })],
      fills: [fill(), fill({ id: 'exit', positionId: undefined, closedPositionId: 'p1', side: 'sell' })],
      closedTrades: [trade()],
    }, seen);
    expect(toasts.map(toast => [toast.badge, toast.title])).toEqual([
      ['Zadáno', 'Příkaz zadán'],
      ['Vyplněno', 'Vstup vyplněn'],
      ['TP', 'TP zasažen'],
    ]);
    expect(toasts[0].line).toBe('BUY 1 LMT @ 19990.00 · SL 19980.00 · TP 20010.00');
    expect(toasts[0].at).toBe(1_700_000_000_000);
    expect(toasts[2]).toMatchObject({ pnl: 39, accounts: 0, sticky: false });
    // Druhé volání nic nezopakuje.
    expect(backtestRuntimeToasts({ orders: [order()], fills: [fill()], closedTrades: [trade()] }, seen)).toEqual([]);
  });

  it('labels stop exits as loss, profit or break-even and reversals as flips', () => {
    const seen = seedBacktestToastSeen({ orders: [], fills: [], closedTrades: [] });
    const toasts = backtestRuntimeToasts({
      orders: [],
      fills: [fill({ id: 'flip', closedPositionId: 'p0' })],
      closedTrades: [
        trade({ id: 'loss', reason: 'stop-loss', grossPnl: -20, pnl: -21 }),
        trade({ id: 'win', reason: 'stop-loss', grossPnl: 10, pnl: 9 }),
        trade({ id: 'be', reason: 'stop-loss', grossPnl: 0, pnl: -1 }),
        trade({ id: 'manual', reason: 'manual' }),
      ],
    }, seen);
    expect(toasts.map(toast => toast.title)).toEqual(['Pozice otočena', 'SL zasažen', 'SL v zisku zasažen', 'SL na BE zasažen', 'Pozice zavřena']);
  });

  it('re-anchors a market draft to the fresh replay close and refuses a draft the price has moved through', () => {
    const mnq = backtestTicketInstrument('MNQ');
    const shown = { bid: 20000, ask: 20000 };
    const market = newTicketDraft('buy', 'market', 20000, mnq, shown);
    expect(market.stopLoss).toBe(19988);
    // Replay mezitím o 14 b níž: SL/TP jedou s cenou, vzdálenost 12 b zůstává.
    const moved = backtestSubmitDraft(market, shown, { bid: 19986, ask: 19986 }, mnq);
    expect(moved).toMatchObject({ blocked: null, quantity: 1 });
    expect(moved.draft.stopLoss).toBe(19974);
    expect(moved.draft.takeProfit).toBe(19986 + 24);
    // Limit nad čerstvou cenou se vyplní hned — jen varování; stop pod cenou (buy) se odmítne.
    const stop = { ...newTicketDraft('buy', 'stop', 20010, mnq, shown) };
    const refused = backtestSubmitDraft(stop, shown, { bid: 20015, ask: 20015 }, mnq);
    expect(refused.blocked).toMatch(/^cena replaye se mezitím pohnula — Stop je pod trhem/);
    expect(backtestSubmitDraft(stop, shown, shown, mnq).blocked).toBeNull();
    expect(shiftDraftBrackets({ ...market, stopLoss: null, takeProfit: null }, 5, 0.25)).toMatchObject({ stopLoss: null, takeProfit: null });
  });

  it('warns when a draft would replace the brackets of the open position or reduce it', () => {
    const draft = { side: 'buy' as const, stopLoss: 19988, takeProfit: 20024 };
    expect(backtestPositionDraftProblem(draft, null)).toBeNull();
    expect(backtestPositionDraftProblem(draft, { side: 'long' })?.text).toMatch(/nahradí SL\/TP celé pozice/);
    expect(backtestPositionDraftProblem({ ...draft, stopLoss: null, takeProfit: null }, { side: 'long' })).toBeNull();
    expect(backtestPositionDraftProblem(draft, { side: 'short' })?.text).toMatch(/nejdřív zmenší/);
  });

  it('calls a stop at the entry BE even with slippage', () => {
    const seen = seedBacktestToastSeen({ orders: [], fills: [], closedTrades: [] });
    const [toast] = backtestRuntimeToasts({ orders: [], fills: [], closedTrades: [trade({ reason: 'stop-loss', stopLoss: 19990, exitPrice: 19989.75, grossPnl: -0.5, pnl: -1.5 })] }, seen);
    expect(toast.title).toBe('SL na BE zasažen');
  });

  it('wires the backtest chart like LIVE: right click only drafts, draft lines need the open panel, BE goes through the line action', () => {
    const session = readFileSync('components/BacktestWorkspace.tsx', 'utf8');
    expect(session).toMatch(/onChartOrder: input => startDraft\(input\.side, input\.type, input\.price, input\.quantity\),/);
    expect(session).not.toMatch(/onChartOrder: \(input, candle\) => \{\s*executeOrder/);
    expect(session).toMatch(/\.\.\.\(draft && quote && ticketOpen \? liveDraftChartLines\(draft, instrument, quote\) : \[\]\)/);
    expect(session).toMatch(/onOrderLineAction: orderLineAction,/);
    // Indikátory LIVE/deníku jen jako start nové session — nic se nepropisuje zpět.
    expect(session).toMatch(/tradeIndicators=\{startIndicators\}/);
    expect(session).not.toMatch(/onTradeIndicatorsChange/);
    const workspace = readFileSync('components/AlphaTradeChartWorkspace.tsx', 'utf8');
    expect(workspace).toMatch(/onAction=\{orderLineSource\?\.onOrderLineAction\}/);
    expect(workspace).toMatch(/if \(backtestSession \|\| !tradeIndicators\) return;/);
  });
});
