import { describe, expect, it } from 'vitest';
import { livePhoneBareMarket, livePhonePosition, livePhoneSheetEntry } from '../lib/livePhoneOrders';
import { validateLeaderEntryPreview, buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import type { TicketDraft } from '../lib/liveOrderTicket';

const quote = { symbol: 'MNQZ6', bid: 24_999.75, ask: 25_000, at: Date.UTC(2026, 10, 2, 1) };
const instrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const valid = (draft: object) => validateLeaderEntryPreview(buildLeaderEntryPreviewCommand(draft as never, {
  group: { id: 'g', enabled: true, leaderAccountId: 1, followers: [] }, armedAt: 1, excludedFollowers: new Set(), participation: [], operationId: 'preview:abcdefgh1',
}));

describe('telefon: lišta a list objednávky → stejný příkaz jako PC', () => {
  it('lišta = holý Market s cenou strany, bez SL/TP; bez IBKR kontraktu nic', () => {
    const buy = livePhoneBareMarket('buy', 2, quote);
    expect(buy).toEqual({ symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: quote.at });
    expect(() => valid(buy)).not.toThrow();
    expect(livePhoneBareMarket('sell', 1, quote)).toMatchObject({ side: 'Sell', referencePrice: 24_999.75 });
    expect(livePhoneBareMarket('buy', 1, { ...quote, symbol: null })).toHaveProperty('error');
    expect(livePhoneBareMarket('buy', 0, quote)).toHaveProperty('error');
  });

  it('list: Limit se SL+TP, Market bez nohou, jedna noha = chyba', () => {
    const base: TicketDraft = { side: 'buy', type: 'limit', price: 24_980, sizing: 'qty', quantity: 3, riskUsd: 0, stopLoss: 24_970, takeProfit: 25_010 } as TicketDraft;
    const limit = livePhoneSheetEntry(base, instrument, quote);
    expect(limit).toMatchObject({ orderType: 'Limit', price: 24_980, quantity: 3, stopLoss: 24_970, takeProfit: 25_010 });
    expect(() => valid(limit)).not.toThrow();
    expect(livePhoneSheetEntry({ ...base, takeProfit: null }, instrument, quote)).toHaveProperty('error');
    expect(livePhoneSheetEntry({ ...base, stopLoss: null, takeProfit: null }, instrument, quote)).toHaveProperty('error');
    const bare = livePhoneSheetEntry({ ...base, type: 'market', stopLoss: null, takeProfit: null }, instrument, quote);
    expect(bare).toMatchObject({ orderType: 'Market', referencePrice: 25_000 });
    expect(bare).not.toHaveProperty('stopLoss');
    expect(() => valid(bare)).not.toThrow();
  });
});

describe('telefon: lišta pozice vs. čekající vstup', () => {
  const leader = { quantity: 1 };
  it('čekající Limit není pozice a nenabízí Přidat SL/TP (DEMO 2. 11.: ukázal „LONG 1“)', () => {
    const pending = livePhonePosition({ kind: 'pending', side: 'long', entry: 28_753.5, entryType: 'Limit' }, leader, 'MNQZ6', 'entry:abc');
    expect(pending).toEqual({ side: 'long', quantity: 1, symbol: 'MNQZ6', bareEntryOperationId: null, pending: { type: 'Limit', price: 28_753.5 } });
  });
  it('otevřená pozice drží holý vstup pro attach', () => {
    const open = livePhonePosition({ kind: 'position', side: 'short', entry: 28_791.5, entryType: null }, leader, 'MNQZ6', 'entry:abc');
    expect(open).toMatchObject({ side: 'short', pending: null, bareEntryOperationId: 'entry:abc' });
  });
  it('bez leadera nebo kontraktu nic', () => {
    expect(livePhonePosition({ kind: 'position', side: 'long', entry: 1, entryType: null }, null, 'MNQZ6', null)).toBeNull();
    expect(livePhonePosition({ kind: 'position', side: 'long', entry: 1, entryType: null }, leader, null, null)).toBeNull();
  });
});
