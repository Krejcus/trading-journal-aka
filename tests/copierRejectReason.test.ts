import { describe, expect, it } from 'vitest';
import { translateCopierRejectReason } from '../lib/copierRejectReason';

describe('translateCopierRejectReason', () => {
  it('přeloží price-through reject a zachová celý originál', () => {
    const original = 'Please check the order price. The current price is outside the price limits set for this product.';
    expect(translateCopierRejectReason(original)).toEqual({
      category: 'price-through',
      message: 'Stop/limit odmítnut: cena už byla za zadanou úrovní',
      original,
    });
  });

  it('přeloží DLL reject', () => {
    expect(translateCopierRejectReason('Violation: daily loss limit reached')).toMatchObject({
      category: 'dll',
      message: 'Denní limit ztráty (DLL) — účet uzamčen do konce session',
      original: 'Violation: daily loss limit reached',
    });
  });

  it.each(['Unregisted Tag50', 'customTag50 is not enabled'])(
    'označí interní tag reject: %s',
    reason => {
      expect(translateCopierRejectReason(reason)).toMatchObject({
        category: 'tag',
        message: 'Interní značka příkazu nebyla brokerem přijata',
        original: reason,
      });
    },
  );

  it('přeloží limit množství i s čísly a neplatnou cenu', () => {
    const quantity = 'Your maximum order quantity has been met. Please change your quantity to place the order. If you would like to request an increase, please submit a risk change request in the Account Settings Limit: 2 Current: 3.0. Scope: all Rule #3968';
    expect(translateCopierRejectReason(quantity)).toMatchObject({
      category: 'quantity-limit',
      message: 'Broker odmítl: limit množství (max 2, požadováno 3)',
      original: quantity,
    });
    expect(translateCopierRejectReason('InvalidPrice')).toMatchObject({
      category: 'invalid-price',
      message: 'Broker odmítl: neplatná cena příkazu',
    });
  });

  it('neznámý důvod zkrátí jen v prezentaci a neztratí originál', () => {
    const original = `Unexpected  broker\nrejection ${'x'.repeat(220)}`;
    const translated = translateCopierRejectReason(original);
    expect(translated.category).toBe('unknown');
    expect(translated.message).toHaveLength(160);
    expect(translated.message.endsWith('…')).toBe(true);
    expect(translated.original).toBe(original);
  });
});
