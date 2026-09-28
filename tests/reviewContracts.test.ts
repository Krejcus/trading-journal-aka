import { describe, expect, it, vi } from 'vitest';
import { resolveContractsForEntries, type MarketCandleResponse } from '../services/marketData';

const response = (symbol: string, offset: number) => ({
  symbol, sourceSymbol: symbol,
  candles: [0, 60, 120, 180].map(time => ({ time: 1_788_999_960 + time, open: 29_100 + offset, high: 29_110 + offset, low: 29_090 + offset, close: 29_105 + offset, volume: 1 })),
}) as unknown as MarketCandleResponse;

describe('review týdne přes rollover', () => {
  it('každý obchod dostane kontrakt, na který sedí jeho vstup; kontrakt se stáhne jednou', async () => {
    const primary = response('MNQ.v.0', 0);          // kontinuální řada = zářijový kontrakt
    const dec = response('MNQZ6', 300);              // prosincový o 300 bodů výš
    const load = vi.fn(async (symbol: string) => (symbol === 'MNQZ6' ? dec : response(symbol, -300)));
    const at = (1_788_999_960 + 60) * 1000;
    const map = await resolveContractsForEntries({
      primary,
      candidates: () => ['MNQU6', 'MNQZ6'],
      load,
      entries: [
        { key: 'sep', at, price: 29_100 },
        { key: 'dec-1', at, price: 29_400 },
        { key: 'dec-2', at, price: 29_405 },
      ],
    });
    expect(map.get('sep')).toBe(primary);
    expect(map.get('dec-1')).toBe(dec);
    expect(map.get('dec-2')).toBe(dec);
    expect(load).toHaveBeenCalledTimes(2); // U6 i Z6 jen jednou, ne pro každý obchod
  });
  it('bez ceny vstupu zůstane kontinuální řada', async () => {
    const primary = response('MNQ.v.0', 0);
    const map = await resolveContractsForEntries({ primary, candidates: () => ['MNQZ6'], load: vi.fn(), entries: [{ key: 'x', at: 0, price: NaN }] });
    expect(map.get('x')).toBe(primary);
  });
});
