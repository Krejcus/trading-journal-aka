import { describe, expect, it } from 'vitest';
import { clickedOrderType, newTicketDraft } from '../lib/liveOrderTicket';

const quote = { bid: 25_000, ask: 25_000.25 };
const instrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };

describe('pravý klik / + v LIVE grafu: typ podle živé kotace', () => {
  it('BUY pod trhem = Limit, nad = Stop; SELL obráceně; na trhu = Market', () => {
    expect(clickedOrderType('buy', 24_990, quote, 0.25)).toBe('limit');
    expect(clickedOrderType('buy', 25_010, quote, 0.25)).toBe('stop');
    expect(clickedOrderType('sell', 25_010, quote, 0.25)).toBe('limit');
    expect(clickedOrderType('sell', 24_990, quote, 0.25)).toBe('stop');
    expect(clickedOrderType('buy', 25_000.25, quote, 0.25)).toBe('market');
    expect(clickedOrderType('sell', 25_000, quote, 0.25)).toBe('market');
  });

  it('návrh drží přesnou kliknutou cenu (na tick) a nic neodesílá', () => {
    const draft = newTicketDraft('buy', clickedOrderType('buy', 24_987.5, quote, 0.25), 24_987.5, instrument, quote);
    expect(draft).toMatchObject({ side: 'buy', type: 'limit', price: 24_987.5 });
    expect(draft.stopLoss).not.toBeNull();
    expect(draft.takeProfit).not.toBeNull();
  });
});
