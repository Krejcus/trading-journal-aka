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

  it('neznámý důvod zkrátí jen v prezentaci a neztratí originál', () => {
    const original = `Unexpected  broker\nrejection ${'x'.repeat(220)}`;
    const translated = translateCopierRejectReason(original);
    expect(translated.category).toBe('unknown');
    expect(translated.message).toHaveLength(160);
    expect(translated.message.endsWith('…')).toBe(true);
    expect(translated.original).toBe(original);
  });
});
