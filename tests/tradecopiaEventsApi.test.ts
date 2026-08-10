import { describe, expect, it } from 'vitest';
import { normalizeTradecopiaFastEvent } from '../api/tradecopia-events';

describe('TradeCopia event API validace', () => {
  const base = {
    key: 'event-1',
    type: 'trade_closed',
    severity: 'info',
    occurredAt: '2026-08-10T10:00:00.000Z',
  };

  it('nepřevádí chybějící P&L ani cenu na nulu', () => {
    expect(normalizeTradecopiaFastEvent({ ...base, pnl: null, price: null })).toMatchObject({
      pnl: undefined,
      price: undefined,
    });
  });

  it('odmítne neznámý typ nebo neplatný čas', () => {
    expect(normalizeTradecopiaFastEvent({ ...base, type: 'execute_trade' })).toBeNull();
    expect(normalizeTradecopiaFastEvent({ ...base, occurredAt: 'nikdy' })).toBeNull();
  });

  it('ořízne seznam účtů a nepustí neočekávaná pole', () => {
    const event = normalizeTradecopiaFastEvent({
      ...base,
      accountNames: Array.from({ length: 40 }, (_, index) => `Účet ${index}`),
      authToken: 'nesmí projít',
    });
    expect(event?.accountNames).toHaveLength(30);
    expect(event).not.toHaveProperty('authToken');
  });
});
