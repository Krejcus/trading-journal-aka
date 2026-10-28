import { beforeEach, describe, expect, it } from 'vitest';
import { isLivePriceFallback, LIVE_IBKR_FALLBACK_MEMORY_MS, noteLivePriceSource, resetLivePriceSourceFallback } from '../lib/livePriceSourceFallback';

beforeEach(() => resetLivePriceSourceFallback());

describe('záloha TradingView místo IBKR (jen štítek ceny)', () => {
  it('TV bez předchozího IBKR není záloha (worker jen s TV)', () => {
    expect(isLivePriceFallback('CME_MINI:MNQ1!', 1_000)).toBe(false);
  });

  it('TV po IBKR = záloha; IBKR samo nikdy; po 6 h bez IBKR už ne; čtení nic nemění', () => {
    noteLivePriceSource('IBKR:MNQZ2026', 1_000);
    expect(isLivePriceFallback('IBKR:MNQZ2026', 2_000)).toBe(false);
    expect(isLivePriceFallback('CME_MINI:MNQ1!', 2_000)).toBe(true);
    expect(isLivePriceFallback('CME_MINI:MNQ1!', 1_000 + LIVE_IBKR_FALLBACK_MEMORY_MS + 1)).toBe(false);
    noteLivePriceSource('CME_MINI:MNQ1!', 3_000);
    expect(isLivePriceFallback('CME_MINI:MNQ1!', 3_000)).toBe(true);
    expect(isLivePriceFallback(null, 4_000)).toBe(false);
  });
});
