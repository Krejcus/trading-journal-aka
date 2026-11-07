import { describe, expect, it } from 'vitest';
import { copierMarketPricesFromQuote, COPIER_MARKET_PRICE_MAX_AGE_MS, pickCopierMarketPrice } from '../lib/copierMarketPrice';

describe('„Do fillu“ z kotace IBKR', () => {
  // Kotace nese krátký kontrakt jako symbol příkazu (`services/manualEntryPreview.ts`).
  const quote = { contract: 'MNQZ6', last: 27_000.25, lastAt: 1_000_000 };

  it('kotace se vybere pro kontrakt leadera a stará vyprší', () => {
    const rows = copierMarketPricesFromQuote(quote);
    expect(pickCopierMarketPrice(rows, 'MNQZ6', quote.lastAt + 1_000)).toBe(27_000.25);
    expect(pickCopierMarketPrice(rows, 'ESZ6', quote.lastAt + 1_000)).toBeNull();
    expect(pickCopierMarketPrice(rows, 'MNQZ6', quote.lastAt + COPIER_MARKET_PRICE_MAX_AGE_MS + 1)).toBeNull();
  });

  it('bez kotace nic, neplatná hodnota se nevydává za cenu', () => {
    expect(copierMarketPricesFromQuote(null)).toEqual([]);
    expect(copierMarketPricesFromQuote({ ...quote, last: 0 })).toEqual([]);
    expect(copierMarketPricesFromQuote({ ...quote, lastAt: Number.NaN })).toEqual([]);
  });
});
