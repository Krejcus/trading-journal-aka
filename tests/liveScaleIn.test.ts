// Přikoupení v UI (3. 11. 2026): záměr pozice a SL/TP pozice do příkazu, hlášky listu telefonu.
import { describe, expect, it } from 'vitest';
import { liveTicketScaleIn, withScaleInIntent, type LiveLeaderPosition } from '../lib/liveScaleIn';
import { livePhonePillScaleIn, livePhoneScaleInBlocked, livePhoneScaleInDraft } from '../lib/livePhoneOrders';
import { COPIER_MANUAL_ENTRY_SCALE_IN_CAPABILITY } from '../lib/copierWorkerCapabilities';
import type { TicketDraft } from '../lib/liveOrderTicket';

const position = (patch: Partial<LiveLeaderPosition> = {}): LiveLeaderPosition => ({
  symbol: 'MNQZ6', side: 'Buy', quantity: 2, baseEntryOperationId: 'entry:base0001', ticketEntryIds: ['22', '11'], tickets: 2,
  avgPrice: 100, stopPrice: 90, targetPrice: 130, stopUniform: true, targetUniform: true, pendingAdd: null,
  canAdd: true, canManage: true, ...patch,
});
const status = (positions: LiveLeaderPosition[], capability = true) => ({
  capabilities: capability ? [COPIER_MANUAL_ENTRY_SCALE_IN_CAPABILITY] : [],
  controller: { leaderPositions: positions },
}) as never;

describe('withScaleInIntent', () => {
  it('stejná strana se SL/TP pozice = přikoupení: záměr pozice, ceny beze změny', () => {
    const draft = withScaleInIntent({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 95, stopLoss: 90, takeProfit: 130 }, status([position()]));
    expect(draft).toMatchObject({ stopLoss: 90, takeProfit: 130, position: { mode: 'add', side: 'Buy', quantity: 2, ticketEntryIds: ['11', '22'] } });
  });
  it('jiné SL/TP než pozice se NIKDY tiše nepřepíšou — nic neodejde (P1-B)', () => {
    expect(() => withScaleInIntent({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 95, stopLoss: 92, takeProfit: 130 }, status([position()])))
      .toThrow(/SL a TP pozice \(SL 90\.00, TP 130\.00\)/);
    expect(() => withScaleInIntent({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 95, stopLoss: 90, takeProfit: 130 }, status([position({ stopPrice: null })])))
      .toThrow(/SL a TP pozice/);
  });
  it('opačná strana, holý Market, bez capability = beze změny (worker zastaví branou z flat)', () => {
    const sell = { symbol: 'MNQZ6', side: 'Sell' as const, quantity: 1, orderType: 'Limit' as const, price: 105, stopLoss: 110, takeProfit: 90 };
    expect(withScaleInIntent(sell, status([position()]))).toBe(sell);
    const bare = { symbol: 'MNQZ6', side: 'Buy' as const, quantity: 1, orderType: 'Market' as const, referencePrice: 100, quoteReceivedAt: 1 };
    expect(withScaleInIntent(bare, status([position()]))).toBe(bare);
    const buy = { symbol: 'MNQZ6', side: 'Buy' as const, quantity: 1, orderType: 'Limit' as const, price: 95, stopLoss: 80, takeProfit: 140 };
    expect(withScaleInIntent(buy, status([position()], false))).toBe(buy);
  });
});

describe('telefon: list přikoupení', () => {
  const draft = (patch: Partial<TicketDraft> = {}) => ({ side: 'buy', type: 'limit', price: 95, stopLoss: 90, takeProfit: 130, ...patch }) as TicketDraft;
  it('list převezme SL/TP pozice jen na její stranu', () => {
    const scaleIn = liveTicketScaleIn(position());
    expect(livePhoneScaleInDraft(draft({ stopLoss: 80, takeProfit: 140 }), scaleIn)).toMatchObject({ stopLoss: 90, takeProfit: 130 });
    expect(livePhoneScaleInDraft(draft({ side: 'sell', stopLoss: 80, takeProfit: 140 }), scaleIn)).toMatchObject({ stopLoss: 80, takeProfit: 140 });
  });
  it('upravené SL v listu se nepřepíše, ale zablokuje (P1-B)', () => {
    expect(livePhoneScaleInBlocked(draft({ stopLoss: 92 }), 1, liveTicketScaleIn(position()), 5)).toContain('SL a TP pozice');
  });
  it('blokace: opačná strana, čekající přikoupení, Limit > 1, strop celé pozice, worker nepustí', () => {
    const scaleIn = liveTicketScaleIn(position());
    expect(livePhoneScaleInBlocked(draft({ side: 'sell' }), 1, scaleIn, 5)).toContain('jen přikoupit');
    expect(livePhoneScaleInBlocked(draft(), 1, liveTicketScaleIn(position({ pendingAdd: { operationId: 'entry:x', entryBrokerOrderId: '3', orderType: 'Limit', quantity: 1, filled: 0, price: 95 } })), 5)).toContain('čeká');
    expect(livePhoneScaleInBlocked(draft(), 2, scaleIn, 5)).toContain('jen po 1');
    expect(livePhoneScaleInBlocked(draft({ type: 'market' }), 4, scaleIn, 5)).toContain('strop účtu je 5');
    expect(livePhoneScaleInBlocked(draft({ type: 'market' }), 3, scaleIn, 5)).toBeNull();
    expect(livePhoneScaleInBlocked(draft(), 1, liveTicketScaleIn(position({ canAdd: false, addBlockedReason: 'SL a TP nekryjí celou pozici' })), 5)).toContain('nekryjí');
  });
});

describe('čára čekajícího přikoupení', () => {
  it('pozice s čekajícím přikoupením má vlastní čáru s × (zrušit jen přikoupení)', async () => {
    const { livePositionChartLines, LIVE_PENDING_ADD_LINE_ID } = await import('../lib/liveChartOrderLines');
    const summary = { kind: 'position', side: 'long', quantity: 2, entry: 100, entryType: null, openPnl: 10, mark: 105, stop: 90, target: 130,
      protection: '', accounts: 1, scopeLabel: null, leader: { accountId: 1, quantity: 2, entry: 100 }, rows: [] } as never;
    const lines = livePositionChartLines(summary, { manageable: true, canClose: true, entryAvg: 100, pointValue: 2, pendingAdd: { price: 95, quantity: 1, orderType: 'Limit' } });
    expect(lines.find(line => line.id === LIVE_PENDING_ADD_LINE_ID)).toMatchObject({ price: 95, cancellable: true, cancelAction: 'cancel-order' });
    expect(livePositionChartLines(summary, { manageable: true, entryAvg: 100, pointValue: 2 }).some(line => line.id === LIVE_PENDING_ADD_LINE_ID)).toBe(false);
  });
});

describe('telefon: Koupit / Prodat z lišty v pozici', () => {
  const quote = { symbol: 'MNQZ6', bid: 100, ask: 100.25, at: 1_000.4 };
  it('na stranu pozice odejde Market se SL/TP pozice a desk připojí záměr přikoupení', () => {
    const draft = livePhonePillScaleIn('buy', 1, quote, liveTicketScaleIn(position()), 5);
    expect(draft).toEqual({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 100.25, quoteReceivedAt: 1000, stopLoss: 90, takeProfit: 130 });
    expect(withScaleInIntent(draft as never, status([position()]))).toMatchObject({ position: { mode: 'add', quantity: 2 } });
  });
  it('nikdy holý Market v pozici: bez SL/TP, opačná strana, strop i čekající přikoupení jen důvod', () => {
    expect(livePhonePillScaleIn('buy', 1, quote, liveTicketScaleIn(position({ stopPrice: null })), 5)).toEqual({ error: expect.stringContaining('se SL i TP') });
    expect(livePhonePillScaleIn('sell', 1, quote, liveTicketScaleIn(position()), 5)).toEqual({ error: expect.stringContaining('jen přikoupit') });
    expect(livePhonePillScaleIn('buy', 4, quote, liveTicketScaleIn(position()), 5)).toEqual({ error: expect.stringContaining('strop účtu') });
    expect(livePhonePillScaleIn('buy', 1, quote, liveTicketScaleIn(position({ canAdd: false, addBlockedReason: 'Ne teď.' })), 5)).toEqual({ error: 'Ne teď.' });
  });
});
